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

// Mobile-only top bar — on lg+ the Sidebar handles nav instead. Flat
// paper with a 1px rule; the active entry carries the red pen.
export function Header() {
  return (
    <header className="sticky top-0 z-20 border-b border-rule bg-paper lg:hidden">
      <div className="container flex h-14 items-center justify-between gap-4">
        <Link to="/" className="font-serif font-semibold tracking-tight">
          <span className="hidden sm:inline">ReviewArena</span>
          <span className="sm:hidden">R</span>
        </Link>
        <nav className="flex items-center gap-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-1.5 border-b-2 px-3 py-1.5 font-mono text-[12.5px] tracking-[0.02em] transition-colors hover:bg-paper2",
                  isActive
                    ? "border-red text-red"
                    : "border-transparent text-graphite hover:text-ink",
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
