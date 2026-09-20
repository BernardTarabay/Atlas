// What the assistant is allowed to propose, and what it is told about Atlas.
//
// TWO CLASSES OF ACTION, AND THE LINE BETWEEN THEM
//
//   look   navigate, search, find, select, view, sort, group, photos, open
//          These change what is ON SCREEN and nothing else, so the browser runs
//          them the moment they come back. Making someone click Apply to
//          receive an answer they just asked for is friction pretending to be
//          safety.
//
//   plan   move, rename
//          These change where a file WOULD go. Still nothing on disk - but it
//          is the user's library, so each one is rendered as a card and waits
//          for a click. Both are undoable afterwards.
//
// Deleting, copying and anything else that would touch the filesystem is not in
// the vocabulary at all. The model cannot propose what it cannot name.
import { ask } from "./gemini.ts";

export const ACTIONS = [
  "navigate", "search", "find", "select", "view", "sort", "group", "reset", "photos", "open", "move", "rename",
] as const;

export const READ_ONLY = new Set(["navigate", "search", "find", "select", "view", "sort", "group", "reset", "photos", "open"]);

const SCHEMA = {
  type: "object",
  properties: {
    reply: {
      type: "string",
      description: "Your answer, in plain language and in the SAME language the user wrote in. Say what you are doing or proposing, briefly. If you are missing something you need (which file, which folder), ask for it instead of guessing.",
    },
    actions: {
      type: "array",
      description: "Zero or more actions. Looking actions run immediately; move and rename are shown to the user as a card and wait for a click. Propose several at once for a bulk request.",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ACTIONS },
          summary: { type: "string", description: "One short sentence saying exactly what this does, in the user's language, e.g. 'Move 12 invoices to Documents/Invoices/2024'. File and folder names stay in their own script." },
          path: { type: ["string", "null"], description: "For navigate: a library folder, '/'-separated, e.g. 'Documents/Invoices/2026'. Empty string means the top of the library. For move: the destination folder." },
          query: { type: ["string", "null"], description: "For search: what to look for, in the user's own words. Searches names and the text inside documents, in English, Arabic and French." },
          scope: { type: ["string", "null"], description: "For search: the folder to search inside. Omit to search the whole library." },
          criteria: {
            type: ["object", "null"],
            description: "For find and select: WHICH files, by property rather than by words. Fields combine as AND. Omit fields you do not need.",
            properties: {
              ext: { type: ["string", "null"], description: "Extensions without dots, comma-separated: 'pdf' or 'pdf,docx'." },
              kind: { type: ["string", "null"], description: "One of image, video, audio, pdf, doc, sheet, slides, text, archive." },
              dtype: { type: ["string", "null"], description: "Document type: invoice, receipt, contract, statement, payslip, letter, cv, certificate, report, minutes, medical, tax, identity, registration, quote, order, insurance." },
              lang: { type: ["string", "null"], description: "Language of the text: en, ar or fr." },
              folder: { type: ["string", "null"], description: "Only inside this library folder, including everything under it." },
              nameContains: { type: ["string", "null"], description: "Substring of the name or its folder path." },
              after: { type: ["string", "null"], description: "Earliest date, YYYY-MM-DD, inclusive. This is the document's own date when it has one, the file's date otherwise." },
              before: { type: ["string", "null"], description: "Latest date, YYYY-MM-DD, inclusive." },
              minSize: { type: ["number", "null"], description: "Smallest size in bytes." },
              maxSize: { type: ["number", "null"], description: "Largest size in bytes." },
            },
          },
          ids: { type: ["array", "null"], items: { type: "number" }, description: "For select, move, rename and open: file ids, taken from what you were shown. Never invent one.", },
          mode: { type: ["string", "null"], description: "For view: xl, large, medium, small, list, details, tiles or content." },
          by: { type: ["string", "null"], description: "For sort: name, mtime, ctime, ddate, type, size, dtype, title, lang or relevance. For group: none, name, type, size, mtime, ctime, dtype or lang." },
          dir: { type: ["string", "null"], description: "For sort: asc or desc." },
          status: { type: ["string", "null"], description: "For photos: all, read, pending, failed." },
          name: { type: ["string", "null"], description: "For rename: the new name INCLUDING the extension, never containing a slash. Keep the extension unless asked otherwise." },
        },
        required: ["type", "summary"],
      },
    },
  },
  required: ["reply", "actions"],
};

const SYSTEM = `You are the assistant inside Atlas, a local file organizer. You do by conversation what
the toolbar does by clicking: go somewhere, find things, arrange what is shown, select
files, move them, rename them.

WHAT ATLAS IS, AND THE ONE THING THAT MATTERS MOST

Atlas has read the user's folders and built a PLAN: for each file, where it would go and
what it would be called, decided by filing rules. The library the user browses IS that
plan. Nothing has been moved, renamed or deleted on disk, and nothing will be until an
apply step exists that is not built yet.

So "move" and "rename" here change the PLAN. They are real and they persist and they are
what the user wants when they say move or rename - but say it plainly if it matters:
their files on disk are untouched. Never claim you deleted, copied or archived anything.
If asked to delete a file, explain that Atlas has never deleted a file and that this is
deliberate while it is in development; offer to move it somewhere instead.

WHAT YOU ARE TOLD

Each message tells you where the user is (a folder, search results or the photos page),
how it is arranged, what they have selected, and a sample of what is on screen with the
file ids. Use it: "this file" means the selected one, or the one under discussion. If the
reference is genuinely ambiguous, ask - do not guess between two files.

Only use ids you have actually been shown. If the user asks about files you cannot see
from here, use find (by property) or search (by words) to get them on screen first, in
the same answer - you may propose several actions at once.

CHOOSING BETWEEN find AND search

find is for properties: every PDF, everything over 10 MB, anything filed after March,
the Arabic invoices. search is for words and meaning: what the document says or is
called. When the user describes files by a property, use find; it is exact and it is
free. Use search when they describe content.

FOLDERS

Library folders are made by the filing rules, so there is no "create folder" action: a
folder exists because something is planned into it. Moving files to a folder that does
not exist yet creates it by putting them there. Use the folder paths you have been shown
where you can, and keep the user's own words for new ones.

STYLE

Answer in the user's language, including Arabic and French. Be brief - one or two
sentences. Do not narrate what you are about to do when the action's summary already
says it. Never invent a file, a folder, a count or a date: if you do not know, say so or
propose a find that would answer it.`;

export interface Action {
  type: string;
  summary: string;
  [k: string]: unknown;
}

export interface Answer { reply: string; actions: Action[] }

/** One call, one answer. History is capped: a chat is not a memory system. */
export async function chat(message: string, history: { role: string; text: string }[], context: unknown): Promise<Answer> {
  const recent = history.slice(-8);
  const conversation = recent.length
    ? recent.map((h) => `${h.role === "assistant" ? "Assistant" : "User"}: ${String(h.text).slice(0, 2000)}`).join("\n")
    : "(this is the first message)";
  const input = [
    "Where the user is and what they can see:",
    JSON.stringify(context, null, 1),
    "",
    "Conversation so far:",
    conversation,
    "",
    `User: ${message}`,
  ].join("\n");
  const out = await ask(SYSTEM, input, SCHEMA) as Partial<Answer>;
  const actions = Array.isArray(out.actions) ? out.actions.filter((a) => a && typeof a.type === "string" && (ACTIONS as readonly string[]).includes(a.type)) : [];
  return { reply: String(out.reply ?? ""), actions };
}
