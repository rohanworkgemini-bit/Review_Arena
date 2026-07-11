import { Link } from "react-router-dom";

// Site-wide footer. Same component on the landing page and inside the
// AppShell so the chrome is consistent. Mono, graphite, single hairline
// above; the § tagline carries the pen.
//
// The footer sits at the bottom of the page's normal flow (not fixed
// or sticky). On short pages it naturally hugs the viewport bottom
// thanks to AppShell's flex layout (main is flex-1).
export function Footer() {
  return (
    <footer className="border-t border-rule">
      <div className="mx-auto flex max-w-[1080px] flex-col items-start justify-between gap-3 px-7 pb-10 pt-[22px] font-mono text-[11.5px] text-graphite md:flex-row md:items-baseline">
        <span>ReviewArena · benchmarking automated peer-review systems under a shared human evaluation</span>
        <div className="flex items-baseline gap-5">
          <Link to="/leaderboard" className="transition-colors hover:text-ink">
            Leaderboard
          </Link>
          <Link to="/consent" className="transition-colors hover:text-ink">
            Data processing
          </Link>
          <a
            href="https://github.com/rohanworkgemini/review-arena"
            target="_blank"
            rel="noreferrer noopener"
            className="transition-colors hover:text-ink"
          >
            GitHub
          </a>
        
        </div>
      </div>
    </footer>
  );
}
