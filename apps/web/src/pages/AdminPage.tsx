import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Beaker,
  BookOpen,
  FileSearch,
  Settings as SettingsIcon,
  Layers,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { ReviewerPlayground } from "@/components/ReviewerPlayground";
import { DocsTab } from "@/components/admin/DocsTab";

// Admin dashboard. Single entry point for the thesis-runner: enter the
// ADMIN_TOKEN once, then operate across five tabs:
//   - Docs:       how the system works and how to run a study session.
//   - Playground: hit /reviews/playground to round-trip a paper through
//     one chosen system without polluting the DB.
//   - Parse:      hit /parse and /parse-arxiv to sanity-check the parser.
//   - Systems:    review_systems CRUD (enable / disable / delete).
//   - Settings:   token field + sign-out.
//
// The admin token is bearer-auth on the API side; we stash it in
// localStorage so the operator doesn't paste it every page load. This is
// NOT a real session model — it's a single-tenant thesis app. Real
// security comes from the server checking the bearer on every admin
// route; this UI gate is for visibility / convenience.

const TOKEN_KEY = "reviewarena.adminToken";

const TABS = [
  { id: "docs", label: "Docs", icon: BookOpen },
  { id: "playground", label: "Playground", icon: Beaker },
  { id: "parse", label: "Parse", icon: FileSearch },
  { id: "systems", label: "Systems", icon: Layers },
  { id: "settings", label: "Settings", icon: SettingsIcon },
] as const;
type TabId = (typeof TABS)[number]["id"];

interface ReviewSystemRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  adapterKey: string;
  enabled: boolean;
  createdAt: string;
}

