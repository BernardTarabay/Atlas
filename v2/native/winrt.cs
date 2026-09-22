// atlas-winrt: Windows' built-in OCR and PDF rendering, as a long-lived helper.
//
// Both engines ship with Windows (Windows.Media.Ocr, Windows.Data.Pdf): nothing to
// download, nothing GPL to bundle. One process serves many requests, so the WinRT
// start-up cost is paid once.
//
// Built against the per-namespace metadata in System32\WinMetadata that every
// Windows install has. It deliberately avoids .NET's WinRT bridge (AsTask, stream
// adapters), which needs the Windows SDK's union metadata: async operations are
// awaited through their Completed events, files are opened through StorageFile.
//
// Protocol: one JSON object per line on stdin, one JSON reply per line on stdout.
//   {"id":1,"op":"langs"}                                   -> {"id":1,"langs":["ar-SA",...]}
//   {"id":2,"op":"ocr","path":"x.png","lang":"ar-SA"}       -> {"id":2,"text":"...","lines":12,"angle":0.4,"w":..,"h":..,"ms":95}
//   {"id":3,"op":"pages","path":"x.pdf"}                    -> {"id":3,"pages":4}
//   {"id":4,"op":"ocrpdf","path":"x.pdf","page":0,"dpi":200,"lang":"fr-FR"} -> like "ocr" (page rendered in memory)
//   {"id":5,"op":"render","path":"x.pdf","page":0,"dpi":150,"out":"C:\\dir\\p.png"} -> {"id":5,"w":..,"h":..}
//   {"id":6,"op":"move","path":"C:\\a.pdf","to":"C:\\lib\\a.pdf"}   -> {"id":6}  (Apply: never replaces, see Move)
//   {"id":7,"op":"created","path":"C:\\x.pdf","t":1700000000000}   -> {"id":7}  (set the creation time)
// Errors: {"id":n,"error":"...","code":<win32 error, when there is one>}. The helper never exits on a bad request.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Windows.Data.Pdf;
using Windows.Foundation;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage;
using Windows.Storage.FileProperties;
using Windows.Storage.Streams;

static class AtlasWinRT {
  static readonly Dictionary<string, OcrEngine> engines = new Dictionary<string, OcrEngine>();
  static readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

