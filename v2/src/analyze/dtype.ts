// Document type from content keywords, in English, Arabic and French.
// Computed once per unique content (at analysis time), then used by the rules.
// Deterministic and explainable: the matched keywords are returned.
import { normalize } from "../search/text.ts";

export type DocType =
  | "invoice" | "receipt" | "contract" | "statement" | "payslip" | "letter" | "cv" | "certificate"
  | "report" | "minutes" | "medical" | "tax" | "identity" | "registration" | "quote" | "order" | "insurance";

const RAW: Record<DocType, string[]> = {
  // Real billing paperwork rarely says "invoice" (measured on RVL-CDIP): it says
  // what is owed and how to pay it.
  invoice: ["invoice", "tax invoice", "invoice number", "invoice no", "amount due", "balance due", "total due", "please remit",
    "remit to", "payment due", "payment voucher", "facture", "numero de facture", "montant ttc", "total ttc", "net à payer",
    "date d’échéance", "bill to", "فاتورة", "فاتورة ضريبية", "رقم الفاتورة", "المبلغ المستحق", "تاريخ الاستحقاق"],
  receipt: ["receipt", "payment received", "recu", "reçu de paiement", "ticket de caisse", "إيصال", "ايصال استلام", "وصل استلام"],
  contract: ["contract", "agreement", "the parties", "hereinafter", "contrat", "convention", "les parties", "ci-apres", "عقد", "اتفاقية", "الطرف الأول", "الطرف الثاني"],
  statement: ["bank statement", "account statement", "statement of account", "opening balance", "closing balance", "previous balance",
    "releve de compte", "releve bancaire", "solde", "كشف حساب", "الرصيد"],
  payslip: ["payslip", "pay slip", "salary slip", "net pay", "bulletin de paie", "fiche de paie", "bulletin de salaire", "salaire net", "قسيمة الراتب", "كشف راتب", "صافي الراتب"],
  letter: ["letter", "lettre", "courrier", "رسالة", "dear sir", "dear madam", "yours sincerely", "yours faithfully", "madame monsieur", "veuillez agreer", "je vous prie", "cordialement", "المحترم", "تحية طيبة", "وبعد"],
  // "Biographical sketch" is the academic CV (NIH and most grant bodies): it named 60
  // of the 133 real resumes the first version missed.
  cv: ["curriculum vitae", "resume", "biographical sketch", "work experience", "professional experience", "employment history",
    "education and training", "experience professionnelle", "formation", "السيرة الذاتية", "الخبرات", "المؤهلات"],
  certificate: ["certificate", "certify that", "certificat", "attestation", "certifie que", "atteste que", "شهادة", "نشهد بأن", "يشهد"],
  report: ["report", "executive summary", "findings", "rapport", "synthese", "تقرير", "ملخص تنفيذي"],
  minutes: ["minutes of the meeting", "meeting minutes", "proces verbal", "compte rendu de reunion", "ordre du jour", "محضر", "محضر اجتماع", "جدول الأعمال"],
  medical: ["prescription", "diagnosis", "patient", "ordonnance", "diagnostic", "analyses medicales", "وصفة طبية", "تشخيص", "المريض"],
  tax: ["tax return", "income tax", "declaration d’impot", "avis d’imposition", "impot sur le revenu", "ضريبة الدخل", "الإقرار الضريبي"],
  // NOT "date of birth": it appears on registration forms, CVs and medical papers far more
  // often than on identity papers (it put 163 school forms under Identity documents).
  identity: ["passport", "identity card", "id card number", "passeport", "carte d’identite", "piece d’identite", "جواز سفر", "بطاقة الهوية", "رقم الهوية"],
  registration: ["registration form", "enrolment form", "demande d’inscription", "fiche d’inscription", "formulaire d’inscription", "طلب تسجيل", "استمارة تسجيل"],
  quote: ["quotation", "price quote", "cost estimate", "price estimate", "production estimate", "estimate number", "devis",
    "offre de prix", "عرض سعر", "عرض أسعار"],
  order: ["purchase order", "order number", "bon de commande", "numero de commande", "أمر شراء", "طلبية"],
  insurance: ["insurance policy", "policy number", "insured", "police d’assurance", "assure", "وثيقة تأمين", "تأمين"],
};

