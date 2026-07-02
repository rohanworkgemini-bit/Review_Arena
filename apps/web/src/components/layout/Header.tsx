import { Link, NavLink } from "react-router-dom";
import { Trophy, Vote, Shield } from "lucide-react";
import { cn } from "@/lib/cn";

// No standalone "Compare" entry — /compare requires a paperId in the URL,
// so it can only be reached by uploading a paper first: submit content →
// land directly on the comparison view. The brand mark links to / (Home).
const navItems = [
  { to: "/upload", label: "Vote", icon: Vote },
  { to: "/leaderboard", label: "Leaderboard", icon: Trophy },
  { to: "/admin", label: "Admin", icon: Shield },
];

// Mobile-only top bar — on lg+ the Sidebar handles nav instead. Kept as
// a separate component so the lg+ flex layout stays clean. Flat and
// opaque: 1px hairline, active entry marked with the red-pen accent.
export function Header() {
  return (
    <header className="sticky top-0 z-20 border-b bg-background lg:hidden">
      <div className="container flex h-14 items-center justify-between gap-4">
        <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span
            aria-hidden
            className="flex h-7 w-7 items-center justify-center border bg-card font-serif text-sm font-semibold text-primary"
          >
            R
          </span>
          <span className="hidden font-serif sm:inline">ReviewArena</span>
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-1.5 border-b-2 px-3 py-1.5 transition-colors hover:bg-accent",
                  isActive
                    ? "border-primary font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )
              }
            >
              <item.icon className="h-4 w-4" />
              <span className="hidden sm:inline">{item.label}</span>
            </NavLink>
          ))}
        </nav>
      </div>
    </header>
  );
}
