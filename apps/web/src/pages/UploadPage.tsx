import { useCallback, useEffect, useRef, useState } from "react";
import { useDropzone, type FileRejection } from "react-dropzone";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { UploadCloud, FileText, Loader2, Link2, Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { uploadArxiv, uploadPaper } from "@/lib/api";
import { cn } from "@/lib/cn";

const MAX_SIZE = 10 * 1024 * 1024;

type Source = "pdf" | "arxiv";

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
        ? uploadPaper(file!, title || undefined)
        : uploadArxiv(arxivUrl.trim(), title || undefined),
    onSuccess: (data) => {
      // Route through /scope so the user picks which sections each
      // reviewer sees. ScopePage forwards to /compare after the selection
      // is saved (or immediately if the user clicks "Review whole paper").
      navigate(`/scope?paperId=${data.paperId}`);
    },
  });

  const submitting = mutation.isPending;
  const arxivLooksValid = ARXIV_HINT_RE.test(arxivUrl.trim());
  const canSubmit =
    !submitting && (source === "pdf" ? !!file : arxivLooksValid);

  return (
    <div className="container max-w-2xl py-10 pb-32 space-y-6">
      <div>
        <div className="eyebrow mb-3">Submit a manuscript</div>
        <h1 className="text-3xl font-semibold tracking-[-0.01em]">
          Upload a paper
        </h1>
        <p className="text-graphite mt-1">
          PDF, max 10 MB. Both reviewing systems get the same section
          selection; you then compare the two reviews blinded and vote.
        </p>
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
        </div>
      </div>

      {mutation.isError && (
        <p className="text-sm text-destructive">{(mutation.error as Error).message}</p>
      )}

      <div
        className="fixed bottom-0 right-0 z-30 border-t bg-background left-0 lg:[left:var(--sidebar-w)]"
      >
        <div className="container max-w-2xl flex items-center gap-4 py-3">
          {submitting ? (
            <div className="flex flex-1 items-center gap-2 font-mono text-xs text-graphite">
              <Loader2 className="h-4 w-4 animate-spin shrink-0" />
              <span>Uploading…</span>
            </div>
          ) : (
            <div className="flex-1 font-mono text-xs text-graphite">
              {source === "pdf"
                ? file
                  ? `Ready: ${file.name}`
                  : "Select a PDF to continue."
                : arxivLooksValid
                ? `Ready: ${arxivUrl.trim()}`
                : "Paste an arXiv URL or ID to continue."}
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
      </div>
    </div>
  );
}

// Dropdown menu to pick between "Upload PDF" and "arXiv link" sources.
// Plain useState + click-outside; no Radix dependency for one menu.
// Keyboard: Enter/Space opens, Esc closes, ArrowDown/ArrowUp move focus,
// Enter on an item selects.
const SOURCE_OPTIONS: { value: Source; label: string; icon: typeof UploadCloud }[] = [
  { value: "pdf", label: "Upload PDF", icon: UploadCloud },
  { value: "arxiv", label: "arXiv link", icon: Link2 },
];

function SourceDropdown({
  value,
  onChange,
}: {
  value: Source;
  onChange: (s: Source) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Focus the selected item when the menu opens for keyboard navigability.
  useEffect(() => {
    if (!open) return;
    const id = `source-opt-${value}`;
    requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>(`#${id}`)?.focus();
    });
  }, [open, value]);

  const onItemKey = (e: React.KeyboardEvent<HTMLButtonElement>, idx: number) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = (idx + 1) % SOURCE_OPTIONS.length;
      menuRef.current
        ?.querySelector<HTMLElement>(`#source-opt-${SOURCE_OPTIONS[next]!.value}`)
        ?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = (idx - 1 + SOURCE_OPTIONS.length) % SOURCE_OPTIONS.length;
      menuRef.current
        ?.querySelector<HTMLElement>(`#source-opt-${SOURCE_OPTIONS[prev]!.value}`)
        ?.focus();
    }
  };

  const current = SOURCE_OPTIONS.find((o) => o.value === value) ?? SOURCE_OPTIONS[0]!;
  const CurrentIcon = current.icon;

  return (
    <div ref={wrapperRef} className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 border border-rule2 bg-card px-3 py-2 font-mono text-[13px] font-medium transition-colors hover:bg-paper2"
      >
        <CurrentIcon className="h-4 w-4 text-muted-foreground" />
        <span>{current.label}</span>
        <ChevronDown
          className={cn(
            "h-4 w-4 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Source"
          className="absolute left-0 top-[calc(100%+4px)] z-30 min-w-[14rem] overflow-hidden border border-rule2 bg-card p-1"
        >
          {SOURCE_OPTIONS.map((opt, idx) => {
            const Icon = opt.icon;
            const active = opt.value === value;
            return (
              <button
                key={opt.value}
                id={`source-opt-${opt.value}`}
                role="menuitemradio"
                aria-checked={active}
                type="button"
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                  buttonRef.current?.focus();
                }}
                onKeyDown={(e) => onItemKey(e, idx)}
                className={cn(
                  "flex w-full items-center gap-2 px-2.5 py-2 text-left font-mono text-[13px] transition-colors focus:outline-none",
                  active
                    ? "bg-paper2 text-ink"
                    : "text-graphite hover:bg-paper2 hover:text-ink focus:bg-paper2 focus:text-ink",
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="flex-1 truncate">{opt.label}</span>
                {active && <Check className="h-4 w-4 shrink-0 text-primary" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