  // ---- Apply's two primitives ------------------------------------------------
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool MoveFileExW(string from, string to, uint flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetFileTime(IntPtr h, ref long created, IntPtr accessed, IntPtr written);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  const uint MOVEFILE_WRITE_THROUGH = 0x8, FILE_WRITE_ATTRIBUTES = 0x100, SHARE_ALL = 0x7, OPEN_EXISTING = 3, BACKUP_SEMANTICS = 0x02000000;

  static string LongPath(string p) {
    p = Path.GetFullPath(p);
    if (p.StartsWith(@"\\?\")) return p;
    if (p.StartsWith(@"\\")) return @"\\?\UNC\" + p.Substring(2);
    return @"\\?\" + p;
  }

  // Rename on one volume that NEVER replaces: without MOVEFILE_REPLACE_EXISTING an
  // existing destination (compared the way the filesystem compares names, ignoring
  // case) fails with ERROR_ALREADY_EXISTS instead of being overwritten - which is
  // what Node's fs.rename would do. Without MOVEFILE_COPY_ALLOWED, across volumes it
  // fails (ERROR_NOT_SAME_DEVICE) instead of silently becoming a copy and delete.
  // WRITE_THROUGH: it does not return before the rename is on disk.
  static void Move(string from, string to) {
    if (!MoveFileExW(LongPath(from), LongPath(to), MOVEFILE_WRITE_THROUGH)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }

  // A copy is a new file with a new creation time: give it back the original's.
  static void SetCreated(string path, long unixMs) {
    IntPtr h = CreateFileW(LongPath(path), FILE_WRITE_ATTRIBUTES, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, BACKUP_SEMANTICS, IntPtr.Zero);
    if (h == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      long ft = (unixMs + 11644473600000L) * 10000L;
      if (!SetFileTime(h, ref ft, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally { CloseHandle(h); }
  }

  static T Wait<T>(IAsyncOperation<T> op) {
    using (var done = new ManualResetEvent(false)) {
      op.Completed = (o, s) => done.Set();
      if (op.Status == AsyncStatus.Started) done.WaitOne();
    }
    if (op.Status == AsyncStatus.Error) throw new Exception(op.ErrorCode.Message);
    return op.GetResults();
  }

  static void Wait(IAsyncAction op) {
    using (var done = new ManualResetEvent(false)) {
      op.Completed = (o, s) => done.Set();
      if (op.Status == AsyncStatus.Started) done.WaitOne();
    }
    if (op.Status == AsyncStatus.Error) throw new Exception(op.ErrorCode.Message);
  }

  static T Wait<T, P>(IAsyncOperationWithProgress<T, P> op) {
    using (var done = new ManualResetEvent(false)) {
      op.Completed = (o, s) => done.Set();
      if (op.Status == AsyncStatus.Started) done.WaitOne();
    }
    if (op.Status == AsyncStatus.Error) throw new Exception(op.ErrorCode.Message);
    return op.GetResults();
  }

  static OcrEngine Engine(string lang) {
    OcrEngine e;
    if (!engines.TryGetValue(lang, out e)) {
      e = OcrEngine.TryCreateFromLanguage(new Language(lang));
      if (e == null) throw new Exception("OCR language not installed: " + lang);
      engines[lang] = e;
    }
    return e;
  }

  static IRandomAccessStream OpenRead(string path) {
    var file = Wait(StorageFile.GetFileFromPathAsync(Path.GetFullPath(path)));
    return Wait(file.OpenAsync(FileAccessMode.Read));
  }

  static SoftwareBitmap Decode(IRandomAccessStream stream) {
    var decoder = Wait(BitmapDecoder.CreateAsync(stream));
    uint max = OcrEngine.MaxImageDimension;
    uint w = decoder.PixelWidth, h = decoder.PixelHeight;
    var transform = new BitmapTransform();
    if (w > max || h > max) {
      double s = Math.Min((double)max / w, (double)max / h);
      transform.ScaledWidth = (uint)(w * s);
      transform.ScaledHeight = (uint)(h * s);
      transform.InterpolationMode = BitmapInterpolationMode.Fant;
    }
    return Wait(decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied, transform,
      ExifOrientationMode.RespectExifOrientation, ColorManagementMode.DoNotColorManage));
  }

  static Dictionary<string, object> Recognize(SoftwareBitmap bmp, string lang) {
    var r = Wait(Engine(lang).RecognizeAsync(bmp));
    var sb = new StringBuilder();
    foreach (var line in r.Lines) sb.Append(line.Text).Append('\n');
    return new Dictionary<string, object> {
      { "text", sb.ToString() }, { "lines", r.Lines.Count }, { "angle", r.TextAngle.HasValue ? r.TextAngle.Value : 0.0 },
      { "w", bmp.PixelWidth }, { "h", bmp.PixelHeight },
    };
  }

  static IRandomAccessStream RenderPage(string path, int index, double dpi, out PdfPage page) {
    var doc = Wait(PdfDocument.LoadFromStreamAsync(OpenRead(path)));
    if (index < 0 || index >= doc.PageCount) throw new Exception("page out of range");
    page = doc.GetPage((uint)index);
    var opts = new PdfPageRenderOptions { DestinationWidth = (uint)Math.Round(page.Size.Width * dpi / 96.0) };
    var mem = new InMemoryRandomAccessStream();
    Wait(page.RenderToStreamAsync(mem, opts));
    mem.Seek(0);
    return mem;
  }

  /// <summary>
  /// A thumbnail, the way Explorer gets one: ask the shell first. That is the
  /// same cache and the same handlers Explorer uses, so photos, video frames,
  /// PDFs and Office documents all come back as pictures wherever Windows can
  /// draw them. When the shell only has an icon (no handler), images are decoded
  /// directly instead. Anything else has no thumbnail, and says so.
  ///
  /// PNG out only when the picture really has an alpha channel - a JPEG would
  /// paint the transparent parts black - and JPEG for everything else, which is
  /// a fraction of the size. Asking the decoder, not the file extension: most
  /// PNGs on a real disk are screenshots with no transparency at all.
  /// </summary>
  static Dictionary<string, object> Thumb(string path, uint size, string outPath) {
    var file = Wait(StorageFile.GetFileFromPathAsync(Path.GetFullPath(path)));
    string ext = Path.GetExtension(path).ToLowerInvariant();
    bool mayHaveAlpha = ext == ".png" || ext == ".gif" || ext == ".webp" || ext == ".ico";
    string source = "shell";
    IRandomAccessStream src = null;
    try {
      var t = Wait(file.GetThumbnailAsync(ThumbnailMode.SingleItem, size, ThumbnailOptions.ResizeThumbnail));
      if (t != null && t.Type == ThumbnailType.Image) src = t;
      else if (t != null) t.Dispose();
    } catch { /* no shell thumbnail: try decoding it ourselves */ }
    if (src == null && ext == ".pdf") {
      // No shell handler for PDFs on a stock Windows (Edge does not register one):
      // draw the first page ourselves, straight to JPEG, the way OCR renders pages.
      var doc = Wait(PdfDocument.LoadFromStreamAsync(Wait(file.OpenAsync(FileAccessMode.Read))));
      if (doc.PageCount == 0) throw new Exception("no thumbnail");
      var page = doc.GetPage(0);
      double k = Math.Min(size / page.Size.Width, size / page.Size.Height);
      var opts = new PdfPageRenderOptions {
        DestinationWidth = (uint)Math.Max(1, Math.Round(page.Size.Width * k)),
        DestinationHeight = (uint)Math.Max(1, Math.Round(page.Size.Height * k)),
        BitmapEncoderId = BitmapEncoder.JpegEncoderId,
      };
      using (var mem = new InMemoryRandomAccessStream()) {
        Wait(page.RenderToStreamAsync(mem, opts));
        var reader = new DataReader(mem.GetInputStreamAt(0));
        uint n = (uint)mem.Size;
        Wait(reader.LoadAsync(n));
        var bytes = new byte[n];
        reader.ReadBytes(bytes);
        File.WriteAllBytes(outPath, bytes);
        return new Dictionary<string, object> {
          { "w", (int)opts.DestinationWidth }, { "h", (int)opts.DestinationHeight }, { "source", "pdf" }, { "format", "jpeg" }, { "bytes", (int)n },
        };
      }
    }
    if (src == null) {
      bool image = ext == ".jpg" || ext == ".jpeg" || ext == ".png" || ext == ".gif" || ext == ".bmp" || ext == ".tif" ||
        ext == ".tiff" || ext == ".webp" || ext == ".heic" || ext == ".heif" || ext == ".jfif" || ext == ".ico";
      if (!image) throw new Exception("no thumbnail");
      src = Wait(file.OpenAsync(FileAccessMode.Read));
      source = "decode";
    }
    using (src) {
      var decoder = Wait(BitmapDecoder.CreateAsync(src));
      bool alpha = mayHaveAlpha && decoder.BitmapAlphaMode != BitmapAlphaMode.Ignore;
      uint w = decoder.OrientedPixelWidth, h = decoder.OrientedPixelHeight;
      var transform = new BitmapTransform { InterpolationMode = BitmapInterpolationMode.Fant };
      if (w > size || h > size) {
        double k = Math.Min((double)size / w, (double)size / h);
        // BitmapTransform scales the decoded (not the oriented) image.
        bool turned = decoder.OrientedPixelWidth != decoder.PixelWidth;
        transform.ScaledWidth = (uint)Math.Max(1, Math.Round((turned ? h : w) * k));
        transform.ScaledHeight = (uint)Math.Max(1, Math.Round((turned ? w : h) * k));
      }
      var bmp = Wait(decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, alpha ? BitmapAlphaMode.Premultiplied : BitmapAlphaMode.Ignore,
        transform, ExifOrientationMode.RespectExifOrientation, ColorManagementMode.DoNotColorManage));
      using (var mem = new InMemoryRandomAccessStream()) {
        var enc = Wait(BitmapEncoder.CreateAsync(alpha ? BitmapEncoder.PngEncoderId : BitmapEncoder.JpegEncoderId, mem));
        enc.SetSoftwareBitmap(bmp);
        Wait(enc.FlushAsync());
        var reader = new DataReader(mem.GetInputStreamAt(0));
        uint n = (uint)mem.Size;
        Wait(reader.LoadAsync(n));
        var bytes = new byte[n];
        reader.ReadBytes(bytes);
        File.WriteAllBytes(outPath, bytes);
        return new Dictionary<string, object> {
          { "w", bmp.PixelWidth }, { "h", bmp.PixelHeight }, { "source", source }, { "format", alpha ? "png" : "jpeg" }, { "bytes", (int)n },
        };
      }
    }
  }

  static object Handle(Dictionary<string, object> req) {
    string op = (string)req["op"];
    if (op == "langs") {
      var list = new List<string>();
      foreach (var l in OcrEngine.AvailableRecognizerLanguages) list.Add(l.LanguageTag);
      return new Dictionary<string, object> { { "langs", list } };
    }
    string path = (string)req["path"];
    if (op == "move") { Move(path, (string)req["to"]); return new Dictionary<string, object>(); }
    if (op == "created") { SetCreated(path, Convert.ToInt64(req["t"])); return new Dictionary<string, object>(); }
    if (op == "thumb") return Thumb(path, Convert.ToUInt32(req["size"]), (string)req["out"]);
    if (op == "ocr") {
      using (var s = OpenRead(path)) return Recognize(Decode(s), (string)req["lang"]);
    }
    if (op == "pages") {
      var doc = Wait(PdfDocument.LoadFromStreamAsync(OpenRead(path)));
      return new Dictionary<string, object> { { "pages", (int)doc.PageCount } };
    }
    int index = Convert.ToInt32(req["page"]);
    double dpi = req.ContainsKey("dpi") ? Convert.ToDouble(req["dpi"]) : 200.0;
    PdfPage page;
    using (var mem = RenderPage(path, index, dpi, out page)) {
      if (op == "ocrpdf") return Recognize(Decode(mem), (string)req["lang"]);
      if (op == "render") {
        var reader = new DataReader(mem.GetInputStreamAt(0));
        uint size = (uint)mem.Size;
        Wait(reader.LoadAsync(size));
        var bytes = new byte[size];
        reader.ReadBytes(bytes);
        File.WriteAllBytes((string)req["out"], bytes);
        return new Dictionary<string, object> {
          { "w", (int)Math.Round(page.Size.Width * dpi / 96.0) }, { "h", (int)Math.Round(page.Size.Height * dpi / 96.0) },
        };
      }
    }
    throw new Exception("unknown op: " + op);
  }

  static int Main(string[] args) {
    var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
    string line;
    while ((line = stdin.ReadLine()) != null) {
      if (line.Length == 0) continue;
      object id = null;
      Dictionary<string, object> reply;
      var sw = Stopwatch.StartNew();
      try {
        var req = json.Deserialize<Dictionary<string, object>>(line);
        req.TryGetValue("id", out id);
        reply = Handle(req) as Dictionary<string, object> ?? new Dictionary<string, object>();
      } catch (Exception e) {
        var inner = e is AggregateException && e.InnerException != null ? e.InnerException : e;
        reply = new Dictionary<string, object> { { "error", inner.Message } };
        var w32 = inner as Win32Exception;
        if (w32 != null) reply["code"] = w32.NativeErrorCode;
      }
      reply["id"] = id;
      reply["ms"] = sw.ElapsedMilliseconds;
      stdout.WriteLine(json.Serialize(reply));
    }
    return 0;
  }
}
