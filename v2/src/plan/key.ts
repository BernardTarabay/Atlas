// A planned path as the disk compares it. Windows ignores case in names, so
// "Documents/Report.pdf" and "documents/REPORT.pdf" are ONE place: two files
// planned there could never both be applied. Upper case in Unicode (not SQLite's
// ASCII-only upper()), after NFC, so "Été" and "ÉTÉ" meet too. It can over-match
// (JavaScript turns "ß" into "SS"; NTFS does not): that only numbers a name that
// did not strictly need it - never the other way round.
export const planKey = (plan: string) => plan.normalize("NFC").toUpperCase();
