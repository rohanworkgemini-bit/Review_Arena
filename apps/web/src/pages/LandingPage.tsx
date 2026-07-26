import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Footer } from "@/components/layout/Footer";
import { getLeaderboard } from "@/lib/api";

// Public landing page — a React port of the hand-built reference
// (reviewarena-landing.html). Manuscript register: warm paper, ink,
// hairline rules; the red is the reviewer's pen (interactive elements
// and editorial marks only). The hero embeds a self-contained demo of
// the signature comparison card: two sample reviews stream in blind,
// you vote, identities reveal, the Elo delta prints.

// ─── Demo data (from the reference; sample pairs, not live reviews) ─────────

interface DemoPair {
  paper: string;
  a: { sys: string; text: string };
  b: { sys: string; text: string };
}

const PAIRS: DemoPair[] = [
  {
    paper: "Sparse Attention for Long-Context Retrieval",
    a: {
      sys: "gpt-4o",
      text: "The sparsity pattern is well motivated, but there is no wall-clock comparison against FlashAttention-2. Without it, the efficiency claims in Section 4 are unsupported. Major revision.",
    },
    b: {
      sys: "claude-3.5",
      text: "Strong empirical results, though the Table 3 ablation conflates two variables. The gains may come from the reranker, not the sparse mask — isolate this before acceptance.",
    },
  },
  {
    paper: "Contrastive Pretraining for Low-Resource ASR",
    a: {
      sys: "llama-3.1-70b",
      text: "Clear writing, reasonable baseline. But the low-resource claim rests on a single 10-hour split; 1- and 5-hour results are needed to support the headline. Borderline.",
    },
    b: {
      sys: "gemini-1.5",
      text: "Incremental over Wav2Vec2, and the novelty is oversold in the abstract. That said, the error analysis in Section 5 is genuinely useful. Weak accept.",
    },
  },
  {
    paper: "Differentiable Rendering for Protein Docking",
    a: {
      sys: "claude-3.5",
      text: "Ambitious cross-domain transfer. The gradient estimator is derived correctly, but the docking benchmark uses a non-standard split, making comparison to prior work impossible. Fixable.",
    },
    b: {
      sys: "gpt-4o",
      text: "Elegant idea, excellent figures. My concern is compute: 400 GPU-hours per complex limits practical use. That tradeoff deserves an honest discussion, not a footnote.",
    },
  },
];

const DEMO_BOARD = [
  { systemName: "claude-3.5", rating: 1532, voteCount: 2841, ratingCiLow: 1511, ratingCiHigh: 1553 },
  { systemName: "gpt-4o", rating: 1518, voteCount: 2790, ratingCiLow: 1496, ratingCiHigh: 1540 },
  { systemName: "gemini-1.5", rating: 1489, voteCount: 2655, ratingCiLow: 1466, ratingCiHigh: 1512 },
  { systemName: "llama-3.1-70b", rating: 1451, voteCount: 2402, ratingCiLow: 1426, ratingCiHigh: 1476 },
  { systemName: "mistral-large", rating: 1442, voteCount: 2318, ratingCiLow: 1416, ratingCiHigh: 1468 },
];

export function LandingPage() {
  return (
    <div className="min-h-screen bg-paper text-ink">
      {/* editor's mark across the very top */}
      <div className="h-[3px] bg-red" aria-hidden />
      <TopNav />
      <main>
        <Hero />
        <About />
        <HowItWorks />
        <Standings />
        <Closing />
      </main>
      <Footer />
    </div>
  );
}

// ─── Nav ───────────────────────────────────────────────────────────────────

function TopNav() {
  return (
    <nav className="border-b border-rule">
      <div className="mx-auto flex max-w-[1080px] items-baseline justify-between px-7 pb-[18px] pt-5">
        <Link to="/" className="font-serif text-[19px] font-semibold tracking-tight">
          ReviewArena
        </Link>
        <div className="flex items-baseline gap-[26px]">
          <Link
            to="/leaderboard"
            className="font-mono text-[12.5px] tracking-[0.02em] text-graphite transition-colors hover:text-ink"
          >
            Leaderboard
          </Link>
          <a
            href="#how"
            className="hidden font-mono text-[12.5px] tracking-[0.02em] text-graphite transition-colors hover:text-ink sm:inline"
          >
            How it works
          </a>
          <Link
            to="/upload"
            className="border-b border-red pb-0.5 font-mono text-[12.5px] tracking-[0.02em] text-red"
          >
            Start comparing →
          </Link>
        </div>
      </div>
    </nav>
  );
}

// ─── Hero: copy left, live demo card right, 1px rule between ───────────────

