// Operator documentation, rendered inside the admin area rather than kept
// in a file — the person running a study session is already signed in here,
// and a runbook that lives next to the buttons it describes does not drift
// as quietly as one in a repo.
//
// Everything stated here is derived from code in this repo. When the system
// changes, this changes: the six systems come from study/rotation.ts, the
// dimension list from shared-types/dimensions.ts, the commands from
// apps/api/package.json.

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// ─── Small presentational helpers ──────────────────────────────────────────

function K({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">
      {children}
    </code>
  );
}

function Pre({ children }: { children: React.ReactNode }) {
  return (
    <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-[12px] leading-relaxed">
      {children}
    </pre>
  );
}

function Table({
  head,
  rows,
}: {
  head: string[];
  rows: React.ReactNode[][];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            {head.map((h) => (
              <th
                key={h}
                className="border-b py-2 pr-4 text-left font-mono text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) => (
                <td
                  key={j}
                  className="border-b py-2 pr-4 align-top text-muted-foreground [&>strong]:font-medium [&>strong]:text-foreground"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[28px_1fr] gap-3 border-t py-3.5 first:border-t-0 first:pt-0">
      <div className="pt-[2px] font-mono text-[12px] text-muted-foreground">
        {n}
      </div>
      <div>
        <div className="text-[14px] font-medium">{title}</div>
        <div className="mt-1 space-y-2 text-[13.5px] leading-relaxed text-muted-foreground">
          {children}
        </div>
      </div>
    </div>
  );
}

// ─── Content ───────────────────────────────────────────────────────────────

const SYSTEMS: [string, string, string][] = [
  ["A", "claude-sonnet-5", "Anthropic"],
  ["B", "deepseek-v4-flash", "DeepSeek"],
  ["C", "gemini-3.8-flash", "Google"],
  ["D", "glm-5.2", "Z.ai"],
  ["E", "gpt-5.6-terra", "OpenAI"],
  ["F", "mistral-medium-3.5", "Mistral"],
];

const DIMENSIONS: [string, string][] = [
  ["Core contribution accuracy", "Does the review describe what the paper actually claims?"],
  ["Results interpretation", "Are the reported numbers read correctly?"],
  ["Comparative analysis", "Is the work placed against the right prior art?"],
  ["Evidence-based critique", "Are criticisms tied to specific parts of the paper?"],
  ["Critique clarity", "Could an author act on this?"],
  ["Completeness coverage", "Does it address the whole paper?"],
  ["Constructive tone", "Is it useful rather than dismissive?"],
  ["False or contradictory claims", "Does it invent problems that are not there?"],
];

export function DocsTab() {
  return (
    <div className="space-y-6">
      {/* ─── What this is ───────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>What ReviewArena is</CardTitle>
          <CardDescription>
            The one-paragraph version, for handing to someone new.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-[14px] leading-relaxed text-muted-foreground">
          <p>
            Six frontier language models each write a peer review of the same
            paper, under identical conditions. A person reads two of those
            reviews side by side without knowing who wrote them, and picks the
            more useful one. Those picks accumulate into a ranking of the
            systems. The question the platform exists to answer is not{" "}
            <em>can a model write a review</em> — they all can — but{" "}
            <strong className="font-medium text-foreground">
              which reviews people actually find useful, and whether a language
              model can stand in for that judgement.
            </strong>
          </p>
          <p>There are two modes, and they behave differently:</p>
          <Table
            head={["Mode", "Who uses it", "Pairing", "Judged by AI?"]}
            rows={[
              [
                <strong>Arena</strong>,
                "Anyone, from the public site",
                "Uniform random over eligible pairs",
                "No",
              ],
              [
                <strong>Study</strong>,
                "20 invited participants with a code",
                "Fixed rotation, decided in advance",
                "Yes — all six models judge every pair",
              ],
            ]}
          />
          <p>
            Both modes record the same vote: one overall preference plus a pick
            on each of eight dimensions. Study votes are tagged{" "}
            <K>mode=STUDY</K> and still count toward the live leaderboard; the
            tag exists so the offline analysis can separate them.
          </p>
        </CardContent>
      </Card>

      {/* ─── How it fits together ───────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>How the pieces fit together</CardTitle>
          <CardDescription>
            Four processes. Nothing needs a GPU — every model is a remote API.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Pre>{`browser (Vite SPA, :5173 dev)
   │
   ├─ /api/*  ──►  Node API  (:8000)  ──►  Postgres (:5432)
   │                  │
   │                  └────────────►  review-gen  (:8001, FastAPI)
   │                                     │
   │                                     ├─ Datalab Chandra   PDF → text
   │                                     ├─ arxiv2md          arXiv → text
   │                                     └─ six model APIs    text → review
   │                                                          + judging
   └─ SSE /reviews/stream/:id  ──►  live tokens while a review is written`}</Pre>
          <Table
            head={["Process", "Responsibility"]}
            rows={[
              [
                <strong>web</strong>,
                "The SPA. Voting UI, leaderboard, reveal, this admin area.",
              ],
              [
                <strong>api</strong>,
                "Everything stateful: pairing, votes, ratings, the study rotation, the judge fan-out. Owns the database.",
              ],
              [
                <strong>review-gen</strong>,
                "Every outbound model call. Parsing, review generation, judging. Stateless — it holds no data of its own.",
              ],
              [
                <strong>postgres</strong>,
                "All of it. Papers, reviews, votes, judge verdicts, participants.",
              ],
            ]}
          />
          <p className="text-[13.5px] leading-relaxed text-muted-foreground">
            The split matters operationally: <K>review-gen</K> can be restarted
            at any time without losing anything, but restarting <K>api</K>{" "}
            mid-generation leaves reviews in <K>GENERATING</K> until the sweeper
            reclaims them.
          </p>
        </CardContent>
      </Card>

      {/* ─── The lineup ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>The six systems</CardTitle>
          <CardDescription>
            One per provider. Each one both writes reviews and sits on the judge
            panel.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Table
            head={["Letter", "Slug", "Provider"]}
            rows={SYSTEMS.map(([letter, slug, provider]) => [
              <strong>{letter}</strong>,
              <span className="font-mono text-[12.5px]">{slug}</span>,
              provider,
            ])}
          />
          <p className="text-[13.5px] leading-relaxed text-muted-foreground">
            Letters are assigned alphabetically by slug and are fixed — the
            rotation below refers to them. Six is not arbitrary: it is what
            makes the study's pairing scheme work, so adding or removing a
            system breaks the design rather than just widening it.
          </p>
          <p className="text-[13.5px] leading-relaxed text-muted-foreground">
            Fairness is enforced, not assumed. Every system receives the exact
            same canonical text — same paper, same instructions, same venue
            review form — and no output cap. Token counts are recorded per
            generation so this can be checked after the fact rather than
            promised.
          </p>
        </CardContent>
      </Card>

      {/* ─── Judge panel ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>The judge panel</CardTitle>
          <CardDescription>
            Study pairs only. Arena papers are never judged.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-[14px] leading-relaxed text-muted-foreground">
          <p>
            After both reviews in a study pair are written, all six models judge
            that pair — including the two that wrote the reviews. Each judge
            sees the paper and both reviews in one request and returns a
            preference plus per-dimension picks: the same thing a human rater
            produces.
          </p>
          <p>Two details that exist for specific reasons:</p>
          <Table
            head={["Detail", "Why"]}
            rows={[
              [
                <strong>Two passes, order swapped</strong>,
                "Models favour whichever review they see first. Running both orders exposes it — when the two passes disagree, the verdict carries no preference signal, and that is recorded rather than hidden.",
              ],
              [
                <strong>Judges rate their own work</strong>,
                "Self-judgements are flagged, never dropped. A model preferring its own review is the central measurement of the thesis, so it has to be observed rather than designed away.",
              ],
            ]}
          />
          <p>
            A pair is <K>COMPLETE</K> when all six judges returned,{" "}
            <K>PARTIAL</K> when some did, <K>FAILED</K> when none did. Only{" "}
            <K>FAILED</K> excludes a battle from the leaderboard — a partial
            panel is still usable data. Re-running{" "}
            <K>rescore-missing</K> retries only the judges that are absent.
          </p>
        </CardContent>
      </Card>

      {/* ─── Study design ───────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>The study design</CardTitle>
          <CardDescription>
            Everything is decided before the first participant arrives.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Table
            head={["", "Count"]}
            rows={[
              [<strong>Participants</strong>, "20"],
              [<strong>Papers each</strong>, "2 (their own choice)"],
              [<strong>Comparisons per paper</strong>, "3"],
              [<strong>Comparisons per participant</strong>, "6"],
              [<strong>Total comparisons</strong>, "120"],
              [<strong>Distinct system pairs</strong>, "15 — every pair, 8 times each"],
            ]}
          />
          <p className="text-[13.5px] leading-relaxed text-muted-foreground">
            The pairing is a rotation: five rounds, each splitting the six
            systems into three pairs that share no system. Every participant
            gets two rounds, and across all twenty the fifteen possible pairs
            come up exactly eight times each. Nothing is left to chance, so no
            pair can end up under-sampled — which is what a 120-comparison
            budget cannot afford.
          </p>
          <p className="text-[13.5px] leading-relaxed text-muted-foreground">
            The arena draws its pairs uniformly at random for a related
            reason: with six systems there are only fifteen pairs, and 120
            comparisons is a census rather than a selection. Adaptive sampling
            solves a problem that does not exist at this scale, and its
            rating-dependent draw would need a correction in the estimator
            that ours does not apply.
          </p>
        </CardContent>
      </Card>

      {/* ─── Dimensions ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>The eight dimensions</CardTitle>
          <CardDescription>
            Every vote picks a side on all eight. The UI will not submit a
            partial vote, and neither will the server accept one.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table
            head={["Dimension", "The question it asks"]}
            rows={DIMENSIONS.map(([name, q]) => [<strong>{name}</strong>, q])}
          />
        </CardContent>
      </Card>

      {/* ─── Running a study session ────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Running the study</CardTitle>
          <CardDescription>
            What to do before the window opens, during a session, and after.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div>
            <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground">
              Once, before any participant
            </div>
            <Step n="1." title="Bring the database up and apply the schema">
              <Pre>{`sudo docker compose up -d postgres
pnpm --filter @reviewarena/api db:push
pnpm --filter @reviewarena/api db:seed`}</Pre>
              <p>
                <K>db:seed</K> should report six enabled systems. If it reports
                fewer, an API key is missing — a system with no key seeds
                disabled and will silently never be paired.
              </p>
            </Step>
            <Step n="2." title="Generate the participant codes">
              <Pre>pnpm --filter @reviewarena/api exec tsx scripts/seed-participants.ts</Pre>
              <p>
                Prints all twenty codes and which rotation each participant
                gets. Idempotent — re-running keeps existing codes. Save the
                table somewhere outside the repo; there is no recovery path if
                you lose it, and the codes are what link a participant to their
                data.
              </p>
            </Step>
            <Step n="3." title="Verify the whole pipeline with one real paper">
              <p>
                Upload one paper through <K>/study</K> and confirm the panel
                actually ran. Six providers, two passes, three pairs is
                thirty-six live API calls — this is the step that catches a
                broken key or a provider change.
              </p>
              <Pre>{`select judge_model, count(*) from judge_verdicts group by 1;   -- 6 rows
select judge_status, count(*) from reviews group by 1;         -- COMPLETE`}</Pre>
              <p>
                <strong className="font-medium text-foreground">
                  Then delete that test data.
                </strong>{" "}
                Anything left under a participant code becomes part of that
                participant's real record.
              </p>
            </Step>
          </div>

          <div>
            <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground">
              Each session, about 45–60 minutes
            </div>
            <Step n="1." title="Hand over the code in person">
              <p>
                One code per participant, never reused. Point them at{" "}
                <K>/study</K> and let them enter it themselves.
              </p>
            </Step>
            <Step n="2." title="Let them read the processing notice">
              <p>
                They must tick consent before uploading. Do not tick it for
                them, and do not paraphrase it — the wording is what the ethics
                filing covers.
              </p>
            </Step>
            <Step n="3." title="They upload two papers and make six comparisons">
              <p>
                Papers are their choice; their own work or a public preprint
                both work. Generation takes roughly 10–50 seconds per review and
                streams live, so there is something to watch. Judging runs in
                the background and does not block voting.
              </p>
            </Step>
            <Step n="4." title="Stay available, but do not steer">
              <p>
                Answer questions about the interface. Do not answer questions
                about which review is better, and do not react to their choices
                — a raised eyebrow is data contamination.
              </p>
            </Step>
            <Step n="5." title="Check the session landed before they leave">
              <p>
                Six comparisons recorded, both papers present. A participant who
                left with four is a hole in the rotation that nobody else can
                fill.
              </p>
            </Step>
          </div>

          <div>
            <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground">
              After the last participant
            </div>
            <Step n="1." title="Backfill any judging that failed">
              <Pre>pnpm --filter @reviewarena/api exec tsx scripts/rescore-missing.ts</Pre>
              <p>Run it until it reports zero papers.</p>
            </Step>
            <Step n="2." title="Export the raw data">
              <p>
                <K>Systems → export</K>, or <K>GET /admin/export.json</K>, which
                includes every judge verdict. Back it up before analysing
                anything.
              </p>
            </Step>
            <Step n="3." title="Run the analysis">
              <Pre>pnpm --filter @reviewarena/api exec tsx src/thesis-analysis.ts</Pre>
            </Step>
          </div>
        </CardContent>
      </Card>

      {/* ─── Operations ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Operations reference</CardTitle>
          <CardDescription>
            All prefixed with <K>pnpm --filter @reviewarena/api</K>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Table
            head={["Command", "What it does"]}
            rows={[
              [<K>db:push</K>, "Apply schema.ts to the database. No migration files — it diffs."],
              [<K>db:seed</K>, "Insert or update the six review systems. Safe to re-run."],
              [<K>db:browser</K>, "Read-only table viewer on :4983."],
              [<K>db:inspect</K>, "Row counts and health summary."],
              [<K>db:wipe-data</K>, "Delete papers, reviews and votes. Keeps systems and participants."],
              [<K>db:retire-system</K>, "Hard-delete one system and everything referencing it. Pre-study only."],
              [<K>db:nuke</K>, "Drop every table. There is no undo."],
            ]}
          />
          <div>
            <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground">
              When something looks wrong
            </div>
            <Table
              head={["Symptom", "Cause and fix"]}
              rows={[
                [
                  <strong>A review sticks on GENERATING</strong>,
                  "The api process restarted mid-call. The sweeper reclaims it; give it a few minutes before intervening.",
                ],
                [
                  <strong>judge_status stays RUNNING</strong>,
                  "A provider is slow or rate-limited. The cutoff is 90 minutes, after which it settles as PARTIAL or FAILED. Re-run rescore-missing.",
                ],
                [
                  <strong>A system never appears in pairs</strong>,
                  "It seeded disabled because its API key is missing. Check Systems, then check .env.",
                ],
                [
                  <strong>A system is missing from the leaderboard</strong>,
                  "Not a bug. Bradley-Terry cannot place a system until wins and losses connect it to the rest of the field.",
                ],
                [
                  <strong>Requests fail under load</strong>,
                  "Connection pool exhaustion. It is sized for twenty concurrent participants; raise DB_POOL_MAX if you exceed that.",
                ],
              ]}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
