// Representative OCR test set with exact ground truth, rendered by the Edge that
// ships with Windows. Nothing is downloaded.
//
//   clean       a document page as a crisp image (a phone screenshot of a PDF)
//   scan        grayscale, slightly rotated, blurred, noisy, off-white paper
//   photo       a phone photo of a page: perspective, shading, blur, table behind it
//   screenshot  phone UI (chat bubbles), screen resolution
//   notext      pictures with no text at all (for the "does this need OCR?" gate)
//   pdf-text    a real PDF with a text layer (tests extraction, incl. Arabic order)
//   pdf-scan    an image-only PDF of a scanned page
//
// Usage: node bench/ocr-corpus.ts [--per 8] [--out ~/AtlasBench/ocr]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const PER = Number(opt("per", "8"));
const out = path.resolve(opt("out", path.join(os.homedir(), "AtlasBench", "ocr")));
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
let seed = 7;
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const shuffle = <T,>(a: T[]) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

type Lang = "ar" | "fr" | "en";
const L: Record<Lang, { dir: string; fonts: string[]; org: string; sentences: string[]; titles: string[]; items: string[]; names: string[]; words: Record<string, string> }> = {
  ar: {
    dir: "rtl",
    fonts: ["Traditional Arabic", "Simplified Arabic", "Sakkal Majalla", "Arabic Typesetting", "Tahoma", "Segoe UI", "Arial", "Adobe Naskh Medium"],
    org: "مدرسة مار يوسف",
    sentences: [
      "نود إعلامكم بأن موعد الاجتماع السنوي للجنة الأهل قد تحدد يوم الخميس المقبل في قاعة المدرسة.",
      "يرجى تسديد المبلغ المتوجب قبل نهاية الشهر الحالي تفادياً لأي غرامات تأخير.",
      "تتضمن هذه الفاتورة رسوم التسجيل والكتب المدرسية وبدل النقل للفصل الدراسي الأول.",
      "نشكركم على تعاونكم الدائم ونتمنى لكم ولعائلاتكم دوام الصحة والعافية.",
      "تم استلام المبلغ المذكور أعلاه نقداً من السيد جورج خوري بتاريخ اليوم.",
      "يعتبر هذا العقد نافذاً اعتباراً من تاريخ توقيعه من قبل الطرفين ولمدة سنة كاملة.",
      "يلتزم الطرف الثاني بتسليم المواد المطلوبة في الموعد المحدد وبالمواصفات المتفق عليها.",
      "نرجو منكم التكرم بالموافقة على طلب الإجازة المرفق لمدة أسبوعين.",
      "بلغ مجموع المصاريف التشغيلية لهذا العام حوالي خمسة وأربعين ألف دولار.",
      "سيتم تنظيم رحلة للطلاب إلى المتحف الوطني يوم السبت الواقع في الخامس عشر من الشهر.",
      "الرجاء إحضار صورة عن الهوية وشهادة الميلاد عند تقديم طلب التسجيل.",
      "أوصت اللجنة بزيادة عدد الساعات المخصصة لتعليم اللغات الأجنبية.",
      "تقدم الراهبات خدمة الرعاية الاجتماعية للعائلات المحتاجة في المنطقة.",
      "يرجى الاتصال بأمانة السر على الرقم المذكور أدناه لأي استفسار.",
      "أظهر التقرير المالي تحسناً ملحوظاً في الإيرادات مقارنة بالسنة الماضية.",
      "تبدأ الدروس في الثامنة صباحاً وتنتهي في الثانية والنصف بعد الظهر.",
    ],
    titles: ["فاتورة", "إيصال استلام", "عقد إيجار", "محضر اجتماع", "تقرير سنوي", "طلب تسجيل", "رسالة إلى الأهل", "شهادة"],
    items: ["رسوم التسجيل", "الكتب المدرسية", "النقل", "الزي المدرسي", "النشاطات", "الغداء"],
    names: ["جورج خوري", "مريم حداد", "إيلي نصار", "رنا عبد الله", "الأخت تريزا", "سامي فرح"],
    words: { no: "رقم", date: "التاريخ", total: "المجموع", qty: "الكمية", price: "السعر", to: "إلى", name: "الاسم", birth: "تاريخ الولادة", class: "الصف", signature: "التوقيع", dear: "حضرة", section: "القسم" },
  },
  fr: {
    dir: "ltr",
    fonts: ["Times New Roman", "Calibri", "Arial", "Georgia", "Cambria", "Segoe UI", "Verdana", "Courier New"],
    org: "École Saint-Joseph",
    sentences: [
      "Nous avons le plaisir de vous informer que la réunion annuelle des parents aura lieu jeudi prochain dans la salle des fêtes.",
      "Veuillez régler le montant dû avant la fin du mois afin d'éviter toute pénalité de retard.",
      "Cette facture comprend les frais d'inscription, les manuels scolaires et le transport pour le premier trimestre.",
      "Nous vous remercions de votre collaboration et vous prions d'agréer nos salutations distinguées.",
      "Reçu de Monsieur Georges Khoury la somme mentionnée ci-dessus, en espèces, à la date de ce jour.",
      "Le présent contrat prend effet à la date de sa signature par les deux parties pour une durée d'un an.",
      "Le prestataire s'engage à livrer le matériel commandé dans les délais et selon les spécifications convenues.",
      "Je vous prie de bien vouloir accepter ma demande de congé ci-jointe pour une durée de deux semaines.",
      "Le total des dépenses de fonctionnement pour cette année s'élève à environ quarante-cinq mille dollars.",
      "Une sortie scolaire au musée national est prévue le samedi quinze du mois.",
      "Merci de fournir une copie de la carte d'identité et de l'acte de naissance lors de l'inscription.",
      "La commission recommande d'augmenter le nombre d'heures consacrées à l'enseignement des langues étrangères.",
      "Les religieuses assurent un service d'accompagnement social auprès des familles de la région.",
      "Pour toute question, veuillez contacter le secrétariat au numéro indiqué ci-dessous.",
      "Le rapport financier montre une nette amélioration des recettes par rapport à l'année dernière.",
      "Les cours commencent à huit heures et se terminent à quatorze heures trente.",
    ],
    titles: ["Facture", "Reçu", "Contrat de location", "Procès-verbal de réunion", "Rapport annuel", "Demande d'inscription", "Lettre aux parents", "Attestation"],
    items: ["Frais d'inscription", "Manuels scolaires", "Transport", "Uniforme", "Activités", "Cantine"],
    names: ["Georges Khoury", "Marie Haddad", "Élie Nassar", "Rana Abdallah", "Sœur Thérèse", "Sami Farah"],
    words: { no: "N°", date: "Date", total: "Total", qty: "Qté", price: "Prix", to: "À", name: "Nom", birth: "Date de naissance", class: "Classe", signature: "Signature", dear: "Madame, Monsieur", section: "Section" },
  },
  en: {
    dir: "ltr",
    fonts: ["Times New Roman", "Calibri", "Arial", "Georgia", "Cambria", "Segoe UI", "Verdana", "Courier New"],
    org: "St. Joseph School",
    sentences: [
      "We are pleased to inform you that the annual parents meeting will take place next Thursday in the main hall.",
      "Please settle the outstanding amount before the end of the month to avoid any late payment penalty.",
      "This invoice includes registration fees, school books and transportation for the first term.",
      "Thank you for your continued cooperation and we wish you and your families good health.",
      "Received from Mr. George Khoury the amount stated above, in cash, on this date.",
      "This agreement shall take effect on the date of signature by both parties for a period of one year.",
      "The supplier undertakes to deliver the ordered materials on time and according to the agreed specifications.",
      "I kindly request approval of the attached leave application for a period of two weeks.",
      "Total operating expenses for this year amounted to approximately forty-five thousand dollars.",
      "A school trip to the national museum is planned for Saturday the fifteenth of the month.",
      "Please bring a copy of your identity card and birth certificate when submitting the registration form.",
      "The committee recommends increasing the hours dedicated to teaching foreign languages.",
      "The sisters provide social support services to families in need across the region.",
      "For any questions, please contact the secretariat at the number listed below.",
      "The financial report shows a clear improvement in revenue compared to last year.",
      "Classes begin at eight in the morning and end at half past two in the afternoon.",
    ],
    titles: ["Invoice", "Receipt", "Lease Agreement", "Meeting Minutes", "Annual Report", "Registration Form", "Letter to Parents", "Certificate"],
    items: ["Registration fee", "School books", "Transportation", "Uniform", "Activity fee", "Lunch program"],
    names: ["George Khoury", "Mary Haddad", "Elie Nassar", "Rana Abdallah", "Sister Theresa", "Sami Farah"],
    words: { no: "No.", date: "Date", total: "Total", qty: "Qty", price: "Price", to: "To", name: "Name", birth: "Date of birth", class: "Class", signature: "Signature", dear: "Dear parents,", section: "Section" },
  },
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const date = () => `${String(int(1, 28)).padStart(2, "0")}/${String(int(1, 12)).padStart(2, "0")}/${int(2019, 2025)}`;

/** A document: HTML body + the exact text a perfect OCR would read, line by line. */
function documentFor(lang: Lang, template: string): { body: string; truth: string[] } {
  const l = L[lang];
  const w = l.words;
  const truth: string[] = [];
  const lines: string[] = [];
  const line = (html: string, text: string) => { lines.push(html); truth.push(text); };
  line(`<div class="org">${esc(l.org)}</div>`, l.org);
  if (template === "invoice") {
    const no = `${int(2019, 2025)}-${String(int(1, 999)).padStart(4, "0")}`;
    line(`<h1>${esc(l.titles[0])} ${w.no} ${no}</h1>`, `${l.titles[0]} ${w.no} ${no}`);
    const d = date();
    line(`<p>${esc(w.date)}: ${d}</p>`, `${w.date}: ${d}`);
    const head = l.items[0].split(" ")[0];
    line(`<table><tr><th>${esc(head)}</th><th>${esc(w.qty)}</th><th>${esc(w.price)}</th></tr>`, `${head} ${w.qty} ${w.price}`);
    let total = 0;
    const rows: string[] = [];
    for (const it of shuffle(l.items).slice(0, int(3, 6))) {
      const q = int(1, 4), p = int(15, 450);
      total += q * p;
      rows.push(`<tr><td>${esc(it)}</td><td>${q}</td><td>${p}.00</td></tr>`);
      truth.push(`${it} ${q} ${p}.00`);
    }
    lines.push(rows.join("") + "</table>");
    line(`<p class="total">${esc(w.total)}: ${total}.00 USD</p>`, `${w.total}: ${total}.00 USD`);
    for (const s of shuffle(l.sentences).slice(0, 2)) line(`<p>${esc(s)}</p>`, s);
  } else if (template === "receipt") {
    line(`<h1>${esc(l.titles[1])}</h1>`, l.titles[1]);
    const d = `${date()} ${String(int(8, 20)).padStart(2, "0")}:${String(int(0, 59)).padStart(2, "0")}`;
    line(`<p>${d}</p>`, d);
    let total = 0;
    for (const it of shuffle(l.items).slice(0, int(2, 5))) {
      const p = int(2, 90);
      total += p;
      line(`<p class="row"><span>${esc(it)}</span><span>${p}.00</span></p>`, `${it} ${p}.00`);
    }
    line(`<p class="total">${esc(w.total)} ${total}.00</p>`, `${w.total} ${total}.00`);
    const s = l.sentences[4];
    line(`<p class="small">${esc(s)}</p>`, s);
  } else if (template === "form") {
    line(`<h1>${esc(l.titles[5])}</h1>`, l.titles[5]);
    const fields: [string, string][] = [[w.name, pick(l.names)], [w.birth, date()], [w.class, String(int(1, 12))], [w.date, date()]];
    for (const [k, v] of fields) line(`<p class="field"><b>${esc(k)}:</b> ${esc(v)}</p>`, `${k}: ${v}`);
    for (const s of shuffle(l.sentences).slice(0, 2)) line(`<p>${esc(s)}</p>`, s);
    const signer = pick(l.names);
    line(`<p class="sig">${esc(w.signature)}: ${esc(signer)}</p>`, `${w.signature}: ${signer}`);
  } else {
    // letter / report
    const title = template === "report" ? l.titles[4] : pick([l.titles[6], l.titles[3], l.titles[2], l.titles[7]]);
    line(`<h1>${esc(title)}</h1>`, title);
    const d = date();
    line(`<p class="right">${esc(w.date)}: ${d}</p>`, `${w.date}: ${d}`);
    if (template === "letter") line(`<p>${esc(w.dear)}</p>`, w.dear);
    const ss = shuffle(l.sentences);
    for (let p = 0; p < int(2, 4); p++) {
      if (template === "report") { const h = `${w.section} ${p + 1}`; line(`<h2>${esc(h)}</h2>`, h); }
      const para = ss.slice(p * 2, p * 2 + int(1, 3));
      line(`<p>${esc(para.join(" "))}</p>`, para.join(" "));
    }
    const n = pick(l.names);
    line(`<p class="sig">${esc(n)}</p>`, n);
  }
  return { body: lines.join("\n"), truth: truth.filter(Boolean) };
}

const NOISE = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='256' height='256'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.55'/></svg>")`;

function pageHtml(lang: Lang, body: string, variant: string, template: string): string {
  const l = L[lang];
  const font = pick(l.fonts);
  const size = template === "receipt" ? int(15, 18) : int(15, 19);
  const receipt = template === "receipt";
  const base = `
    *{box-sizing:border-box} html,body{margin:0;height:100%}
    .page{width:794px;min-height:1123px;padding:${receipt ? "40px 60px" : "70px 80px"};background:#fff;color:#111;font-family:"${font}";font-size:${size}px;line-height:1.55;direction:${l.dir}}
    ${receipt ? `.page{width:420px;margin:40px auto;font-family:"${lang === "ar" ? "Tahoma" : "Courier New"}";font-size:16px} .row{display:flex;justify-content:space-between}` : ""}
    .org{font-weight:bold;font-size:1.1em;color:#223}
    h1{font-size:1.6em;margin:.6em 0} h2{font-size:1.2em;margin:.8em 0 .2em}
    .right{text-align:end} .total{font-weight:bold} .small{font-size:.85em} .sig{margin-top:2.5em}
    table{border-collapse:collapse;width:100%;margin:1em 0} td,th{border:1px solid #999;padding:6px 10px;text-align:start}`;
  const variants: Record<string, string> = {
    clean: "",
    scan: `body{background:#ece8dc} .page{background:#f4f1e6;filter:grayscale(1) contrast(1.12) blur(${(0.25 + rnd() * 0.35).toFixed(2)}px);transform:rotate(${(rnd() * 2.4 - 1.2).toFixed(2)}deg);position:relative}
      .page::after{content:"";position:absolute;inset:0;background:${NOISE};mix-blend-mode:multiply;opacity:.55;pointer-events:none}`,
    photo: `body{background:linear-gradient(135deg,#5a3d2b,#3b281c);display:flex;align-items:center;justify-content:center;overflow:hidden}
      .page{transform:perspective(1600px) rotateX(${int(3, 9)}deg) rotateY(${int(-6, 6)}deg) rotate(${(rnd() * 4 - 2).toFixed(1)}deg) scale(.86);
        box-shadow:0 30px 60px rgba(0,0,0,.55);filter:blur(${(0.4 + rnd() * 0.5).toFixed(2)}px) brightness(.97);position:relative}
      .page::after{content:"";position:absolute;inset:0;background:radial-gradient(ellipse at ${int(20, 80)}% ${int(10, 50)}%,rgba(255,255,255,0) 30%,rgba(0,0,0,.28) 100%);pointer-events:none}`,
  };
  return `<!doctype html><html lang="${lang}" dir="${l.dir}"><meta charset="utf-8"><style>${base}${variants[variant]}</style><body><div class="page">${body}</div></body></html>`;
}

function screenshotHtml(lang: Lang): { html: string; truth: string[] } {
  const l = L[lang];
  const msgs = shuffle(l.sentences).slice(0, int(3, 5));
  const truth: string[] = [pick(l.names)];
  const bubbles = msgs.map((m, i) => { truth.push(m); const t = `${int(8, 22)}:${String(int(0, 59)).padStart(2, "0")}`; truth.push(t); return `<div class="b ${i % 2 ? "me" : ""}">${esc(m)}<span>${t}</span></div>`; }).join("");
  return {
    truth,
    html: `<!doctype html><html dir="${l.dir}"><meta charset="utf-8"><style>
      body{margin:0;font-family:"Segoe UI",Tahoma,sans-serif;background:#e5ddd5;font-size:15px;direction:${l.dir}}
      .top{background:#075e54;color:#fff;padding:14px 16px;font-weight:600;font-size:17px}
      .b{background:#fff;margin:10px 12px;padding:8px 10px;border-radius:8px;max-width:78%;box-shadow:0 1px 1px rgba(0,0,0,.15)}
      .b.me{background:#dcf8c6;margin-inline-start:auto} .b span{display:block;text-align:end;color:#777;font-size:11px;margin-top:3px}
    </style><body><div class="top">${esc(truth[0])}</div>${bubbles}</body></html>`,
  };
}

function noTextHtml(): string {
  const shapes = Array.from({ length: int(6, 14) }, () =>
    `<div style="position:absolute;left:${int(0, 90)}%;top:${int(0, 90)}%;width:${int(40, 260)}px;height:${int(40, 260)}px;border-radius:${int(0, 50)}%;background:hsl(${int(0, 360)} ${int(30, 80)}% ${int(35, 75)}%);opacity:.8;filter:blur(${int(0, 6)}px)"></div>`).join("");
  return `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;background:linear-gradient(${int(0, 360)}deg,hsl(${int(0, 360)} 50% 70%),hsl(${int(0, 360)} 40% 30%));position:relative;overflow:hidden">${shapes}</body>`;
}

// --- Edge rendering, a few at a time, each with its own throwaway profile ---
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-edge-"));
let profileN = 0;
function edge(args: string[]): Promise<void> {
  const profile = path.join(tmpRoot, `p${profileN++ % 8}`);
  return new Promise((resolve, reject) => {
    const p = spawn(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", `--user-data-dir=${profile}`, ...args], { windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => p.kill(), 60_000);
    p.on("exit", () => { clearTimeout(timer); resolve(); });
    p.on("error", reject);
  });
}
const tasks: (() => Promise<void>)[] = [];
async function runAll(concurrency: number) {
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < tasks.length) { const t = tasks[i++]; await t(); if (++done % 25 === 0) process.stdout.write(`  rendered ${done}/${tasks.length}\n`); }
  }));
}