function Hero() {
  return (
    <header className="mx-auto max-w-[1080px] px-7">
      <div className="grid grid-cols-1 items-start py-10 md:grid-cols-[minmax(0,4.3fr)_1px_minmax(0,6.7fr)] md:py-16 md:pb-[72px]">
        <div className="md:pr-11">
          <div className="eyebrow mb-[22px]">Blind pairwise evaluation</div>
          <h1 className="mb-[22px] font-serif text-[clamp(30px,4.2vw,46px)] font-semibold leading-[1.05] tracking-[-0.02em]">
            Which AI model writes the best peer reviews?
            <br />
            <em className="font-normal italic text-redink">Ranked by humans.</em>
          </h1>
          <p className="mb-3.5 max-w-[34ch] text-[16.5px] text-ink2">
            Read two blind reviews of the same paper. Vote on which is more
            useful. Every verdict updates an <b className="font-semibold">Elo ranking</b> of
            the systems behind them.
          </p>
          <p className="mt-[26px] max-w-[30ch] border-l-2 border-red pl-3.5 font-mono text-xs leading-normal text-graphite">
            No names until you vote. 
          </p>
        </div>

        <div className="hidden self-stretch bg-rule md:block" aria-hidden />

        <div className="mt-9 md:mt-0 md:pl-11">
          <DemoCard />
        </div>
      </div>
    </header>
  );
}

// ─── Demo comparison card (the signature, self-contained) ──────────────────

function useReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Word-by-word streamer with the red pen cursor. */
function useWordStream(text: string, active: boolean, onDone: () => void) {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState("");
  const [streaming, setStreaming] = useState(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (!active) return;
    if (reduce) {
      setShown(text);
      setStreaming(false);
      doneRef.current();
      return;
    }
    setShown("");
    setStreaming(true);
    const words = text.split(" ");
    let i = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (i < words.length) {
        i++;
        setShown(words.slice(0, i).join(" "));
        timer = setTimeout(tick, 34 + Math.random() * 26);
      } else {
        setStreaming(false);
        doneRef.current();
      }
    };
    timer = setTimeout(tick, 120);
    return () => clearTimeout(timer);
  }, [text, active, reduce]);

  return { shown, streaming };
}

function expectedScore(r1: number, r2: number) {
  return 1 / (1 + Math.pow(10, (r2 - r1) / 400));
}

