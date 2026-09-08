import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Minus, Plus, MoveHorizontal } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Type size and column width for the review columns.
 *
 * A participant reads roughly 2,400 words of dense text per comparison, six
 * times, often on a laptop. Letting them set a comfortable measure is the
 * cheapest accessibility win available, and it cannot bias the comparison:
 * the setting applies to the container, so both panels change together.
 * That symmetry is the presentation control the whole design rests on —
 * there is deliberately no way to size one column alone.
 *
 * The preference is per-viewer convenience, so it lives in localStorage and
 * never reaches the server. It is not research data.
 */

const SIZE_KEY = "ra-read-size";
const WIDE_KEY = "ra-read-wide";

// `wide` is shared rather than local: turning it on also collapses the app
// sidebar, and the sidebar lives in AppShell, well outside this component.
// A tiny external store lets both subscribe without threading state through
// every route. Text size stays local — nothing else cares about it.
let wideValue = ((): boolean => {
  try {
    return localStorage.getItem(WIDE_KEY) === "1";
  } catch {
    return false;
  }
})();
const wideListeners = new Set<() => void>();

function setWideValue(next: boolean): void {
  if (next === wideValue) return;
  wideValue = next;
  try {
    localStorage.setItem(WIDE_KEY, next ? "1" : "0");
  } catch {
    /* private mode */
  }
  for (const l of wideListeners) l();
}

/** Subscribe to the wide-reading preference. */
export function useWideReading(): boolean {
  return useSyncExternalStore(
    (cb) => {
      wideListeners.add(cb);
      return () => wideListeners.delete(cb);
    },
    () => wideValue,
    () => false,
  );
}

// Steps in px against the panel's 14.5px default. Bounded so the layout
// cannot be driven somewhere unreadable and then persisted there.
const SIZES = [13, 14.5, 16, 17.5, 19] as const;
const DEFAULT_INDEX = 1;

export interface ReadingPrefs {
  /** Font size for review body text, in px. */
  fontSize: number;
  /** Drop the max-width cap so the columns use the full viewport. */
  wide: boolean;
}

function read<T>(key: string, parse: (raw: string) => T, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : parse(raw);
  } catch {
    return fallback;
  }
}

export function useReadingPrefs() {
  const [index, setIndex] = useState(() =>
    read(SIZE_KEY, (r) => {
      const n = Number(r);
      return Number.isInteger(n) && n >= 0 && n < SIZES.length ? n : DEFAULT_INDEX;
    }, DEFAULT_INDEX),
  );
  const wide = useWideReading();

  useEffect(() => {
    try {
      localStorage.setItem(SIZE_KEY, String(index));
    } catch {
      /* private mode */
    }
  }, [index]);
  const bigger = useCallback(() => setIndex((i) => Math.min(i + 1, SIZES.length - 1)), []);
  const smaller = useCallback(() => setIndex((i) => Math.max(i - 1, 0)), []);

  return {
    prefs: { fontSize: SIZES[index]!, wide } as ReadingPrefs,
    bigger,
    smaller,
    canGrow: index < SIZES.length - 1,
    canShrink: index > 0,
    wide,
    toggleWide: () => setWideValue(!wideValue),
  };
}

export function ReadingControls({
  bigger,
  smaller,
  canGrow,
  canShrink,
  wide,
  toggleWide,
  className,
}: {
  bigger: () => void;
  smaller: () => void;
  canGrow: boolean;
  canShrink: boolean;
  wide: boolean;
  toggleWide: () => void;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-1", className)}>
      <span className="mr-1 font-mono text-[11px] uppercase tracking-[0.1em] text-graphite">
        Text
      </span>
      <IconButton label="Smaller text" onClick={smaller} disabled={!canShrink}>
        <Minus className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton label="Larger text" onClick={bigger} disabled={!canGrow}>
        <Plus className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton
        label={wide ? "Narrower columns" : "Wider columns"}
        onClick={toggleWide}
        pressed={wide}
      >
        <MoveHorizontal className="h-3.5 w-3.5" />
      </IconButton>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      className={cn(
        "flex h-6 w-6 items-center justify-center border transition-colors",
        pressed ? "border-ink bg-ink text-paper" : "border-rule2 text-graphite hover:text-ink",
        disabled && "cursor-not-allowed opacity-35 hover:text-graphite",
      )}
    >
      {children}
    </button>
  );
}
