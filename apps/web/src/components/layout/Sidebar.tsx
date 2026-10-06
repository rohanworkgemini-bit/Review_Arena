import { Link, NavLink } from "react-router-dom";
import {
  Trophy,
  Vote,
  Shield,
  ChevronsLeft,
  ChevronsRight,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";

// Persistent left rail. Only rendered on lg+ — small screens get the
// fallback Header (top bar). Width is driven by the CSS variable
// --sidebar-w on the layout root so sticky bottom bars on /compare and
// /upload can offset themselves without prop drilling.
//
// Manuscript register: paper surface, 1px rule hairline, mono nav
// labels. The active item carries the red pen — text + 2px left rule.

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

const navItems: NavItem[] = [
  { to: "/upload", label: "Vote", icon: Vote },
  { to: "/leaderboard", label: "Leaderboard", icon: Trophy },
  { to: "/admin", label: "Admin", icon: Shield },
];

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  return (
    <aside
      className="sticky top-0 z-10 hidden h-screen shrink-0 flex-col border-r border-rule bg-paper transition-[width] duration-150 lg:flex"
      style={{ width: "var(--sidebar-w)" }}
    >
      {/* ─── Brand row ─────────────────────────────────────────────── */}
      <div className="flex h-14 items-center justify-between border-b border-rule px-3">
        <Link to="/" className="flex min-w-0 items-baseline font-serif font-semibold">
          {collapsed ? (
            <span className="mx-auto text-lg">R</span>
          ) : (
            <span className="truncate tracking-tight">ReviewArena</span>
          )}
        </Link>
        {!collapsed && (
          <button
            type="button"
            onClick={onToggle}
            className="p-1 text-graphite transition-colors hover:bg-paper2 hover:text-ink"
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
          >
            <ChevronsLeft className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* ─── Nav (mono labels, red left rule on the active entry) ──── */}
      <nav className="flex flex-col gap-0.5 p-2">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            title={collapsed ? item.label : undefined}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2 border-l-2 border-transparent px-2.5 py-1.5 font-mono text-[12.5px] tracking-[0.02em] transition-colors hover:bg-paper2 hover:text-ink",
                isActive ? "border-red text-red" : "text-graphite",
                collapsed && "justify-center border-l-0 px-0",
              )
            }
          >
            <item.icon className="h-4 w-4 shrink-0" />
            {!collapsed && <span className="truncate">{item.label}</span>}
          </NavLink>
        ))}
      </nav>

      {/* ─── Footer: version / collapse ────────────────────────────── */}
      <div className="mt-auto border-t border-rule p-2">
        {collapsed ? (
          <button
            type="button"
            onClick={onToggle}
            className="flex w-full items-center justify-center p-2 text-graphite transition-colors hover:bg-paper2 hover:text-ink"
            title="Expand sidebar"
            aria-label="Expand sidebar"
          >
            <ChevronsRight className="h-4 w-4" />
          </button>
        ) : (
          <div className="px-2 py-1 font-mono text-[11px] text-graphite">
            v0.1 · anon session
          </div>
        )}
      </div>
    </aside>
  );
}
