import { useEffect, useState } from "react";
import { FileText, Sparkles, AlertCircle } from "lucide-react";
import { api } from "../services/apiClient";
import { useApiData } from "../hooks/useApiData";
import { PageSpinner } from "./Spinner";

/**
 * Shows what a file actually IS before someone renames it -- the whole
 * point being "so I know what to rename it to" rather than guessing from
 * the old filename. Always tries to render an actual picture of the
 * file's first page: real images are already that; everything else
 * (docx/xlsx/pptx/pdf/legacy office/txt/csv/svg/etc.) is rasterized
 * server-side via LibreOffice into a PNG (fileService.getPreviewImage).
 * Only falls back to the extracted-text excerpt + AI summary if image
 * generation genuinely fails (e.g. LibreOffice isn't installed on the
 * backend, or the file is a format nothing can render) -- it's a
 * fallback, not the default, per "make sure the preview is a picture of
 * the first page regardless of format."
 */
export function FilePreviewPane({ fileId, compact = false }) {
  const { data: detail, loading: loadingDetail } = useApiData(
    () => (fileId ? api.get(`/files/${fileId}`) : Promise.resolve(null)),
    [fileId]
  );

  const [blobUrl, setBlobUrl] = useState(null);
  const [imageError, setImageError] = useState(null);
  const [loadingImage, setLoadingImage] = useState(false);

  useEffect(() => {
    let currentUrl = null;
    let cancelled = false;
    setBlobUrl(null);
    setImageError(null);

    if (fileId) {
      setLoadingImage(true);
      api
        .previewBlobUrl(`/files/${fileId}/preview`)
        .then(({ url }) => {
          if (cancelled) { URL.revokeObjectURL(url); return; }
          currentUrl = url;
          setBlobUrl(url);
        })
        .catch((err) => !cancelled && setImageError(err.message))
        .finally(() => !cancelled && setLoadingImage(false));
    }

    return () => {
      cancelled = true;
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [fileId]);

  const height = compact ? "h-48" : "h-80";

  if (!fileId) return null;

  return (
    <div className="space-y-2">
      <div className={`overflow-hidden rounded-xl border border-line bg-inset ${height}`}>
        {loadingImage || loadingDetail ? (
          <div className="flex h-full items-center justify-center"><PageSpinner /></div>
        ) : blobUrl ? (
          <img src={blobUrl} alt={detail?.filename_current || "Preview"} className="h-full w-full object-contain" />
        ) : (
          // Image generation failed -- fall back to text excerpt + AI summary.
          <div className="h-full overflow-auto p-3.5">
            {imageError && (
              <p className="mb-2.5 flex items-start gap-1.5 text-xs text-amber-700">
                <AlertCircle size={12} className="mt-0.5 shrink-0" />
                <span>Couldn't render an image preview: {imageError}</span>
              </p>
            )}
            {detail?.ai_summary && (
              <p className="mb-2.5 flex items-start gap-1.5 text-xs text-brand-700">
                <Sparkles size={12} className="mt-0.5 shrink-0" />
                <span>{detail.ai_summary}</span>
              </p>
            )}
            {detail?.content?.excerpt ? (
              <p className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-base-300">{detail.content.excerpt}</p>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center text-xs text-base-500">
                <FileText size={18} />
                No preview available for this file yet.
              </div>
            )}
          </div>
        )}
      </div>
      {detail && (
        <p className="truncate text-xs text-base-500">
          {detail.ai_short_title || detail.filename_current}
          {detail.mime_type_detected ? ` · ${detail.mime_type_detected}` : ""}
        </p>
      )}
    </div>
  );
}
