// AtlasService: the Windows service that keeps the Atlas engine running.
//
// It owns exactly four jobs, all of which Node cannot do on its own:
//   1. Speak the Service Control Manager protocol (start at boot, no login).
//   2. Supervise node.exe: restart it with backoff if it exits, kill it if it
//      stops sending "@@alive" (a hung event loop is a crash that doesn't exit).
//   3. Hold a Windows power request while the engine says it is busy
//      ("@@awake 1"/"@@awake 0"), so idle sleep never interrupts processing.
//   4. Tell the engine about resume-from-sleep so it rescans.
//
// Engine protocol: engine -> host on stdout: "@@alive", "@@awake 1|0".
//                  host -> engine on stdin:  "shutdown", "resume".
// Everything else the engine writes goes to its own log files.
//
// Usage: AtlasService.exe            (started by the SCM)
//        AtlasService.exe console    (foreground, for development)
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Threading;

public class AtlasService : ServiceBase {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct REASON_CONTEXT { public uint Version; public uint Flags; [MarshalAs(UnmanagedType.LPWStr)] public string Reason; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr PowerCreateRequest(ref REASON_CONTEXT ctx);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool PowerSetRequest(IntPtr h, int type);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool PowerClearRequest(IntPtr h, int type);
  const int PowerRequestSystemRequired = 1;

  // A Job Object with KILL_ON_JOB_CLOSE ties node.exe's life to this process: if the
  // host is killed (crash, taskkill, SCM timeout), Windows kills the engine too, so a
  // restarted host can never end up with two engines on one database.
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION Basic; public IO_COUNTERS Io;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr sa, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int len);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  const int JobObjectExtendedLimitInformation = 9;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
  static IntPtr job = IntPtr.Zero;

  static void EnsureJob() {
    if (job != IntPtr.Zero) return;
    job = CreateJobObject(IntPtr.Zero, null);
    var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    info.Basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
  }

  const int ALIVE_TIMEOUT_S = 120;
  const int STOP_GRACE_MS = 25000;

  readonly string appDir, homeDir, logPath;
  readonly object gate = new object();
  Process child;
  Thread supervisor;
  volatile bool stopping;
  DateTime lastAlive = DateTime.UtcNow;
  IntPtr powerRequest = IntPtr.Zero;
  bool awake;