function DemoCard() {
  const [idx, setIdx] = useState(0);
  const [aDone, setADone] = useState(false);
  const [bDone, setBDone] = useState(false);
  const [picked, setPicked] = useState<"a" | "b" | null>(null);
  const [delta, setDelta] = useState(0);
  const [board, setBoard] = useState(() =>
    Object.fromEntries(DEMO_BOARD.map((r) => [r.systemName, r.rating])),
  );
  const pair = PAIRS[idx]!;

  const a = useWordStream(pair.a.text, true, useCallback(() => setADone(true), []));
  const b = useWordStream(pair.b.text, true, useCallback(() => setBDone(true), []));

  const ready = aDone && bDone && !picked;

  const vote = (pick: "a" | "b") => {
    if (picked) return;
    setPicked(pick);
    const win = pick === "a" ? pair.a.sys : pair.b.sys;
    const los = pick === "a" ? pair.b.sys : pair.a.sys;
    const K = 24;
    const d = Math.round(K * (1 - expectedScore(board[win] ?? 1500, board[los] ?? 1500)));
    setDelta(d);
    setBoard((prev) => ({
      ...prev,
      [win]: (prev[win] ?? 1500) + d,
      [los]: (prev[los] ?? 1500) - d,
    }));
  };

  const next = () => {
    setIdx((i) => (i + 1) % PAIRS.length);
    setADone(false);
    setBDone(false);
    setPicked(null);
  };

  const win = picked === "a" ? pair.a.sys : pair.b.sys;
  const los = picked === "a" ? pair.b.sys : pair.a.sys;

  return (
    <div className="border border-rule2 bg-card">
      <div className="flex items-baseline justify-between gap-3.5 border-b border-rule bg-paper2 px-4 py-[13px]">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-graphite">
          Pair {String(idx + 1).padStart(2, "0")} / blind
        </span>
        <span className="text-right font-serif text-sm italic">
          <span className="block font-mono text-[10.5px] not-italic tracking-[0.1em] text-graphite">
            Manuscript
          </span>
          “{pair.paper}”
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[1fr_1px_1fr]">
        <DemoCol
          label="Review A"
          who={picked ? pair.a.sys : ""}
          text={a.shown}
          streaming={a.streaming}
          win={picked === "a"}
        />
        <div className="hidden bg-rule sm:block" aria-hidden />
        <div className="h-px bg-rule sm:hidden" aria-hidden />
        <DemoCol
          label="Review B"
          who={picked ? pair.b.sys : ""}
          text={b.shown}
          streaming={b.streaming}
          win={picked === "b"}
        />
      </div>

      <div className="border-t border-rule px-4 py-[15px]">
        <div className="mb-[11px] font-mono text-[11px] uppercase tracking-[0.1em] text-graphite">
          Which review is more useful?
        </div>
        <div className="flex gap-2.5">
          {(["a", "b"] as const).map((side) => (
            <button
              key={side}
              type="button"
              disabled={!ready}
              onClick={() => vote(side)}
              className={
                "flex-1 border px-3 py-2.5 font-mono text-[13px] font-medium tracking-[0.02em] transition-colors " +
                (picked === side
                  ? "border-red bg-red text-paper"
                  : "border-ink bg-paper text-ink enabled:hover:border-red enabled:hover:bg-red enabled:hover:text-paper disabled:cursor-default disabled:opacity-60")
              }
            >
              Review {side.toUpperCase()}
            </button>
          ))}
        </div>
        {picked && (
          <div className="mt-[13px] flex items-baseline justify-between gap-3 border-t border-dashed border-rule2 pt-[13px]">
            <span className="font-mono text-[12.5px] text-ink2">
              {win} <b className="text-up">+{delta}</b> · {los}{" "}
              <b className="text-red">−{delta}</b>
            </span>
            <button
              type="button"
              onClick={next}
              className="border-b border-red pb-px font-mono text-[12.5px] text-red"
            >
              Next pair →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function DemoCol({
  label,
  who,
  text,
  streaming,
  win,
}: {
  label: string;
  who: string;
  text: string;
  streaming: boolean;
  win: boolean;
}) {
  return (
    <div className={"min-h-[186px] px-[17px] pb-[15px] pt-4" + (win ? " bg-red/[0.045]" : "")}>
      <div className="mb-[11px] flex items-baseline justify-between">
        <span
          className={
            "font-mono text-xs font-medium tracking-[0.04em]" + (win ? " text-red" : "")
          }
        >
          {label}
        </span>
        {who && <span className="font-mono text-[11px] text-redink">{who}</span>}
      </div>
      <div className="min-h-[120px] text-[14.5px] leading-[1.62] text-ink2">
        {text}
        {streaming && <span className="stream-cursor" aria-hidden />}
      </div>
    </div>
  );
}

// ─── What it is — a short statement of the project ─────────────────────────

function About() {
  return (
    <section className="border-t border-rule" id="about">
      <div className="mx-auto max-w-[1080px] px-7">
        <div className="eyebrow mb-[34px] pt-[52px]">
          <b className="font-medium text-red">01</b> What it is
        </div>
        <div className="grid grid-cols-1 items-start pb-[60px] md:grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)]">
          <div className="md:pr-11">
            <p className="font-serif text-[26px] leading-[1.32] tracking-[-0.01em] text-ink">
              ReviewArena is a Web platform for{" "}
              <em className="italic text-redink">Benchmarking AI models for automated peer-review generation </em>{" "}
              under a shared human evaluation.
            </p>
          </div>

          <div className="hidden self-stretch bg-rule md:block" aria-hidden />

          <div className="mt-6 md:mt-0 md:pl-11">
            <p className="text-[15.5px] leading-relaxed text-graphite">
              Every system reviews the same paper under identical conditions.
              Human raters read the two reviews blind, votes on which is more
              useful. The verdicts accumulate into an Elo ranking .
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── How it works — a genuine sequence, so the numerals earn their place ───

const STEPS: { n: string; title: string; body: string }[] = [
  {
    n: "i.",
    title: "Submit a manuscript",
    body: "Upload a paper or paste an arXiv link. The same paper goes to two review systems .",
  },
  {
    n: "ii.",
    title: "Read the pair of generated reviews",
    body: "Two reviews arrive with their generating systems hidden.",
  },
  {
    n: "iii.",
    title: "Vote on which is more useful",
    body: "Vote for the review that which you find more overall helpful as well as across multiple dimensions .",
  },
  {
    n: "iv.",
    title: "See the results ",
    body: "Your vote feeds a Elo-based leaderboard. See the updated ratings and confidence intervals for the two systems you just compared.",
  },
];

function HowItWorks() {
  return (
    <section className="border-t border-rule" id="how">
      <div className="mx-auto max-w-[1080px] px-7">
        <div className="eyebrow mb-[34px] pt-[52px]">
          <b className="font-medium text-red">02</b> How it works
        </div>
        <div className="pb-[60px]">
          {STEPS.map((step, i) => (
            <div
              key={step.n}
              className={
                "grid grid-cols-[40px_1fr] gap-3.5 py-[22px] pb-6 sm:grid-cols-[56px_1fr] sm:gap-[22px] " +
                (i > 0 ? "border-t border-rule " : "") +
                // deliberate asymmetry on even steps (desktop only)
                (i % 2 === 1 ? "sm:pl-10" : "")
              }
            >
              <div className="pt-[3px] font-mono text-[13px] text-red">{step.n}</div>
              <div>
                <h3 className="mb-[5px] font-serif text-xl font-medium tracking-[-0.01em]">
                  {step.title}
                </h3>
                <p className="max-w-[52ch] text-[15px] text-graphite">{step.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Standings — data is the aesthetic ─────────────────────────────────────

function Standings() {
  const { data } = useQuery({
    queryKey: ["leaderboard", null],
    queryFn: () => getLeaderboard(),
    retry: false,
  });

  const live = data?.entries ?? [];
  const isLive = live.length >= 2;
  const rows = isLive ? live.slice(0, 6) : DEMO_BOARD;
  const max = Math.max(...rows.map((r) => r.rating));
  const min = Math.min(...rows.map((r) => r.rating));

  return (
    <section className="border-t border-rule" id="leaderboard">
      <div className="mx-auto max-w-[1080px] px-7 pb-16">
        <div className="eyebrow mb-[34px] pt-[52px]">
          <b className="font-medium text-red">03</b> Standings
          <span className="ml-auto font-mono text-[11px] normal-case tracking-[0.1em] text-graphite">
            {isLive
              ? `live · ${data?.totalVotes ?? 0} votes · ${data?.totalPapers ?? 0} papers`
              : "sample data"}
          </span>
        </div>
        <table className="w-full border-collapse font-mono text-[13.5px]">
          <thead>
            <tr>
              <th className="border-b border-rule2 pb-[11px] text-left text-[10.5px] font-medium uppercase tracking-[0.12em] text-graphite">
                System
              </th>
              <th className="border-b border-rule2 pb-[11px] text-right text-[10.5px] font-medium uppercase tracking-[0.12em] text-graphite">
                Elo
              </th>
              <th className="border-b border-rule2 pb-[11px] text-right text-[10.5px] font-medium uppercase tracking-[0.12em] text-graphite">
                Votes
              </th>
              <th className="border-b border-rule2 pb-[11px] text-right text-[10.5px] font-medium uppercase tracking-[0.12em] text-graphite">
                95% CI
              </th>
              <th className="hidden w-[34%] border-b border-rule2 pb-[11px] pl-5 text-left text-[10.5px] font-medium uppercase tracking-[0.12em] text-graphite md:table-cell">
                Rating
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const half = Math.round((r.ratingCiHigh - r.ratingCiLow) / 2);
              const pct = 12 + ((r.rating - min) / (max - min || 1)) * 88;
              return (
                <tr key={r.systemName}>
                  <td className="border-b border-rule py-[13px] font-medium text-ink">
                    <span className="text-graphite">{String(i + 1).padStart(2, "0")}</span>
                    &nbsp;&nbsp;{r.systemName}
                  </td>
                  <td className="border-b border-rule py-[13px] text-right text-ink">
                    {Math.round(r.rating)}
                  </td>
                  <td className="border-b border-rule py-[13px] text-right text-ink2">
                    {r.voteCount.toLocaleString()}
                  </td>
                  <td className="border-b border-rule py-[13px] text-right text-ink2">±{half}</td>
                  <td className="hidden border-b border-rule py-[13px] pl-5 md:table-cell">
                    <span className="relative block h-[7px] border border-rule bg-paper2">
                      <i className="absolute bottom-0 left-0 top-0 block bg-red" style={{ width: `${pct}%` }} />
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mt-4 font-mono text-[11px] text-graphite">
          {isLive
            ? "Elo initialised at 1000 · K = 4 · intervals from 100 bootstrap resamples"
            : "Sample table — upload a paper and vote to start the real ladder"}
        </p>
        <Link
          to="/leaderboard"
          className="mt-4 inline-block border-b border-red pb-px font-mono text-[12.5px] text-red"
        >
          Full leaderboard, all eight dimensions →
        </Link>
      </div>
    </section>
  );
}

// ─── Closing ───────────────────────────────────────────────────────────────

function Closing() {
  return (
    <section className="border-t-[3px] border-red">
      <div className="mx-auto max-w-[1080px] px-7 pb-[70px] pt-14 text-center">
        <h2 className="mb-2 font-serif text-[clamp(26px,3.4vw,36px)] font-semibold tracking-[-0.02em]">
          Make your first <em className="font-normal italic text-redink">vote.</em>
        </h2>
        <p className="mb-[26px] text-graphite">
          Read the reviews and vote the better one.
        </p>
        <Link
          to="/upload"
          className="inline-block border border-ink bg-ink px-[26px] py-[13px] font-mono text-sm font-medium tracking-[0.02em] text-paper transition-colors hover:border-red hover:bg-red"
        >
          Start a comparison
        </Link>
      </div>
    </section>
  );
}