export const DICT: { type: DocType; kw: string; weight: number }[] = [];
for (const [type, words] of Object.entries(RAW) as [DocType, string[]][]) {
  for (const w of words) {
    const kw = normalize(w);
    if (kw) DICT.push({ type, kw, weight: kw.includes(" ") ? 2 : 1 });
  }
}

/**
 * What a document announces about itself: its first few non-empty lines.
 * A scan often just says "RECEIPT" - one word, which `headingFrom` rejects.
 */
export function openingLines(text: string, n = 3, cap = 160): string {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line) continue;
    out.push(line.length > cap ? line.slice(0, cap) : line);
    if (out.length >= n) break;
  }
  return out.join("\n");
}

/**
 * Types recognised by their SHAPE rather than their words.
 *
 * Measured on RVL-CDIP (3,200 real scanned business documents): only 12% of real
 * letters were typed, because a letter is not identified by vocabulary - "Dear
 * Fred:" and "Very truly yours" are - and the dictionary only knew "dear sir".
 * These signals are lines, matched whole, on the text as read (not normalized),
 * so a salutation at the start of a line counts and "oh dear" mid-sentence does not.
 */
const LINE_SIGNALS: { type: DocType; re: RegExp; score: number; label: string }[] = [
  // Salutations: a line that opens a letter.
  { type: "letter", score: 4, label: "salutation", re: /^\s*(dear|to whom it may concern)\b[^\n]{0,60}$/im },
  { type: "letter", score: 4, label: "salutation", re: /^\s*(cher|chère|chers|chères|madame|monsieur|messieurs|mesdames)\b[^\n]{0,50}[,:]\s*$/im },
  { type: "letter", score: 4, label: "salutation", re: /^\s*(حضرة|عزيزي|عزيزتي|السيد|السيدة|الأستاذ)\s[^\n]{0,60}(المحترم|المحترمة)?\s*$/m },
  // Closings: a line that signs one off.
  { type: "letter", score: 3, label: "closing", re: /^\s*(sincerely|yours (sincerely|truly|faithfully|very truly)|very truly yours|respectfully( yours| submitted)?|(best|kind|warm) regards|cordially)\b[^\n]{0,20}$/im },
  { type: "letter", score: 3, label: "closing", re: /(veuillez agr[ée]er|je vous prie d.agr[ée]er|salutations distingu[ée]es|bien (à vous|cordialement))/i },
  { type: "letter", score: 3, label: "closing", re: /(وتفضلوا بقبول|مع فائق الاحترام|مع خالص التحيات|وتقبلوا فائق الاحترام)/ },
];

/**
 * Documents made of named sections. Two or more of a type's section headings, each
 * standing alone on its line, is a strong sign: that is what a CV or a research
 * report looks like, whatever words it uses in between.
 */
const SECTIONS: { type: DocType; heads: string[] }[] = [
  {
    type: "cv",
    heads: ["education", "education and training", "experience", "work experience", "professional experience", "employment",
      "employment history", "publications", "skills", "qualifications", "certifications", "honors", "awards",
      "formation", "expérience", "expérience professionnelle", "compétences", "diplômes",
      "التعليم", "الخبرات", "الخبرة العملية", "المهارات", "المؤهلات"],
  },
  {
    type: "report",
    heads: ["abstract", "introduction", "methods", "materials and methods", "methodology", "results", "discussion",
      "conclusion", "conclusions", "findings", "recommendations",
      "résumé", "méthodes", "résultats", "conclusions et recommandations",
      "الملخص", "المقدمة", "المنهجية", "النتائج", "الخلاصة", "التوصيات"],
  },
];
const SECTION_SCORE = 4;