  public AtlasService() {
    ServiceName = "AtlasEngine";
    CanHandlePowerEvent = true;
    CanShutdown = true;
    appDir = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".."));
    homeDir = Environment.GetEnvironmentVariable("ATLAS_HOME");
    if (string.IsNullOrEmpty(homeDir))
      homeDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Atlas");
    Directory.CreateDirectory(Path.Combine(homeDir, "logs"));
    logPath = Path.Combine(homeDir, "logs", "service.log");
  }

  void Log(string msg) {
    try {
      var fi = new FileInfo(logPath);
      if (fi.Exists && fi.Length > 5 * 1024 * 1024) File.Delete(logPath);
      File.AppendAllText(logPath, DateTime.UtcNow.ToString("o") + " " + msg + Environment.NewLine);
    } catch { }
  }

  string NodePath() {
    string bundled = Path.Combine(appDir, "node", "node.exe");
    return File.Exists(bundled) ? bundled : "node.exe";
  }

  protected override void OnStart(string[] args) { Begin(); }
  protected override void OnStop() { End(); }
  protected override void OnShutdown() { End(); }
  protected override bool OnPowerEvent(PowerBroadcastStatus status) {
    if (status == PowerBroadcastStatus.ResumeAutomatic || status == PowerBroadcastStatus.ResumeSuspend) Send("resume");
    return true;
  }

  public void Begin() {
    stopping = false;
    supervisor = new Thread(Supervise) { IsBackground = true, Name = "supervisor" };
    supervisor.Start();
  }

  public void End() {
    stopping = true;
    try { RequestAdditionalTime(STOP_GRACE_MS + 5000); } catch { }
    Process c;
    lock (gate) c = child;
    if (c != null && !c.HasExited) {
      Send("shutdown");
      if (!c.WaitForExit(STOP_GRACE_MS)) { Log("engine did not stop in time; killing"); try { c.Kill(); } catch { } }
    }
    SetAwake(false);
    Log("service stopped");
  }

  void Send(string line) {
    lock (gate) {
      try { if (child != null && !child.HasExited) { child.StandardInput.WriteLine(line); child.StandardInput.Flush(); } } catch { }
    }
  }

  void SetAwake(bool on) {
    lock (gate) {
      if (on == awake) return;
      if (powerRequest == IntPtr.Zero) {
        var ctx = new REASON_CONTEXT { Version = 0, Flags = 1, Reason = "Atlas is processing files" };
        powerRequest = PowerCreateRequest(ref ctx);
      }
      if (powerRequest == IntPtr.Zero || powerRequest == new IntPtr(-1)) return;
      if (on) PowerSetRequest(powerRequest, PowerRequestSystemRequired);
      else PowerClearRequest(powerRequest, PowerRequestSystemRequired);
      awake = on;
      Log(on ? "keep-awake ON" : "keep-awake OFF");
    }
  }

  void Supervise() {
    int backoffMs = 1000;
    while (!stopping) {
      var psi = new ProcessStartInfo(NodePath(), "--disable-warning=ExperimentalWarning src\\main.ts") {
        WorkingDirectory = appDir, UseShellExecute = false, CreateNoWindow = true,
        RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
      };
      psi.EnvironmentVariables["ATLAS_HOME"] = homeDir;
      psi.EnvironmentVariables["ATLAS_HOSTED"] = "1";
      // Node's thread pool serves the scanner's stat calls and file streaming; 4 is its default.
      if (psi.EnvironmentVariables["UV_THREADPOOL_SIZE"] == null) psi.EnvironmentVariables["UV_THREADPOOL_SIZE"] = "8";
      Process p;
      try { p = Process.Start(psi); }
      catch (Exception e) { Log("could not start engine: " + e.Message); Thread.Sleep(backoffMs); backoffMs = Math.Min(backoffMs * 2, 60000); continue; }
      try { EnsureJob(); AssignProcessToJobObject(job, p.Handle); } catch (Exception e) { Log("could not attach engine to job object: " + e.Message); }
      lock (gate) child = p;
      lastAlive = DateTime.UtcNow;
      var started = DateTime.UtcNow;
      Log("engine started pid=" + p.Id);
      p.ErrorDataReceived += (s, e) => { if (e.Data != null) Log("engine stderr: " + e.Data); };
      p.BeginErrorReadLine();
      var reader = new Thread(() => {
        try {
          string line;
          while ((line = p.StandardOutput.ReadLine()) != null) {
            if (line == "@@alive") lastAlive = DateTime.UtcNow;
            else if (line == "@@awake 1") SetAwake(true);
            else if (line == "@@awake 0") SetAwake(false);
          }
        } catch { }
      }) { IsBackground = true };
      reader.Start();

      while (!p.WaitForExit(5000)) {
        if (!stopping && (DateTime.UtcNow - lastAlive).TotalSeconds > ALIVE_TIMEOUT_S) {
          Log("engine unresponsive for " + ALIVE_TIMEOUT_S + "s; killing it");
          try { p.Kill(); } catch { }
        }
      }
      SetAwake(false);
      Log("engine exited code=" + p.ExitCode);
      lock (gate) child = null;
      if (stopping) break;
      if ((DateTime.UtcNow - started).TotalMinutes > 10) backoffMs = 1000;
      Thread.Sleep(backoffMs);
      backoffMs = Math.Min(backoffMs * 2, 60000);
    }
  }

  public static void Main(string[] args) {
    if (args.Length > 0 && args[0] == "console") {
      var svc = new AtlasService();
      var done = new ManualResetEvent(false);
      Console.CancelKeyPress += (s, e) => { e.Cancel = true; done.Set(); };
      svc.Begin();
      Console.WriteLine("Atlas engine supervised in console mode. Home: " + svc.homeDir + ". Ctrl+C to stop.");
      done.WaitOne();
      svc.End();
      return;
    }
    ServiceBase.Run(new AtlasService());
  }
}