async function adminFetch<T>(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`,
    },
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export function AdminPage() {
  const [token, setToken] = useState<string>(
    () => (typeof window === "undefined" ? "" : localStorage.getItem(TOKEN_KEY) ?? ""),
  );
  const [tab, setTab] = useState<TabId>("playground");

  // Persist token across reloads. Removal is handled explicitly on
  // sign-out so a transient empty string from controlled inputs doesn't
  // wipe localStorage.
  useEffect(() => {
    if (token) localStorage.setItem(TOKEN_KEY, token);
  }, [token]);

  if (!token) {
    return <TokenGate onSubmit={setToken} />;
  }

  return (
    <div className="container max-w-5xl py-8 space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Admin</h1>
        <p className="text-muted-foreground mt-1">
          Operate ReviewArena — round-trip reviews, parse papers, manage
          systems, all behind the admin token.
        </p>
      </div>

      <TabStrip current={tab} onChange={setTab} />

      <div>
        {tab === "docs" && <DocsTab />}
        {tab === "playground" && <ReviewerPlayground token={token} />}
        {tab === "parse" && <ParseTab token={token} />}
        {tab === "systems" && <SystemsTab token={token} />}
        {tab === "settings" && (
          <SettingsTab
            token={token}
            onTokenChange={setToken}
            onSignOut={() => {
              localStorage.removeItem(TOKEN_KEY);
              setToken("");
            }}
          />
        )}
      </div>
    </div>
  );
}

// ─── Token gate (shown when token is empty) ────────────────────────────────

function TokenGate({ onSubmit }: { onSubmit: (token: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="container max-w-md py-16">
      <Card>
        <CardHeader>
          <CardTitle>Admin sign-in</CardTitle>
          <CardDescription>
            Paste the <code className="font-mono text-xs">ADMIN_TOKEN</code>{" "}
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = value.trim();
              if (trimmed) onSubmit(trimmed);
            }}
            className="flex flex-col gap-3"
          >
            <input
              type="password"
              autoFocus
              placeholder="ADMIN_TOKEN"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono"
            />
            <Button type="submit" disabled={!value.trim()}>
              Unlock admin
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Tab strip ─────────────────────────────────────────────────────────────

function TabStrip({
  current,
  onChange,
}: {
  current: TabId;
  onChange: (id: TabId) => void;
}) {
  return (
    <div
      role="tablist"
      className="flex flex-wrap gap-1 rounded-lg border bg-card p-1"
    >
      {TABS.map((t) => {
        const active = current === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
              active
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <t.icon className="h-4 w-4" />
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Parse tab ─────────────────────────────────────────────────────────────
// Two thin interactive forms over the review-gen Python service: parse a
// PDF (multipart) or parse an arXiv URL/ID.
//
// These go through /api/admin/parse* — NOT the /py-api rewrite. review-gen
// requires an X-API-Key that the browser must never hold, and a Vercel
// rewrite cannot inject headers, so calling it directly 401s in prod (it
// only appeared to work locally because the Vite dev proxy adds the
// header). The API holds the shared secret server-side and is guarded by
// the same admin bearer token as every other tab.

function ParseTab({ token }: { token: string }) {
  return (
    <div className="space-y-4">
      <ParseForm
        title="Parse PDF"
        description="Multipart upload. Returns canonical ParsedPaper without touching the DB."
        mode="pdf"
        token={token}
      />
      <ParseForm
        title="Parse arXiv"
        description="Pass an arXiv URL or bare ID (e.g. 2310.06825). Returns canonical ParsedPaper."
        mode="arxiv"
        token={token}
      />
    </div>
  );
}

function ParseForm({
  title,
  description,
  mode,
  token,
}: {
  title: string;
  description: string;
  mode: "pdf" | "arxiv";
  token: string;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [arxiv, setArxiv] = useState("");
  const [resp, setResp] = useState<{ status: number; body: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true);
    setResp(null);
    try {
      let init: RequestInit;
      let url: string;
      if (mode === "pdf") {
        if (!file) {
          setResp({ status: 0, body: "Pick a PDF first." });
          return;
        }
        const fd = new FormData();
        fd.append("file", file);
        url = "/api/admin/parse";
        // No content-type header: the browser must set the multipart
        // boundary itself.
        init = { method: "POST", body: fd };
      } else {
        if (!arxiv.trim()) {
          setResp({ status: 0, body: "Enter an arXiv URL or ID." });
          return;
        }
        url = "/api/admin/parse-arxiv";
        init = {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: arxiv.trim() }),
        };
      }
      const r = await fetch(url, {
        ...init,
        headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
        credentials: "include",
      });
      const text = await r.text();
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* leave as-is */
      }
      setResp({ status: r.status, body: pretty });
    } catch (e) {
      setResp({ status: 0, body: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {mode === "pdf" ? (
          <input
            type="file"
            accept="application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm file:mr-3 file: file:border-0 file:bg-muted file:px-3 file:py-1 file:text-sm"
          />
        ) : (
          <input
            type="text"
            placeholder="https://arxiv.org/abs/2310.06825 or 2310.06825"
            value={arxiv}
            onChange={(e) => setArxiv(e.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
          />
        )}
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={run} disabled={loading}>
            {loading ? "Parsing…" : "Parse"}
          </Button>
          <code className="font-mono text-xs text-muted-foreground">
            POST {mode === "pdf" ? "/api/admin/parse" : "/api/admin/parse-arxiv"}
          </code>
        </div>
        {resp && (
          <ResponseBlock status={resp.status} body={resp.body} />
        )}
      </CardContent>
    </Card>
  );
}

function ResponseBlock({ status, body }: { status: number; body: string }) {
  return (
    <div className="rounded-md border bg-muted/40 p-2">
      <div className="mb-1 flex items-center justify-between font-mono text-[10px] text-muted-foreground">
        <span>HTTP {status}</span>
        <span>{body.length.toLocaleString()} chars</span>
      </div>
      <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
        {body || "(empty)"}
      </pre>
    </div>
  );
}

// ─── Systems tab (formerly the whole AdminPage) ────────────────────────────

function SystemsTab({ token }: { token: string }) {
  const qc = useQueryClient();

  const systemsQuery = useQuery({
    queryKey: ["admin", "systems"],
    queryFn: () => adminFetch<ReviewSystemRow[]>("/admin/review-systems", token),
    retry: false,
  });

  const toggleMutation = useMutation({
    mutationFn: (id: string) =>
      adminFetch<ReviewSystemRow>(`/admin/review-systems/${id}/toggle`, token, {
        method: "POST",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "systems"] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      adminFetch<void>(`/admin/review-systems/${id}`, token, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "systems"] }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Review systems</CardTitle>
        <CardDescription>
          Source of truth for which adapters fan out on each upload.
          Toggle to enable / disable; delete only if the system has never
          produced a review.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {systemsQuery.isLoading && (
          <div className="text-sm text-muted-foreground">Loading…</div>
        )}
        {systemsQuery.error && (
          <div className="text-sm text-destructive">
            {String(systemsQuery.error)}
          </div>
        )}
        {systemsQuery.data && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Slug</th>
                <th className="py-2 pr-3 font-medium">Name</th>
                <th className="py-2 pr-3 font-medium">Adapter</th>
                <th className="py-2 pr-3 font-medium">Enabled</th>
                <th className="py-2 pr-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {systemsQuery.data.map((s) => (
                <tr key={s.id} className="border-b">
                  <td className="py-2 pr-3 font-mono text-xs">{s.slug}</td>
                  <td className="py-2 pr-3">{s.name}</td>
                  <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">
                    {s.adapterKey}
                  </td>
                  <td className="py-2 pr-3">
                    {s.enabled ? (
                      <Badge>enabled</Badge>
                    ) : (
                      <Badge variant="outline">disabled</Badge>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => toggleMutation.mutate(s.id)}
                        disabled={toggleMutation.isPending}
                      >
                        {s.enabled ? "Disable" : "Enable"}
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Delete ${s.slug}? This only works if no reviews reference it.`,
                            )
                          ) {
                            deleteMutation.mutate(s.id);
                          }
                        }}
                        disabled={deleteMutation.isPending}
                      >
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {deleteMutation.error && (
          <div className="mt-3 text-sm text-destructive">
            {String(deleteMutation.error)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Settings tab ──────────────────────────────────────────────────────────

function SettingsTab({
  token,
  onTokenChange,
  onSignOut,
}: {
  token: string;
  onTokenChange: (next: string) => void;
  onSignOut: () => void;
}) {
  type AdminSettings = {
    judgeEnabled: boolean;
    judgeLockedOff: boolean;
    /** Raw setting: null = "all", [] = none, else the chosen subset. */
    judgeModels: string[] | null;
    /** What will actually judge an arena pair, after resolution. */
    arenaJudgeSlugs: string[];
    /** The preregistered panel — the choices available. */
    panelSlugs: string[];
  };
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ["admin-settings", token],
    queryFn: () => adminFetch<AdminSettings>("/admin/settings", token),
  });
  const patchSettings = (
    body: Partial<Pick<AdminSettings, "judgeEnabled" | "judgeModels">>,
  ) =>
    adminFetch<AdminSettings>("/admin/settings", token, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const toggleJudge = useMutation({
    mutationFn: (judgeEnabled: boolean) => patchSettings({ judgeEnabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-settings"] }),
  });

  const setJudgeModels = useMutation({
    mutationFn: (judgeModels: string[] | null) => patchSettings({ judgeModels }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-settings"] }),
  });

  const judgeEnabled = settings.data?.judgeEnabled ?? true;
  const lockedOff = settings.data?.judgeLockedOff ?? false;
  const panelSlugs = settings.data?.panelSlugs ?? [];
  const arenaJudges = settings.data?.arenaJudgeSlugs ?? [];
  const usingDefault = (settings.data?.judgeModels ?? null) === null;
  const toggleOne = (slug: string) => {
    const next = arenaJudges.includes(slug)
      ? arenaJudges.filter((s) => s !== slug)
      : [...arenaJudges, slug];
    setJudgeModels.mutate(next);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Judge panel</CardTitle>
          <CardDescription>
            Every study pair is scored by all six models, twice each with the
            reviews swapped — 36 provider calls per paper. Turn it off while
            testing the upload or voting flow; pairs then stay unjudged and{" "}
            <code className="font-mono text-xs">rescore-missing.ts</code> fills
            them in once it is back on.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant={judgeEnabled ? "destructive" : "default"}
              disabled={settings.isLoading || toggleJudge.isPending || lockedOff}
              onClick={() => toggleJudge.mutate(!judgeEnabled)}
            >
              {toggleJudge.isPending
                ? "Saving…"
                : judgeEnabled
                  ? "Turn judging off"
                  : "Turn judging on"}
            </Button>
            <Badge variant={judgeEnabled ? "default" : "outline"}>
              {settings.isLoading
                ? "checking…"
                : judgeEnabled
                  ? "running"
                  : "paused"}
            </Badge>
          </div>
          {lockedOff && (
            <p className="text-sm text-muted-foreground">
              Forced off by <code className="font-mono text-xs">JUDGE_ENABLED=false</code>{" "}
              in the environment. Remove it there before this switch will do
              anything.
            </p>
          )}
          {!judgeEnabled && !lockedOff && (
            <p className="text-sm text-muted-foreground">
              Remember to turn this back on before a real session — an unjudged
              pair contributes nothing to the judge-agreement analysis.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Arena judges</CardTitle>
          <CardDescription>
            Which models judge pairs uploaded through the open arena. Each
            selected model costs two provider calls per arena paper (the pair
            is judged in both display orders), so this is the lever for arena
            spend. Select none to leave arena pairs unjudged.{" "}
            <strong>The study is unaffected</strong>: study papers are always
            judged by the full preregistered panel, because a partial panel
            would produce judge data that cannot be compared with the rest and
            cannot be recovered afterwards.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {panelSlugs.map((slug) => {
              const on = arenaJudges.includes(slug);
              return (
                <Button
                  key={slug}
                  size="sm"
                  variant={on ? "default" : "outline"}
                  disabled={settings.isLoading || setJudgeModels.isPending}
                  onClick={() => toggleOne(slug)}
                >
                  {on ? "\u2713 " : ""}
                  {slug}
                </Button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={settings.isLoading || setJudgeModels.isPending}
              onClick={() => setJudgeModels.mutate(null)}
            >
              All (default)
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={settings.isLoading || setJudgeModels.isPending}
              onClick={() => setJudgeModels.mutate([])}
            >
              None
            </Button>
            <Badge variant="outline">
              {settings.isLoading
                ? "checking\u2026"
                : setJudgeModels.isPending
                  ? "saving\u2026"
                  : arenaJudges.length === 0
                    ? "arena pairs unjudged"
                    : `${arenaJudges.length} of ${panelSlugs.length}${usingDefault ? " (default)" : ""}`}
            </Badge>
          </div>
          {!judgeEnabled && (
            <p className="text-sm text-muted-foreground">
              Judging is switched off entirely above, so this selection has no
              effect until it is switched back on.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Admin token</CardTitle>
          <CardDescription>
            Stored in this browser's localStorage. Change to point at a
            different deployment, or sign out to clear it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <input
            type="password"
            value={token}
            onChange={(e) => onTokenChange(e.target.value.trim())}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono"
          />
          <div>
            <Button variant="destructive" onClick={onSignOut}>
              Sign out
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">About</CardTitle>
        </CardHeader>
        <CardContent>
          <DefList>
            <Def k="App">ReviewArena · single-tenant thesis build</Def>
            <Def k="Auth model">
              Bearer token sent to <code className="font-mono">/api/admin/*</code>{" "}
              + X-API-Key on review-gen
            </Def>
            <Def k="Token source">
              <code className="font-mono">ADMIN_TOKEN</code> in{" "}
              <code className="font-mono">.env</code> / Secret Manager
            </Def>
          </DefList>
        </CardContent>
      </Card>
    </div>
  );
}

function DefList({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">{children}</dl>;
}
function Def({ k, children }: { k: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd>{children}</dd>
    </>
  );
}
