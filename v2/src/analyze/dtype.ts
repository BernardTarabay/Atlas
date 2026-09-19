// Document type from content keywords, in English, Arabic and French.
// Computed once per unique content (at analysis time), then used by the rules.
// Deterministic and explainable: the matched keywords are returned.
import { normalize } from "../search/text.ts";

export type DocType =
  | "invoice" | "receipt" | "contract" | "statement" | "payslip" | "letter" | "cv" | "certificate"
  | "report" | "minutes" | "medical" | "tax" | "identity" | "registration" | "quote" | "order" | "insurance";

const RAW: Record<DocType, string[]> = {
  invoice: ["invoice", "tax invoice", "invoice number", "facture", "numero de facture", "montant ttc", "total ttc", "bill to", "فاتورة", "فاتورة ضريبية", "رقم الفاتورة"],
  receipt: ["receipt", "payment received", "recu", "reçu de paiement", "ticket de caisse", "إيصال", "ايصال استلام", "وصل استلام"],
  contract: ["contract", "agreement", "the parties", "hereinafter", "contrat", "convention", "les parties", "ci-apres", "عقد", "اتفاقية", "الطرف الأول", "الطرف الثاني"],
  statement: ["bank statement", "account statement", "opening balance", "closing balance", "releve de compte", "releve bancaire", "solde", "كشف حساب", "الرصيد"],
  payslip: ["payslip", "pay slip", "salary slip", "net pay", "bulletin de paie", "fiche de paie", "bulletin de salaire", "salaire net", "قسيمة الراتب", "كشف راتب", "صافي الراتب"],
  letter: ["letter", "lettre", "courrier", "رسالة", "dear sir", "dear madam", "yours sincerely", "yours faithfully", "madame monsieur", "veuillez agreer", "je vous prie", "cordialement", "المحترم", "تحية طيبة", "وبعد"],
  cv: ["curriculum vitae", "resume", "work experience", "professional experience", "experience professionnelle", "formation", "السيرة الذاتية", "الخبرات", "المؤهلات"],
  certificate: ["certificate", "certify that", "certificat", "attestation", "certifie que", "atteste que", "شهادة", "نشهد بأن", "يشهد"],
  report: ["report", "executive summary", "findings", "rapport", "synthese", "تقرير", "ملخص تنفيذي"],
  minutes: ["minutes of the meeting", "meeting minutes", "proces verbal", "compte rendu de reunion", "ordre du jour", "محضر", "محضر اجتماع", "جدول الأعمال"],
  medical: ["prescription", "diagnosis", "patient", "ordonnance", "diagnostic", "analyses medicales", "وصفة طبية", "تشخيص", "المريض"],
  tax: ["tax return", "income tax", "declaration d’impot", "avis d’imposition", "impot sur le revenu", "ضريبة الدخل", "الإقرار الضريبي"],
  // NOT "date of birth": it appears on registration forms, CVs and medical papers far more
  // often than on identity papers (it put 163 school forms under Identity documents).
  identity: ["passport", "identity card", "id card number", "passeport", "carte d’identite", "piece d’identite", "جواز سفر", "بطاقة الهوية", "رقم الهوية"],
  registration: ["registration form", "enrolment form", "demande d’inscription", "fiche d’inscription", "formulaire d’inscription", "طلب تسجيل", "استمارة تسجيل"],
  quote: ["quotation", "price quote", "devis", "offre de prix", "عرض سعر", "عرض أسعار"],
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