fs.rmSync(out, { recursive: true, force: true });
const htmlDir = path.join(out, "_html");
fs.mkdirSync(htmlDir, { recursive: true });
const truthMap: Record<string, { lang: Lang; variant: string; template: string; text: string }> = {};
const fileUrl = (p: string) => "file:///" + p.replaceAll("\\", "/");
const shot = (html: string, png: string, w: number, h: number, dpr: number) =>
  tasks.push(() => edge([`--force-device-scale-factor=${dpr}`, `--window-size=${w},${h}`, `--screenshot=${png}`, fileUrl(html)]));
const pdf = (html: string, pdfPath: string) =>
  tasks.push(() => edge(["--no-pdf-header-footer", `--print-to-pdf=${pdfPath}`, fileUrl(html)]));

const TEMPLATES = ["letter", "invoice", "receipt", "form", "report"];
let n = 0;
for (const lang of ["ar", "fr", "en"] as Lang[]) {
  for (const template of TEMPLATES) {
    for (let k = 0; k < PER; k++) {
      const id = `${lang}-${template}-${k}`;
      const doc = documentFor(lang, template);
      for (const variant of ["clean", "scan", "photo"]) {
        const html = path.join(htmlDir, `${id}-${variant}.html`);
        fs.writeFileSync(html, pageHtml(lang, doc.body, variant, template));
        const rel = `${variant}/${id}.png`;
        fs.mkdirSync(path.join(out, variant), { recursive: true });
        shot(html, path.join(out, rel), variant === "photo" ? 900 : 794, variant === "photo" ? 1200 : 1123, variant === "clean" ? 2 : 1.6);
        truthMap[rel] = { lang, variant, template, text: doc.truth.join("\n") };
      }
      // A quarter of the documents also as PDFs: one with a text layer, one image-only.
      if (k % 4 === 0) {
        fs.mkdirSync(path.join(out, "pdf-text"), { recursive: true });
        fs.mkdirSync(path.join(out, "pdf-scan"), { recursive: true });
        const tRel = `pdf-text/${id}.pdf`;
        pdf(path.join(htmlDir, `${id}-clean.html`), path.join(out, tRel));
        truthMap[tRel] = { lang, variant: "pdf-text", template, text: doc.truth.join("\n") };
        const sHtml = path.join(htmlDir, `${id}-scanpdf.html`);
        fs.writeFileSync(sHtml, `<!doctype html><style>@page{size:A4;margin:0}body{margin:0}img{width:210mm;height:297mm;display:block}</style><img src="${fileUrl(path.join(out, `scan/${id}.png`))}">`);
        truthMap[`pdf-scan/${id}.pdf`] = { lang, variant: "pdf-scan", template, text: doc.truth.join("\n") };
      }
      n++;
    }
  }
  for (let k = 0; k < PER; k++) {
    const s = screenshotHtml(lang);
    const html = path.join(htmlDir, `${lang}-chat-${k}.html`);
    fs.writeFileSync(html, s.html);
    const rel = `screenshot/${lang}-chat-${k}.png`;
    fs.mkdirSync(path.join(out, "screenshot"), { recursive: true });
    // Headless Edge will not lay out narrower than ~500 CSS px, so a phone is 540 px at 2x = 1080 px wide.
    shot(html, path.join(out, rel), 540, 1170, 2);
    truthMap[rel] = { lang, variant: "screenshot", template: "chat", text: s.truth.join("\n") };
  }
}
for (let k = 0; k < PER * 3; k++) {
  const html = path.join(htmlDir, `notext-${k}.html`);
  fs.writeFileSync(html, noTextHtml());
  const rel = `notext/picture-${k}.png`;
  fs.mkdirSync(path.join(out, "notext"), { recursive: true });
  shot(html, path.join(out, rel), 1024, 768, 1);
  truthMap[rel] = { lang: "en", variant: "notext", template: "picture", text: "" };
}

const t0 = performance.now();
console.log(`rendering ${tasks.length} pages with Edge...`);
await runAll(6);
// Image-only PDFs need their scan images to exist first.
tasks.length = 0;
for (const rel of Object.keys(truthMap).filter((r) => r.startsWith("pdf-scan/"))) {
  const id = path.basename(rel, ".pdf");
  pdf(path.join(htmlDir, `${id}-scanpdf.html`), path.join(out, rel));
}
await runAll(6);
fs.writeFileSync(path.join(out, "truth.json"), JSON.stringify(truthMap, null, 1));
fs.rmSync(tmpRoot, { recursive: true, force: true });
const missing = Object.keys(truthMap).filter((r) => !fs.existsSync(path.join(out, r)));
console.log(JSON.stringify({ out, documents: n, files: Object.keys(truthMap).length, missing: missing.length, seconds: Math.round((performance.now() - t0) / 1000) }));
