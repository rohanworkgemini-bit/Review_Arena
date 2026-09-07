import { useCallback, useState } from "react";
import { useDropzone, type FileRejection } from "react-dropzone";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { UploadCloud, FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { uploadArxiv, uploadPaper } from "@/lib/api";
import { cn } from "@/lib/cn";
import { BottomBar } from "@/components/layout/BottomBar";
import {
  CONFERENCE_OPTIONS,
  SOURCE_OPTIONS,
  StyledDropdown,
  type UploadSource as Source,
} from "@/components/ui/styled-dropdown";
import { type Conference } from "@reviewarena/shared-types";

const MAX_SIZE = 10 * 1024 * 1024;

// Loose client-side check — the server has the authoritative normalizer.
// Accepts bare IDs and arxiv.org URLs (abs/pdf/html). Just used to enable
// the submit button so the user gets immediate feedback.
const ARXIV_HINT_RE =
  /^(?:https?:\/\/arxiv\.org\/(?:abs|pdf|html)\/)?\d{4}\.\d{4,5}(?:v\d+)?$/i;

export function UploadPage() {
  const navigate = useNavigate();

  const [source, setSource] = useState<Source>("pdf");
  const [file, setFile] = useState<File | null>(null);
  const [arxivUrl, setArxivUrl] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Data-processing consent — required before any upload. The API also
  // enforces this server-side; see /consent for the full notice.
  const [consented, setConsented] = useState(false);
  // Which venue's review form / rating scale the generated reviews follow.
  const [conference, setConference] = useState<Conference>("iclr");

  const onDrop = useCallback((accepted: File[], rejected: FileRejection[]) => {
    setError(null);
    const r = rejected[0];
    if (r) {
      if (r.errors.some((e) => e.code === "file-too-large")) {
        setError("File exceeds 10 MB.");
      } else {
        setError("Only PDFs are accepted.");
      }
      return;
    }
    if (accepted[0]) setFile(accepted[0]);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    maxSize: MAX_SIZE,
    multiple: false,
  });

  const mutation = useMutation({
    mutationFn: () =>
      source === "pdf"
        ? uploadPaper(file!, title || undefined, conference)
        : uploadArxiv(arxivUrl.trim(), title || undefined, conference),
    onSuccess: (data) => {
      // Straight to the comparison view — both reviewers see the
      // complete paper (no input cap).
      navigate(`/compare?paperId=${data.paperId}`);
    },
  });

  const submitting = mutation.isPending;
  const arxivLooksValid = ARXIV_HINT_RE.test(arxivUrl.trim());
  const canSubmit =
    !submitting && consented && (source === "pdf" ? !!file : arxivLooksValid);

  return (
    <div className="container max-w-2xl py-10 space-y-6">
      <div>
        <div className="eyebrow mb-3">Submit a manuscript</div>
        <h1 className="text-3xl font-semibold tracking-[-0.01em]">
          Upload a paper
        </h1>
        <p className="text-graphite mt-1">
           Via PDF or arXiv link, Select the Review format, Read and vote for the better Review.
        </p>
      </div>

      {/* Conference format — chosen up front; every generated review for
          this paper follows the selected venue's review form and overallå
          rating scale (both blind reviews always share the same scale). */}
      <div>
        <div className="text-sm font-medium">Review format</div>
        <div className="mt-1 flex flex-wrap items-baseline gap-3">
          <StyledDropdown
            value={conference}
            onChange={setConference}
            options={CONFERENCE_OPTIONS}
            ariaLabel="Review format"
            idPrefix="conf"
          />
          <span className="font-mono text-xs text-graphite">
            Both reviews follow this venue&rsquo;s form and rating scale.
          </span>
        </div>
      </div>

      <SourceDropdown value={source} onChange={setSource} />

      <div className="border-y border-rule py-6">
        <div className="space-y-4">
          {source === "pdf" ? (
            <div
              {...getRootProps()}
              className={cn(
                "flex flex-col items-center justify-center border border-dashed border-rule2 p-12 text-center cursor-pointer transition-colors",
                isDragActive && "border-red bg-paper2",
                file && "border-red/50 bg-paper2/60",
              )}
            >
              <input {...getInputProps()} />
              {file ? (
                <div className="flex items-center gap-3 text-sm">
                  <FileText className="h-8 w-8 text-graphite" />
                  <div className="text-left">
                    <div className="font-medium">{file.name}</div>
                    <div className="font-mono text-xs text-graphite">
                      {(file.size / 1024 / 1024).toFixed(2)} MB · click to replace
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2 text-graphite">
                  <UploadCloud className="h-10 w-10" />
                  <div className="font-mono text-xs tracking-[0.02em]">
                    {isDragActive ? "Release to upload" : "Drag a PDF here, or click to browse"}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="arxiv">
                arXiv URL or ID
              </label>
              <input
                id="arxiv"
                value={arxivUrl}
                onChange={(e) => setArxivUrl(e.target.value)}
                placeholder="2312.00752  or  https://arxiv.org/abs/2312.00752"
                className="w-full border border-rule2 bg-paper px-3 py-2 font-mono text-sm"
              />
              <p className="font-mono text-xs text-graphite">
                Parsed via arxiv2md.org — works for arXiv papers with HTML
                rendering.
              </p>
            </div>
          )}
          {error && <Badge variant="destructive">{error}</Badge>}
          <div>
            <label className="text-sm font-medium" htmlFor="title">
              Title <span className="text-muted-foreground">(optional)</span>
            </label>
            <input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                source === "pdf"
                  ? "Falls back to the title extracted from the PDF."
                  : "Falls back to the title from arXiv."
              }
              className="mt-1 w-full border border-rule2 bg-paper px-3 py-2 text-sm"
            />
          </div>

          {/* Data-processing consent — required. The server rejects
              uploads without it, so this is UX, not the enforcement. */}
          <label className="flex cursor-pointer items-start gap-2.5 border-t border-rule pt-4">
            <input
              type="checkbox"
              checked={consented}
              onChange={(e) => setConsented(e.target.checked)}
              className="mt-[3px] h-4 w-4 shrink-0 cursor-pointer accent-[#9d2b22]"
              aria-describedby="consent-hint"
            />
            <span id="consent-hint" className="text-[13px] leading-relaxed text-graphite">
              I understand that this paper will be processed by{" "}
              <span className="text-ink">commercial AI model APIs</span>{" "}
              (OpenAI, Google Gemini, Anthropic, DeepSeek, Mistral, Z.ai), parsed via the
              Datalab Marker API, and handled on infrastructure hosted by
              Vercel and Google Cloud —{" "}
              <Link
                to="/consent"
                className="text-red underline underline-offset-4 hover:text-redink"
              >
                full data-processing notice
              </Link>
              .
            </span>
          </label>
        </div>
      </div>

      {mutation.isError && (
        <p className="text-sm text-destructive">{(mutation.error as Error).message}</p>
      )}

      {/* Must stay the LAST child of the container so it comes to rest
          above the footer at the end of the page (see BottomBar). */}
      <BottomBar className="bg-background">
        <div className="flex items-center gap-4 py-3">
          {submitting ? (
            <div className="flex flex-1 items-center gap-2 font-mono text-xs text-graphite">
              <Loader2 className="h-4 w-4 animate-spin shrink-0" />
              <span>Uploading…</span>
            </div>
          ) : (
            <div className="flex-1 font-mono text-xs text-graphite">
              {source === "pdf" && !file
                ? "Select a PDF to continue."
                : source === "arxiv" && !arxivLooksValid
                ? "Paste an arXiv URL or ID to continue."
                : !consented
                ? "Accept the data-processing notice to continue."
                : `Ready: ${source === "pdf" ? file!.name : arxivUrl.trim()}`}
            </div>
          )}
          <Button
            onClick={() => mutation.mutate()}
            disabled={!canSubmit}
            size="lg"
            className="shrink-0"
          >
            {submitting ? "Working…" : "Upload and start comparing"}
          </Button>
        </div>
      </BottomBar>
    </div>
  );
}

// Paper source picker ("Upload PDF" / "arXiv link") — thin wrapper around
// the shared StyledDropdown.
function SourceDropdown({
  value,
  onChange,
}: {
  value: Source;
  onChange: (s: Source) => void;
}) {
  return (
    <StyledDropdown
      value={value}
      onChange={onChange}
      options={SOURCE_OPTIONS}
      ariaLabel="Source"
      idPrefix="source"
    />
  );
}
