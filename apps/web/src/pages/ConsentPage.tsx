// Data-processing notice ("/consent"). Linked from the upload page's
// required consent checkbox and from the footer. Plain content page in
// the manuscript register — no interactivity, no data fetching.
//
// Keep this page in sync with reality: the processors listed here must
// match what the pipeline actually calls (see services/review-gen
// adapters + parsing, and the deploy workflows for hosting).

const PROCESSORS: Array<{ name: string; role: string; data: string }> = [
  {
    name: "Datalab (Marker API)",
    role: "PDF parsing — converts an uploaded PDF into structured text",
    data: "The full PDF you upload",
  },
  {
    name: "arxiv2md",
    role: "Parsing for arXiv submissions (alternative to PDF upload)",
    data: "The arXiv identifier; the paper is fetched from arxiv.org",
  },
  {
    name: "OpenAI · Google (Gemini) · Anthropic · DeepSeek",
    role: "Commercial AI APIs — generate reviews and act as automated judges",
    data: "The full parsed text of your paper",
  },
  {
    name: "Modal",
    role: "GPU hosting for open-source specialist reviewers (e.g. OpenReviewer)",
    data: "The parsed text of your paper",
  },
  {
    name: "Vercel",
    role: "Hosts this web application",
    data: "Standard web traffic (requests, IP addresses in transit)",
  },
  {
    name: "Google Cloud (Cloud Run)",
    role: "Hosts the API and the review-generation service",
    data: "All application data in transit",
  },
  {
    name: "Neon",
    role: "Managed Postgres database",
    data: "Parsed paper text, generated reviews, votes and notes",
  },
];

export function ConsentPage() {
  return (
    <div className="container max-w-[720px] py-10 pb-20">
      <div className="eyebrow mb-3">Data processing</div>
      <h1 className="text-3xl font-semibold tracking-[-0.01em]">
        How ReviewArena processes your data
      </h1>
      <p className="mt-3 text-[15px] leading-relaxed text-graphite">
        ReviewArena is an academic research platform for benchmarking
        automated peer-review systems. To do that, the paper you submit is
        processed by external services — including commercial AI model APIs.
        This page states plainly what is collected, where it goes, and what
        you agree to when you tick the consent box on the upload page.
      </p>

      {/* ─── What we collect ─────────────────────────────────────────── */}
      <h2 className="mt-10 text-xl font-semibold tracking-[-0.01em]">
        What we collect
      </h2>
      <ul className="mt-3 list-disc space-y-2 pl-5 text-[14.5px] leading-relaxed text-graphite">
        <li>
          <span className="text-ink">The paper you submit</span> — the PDF (or
          arXiv identifier) and the text extracted from it. The PDF itself is
          not stored; only the parsed text is kept.
        </li>
        <li>
          <span className="text-ink">Your evaluation input</span> — votes,
          per-dimension picks, and any free-text notes you write.
        </li>
        <li>
          <span className="text-ink">An anonymous session cookie</span> — a
          random identifier used to prevent duplicate votes and abuse. No
          account, no name, no email. We do not store IP addresses with your
          votes; free-text notes should not contain personal information.
        </li>
      </ul>

      {/* ─── Where it goes ───────────────────────────────────────────── */}
      <h2 className="mt-10 text-xl font-semibold tracking-[-0.01em]">
        Where your paper goes
      </h2>
      <p className="mt-3 text-[14.5px] leading-relaxed text-graphite">
        When you submit a paper, it flows through this pipeline: the document
        is parsed to text (Datalab&rsquo;s Marker API for PDFs, arxiv2md for
        arXiv links), the same text is sent to each participating review
        system — <span className="text-ink">commercial AI model APIs</span>{" "}
        (OpenAI, Google Gemini, Anthropic, DeepSeek) and open-source
        specialist models we host on Modal — and the generated reviews are
        additionally scored by a commercial AI model acting as an automated
        judge. Each provider processes your paper&rsquo;s content under its
        own terms; API-submitted content is generally not used to train these
        providers&rsquo; models, but it does leave this application.
      </p>

      <div className="mt-5 overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              {["Service", "Purpose", "Data it receives"].map((h) => (
                <th
                  key={h}
                  className="border-b border-rule2 pb-2 pr-4 text-left font-mono text-[10.5px] font-medium uppercase tracking-[0.12em] text-graphite"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PROCESSORS.map((p) => (
              <tr key={p.name}>
                <td className="border-b border-rule py-2.5 pr-4 align-top font-medium text-ink">
                  {p.name}
                </td>
                <td className="border-b border-rule py-2.5 pr-4 align-top text-graphite">
                  {p.role}
                </td>
                <td className="border-b border-rule py-2.5 align-top text-graphite">
                  {p.data}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ─── What you should NOT upload ──────────────────────────────── */}
      <h2 className="mt-10 text-xl font-semibold tracking-[-0.01em]">
        What you should not upload
      </h2>
      <p className="mt-3 text-[14.5px] leading-relaxed text-graphite">
        Do not submit confidential manuscripts, papers under a
        double-anonymous embargo you are bound by, or documents containing
        personal or sensitive data. Submit only work you have the right to
        share — your own manuscripts, or openly available papers (e.g.
        arXiv preprints).
      </p>

      {/* ─── Research use ────────────────────────────────────────────── */}
      <h2 className="mt-10 text-xl font-semibold tracking-[-0.01em]">
        How the data is used
      </h2>
      <p className="mt-3 text-[14.5px] leading-relaxed text-graphite">
        Generated reviews, votes, dimension picks, and notes are retained and
        analysed for academic research on automated peer review, and results
        are published in aggregate (e.g. Elo rankings, statistical analyses).
        Individual votes are never published in a form linked to you — there
        is nothing to link them to beyond the anonymous session identifier.
      </p>

      <p className="mt-10 border-t border-rule pt-5 font-mono text-[11.5px] text-graphite">
        Questions or deletion requests: All the data will be deleted upon the completion of study
      </p>
    </div>
  );
}
