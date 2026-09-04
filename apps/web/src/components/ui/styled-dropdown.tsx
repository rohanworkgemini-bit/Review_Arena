import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Link2, UploadCloud, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  CONFERENCES,
  CONFERENCE_NAMES,
  type Conference,
} from "@reviewarena/shared-types";

// A small styled dropdown menu — the shared look for compact pickers (the
// paper source and the review format both use it, on the arena upload page
// and the study upload screen alike). Plain useState + click-outside; no
// Radix dependency. Keyboard: Enter/Space opens, Esc closes, ArrowDown/
// ArrowUp move focus, Enter on an item selects.

export type DropdownOption<T extends string> = {
  value: T;
  label: string;
  icon?: LucideIcon;
};

export type UploadSource = "pdf" | "arxiv";

export const SOURCE_OPTIONS: DropdownOption<UploadSource>[] = [
  { value: "pdf", label: "Upload PDF", icon: UploadCloud },
  { value: "arxiv", label: "arXiv link", icon: Link2 },
];

export const CONFERENCE_OPTIONS: DropdownOption<Conference>[] = CONFERENCES.map((c) => ({
  value: c,
  label: CONFERENCE_NAMES[c],
}));

export function StyledDropdown<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  idPrefix,
}: {
  value: T;
  onChange: (v: T) => void;
  options: DropdownOption<T>[];
  ariaLabel: string;
  idPrefix: string;
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
    const id = `${idPrefix}-opt-${value}`;
    requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>(`#${id}`)?.focus();
    });
  }, [open, value, idPrefix]);

  const onItemKey = (e: React.KeyboardEvent<HTMLButtonElement>, idx: number) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = (idx + 1) % options.length;
      menuRef.current
        ?.querySelector<HTMLElement>(`#${idPrefix}-opt-${options[next]!.value}`)
        ?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = (idx - 1 + options.length) % options.length;
      menuRef.current
        ?.querySelector<HTMLElement>(`#${idPrefix}-opt-${options[prev]!.value}`)
        ?.focus();
    }
  };

  const current = options.find((o) => o.value === value) ?? options[0]!;
  const CurrentIcon = current.icon;

  return (
    <div ref={wrapperRef} className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 border border-rule2 bg-card px-3 py-2 font-mono text-[13px] font-medium transition-colors hover:bg-paper2"
      >
        {CurrentIcon && <CurrentIcon className="h-4 w-4 text-muted-foreground" />}
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
          aria-label={ariaLabel}
          className="absolute left-0 top-[calc(100%+4px)] z-30 min-w-[14rem] overflow-hidden border border-rule2 bg-card p-1"
        >
          {options.map((opt, idx) => {
            const Icon = opt.icon;
            const active = opt.value === value;
            return (
              <button
                key={opt.value}
                id={`${idPrefix}-opt-${opt.value}`}
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
                {Icon && <Icon className="h-4 w-4 shrink-0" />}
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
