// Windows OCR returns each Arabic line in VISUAL order (words left to right as they
// appear on the page), not logical reading order. "مدرسة مار يوسف" comes back as
// "يوسف مار مدرسة". Search tokens don't care about order, but snippets, names,
// document-type phrases and any display of the text do.
//
// For a line whose base direction is right-to-left: reverse the word order, then
// restore the order inside each run of left-to-right words (numbers, Latin), which
// were already in reading order within the run.
const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
const LTR_WORD = /[A-Za-z0-9À-ɏ]/;

export function visualToLogicalLine(line: string): string {
  const words = line.split(/\s+/).filter(Boolean);
  // Base direction by LETTERS, not words: "USD 5364.00 المجموع:" is an Arabic line
  // with a Latin currency code and a number in it. Digits are direction-neutral here.
  const arabicLetters = line.match(/[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g)?.length ?? 0;
  const latinLetters = line.match(/[A-Za-zÀ-ɏ]/g)?.length ?? 0;
  if (arabicLetters === 0 || arabicLetters <= latinLetters) return words.join(" ");
  const reversed = words.reverse();
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => { out.push(...run.reverse()); run = []; };
  for (const w of reversed) {
    if (!ARABIC.test(w) && LTR_WORD.test(w)) run.push(w);
    else { flush(); out.push(w); }
  }
  flush();
  // Inside Arabic text "2020-0762" displays as "0762-2020": the hyphen splits Arabic-number runs.
  return out.map((w) => (/^\d+(-\d+)+$/.test(w) ? w.split("-").reverse().join("-") : w)).join(" ");
}

export const visualToLogical = (text: string) => text.split("\n").map(visualToLogicalLine).join("\n");
