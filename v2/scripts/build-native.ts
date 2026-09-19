// Compile the two native helpers with the C# compiler that ships inside every
// Windows 10/11 (.NET Framework 4.x). No SDK or download is needed.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const csc = path.join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
if (!fs.existsSync(csc)) throw new Error(`C# compiler not found at ${csc}`);

const bin = path.join(root, "bin");
fs.mkdirSync(bin, { recursive: true });

const targets: [string, string, string[]][] = [
  ["walk.cs", "atlas-walk.exe", []],
  ["AtlasService.cs", "AtlasService.exe", ["/reference:System.ServiceProcess.dll"]],
];
for (const [src, out, extra] of targets) {
  execFileSync(csc, ["/nologo", "/optimize+", "/platform:x64", `/out:${path.join(bin, out)}`, ...extra, path.join(root, "native", src)], {
    stdio: "inherit",
  });
  console.log(`built bin/${out}`);
}
