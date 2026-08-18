// Minimal read-only web UI for the database. Drizzle Studio can't run on
// Node 24 with the pinned drizzle-kit (it patches undici internals that
// no longer exist), so this covers the "just let me look at the data"
// case with zero extra dependencies — node:http + the pg pool we already
// depend on.
//
//   pnpm --filter @reviewarena/api exec tsx scripts/db-browser.ts
//   DATABASE_URL="postgresql://reviewarena:reviewarena@localhost:5432/reviewarena" \
//     pnpm --filter @reviewarena/api exec tsx scripts/db-browser.ts --port=4983
//
// Read-only by construction: every query is a SELECT, table names come
// from pg_tables (never from the URL), and it binds to 127.0.0.1 only.

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
// scripts/db-browser.ts → repo-root .env is 4 dirs up.
loadEnv({ path: resolve(fileURLToPath(import.meta.url), "../../../../.env") });

import { createServer } from "node:http";
import { Pool } from "pg";

const args = process.argv.slice(2);
const PORT = Number(args.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 4983);
const PAGE = 50;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

function preview(v: unknown): { short: string; long: string | null } {
  if (v === null || v === undefined) return { short: "∅", long: null };
  if (v instanceof Date) return { short: v.toISOString().replace("T", " ").slice(0, 19), long: null };
  const full = typeof v === "object" ? JSON.stringify(v, null, 2) : String(v);
  const flat = full.replace(/\s+/g, " ");
  return flat.length > 70
    ? { short: flat.slice(0, 69) + "…", long: full }
    : { short: flat, long: null };
}

const PAGE_CSS = `
:root { color-scheme: light dark; --bg:#fff; --fg:#16181d; --mut:#6b7280; --line:#e5e7eb; --accent:#2563eb; --head:#f8fafc; }
@media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --fg:#e6e8ec; --mut:#9199a6; --line:#252a33; --accent:#7aa2f7; --head:#161a21; } }
* { box-sizing: border-box; }
body { margin:0; font:13px/1.5 ui-sans-serif,-apple-system,"Segoe UI",sans-serif; background:var(--bg); color:var(--fg); display:flex; min-height:100vh; }
nav { width:230px; flex:none; border-right:1px solid var(--line); padding:16px 0; position:sticky; top:0; height:100vh; overflow:auto; }
nav h1 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--mut); margin:0 16px 4px; }
nav .db { margin:0 16px 14px; font-size:11px; color:var(--mut); word-break:break-all; }
nav a { display:flex; justify-content:space-between; gap:8px; padding:6px 16px; color:var(--fg); text-decoration:none; }
nav a:hover { background:var(--head); }
nav a.on { background:var(--head); color:var(--accent); font-weight:600; box-shadow:inset 2px 0 0 var(--accent); }
nav a .n { color:var(--mut); font-variant-numeric:tabular-nums; font-weight:400; }
main { flex:1; padding:20px 24px; overflow:auto; min-width:0; }
h2 { margin:0 0 2px; font-size:16px; }
.meta { color:var(--mut); margin-bottom:14px; font-size:12px; }
.scroll { overflow-x:auto; border:1px solid var(--line); border-radius:6px; }
table { border-collapse:collapse; width:100%; font-variant-numeric:tabular-nums; }
th, td { text-align:left; padding:6px 10px; border-bottom:1px solid var(--line); white-space:nowrap; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
th { position:sticky; top:0; background:var(--head); font-family:inherit; font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--mut); }
tr:hover td { background:var(--head); }
td.null { color:var(--mut); }
details { display:inline; } summary { cursor:pointer; list-style:none; color:var(--accent); }
details[open] summary { color:var(--mut); }
details pre { white-space:pre-wrap; word-break:break-word; max-width:900px; margin:6px 0 0; padding:8px; background:var(--head); border-radius:4px; font-size:12px; }
.pager { display:flex; gap:10px; align-items:center; margin-top:12px; }
.pager a { color:var(--accent); text-decoration:none; padding:4px 10px; border:1px solid var(--line); border-radius:4px; }
.pager span { color:var(--mut); }
.empty { color:var(--mut); padding:20px 0; }
`;

