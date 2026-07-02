import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Footer } from "@/components/layout/Footer";
import { getLeaderboard } from "@/lib/api";

// Public landing page. Editorial register: warm paper canvas, IBM Plex
// Serif headlines, Plex Mono for data, oxblood reserved for actions.
// Left-aligned content column inside a wider container — the empty
// right side is deliberate. No decoration: no particles, gradients,
// glows, shadows, or rounded corners.

export function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <TopBar />
      <main>
        <Hero />
        <HowItWorks />
        <Standings />
        <Closing />
      </main>
      <Footer />
    </div>
  );
}

// ─── Top bar ───────────────────────────────────────────────────────────────

function TopBar() {
  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
        <Link to="/" className="font-serif text-lg font-semibold tracking-tight">
          ReviewArena
        </Link>
        <nav className="flex items-center gap-6 text-sm">
          <Link
            to="/leaderboard"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            Leaderboard
          </Link>
          <Link
            to="/admin"
            className="hidden text-muted-foreground transition-colors hover:text-foreground sm:inline"
          >
            Admin
          </Link>
          <Link
            to="/upload"
            className="font-medium text-primary underline decoration-primary/40 underline-offset-4 transition-colors hover:decoration-primary"
          >
            Start a comparison
          </Link>
        </nav>
      </div>
    </header>
  );
}

// ─── Hero ──────────────────────────────────────────────────────────────────

function Hero() {
  return (
    <section className="border-b">
      <div className="mx-auto max-w-5xl px-6 py-24 lg:py-32">
        <div className="max-w-2xl">
          <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            Blind pairwise evaluation
          </p>
          <h1 className="mt-6 text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
            Compare AI peer review systems.
          </h1>
          <p className="mt-6 text-lg leading-relaxed text-muted-foreground">
            Upload a paper. Read two anonymous reviews side by side. Vote on
            which would actually help the author. Your votes feed a
            per-dimension Elo ladder — two reviews, unknown authors, your
            verdict.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-6">
            <Link
              to="/upload"
              className="bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              Start a comparison
            </Link>
            <Link
              to="/leaderboard"
              className="text-sm text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground"
            >
              View the leaderboard
            </Link>
          </div>
          <p className="mt-14 font-mono text-xs text-muted-foreground">
            8 systems · 8 dimensions · Bradley–Terry MLE · 95% bootstrap CIs
          </p>
        </div>
      </div>
    </section>
  );
}

// ─── How it works ──────────────────────────────────────────────────────────

const STEPS: { title: string; body: string }[] = [
  {
    title: "Upload a paper",
    body: "Drop a PDF or paste an arXiv link. The paper is parsed and handed to two review systems chosen by exposure-weighted sampling.",
  },
  {
    title: "Read two blind reviews",
    body: "The reviews stream in side by side with no identities attached. Nothing marks which system wrote which — the content does the arguing.",
  },
  {
    title: "Vote",
    body: "Pick the review that would help the author more, overall and across eight dimensions: comprehensiveness, clarity, fairness, actionability, constructiveness, objectivity, relevance, technical depth.",
  },
  {
    title: "The ladder updates",
    body: "Each vote updates per-dimension Elo ratings via Bradley–Terry maximum likelihood with bootstrap confidence intervals. Identities are revealed only after you vote.",
  },
];

function HowItWorks() {
  return (
    <section className="border-b">
      <div className="mx-auto max-w-5xl px-6 py-20 lg:py-28">
        <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
          How it works
        </p>
        <div className="mt-10 max-w-3xl">
          {STEPS.map((step, i) => (
            <div
              key={step.title}
              className="grid grid-cols-[3rem_1fr] gap-4 border-t py-8 last:pb-0"
            >
              <div className="font-mono text-sm text-primary">{i + 1}</div>
              <div>
                <h3 className="text-base font-semibold">{step.title}</h3>
                <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
                  {step.body}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Standings ─────────────────────────────────────────────────────────────

// Static fallback shown until the API returns real rows (or when it has
// none yet) — realistic values so the table never reads as lorem ipsum.
const FALLBACK_ROWS = [
  { rank: 1, systemName: "GPT-5 Reviewer", systemSlug: "gpt5-reviewer", rating: 1074, ratingCiLow: 1032, ratingCiHigh: 1117, voteCount: 86 },
  { rank: 2, systemName: "Claude Reviewer", systemSlug: "claude-reviewer", rating: 1049, ratingCiLow: 1004, ratingCiHigh: 1093, voteCount: 81 },
  { rank: 3, systemName: "Gemini Reviewer", systemSlug: "gemini-reviewer", rating: 1002, ratingCiLow: 957, ratingCiHigh: 1046, voteCount: 78 },
  { rank: 4, systemName: "Marg (multi-agent)", systemSlug: "marg", rating: 971, ratingCiLow: 924, ratingCiHigh: 1019, voteCount: 74 },
  { rank: 5, systemName: "OpenReviewer 8B", systemSlug: "openreviewer-8b", rating: 943, ratingCiLow: 891, ratingCiHigh: 995, voteCount: 69 },
];

function Standings() {
  const { data } = useQuery({
    queryKey: ["leaderboard", null],
    queryFn: () => getLeaderboard(),
    retry: false,
  });

  const live = data?.entries ?? [];
  const rows = live.length >= 2 ? live.slice(0, 5) : FALLBACK_ROWS;
  const isLive = live.length >= 2;

  return (
    <section className="border-b">
      <div className="mx-auto max-w-5xl px-6 py-20 lg:py-28">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <h2 className="text-2xl font-semibold tracking-tight">
            Current standings
          </h2>
          <p className="font-mono text-xs text-muted-foreground">
            {isLive
              ? `overall · ${data?.totalVotes ?? 0} votes · ${data?.totalPapers ?? 0} papers`
              : "overall · sample data"}
          </p>
        </div>
        <div className="mt-8 overflow-x-auto">
          <table className="w-full max-w-3xl font-mono text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="py-2 pr-4 font-medium">#</th>
                <th className="py-2 pr-4 font-medium">System</th>
                <th className="py-2 pr-4 text-right font-medium">Elo</th>
                <th className="py-2 pr-4 text-right font-medium">95% CI</th>
                <th className="py-2 text-right font-medium">Votes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.systemSlug} className="border-b">
                  <td className="py-2.5 pr-4 text-muted-foreground">{i + 1}</td>
                  <td className="py-2.5 pr-4">{r.systemName}</td>
                  <td className="py-2.5 pr-4 text-right">{Math.round(r.rating)}</td>
                  <td className="py-2.5 pr-4 text-right text-muted-foreground">
                    [{Math.round(r.ratingCiLow)}, {Math.round(r.ratingCiHigh)}]
                  </td>
                  <td className="py-2.5 text-right text-muted-foreground">{r.voteCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Link
          to="/leaderboard"
          className="mt-6 inline-block text-sm text-primary underline decoration-primary/40 underline-offset-4 transition-colors hover:decoration-primary"
        >
          Full leaderboard, all eight dimensions
        </Link>
      </div>
    </section>
  );
}

// ─── Closing ───────────────────────────────────────────────────────────────

function Closing() {
  return (
    <section className="border-b">
      <div className="mx-auto max-w-5xl px-6 py-20">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight">
            Put two reviewers to work on your paper.
          </h2>
          <p className="mt-3 text-muted-foreground">
            Two reviews stream in. You decide which one would actually help.
          </p>
          <div className="mt-8">
            <Link
              to="/upload"
              className="bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              Start a comparison
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