function sectionHits(text: string): Map<DocType, string[]> {
  const found = new Map<DocType, Set<string>>();
  for (const raw of text.split(/\r?\n/)) {
    // "3. RESULTS:", "II. Education" -> "results", "education"
    const line = raw.trim().replace(/^([0-9ivx]+[.)]|[-•*])\s*/i, "").replace(/[:.]\s*$/, "").toLowerCase();
    if (!line || line.length > 40) continue;
    for (const s of SECTIONS) {
      if (s.heads.includes(line)) {
        const set = found.get(s.type) ?? new Set<string>();
        set.add(line);
        found.set(s.type, set);
      }
    }
  }
  const out = new Map<DocType, string[]>();
  for (const [type, set] of found) if (set.size >= 2) out.set(type, [...set]);
  return out;
}

/**
 * The best document type for this text, or null.
 *
 * Three zones, because where a keyword appears says how much it means:
 * `name` is what the document calls itself (its title, heading or filename),
 * `head` is its opening lines, `body` is the rest. A title outweighs a phrase
 * mentioned in passing further down ("bring a copy of your identity card"),
 * which is otherwise how an Annual Report becomes an identity document.
 */
export function detectDocType(name: string, head: string, body: string): { type: DocType; score: number; matched: string[] } | null {
  const zones = [
    { text: ` ${normalize(name)} `, weight: 6 },
    { text: ` ${normalize(head)} `, weight: 3 },
    { text: ` ${normalize(body.length > 8000 ? body.slice(0, 8000) : body)} `, weight: 1 },
  ];
  const scores = new Map<DocType, { score: number; matched: string[]; at: number }>();
  for (const { type, kw, weight } of DICT) {
    const needle = ` ${kw} `;
    let best = 0;
    let at = Infinity;
    for (const [i, z] of zones.entries()) {
      const pos = z.text.indexOf(needle);
      if (pos < 0) continue;
      if (z.weight > best) best = z.weight;
      at = Math.min(at, i * 100_000 + pos); // earliest zone, then earliest position
    }
    if (!best) continue;
    const s = scores.get(type) ?? { score: 0, matched: [], at: Infinity };
    s.score += weight * best;
    s.matched.push(kw);
    s.at = Math.min(s.at, at);
    scores.set(type, s);
  }
  // Shape: salutations, closings and section headings, on the text as it reads.
  const all = `${name}\n${head}\n${body.length > 8000 ? body.slice(0, 8000) : body}`;
  const add = (type: DocType, score: number, label: string) => {
    const s = scores.get(type) ?? { score: 0, matched: [], at: Infinity };
    s.score += score;
    s.matched.push(label);
    scores.set(type, s);
  };
  const seen = new Set<string>();
  for (const sig of LINE_SIGNALS) {
    const key = `${sig.type}:${sig.label}`;
    if (seen.has(key) || !sig.re.test(all)) continue;   // a salutation counts once, in whichever language
    seen.add(key);
    add(sig.type, sig.score, sig.label);
  }
  for (const [type, heads] of sectionHits(all)) add(type, SECTION_SCORE, `sections: ${heads.join(", ")}`);
  // Equal scores are broken by position: a document announces what it is at the
  // top. Then by name, so the outcome never depends on dictionary order.
  let best: { type: DocType; score: number; matched: string[]; at: number } | null = null;
  for (const [type, s] of scores) {
    if (!best || s.score > best.score || (s.score === best.score && (s.at < best.at || (s.at === best.at && type < best.type)))) {
      best = { type, ...s };
    }
  }
  return best && best.score >= 3 ? { type: best.type, score: best.score, matched: best.matched } : null;
}

export const DOC_TYPE_LABEL: Record<DocType, string> = {
  invoice: "Invoices", receipt: "Receipts", contract: "Contracts", statement: "Bank statements", payslip: "Payslips",
  letter: "Letters", cv: "CVs", certificate: "Certificates", report: "Reports", minutes: "Minutes", medical: "Medical",
  tax: "Tax", identity: "Identity documents", registration: "Registration forms", quote: "Quotes", order: "Orders",
  insurance: "Insurance",
};