async function tableList() {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
  );
  const out: { name: string; n: number }[] = [];
  for (const { tablename } of rows) {
    const { rows: c } = await pool.query(`SELECT count(*)::int AS n FROM "${tablename}"`);
    out.push({ name: tablename, n: c[0].n });
  }
  return out;
}

function shell(dbLabel: string, tables: { name: string; n: number }[], active: string, body: string) {
  const links = tables
    .map(
      (t) =>
        `<a class="${t.name === active ? "on" : ""}" href="/t/${encodeURIComponent(t.name)}">` +
        `<span>${esc(t.name)}</span><span class="n">${t.n}</span></a>`,
    )
    .join("");
  return `<!doctype html><meta charset="utf-8"><title>${esc(active || "tables")} — ReviewArena DB</title>
<style>${PAGE_CSS}</style>
<nav><h1>Database</h1><div class="db">${esc(dbLabel)}</div>${links}</nav><main>${body}</main>`;
}

async function tableView(name: string, offset: number) {
  const { rows: cnt } = await pool.query(`SELECT count(*)::int AS n FROM "${name}"`);
  const total: number = cnt[0].n;
  if (total === 0) {
    return `<h2>${esc(name)}</h2><div class="meta">0 rows</div><div class="empty">This table is empty.</div>`;
  }
  const { rows: hasCreated } = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name='created_at' LIMIT 1`,
    [name],
  );
  const order = hasCreated.length ? `ORDER BY created_at DESC` : "";
  const { rows, fields } = await pool.query(
    `SELECT * FROM "${name}" ${order} LIMIT ${PAGE} OFFSET ${offset}`,
  );
  const cols = fields.map((f) => f.name);

  const head = cols.map((c) => `<th>${esc(c)}</th>`).join("");
  const body = rows
    .map(
      (r) =>
        "<tr>" +
        cols
          .map((c) => {
            const { short, long } = preview(r[c]);
            if (long) {
              return `<td><details><summary>${esc(short)}</summary><pre>${esc(long)}</pre></details></td>`;
            }
            return `<td class="${short === "∅" ? "null" : ""}">${esc(short)}</td>`;
          })
          .join("") +
        "</tr>",
    )
    .join("");

  const prev =
    offset > 0
      ? `<a href="/t/${encodeURIComponent(name)}?offset=${Math.max(0, offset - PAGE)}">← prev</a>`
      : "";
  const next =
    offset + PAGE < total
      ? `<a href="/t/${encodeURIComponent(name)}?offset=${offset + PAGE}">next →</a>`
      : "";
  const shown = `${offset + 1}–${Math.min(offset + PAGE, total)} of ${total}`;

  return `<h2>${esc(name)}</h2><div class="meta">${total} rows · ${cols.length} columns${
    hasCreated.length ? " · newest first" : ""
  }</div><div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
<div class="pager">${prev}${next}<span>${shown}</span></div>`;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const tables = await tableList();
    const host = new URL(process.env.DATABASE_URL!).hostname;
    const label =
      host === "localhost" || host === "127.0.0.1" ? "local docker Postgres" : `remote · ${host}`;

    if (url.pathname === "/") {
      const first = tables.find((t) => t.n > 0) ?? tables[0];
      res.writeHead(302, { Location: first ? `/t/${encodeURIComponent(first.name)}` : "/t/none" });
      return res.end();
    }
    const m = url.pathname.match(/^\/t\/(.+)$/);
    const name = m ? decodeURIComponent(m[1]) : "";
    // Whitelist: only tables pg_tables actually reported.
    if (!tables.some((t) => t.name === name)) {
      res.writeHead(404, { "content-type": "text/html" });
      return res.end(shell(label, tables, "", "<h2>Not found</h2><p>Pick a table on the left.</p>"));
    }
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
    const body = await tableView(name, offset);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(shell(label, tables, name, body));
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(err));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`DB browser (read-only) → http://localhost:${PORT}`);
});
