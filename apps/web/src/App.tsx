import { Suspense, lazy, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Header } from "@/components/layout/Header";
import { Sidebar } from "@/components/layout/Sidebar";
import { Footer } from "@/components/layout/Footer";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useWideReading } from "@/components/comparison/ReadingControls";

// Code-split each route. The leaderboard pulls in recharts (~80 KB);
// the admin page is rarely visited; reveal pulls in radar deps. Lazy
// loading them keeps the first-paint bundle small for the upload flow.
//
// LandingPage is NOT lazy — it's the first paint for every new visitor;
// loading a Suspense fallback for the homepage looks broken.
import { LandingPage } from "@/pages/LandingPage";

const LeaderboardPage = lazy(() =>
  import("@/pages/LeaderboardPage").then((m) => ({ default: m.LeaderboardPage })),
);
const UploadPage = lazy(() =>
  import("@/pages/UploadPage").then((m) => ({ default: m.UploadPage })),
);
const ComparisonPage = lazy(() =>
  import("@/pages/ComparisonPage").then((m) => ({ default: m.ComparisonPage })),
);
const RevealPage = lazy(() =>
  import("@/pages/RevealPage").then((m) => ({ default: m.RevealPage })),
);
const AdminPage = lazy(() =>
  import("@/pages/AdminPage").then((m) => ({ default: m.AdminPage })),
);
const ConsentPage = lazy(() =>
  import("@/pages/ConsentPage").then((m) => ({ default: m.ConsentPage })),
);
const InstructionsPage = lazy(() =>
  import("@/pages/InstructionsPage").then((m) => ({
    default: m.InstructionsPage,
  })),
);
// Standalone (default export) — the study flow ships its own chrome and
// deliberately hides the app shell: participants must not see the
// leaderboard while judging.
const StudyPage = lazy(() => import("@/pages/StudyPage"));

function RouteFallback() {
  // Page-level Suspense fallback. Single muted card so the layout
  // doesn't jump — the lazy chunks are usually <100 ms.
  return (
    <div className="container py-10">
      <div className="h-32 animate-pulse rounded-lg border bg-muted/20" />
    </div>
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false },
  },
});

const COLLAPSED_KEY = "sidebar-collapsed";
const EXPANDED_WIDTH = "14rem";
const COLLAPSED_WIDTH = "3.5rem";

// AppShell = the standard sidebar + header + main layout. Wrapped
// around every route EXCEPT "/" — the landing page renders full-bleed
// (no sidebar) with its own minimal top bar.
function AppShell({ children }: { children: ReactNode }) {
  const [userCollapsed, setUserCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(COLLAPSED_KEY) === "true";
  });

  useEffect(() => {
    window.localStorage.setItem(COLLAPSED_KEY, String(userCollapsed));
  }, [userCollapsed]);

  // Reading two long reviews side by side wants every pixel, so the wide
  // toggle on the comparison page folds the rail away too. Only ever an
  // override: turning wide off restores whatever the reader had chosen for
  // the sidebar, rather than forcing it open.
  const wide = useWideReading();
  const collapsed = userCollapsed || wide;

  // --sidebar-w is consumed by Sidebar itself and by any element that
  // needs to offset around the sidebar. Lives on the root layout div so
  // every descendant inherits it.
  const layoutStyle: CSSProperties = {
    ["--sidebar-w" as string]: collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH,
  };

  return (
    <div style={layoutStyle}>
      {/* editor's mark across the very top — same as the landing page */}
      <div className="h-[3px] bg-red" aria-hidden />
      <div className="relative flex min-h-[calc(100vh-3px)]">
        <Sidebar collapsed={collapsed} onToggle={() => setUserCollapsed((c) => !c)} />
        <div className="relative z-10 flex min-w-0 flex-1 flex-col">
          <Header />
          {/* main is flex-1 so on short pages the Footer still hugs the
              viewport bottom instead of floating mid-screen. Page action
              bars are sticky INSIDE main (see BottomBar), so the Footer is
              always the last thing on the page. */}
          <main className="flex-1">{children}</main>
          <Footer />
        </div>
      </div>
    </div>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ErrorBoundary>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              {/* Full-bleed marketing page — no sidebar, no header. */}
              <Route path="/" element={<LandingPage />} />
              {/* Every other route runs inside the standard app shell. */}
              <Route
                path="/leaderboard"
                element={
                  <AppShell>
                    <LeaderboardPage />
                  </AppShell>
                }
              />
              <Route
                path="/upload"
                element={
                  <AppShell>
                    <UploadPage />
                  </AppShell>
                }
              />
              <Route
                path="/compare"
                element={
                  <AppShell>
                    <ComparisonPage />
                  </AppShell>
                }
              />
              <Route
                path="/reveal"
                element={
                  <AppShell>
                    <RevealPage />
                  </AppShell>
                }
              />
              <Route
                path="/admin"
                element={
                  <AppShell>
                    <AdminPage />
                  </AppShell>
                }
              />
              <Route
                path="/instructions"
                element={
                  <AppShell>
                    <InstructionsPage />
                  </AppShell>
                }
              />
              <Route
                path="/consent"
                element={
                  <AppShell>
                    <ConsentPage />
                  </AppShell>
                }
              />
              {/* Controlled study — full-bleed, no AppShell (no leaderboard nav). */}
              <Route path="/study" element={<StudyPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
