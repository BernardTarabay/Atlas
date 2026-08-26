import { useState } from "react";
import {
  Stamp, FileText, Eye, Download, Pencil, FolderInput, Trash2, Sparkles, FolderOpen,
} from "lucide-react";
import { api } from "../services/apiClient";
import { useApiData } from "../hooks/useApiData";
import { PageHeader } from "../components/PageHeader";
import { PageSpinner } from "../components/Spinner";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Pagination } from "../components/Pagination";
import { FileDetailModal } from "../components/FileDetailModal";
import { PreviewModal } from "../components/PreviewModal";
import { EditFileModal } from "../components/EditFileModal";
import { MoveFileModal } from "../components/MoveFileModal";
import { FileFilters, EMPTY_FILTERS, filtersToParams, countActiveFilters } from "../components/FileFilters";
import { DocumentDateInline, LocationLabel } from "../components/DocumentDate";
import { useToast } from "../context/ToastContext";
import { useAuth } from "../context/AuthContext";

const FILES_LIMIT = 20;

/**
 * Browse by Document Type — the second classification axis
 * (docs/03-taxonomy.md §3.4), which had no browse surface at all until now.
 *
 * WHY THIS IS A SEPARATE PAGE FROM SUBJECTS
 *
 * Because the axes are orthogonal, which is the entire reason Document Type
 * exists as its own dimension: "Report" must not have to be a leaf under
 * Finance, Academic AND Administrative at once. The question this page answers
 * — "every Invoice, wherever it is filed" — cannot be asked of a tree.
 *
 * WHY IT IS A FLAT LIST AND NOT A TREE OR A MAP
 *
 * Document types have no hierarchy and are not going to grow one; there are
 * thirteen of them. Mirroring SubjectsPage's list/map toggle would be copying
 * a control that exists to make a deep tree navigable onto something that
 * fits on one screen.
 *
 * WHY "NO TYPE YET" IS A ROW RATHER THAN AN OMISSION
 *
 * On a real corpus most files have no document type: the rule tier only
 * assigns one from a filename or an extension, deliberately (see the comment
 * in classifyProcessor about why body prose cannot answer "what KIND of thing
 * is this"). A page that listed only the populated types would quietly imply
 * the archive is smaller than it is, and would hide the pile that most needs
 * attention.
 */
