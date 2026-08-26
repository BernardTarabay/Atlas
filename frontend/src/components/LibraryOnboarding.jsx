import { MessageSquarePlus, Plus, Sparkles, FolderTree } from "lucide-react";
import { useAssistant } from "../context/AssistantContext";

/**
 * What a library with no folders offers instead of nothing.
 *
 * WHY AN EMPTY LIBRARY IS THE RIGHT STARTING POINT
 *
 * New accounts used to be seeded with twelve folders -- Personal, Finance,
 * Administrative, Reference and some children -- so that the first visit had
 * something in it. The seeding is gone (see authService.register), because a
 * structure handed to someone before they have said anything is a structure
 * derived from nothing: it does not know whether they are filing a business, a
 * thesis, or twenty years of family paperwork. In practice the starter folders
 * became the taxonomy by default, since rearranging someone else's structure
 * costs more than accepting it, and documents then got forced into the
 * least-wrong bucket.
 *
 * But the reasoning behind the seeding was not wrong about the risk. An empty
 * tree with a "create your first folder" button IS a dead end -- it asks
 * someone who has not looked at their documents yet to invent a filing system
 * from memory, one folder at a time.
 *
 * So this is the other way out. The assistant can already create folders as a
 * real action (create_subject, and it can propose a whole set at once), which
 * means the fastest path from nothing to a working library is describing what
 * you have in a sentence. That path leads; making folders by hand stays for
 * people who already know exactly what they want.
 *
 * The suggestions are SENTENCE OPENERS, not commands. They land in the
 * composer for the user to finish, because the useful part is the detail only
 * they have -- the sentence is a way past the blank page, not a template.
 */

const OPENERS = [
  {
    label: "Invoices, receipts, contracts",
    text: "I run a small business. I mostly get invoices, receipts and contracts from clients and suppliers. Set up folders that suit that, and tell me where each kind should go.",
  },
  {
    label: "By year, then by kind",
    text: "I'd like everything organised by year first, then by what kind of document it is. Create that structure for the last few years.",
  },
  {
    label: "Coursework and personal",
    text: "I'm a student. I have coursework, lecture notes, exams and my own personal documents like ID and medical records. Build me folders for that.",
  },
];

export function LibraryOnboarding({ unfiledCount = 0, canManage, onCreateFolder, compact = false }) {
  const { askAssistant } = useAssistant();

  const hasDocuments = unfiledCount > 0;

  return (
    <div className={compact ? "glass-card mb-4 p-5" : "glass-card mx-auto max-w-3xl p-8 text-center"}>
      <div className={compact ? "flex items-start gap-4" : ""}>
        {!compact && (
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-500/15">
            <FolderTree size={22} className="text-brand-700" aria-hidden="true" />
          </div>
        )}

        <div className={compact ? "min-w-0 flex-1" : ""}>
          <h2 className={compact ? "text-sm font-semibold text-base-50" : "text-lg font-semibold text-base-50"}>
            {hasDocuments ? "Your documents have nowhere to go yet" : "Your library is empty"}
          </h2>

          {/* The number is the argument. "You have 1,240 documents and no
              folders" is a reason to act; "no folders yet" is a description. */}
          <p className={"mt-1 text-sm text-base-400 " + (compact ? "" : "mx-auto max-w-xl")}>
            {hasDocuments ? (
              <>
                <strong className="text-base-200">{unfiledCount.toLocaleString()}</strong>{" "}
                document{unfiledCount === 1 ? " is" : "s are"} waiting to be filed. Tell the assistant
                how you want them organised and it will build the folders — or make them yourself.
              </>
            ) : (
              <>
                There are no folders yet, and that is on purpose — this is your filing system, not a
                template. Describe what you keep and the assistant will set it up, or start one folder
                at a time.
              </>
            )}
          </p>

          <div className={"mt-4 flex flex-wrap items-center gap-2 " + (compact ? "" : "justify-center")}>
            <button
              className="btn-primary btn-sm"
              onClick={() =>
                askAssistant(
                  hasDocuments
                    ? "I have documents to organise. Here's what they are and how I'd like them filed: "
                    : "Here's what I'll be keeping in here, and how I'd like it organised: "
                )
              }
            >
              <MessageSquarePlus size={14} /> Describe it to the assistant
            </button>
            {canManage && (
              <button className="btn-secondary btn-sm" onClick={onCreateFolder}>
                <Plus size={14} /> Create a folder myself
              </button>
            )}
          </div>

          {/* Past the blank page. Someone who does not know what to type is the
              whole reason the previous empty state failed. */}
          <div className={"mt-5 " + (compact ? "" : "mx-auto max-w-xl")}>
            <p className={"flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-base-500 " + (compact ? "" : "justify-center")}>
              <Sparkles size={11} aria-hidden="true" /> Or start from one of these
            </p>
            <div className={"mt-2 flex flex-wrap gap-2 " + (compact ? "" : "justify-center")}>
              {OPENERS.map((opener) => (
                <button
                  key={opener.label}
                  onClick={() => askAssistant(opener.text)}
                  className="rounded-full border border-line-strong bg-base-900 px-3 py-1.5 text-xs text-base-300 transition-colors hover:border-brand-400/40 hover:bg-brand-500/10 hover:text-brand-700"
                >
                  {opener.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
