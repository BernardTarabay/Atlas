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
// Errors: {"id":n,"error":"..."}. The helper never exits on a bad request.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Windows.Data.Pdf;
using Windows.Foundation;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage;
using Windows.Storage.Streams;

static class AtlasWinRT {
  static readonly Dictionary<string, OcrEngine> engines = new Dictionary<string, OcrEngine>();
  static readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

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

  static object Handle(Dictionary<string, object> req) {
    string op = (string)req["op"];
    if (op == "langs") {
      var list = new List<string>();
      foreach (var l in OcrEngine.AvailableRecognizerLanguages) list.Add(l.LanguageTag);
      return new Dictionary<string, object> { { "langs", list } };
    }
    string path = (string)req["path"];
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
      }
      reply["id"] = id;
      reply["ms"] = sw.ElapsedMilliseconds;
      stdout.WriteLine(json.Serialize(reply));
    }
    return 0;
  }
}