export function DocumentTypesPage() {
  const { hasPermission } = useAuth();
  const { push } = useToast();

  // Filters apply to the whole page: the counts beside each type AND the file
  // list below. A count that ignored the filter would advertise files the
  // list then refuses to show. showDocumentType is off -- this list IS the
  // type picker.
  const [filters, setFilters] = useState({ ...EMPTY_FILTERS });
  const filterParams = filtersToParams(filters);
  const filterKey = JSON.stringify(filterParams);
  const activeFilters = countActiveFilters(filters);

  const { data, loading, error, reload } = useApiData(
    () => api.get("/document-types/browse", filterParams),
    [filterKey]
  );

  const [selectedId, setSelectedId] = useState(null);
  const [fileOffset, setFileOffset] = useState(0);

  const [selectedFileId, setSelectedFileId] = useState(null);
  const [previewFileId, setPreviewFileId] = useState(null);
  const [editFileTarget, setEditFileTarget] = useState(null);
  const [moveFileTarget, setMoveFileTarget] = useState(null);
  const [removeFileTarget, setRemoveFileTarget] = useState(null);
  const [removingFile, setRemovingFile] = useState(false);

  const documentTypes = data?.documentTypes || [];
  const untypedCount = data?.untypedCount ?? 0;
  const selected = documentTypes.find((d) => d.id === selectedId) || null;

  // The files for whichever type is open. Goes through GET /files with the
  // documentTypeId filter rather than a bespoke endpoint, so this list obeys
  // exactly the same predicates (and the same ownership rule) as the Files
  // page — one builder, no second chance to disagree.
  const { data: files, loading: loadingFiles, reload: reloadFiles } = useApiData(
    () =>
      selectedId
        ? api.get("/files", {
            ...filterParams,
            documentTypeId: selectedId,
            limit: FILES_LIMIT,
            offset: fileOffset,
          })
        : Promise.resolve(null),
    [selectedId, fileOffset, filterKey]
  );

  function selectType(id) {
    setSelectedId((current) => (current === id ? null : id));
    setFileOffset(0);
  }

  async function downloadFile(id, filename) {
    try {
      await api.download(`/files/${id}/download`, filename);
    } catch (err) {
      push(err.message, "error");
    }
  }

  async function confirmRemoveFile() {
    if (!removeFileTarget) return;
    setRemovingFile(true);
    try {
      await api.del(`/files/${removeFileTarget.id}`);
      push(`"${removeFileTarget.filename_current}" removed.`, "success");
      setRemoveFileTarget(null);
      // Both, not just the list: removing a file changes the count beside its
      // type, and a stale count is how a page starts lying quietly.
      reloadFiles();
      reload();
    } catch (err) {
      push(err.message, "error");
    } finally {
      setRemovingFile(false);
    }
  }

  if (loading) return <PageSpinner />;

  return (
    <div>
      <PageHeader
        title="Document types"
        description="What kind of thing each document is — independent of where it's filed. Every Invoice, wherever it lives."
      />

      <FileFilters
        value={filters}
        onChange={(next) => { setFilters(next); setFileOffset(0); }}
        showDocumentType={false}
      />

      {activeFilters > 0 && (
        <p className="mb-3 text-xs text-amber-700/90">
          Filters are on — every count below, and the files listed for a type, describe only the
          matching files.
        </p>
      )}

      {error ? (
        <ErrorState error={error} onRetry={reload} title="Couldn't load document types" />
      ) : !documentTypes.length ? (
        <EmptyState
          icon={Stamp}
          title="No document types defined"
          description="Document types come from seed data (backend/seeds/002). A deployment defines its own."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[22rem_1fr]">
          <div className="glass-card p-3">
            <ul className="space-y-1">
              {documentTypes.map((type) => {
                const on = type.id === selectedId;
                return (
                  <li key={type.id}>
                    <button
                      onClick={() => selectType(type.id)}
                      className={
                        "flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm transition-colors " +
                        (on
                          ? "border border-brand-500/40 bg-brand-500/15 text-brand-700"
                          : "border border-transparent text-base-200 hover:bg-base-850")
                      }
                      // The count is greyed at zero rather than the row being
                      // hidden: "we have no Contracts" is a real answer, and
                      // an option that silently vanishes looks like a bug.
                      title={type.description || type.name}
                    >
                      <Stamp size={14} className={on ? "text-brand-700" : "text-base-500"} />
                      <span className="min-w-0 flex-1 truncate font-medium">{type.name}</span>
                      <span
                        className={
                          "shrink-0 tabular-nums text-xs " +
                          (type.fileCount ? "text-base-300" : "text-base-600")
                        }
                      >
                        {type.fileCount.toLocaleString()}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            {/* The honest bottom line. See the header comment. */}
            <div className="mt-3 flex items-center gap-2 rounded-xl border border-line bg-base-900 px-3 py-2.5 text-sm">
              <FolderOpen size={14} className="shrink-0 text-base-500" />
              <span className="min-w-0 flex-1 text-base-400">No type yet</span>
              <span className="shrink-0 tabular-nums text-xs text-base-400">
                {untypedCount.toLocaleString()}
              </span>
            </div>
            <p className="mt-2 px-1 text-[11px] leading-relaxed text-base-600">
              A type is set from a filename, a decisive extension, the AI tier, or by hand on the
              Files page. It is deliberately never guessed from the document's wording — prose says
              what a document is <em>about</em>, not what kind of thing it is.
            </p>
          </div>

          <div className="glass-card p-4">
            {!selected ? (
              <EmptyState
                icon={Stamp}
                title="Pick a document type"
                description="Choose a type on the left to see every file of that kind, wherever it is filed."
              />
            ) : (
              <>
                <div className="mb-3 flex items-baseline justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-base font-semibold text-base-100">{selected.name}</h2>
                    {selected.description && (
                      <p className="truncate text-xs text-base-500">{selected.description}</p>
                    )}
                  </div>
                  <span className="shrink-0 text-xs tabular-nums text-base-400">
                    {selected.fileCount.toLocaleString()} file{selected.fileCount === 1 ? "" : "s"}
                  </span>
                </div>

                {loadingFiles ? (
                  <PageSpinner />
                ) : !files?.length ? (
                  <p className="text-sm text-base-400">
                    {activeFilters > 0
                      ? `No ${selected.name} files match the current filters.`
                      : `Nothing is typed as ${selected.name} yet.`}
                  </p>
                ) : (
                  <>
                    <ul className="space-y-2">
                      {files.map((f) => (
                        <li
                          key={f.id}
                          className="table-row-hover flex cursor-pointer items-center gap-2.5 rounded-xl border border-line bg-base-900 px-3.5 py-2.5 text-sm"
                          onClick={() => setSelectedFileId(f.id)}
                        >
                          <FileText size={14} className="mt-0.5 shrink-0 text-base-400" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium text-base-100">
                              {f.ai_short_title || f.filename_current}
                            </p>
                            {f.ai_short_title ? (
                              <p className="flex items-center gap-1 truncate text-xs text-base-500">
                                <Sparkles size={10} className="shrink-0 text-brand-600" />
                                {f.filename_current}
                              </p>
                            ) : (
                              <p className="truncate font-mono text-xs text-base-500">{f.current_path}</p>
                            )}
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-base-500">
                              <DocumentDateInline date={f.document_date} source={f.document_date_source} />
                              <LocationLabel name={f.location_name} isReadOnly={f.location_is_read_only} />
                              {/* The OTHER axis, shown here on purpose: the
                                  point of browsing by type is seeing that the
                                  same kind of document lives in several
                                  different places. */}
                              {f.subject_name && (
                                <span className="text-base-500" title={f.subject_path || f.subject_name}>
                                  · {f.subject_name}
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="flex shrink-0 gap-1">
                            {hasPermission("document.download") && (
                              <button
                                className="btn-ghost btn-sm"
                                onClick={(e) => { e.stopPropagation(); setPreviewFileId(f.id); }}
                                title="Preview"
                              >
                                <Eye size={13} />
                              </button>
                            )}
                            <button
                              className="btn-ghost btn-sm"
                              onClick={(e) => { e.stopPropagation(); downloadFile(f.id, f.filename_current); }}
                              title="Download"
                            >
                              <Download size={13} />
                            </button>
                            {(hasPermission("document.rename") || hasPermission("classification.modify")) && (
                              <button
                                className="btn-ghost btn-sm"
                                onClick={(e) => { e.stopPropagation(); setEditFileTarget(f); }}
                                title="Edit"
                              >
                                <Pencil size={13} />
                              </button>
                            )}
                            {hasPermission("classification.modify") && (
                              <button
                                className="btn-ghost btn-sm"
                                onClick={(e) => { e.stopPropagation(); setMoveFileTarget(f); }}
                                title="Move to another subject"
                              >
                                <FolderInput size={13} />
                              </button>
                            )}
                            {hasPermission("document.delete") && (
                              <button
                                className="btn-ghost btn-sm text-rose-600 hover:text-rose-700"
                                onClick={(e) => { e.stopPropagation(); setRemoveFileTarget(f); }}
                                title="Remove file"
                              >
                                <Trash2 size={13} />
                              </button>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                    <div className="mt-2">
                      <Pagination
                        offset={fileOffset}
                        limit={FILES_LIMIT}
                        pageCount={files?.length}
                        onChange={setFileOffset}
                      />
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Reused as-is, so a file looks and behaves the same here as on the
          Files and Subjects pages. */}
      <FileDetailModal
        fileId={selectedFileId}
        onClose={() => setSelectedFileId(null)}
        onEdit={(f) => { setSelectedFileId(null); setEditFileTarget(f); }}
        onMove={(f) => { setSelectedFileId(null); setMoveFileTarget(f); }}
        onDelete={(f) => { setSelectedFileId(null); setRemoveFileTarget(f); }}
      />

      <PreviewModal fileId={previewFileId} onClose={() => setPreviewFileId(null)} />

      <EditFileModal
        file={editFileTarget}
        onClose={() => setEditFileTarget(null)}
        // Reloads the type list too, not just the files: the edit modal is
        // where a document type is set by hand, so a save here can move a file
        // between the very buckets this page is drawn from.
        onSaved={() => {
          setEditFileTarget(null);
          reloadFiles();
          reload();
          push("File updated.", "success");
        }}
      />

      <MoveFileModal
        file={moveFileTarget}
        onClose={() => setMoveFileTarget(null)}
        onMoved={() => { setMoveFileTarget(null); reloadFiles(); push("File moved.", "success"); }}
      />

      <ConfirmDialog
        open={Boolean(removeFileTarget)}
        onClose={() => setRemoveFileTarget(null)}
        onConfirm={confirmRemoveFile}
        loading={removingFile}
        danger
        title="Remove file"
        confirmLabel="Remove"
        description={
          removeFileTarget
            ? `Remove "${removeFileTarget.filename_current}"? It's marked deleted (not erased) and any pending rename proposal for it is cancelled.`
            : ""
        }
      />
    </div>
  );
}
