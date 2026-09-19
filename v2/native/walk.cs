// atlas-walk: enumerate a directory tree for the Atlas scanner.
//
// Uses GetFileInformationByHandleEx(FileIdBothDirectoryInfo), which returns the
// name, size, timestamps, attributes, reparse tag and file ID of MANY entries per
// call. No file is ever opened or stat'ed individually, which is why this is ~2x
// faster than Node's readdir+stat with a warm cache and far faster cold, and it
// is the only cheap way to see cloud-placeholder attributes.
//
// Usage: atlas-walk.exe <absolute root> [--exclude <dir name>]...
//
// Output (UTF-8 lines, TAB separated; Windows forbids TAB/LF in names):
//   V  <volume serial hex>  <filesystem name>          once, first
//   D  <dir relative to root, '' for root>             a directory that was listed
//   F  <name> <size> <mtime ms> <ctime ms> <attrs> <file id hex> <reparse tag>
//   E  <dir relative to root>  <win32 error>           a directory that could not be listed
//   Z  <files> <dirs> <errors>                          once, last (absent = walker died)
// Exit code 2 = the root itself could not be opened.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class AtlasWalk {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandleEx(IntPtr h, int cls, IntPtr buf, uint size);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool GetVolumeInformationByHandleW(IntPtr h, StringBuilder volName, uint volNameSize,
    out uint serial, out uint maxComp, out uint fsFlags, StringBuilder fsName, uint fsNameSize);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  const int FileIdBothDirectoryInfo = 10;
  const uint FILE_LIST_DIRECTORY = 0x1, SHARE_ALL = 0x7, OPEN_EXISTING = 3, BACKUP_SEMANTICS = 0x02000000;
  const uint ATTR_DIRECTORY = 0x10, ATTR_REPARSE = 0x400;
  const int BUF = 256 * 1024;
  static readonly IntPtr INVALID = new IntPtr(-1);
  const long EPOCH_DIFF_MS = 11644473600000L;

  static string LongPath(string p) {
    if (p.StartsWith(@"\\?\")) return p;
    if (p.StartsWith(@"\\")) return @"\\?\UNC\" + p.Substring(2);
    return @"\\?\" + p;
  }

  static bool IsCloudTag(uint tag) { return (tag & 0xFFFF0FFF) == 0x9000001A; }

  static int Main(string[] args) {
    if (args.Length < 1) { Console.Error.WriteLine("usage: atlas-walk <root> [--exclude name]..."); return 1; }
    string root = Path.GetFullPath(args[0]).TrimEnd('\\');
    if (root.EndsWith(":")) root += "\\";
    var excludes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    for (int i = 1; i + 1 < args.Length; i++) if (args[i] == "--exclude") excludes.Add(args[++i]);

    var o = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false), 1 << 20);
    o.NewLine = "\n";
    IntPtr buf = Marshal.AllocHGlobal(BUF);
    long files = 0, dirs = 0, errors = 0;

    IntPtr rh = CreateFileW(LongPath(root), FILE_LIST_DIRECTORY, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, BACKUP_SEMANTICS, IntPtr.Zero);
    if (rh == INVALID) { o.WriteLine("E\t\t" + Marshal.GetLastWin32Error()); o.Flush(); return 2; }
    uint serial, maxComp, fsFlags;
    var fsName = new StringBuilder(64);
    GetVolumeInformationByHandleW(rh, null, 0, out serial, out maxComp, out fsFlags, fsName, 64);
    CloseHandle(rh);
    o.WriteLine("V\t" + serial.ToString("x8") + "\t" + fsName);

    var stack = new Stack<string>();
    stack.Push("");
    var sb = new StringBuilder(512);
    while (stack.Count > 0) {
      string rel = stack.Pop();
      string abs = rel.Length == 0 ? root : Path.Combine(root, rel);
      IntPtr h = CreateFileW(LongPath(abs), FILE_LIST_DIRECTORY, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, BACKUP_SEMANTICS, IntPtr.Zero);
      if (h == INVALID) { errors++; o.WriteLine("E\t" + rel + "\t" + Marshal.GetLastWin32Error()); continue; }
      dirs++;
      o.WriteLine("D\t" + rel);
      try {
        while (GetFileInformationByHandleEx(h, FileIdBothDirectoryInfo, buf, BUF)) {
          int off = 0;
          while (true) {
            IntPtr p = buf + off;
            int next = Marshal.ReadInt32(p, 0);
            long ctime = Marshal.ReadInt64(p, 8);
            long mtime = Marshal.ReadInt64(p, 24);
            long size = Marshal.ReadInt64(p, 40);
            uint attrs = (uint)Marshal.ReadInt32(p, 56);
            int nameLen = Marshal.ReadInt32(p, 60);
            uint ea = (uint)Marshal.ReadInt32(p, 64);
            long fileId = Marshal.ReadInt64(p, 96);
            string name = Marshal.PtrToStringUni(p + 104, nameLen / 2);
            if (name != "." && name != "..") {
              uint tag = (attrs & ATTR_REPARSE) != 0 ? ea : 0;
              if ((attrs & ATTR_DIRECTORY) != 0) {
                // Junctions, symlinks and mount points are not followed: they
                // alias other trees (loops, double counting). Cloud folders are.
                bool follow = tag == 0 || IsCloudTag(tag);
                if (follow && !excludes.Contains(name)) stack.Push(rel.Length == 0 ? name : rel + "\\" + name);
              } else {
                files++;
                sb.Clear();
                sb.Append("F\t").Append(name).Append('\t').Append(size).Append('\t')
                  .Append(mtime / 10000 - EPOCH_DIFF_MS).Append('\t').Append(ctime / 10000 - EPOCH_DIFF_MS).Append('\t')
                  .Append(attrs).Append('\t').Append(fileId.ToString("x")).Append('\t').Append(tag.ToString("x"));
                o.WriteLine(sb.ToString());
              }
            }
            if (next == 0) break;
            off += next;
          }
        }
        int last = Marshal.GetLastWin32Error();
        if (last != 18 /* ERROR_NO_MORE_FILES */ && last != 0) { errors++; o.WriteLine("E\t" + rel + "\t" + last); }
      } finally { CloseHandle(h); }
    }
    o.WriteLine("Z\t" + files + "\t" + dirs + "\t" + errors);
    o.Flush();
    return 0;
  }
}
