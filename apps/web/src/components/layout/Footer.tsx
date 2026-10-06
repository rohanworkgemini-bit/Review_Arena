import { Link } from "react-router-dom";
import { useSessionId } from "../../lib/useSessionId";

// Site-wide footer. Same component on the landing page and inside the
// AppShell so the chrome is consistent. Mono, graphite, single hairline
// above; the § tagline carries the pen.
//
// The footer sits at the bottom of the page's normal flow (not fixed
// or sticky). On short pages it naturally hugs the viewport bottom
// thanks to AppShell's flex layout (main is flex-1).
export function Footer() {
  const sessionId = useSessionId();
  return (
    <footer className="border-t border-rule">
      <div className="mx-auto flex max-w-[1080px] flex-col items-start justify-between gap-3 px-7 pt-[22px] font-mono text-[11.5px] text-graphite md:flex-row md:items-baseline">
        <span>ReviewArena · which AI writes the most useful peer review?</span>
        <div className="flex items-baseline gap-5">
          <Link to="/leaderboard" className="transition-colors hover:text-ink">
            Leaderboard
          </Link>
          <Link to="/consent" className="transition-colors hover:text-ink">
            Data processing
          </Link>
        </div>
      </div>
      {/* Anonymous session id — shown so participants can quote it in a
          data-deletion request (see /consent). No PII. */}
      <div className="mx-auto max-w-[1080px] px-7 pb-10 pt-3 font-mono text-[10.5px] text-graphite/70">
        {sessionId ? (
          <>
            Your anonymous session:{" "}
            <span className="select-all text-graphite">{sessionId}</span>
            {" "}· quote this to request deletion of your data.
          </>
        ) : (
          <>&nbsp;</>
        )}
      </div>
    </footer>
  );
}
