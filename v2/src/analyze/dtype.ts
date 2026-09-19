// Document type from content keywords, in English, Arabic and French.
// Computed once per unique content (at analysis time), then used by the rules.
// Deterministic and explainable: the matched keywords are returned.
import { normalize } from "../search/text.ts";

export type DocType =
  | "invoice" | "receipt" | "contract" | "statement" | "payslip" | "letter" | "cv" | "certificate"
  | "report" | "minutes" | "medical" | "tax" | "identity" | "quote" | "order" | "insurance";

const RAW: Record<DocType, string[]> = {
  invoice: ["invoice", "tax invoice", "invoice number", "facture", "numero de facture", "montant ttc", "total ttc", "bill to", "فاتورة", "فاتورة ضريبية", "رقم الفاتورة"],
  receipt: ["receipt", "payment received", "recu", "reçu de paiement", "ticket de caisse", "إيصال", "ايصال استلام", "وصل استلام"],
  contract: ["contract", "agreement", "the parties", "hereinafter", "contrat", "convention", "les parties", "ci-apres", "عقد", "اتفاقية", "الطرف الأول", "الطرف الثاني"],
  statement: ["bank statement", "account statement", "opening balance", "closing balance", "releve de compte", "releve bancaire", "solde", "كشف حساب", "الرصيد"],
  payslip: ["payslip", "pay slip", "salary slip", "net pay", "bulletin de paie", "fiche de paie", "bulletin de salaire", "salaire net", "قسيمة الراتب", "كشف راتب", "صافي الراتب"],
  letter: ["dear sir", "dear madam", "yours sincerely", "yours faithfully", "madame monsieur", "veuillez agreer", "je vous prie", "cordialement", "المحترم", "تحية طيبة", "وبعد"],
  cv: ["curriculum vitae", "resume", "work experience", "professional experience", "experience professionnelle", "formation", "السيرة الذاتية", "الخبرات", "المؤهلات"],
  certificate: ["certificate", "certify that", "certificat", "attestation", "certifie que", "atteste que", "شهادة", "نشهد بأن", "يشهد"],
  report: ["report", "executive summary", "findings", "rapport", "synthese", "تقرير", "ملخص تنفيذي"],
  minutes: ["minutes of the meeting", "meeting minutes", "proces verbal", "compte rendu de reunion", "ordre du jour", "محضر", "محضر اجتماع", "جدول الأعمال"],
  medical: ["prescription", "diagnosis", "patient", "ordonnance", "diagnostic", "analyses medicales", "وصفة طبية", "تشخيص", "المريض"],
  tax: ["tax return", "income tax", "declaration d impot", "avis d imposition", "impot sur le revenu", "ضريبة الدخل", "الإقرار الضريبي"],
  identity: ["passport", "identity card", "date of birth", "passeport", "carte d identite", "date de naissance", "جواز سفر", "بطاقة الهوية", "تاريخ الولادة", "تاريخ الميلاد"],
  quote: ["quotation", "price quote", "devis", "offre de prix", "عرض سعر", "عرض أسعار"],
  order: ["purchase order", "order number", "bon de commande", "numero de commande", "أمر شراء", "طلبية"],
  insurance: ["insurance policy", "policy number", "insured", "police d assurance", "assure", "وثيقة تأمين", "تأمين"],
};

const DICT: { type: DocType; kw: string; weight: number }[] = [];
for (const [type, words] of Object.entries(RAW) as [DocType, string[]][]) {
  for (const w of words) {
    const kw = normalize(w);
    if (kw) DICT.push({ type, kw, weight: kw.includes(" ") ? 2 : 1 });
  }
}

/**
 * The best document type for this text, or null. `head` (title + first lines)
 * counts triple: a document announces what it is at the top.
 */
export function detectDocType(head: string, body: string): { type: DocType; score: number; matched: string[] } | null {
  const h = ` ${normalize(head)} `;
  const b = ` ${normalize(body.length > 8000 ? body.slice(0, 8000) : body)} `;
  const scores = new Map<DocType, { score: number; matched: string[] }>();
  for (const { type, kw, weight } of DICT) {
    const needle = ` ${kw} `;
    const inHead = h.includes(needle);
    const inBody = !inHead && b.includes(needle);
    if (!inHead && !inBody) continue;
    const s = scores.get(type) ?? { score: 0, matched: [] };
    s.score += weight * (inHead ? 3 : 1);
    s.matched.push(kw);
    scores.set(type, s);
  }
  let best: { type: DocType; score: number; matched: string[] } | null = null;
  for (const [type, s] of scores) if (!best || s.score > best.score) best = { type, ...s };
  return best && best.score >= 3 ? best : null;
}

export const DOC_TYPE_LABEL: Record<DocType, string> = {
  invoice: "Invoices", receipt: "Receipts", contract: "Contracts", statement: "Bank statements", payslip: "Payslips",
  letter: "Letters", cv: "CVs", certificate: "Certificates", report: "Reports", minutes: "Minutes", medical: "Medical",
  tax: "Tax", identity: "Identity documents", quote: "Quotes", order: "Orders", insurance: "Insurance",
};
