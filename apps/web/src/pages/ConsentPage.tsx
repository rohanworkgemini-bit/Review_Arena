// Data-processing notice ("/consent"). Linked from the upload page's
// required consent checkbox and from the footer. Plain content page in
// the manuscript register — no interactivity, no data fetching.
//
// Mirrors the informed-consent document submitted to the TU Darmstadt
// Ethics Commission. Keep this page in sync with reality: the processors
// listed here must match what the pipeline actually calls (see
// services/review-gen adapters + parsing, and the deploy workflows for
// hosting), and the retention/contact statements must match the ethics
// filing.

import { useSessionId } from "../lib/useSessionId";

// Contact for data-access / deletion requests and questions.
const CONTACT_EMAIL = "rohan.gupta@stud.tu-darmstadt.de";

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
    name: "Vercel",
    role: "Hosts this web application",
    data: "Standard web traffic (requests, IP addresses in transit)",
  },
  {
    name: "Google Cloud (Cloud Run)",
    role: "Hosts the API and the review-generation service",
    data: "All application data in transit",
  },
];

export function ConsentPage() {
  const sessionId = useSessionId();
  return (
    <div className="container max-w-[720px] py-10 pb-20">
      <div className="eyebrow mb-3">Data processing</div>
      <h1 className="text-3xl font-semibold tracking-[-0.01em]">
        How ReviewArena processes your data
      </h1>
      <p className="mt-3 text-[15px] leading-relaxed text-graphite">
        ReviewArena is an academic research platform, run by the Ubiquitous
        Knowledge Processing (UKP) Lab at TU Darmstadt, for benchmarking
        automated peer-review systems by human judgement. To do that, the
        paper you submit is processed by external services — including
        commercial AI model APIs. This page states plainly what is collected,
        where it goes, and what you agree to when you tick the consent box on
        the upload page. Participation is entirely voluntary.
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
          <span className="text-ink">Your evaluation input</span> — your
          overall vote, your eight per-dimension picks, the time you took to
          decide, and any free-text notes you write.
        </li>
        <li>
          <span className="text-ink">An anonymous session identifier</span> — a
          random value stored in a browser cookie, used only to prevent
          duplicate votes. No account, no name, no e-mail. We do not store IP
          addresses together with your votes, and no age, gender or other
          demographic data is collected.
        </li>
      </ul>

      {/* ─── Where it goes ───────────────────────────────────────────── */}
      <h2 className="mt-10 text-xl font-semibold tracking-[-0.01em]">
        Where your paper goes
      </h2>
      <p className="mt-3 text-[14.5px] leading-relaxed text-graphite">
        The review systems compared here are commercial AI services, so the
        text of your paper is sent to external providers. When you submit a
        paper it flows through this pipeline: the document is parsed to text
        (Datalab&rsquo;s Marker API for PDFs, arxiv2md for arXiv links), the
        same text is sent to each participating review system —{" "}
        <span className="text-ink">commercial AI model APIs</span> (OpenAI,
        Google Gemini, Anthropic, DeepSeek) — and the generated reviews are
        additionally scored by a commercial AI model acting as an automated
        judge. Data is transmitted over encrypted connections (TLS). Under
        these providers&rsquo; API terms, submitted content is not used to
        train their models, but it does leave this application. Providers
        outside the EU are used on the basis of their Standard Contractual
        Clauses / EU-U.S. Data Privacy Framework certification.
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
        Submit only work you have the right to share — your own manuscripts, or
        openly available papers (e.g. arXiv preprints). Do not submit
        confidential manuscripts, papers under a double-anonymous embargo you
        are bound by, or documents containing personal or sensitive data. Do
        not enter personal information in free-text notes.
      </p>

      {/* ─── A note on anonymity ─────────────────────────────────────── */}
      <h2 className="mt-10 text-xl font-semibold tracking-[-0.01em]">
        A note on anonymity
      </h2>
      <p className="mt-3 text-[14.5px] leading-relaxed text-graphite">
        We collect no identifying data. However, if you submit your own
        unpublished manuscript, its{" "}
        <span className="text-ink">
          writing style could in principle reveal you
        </span>{" "}
        through author-profiling techniques. To limit this, your submitted
        paper is never published, the PDF is not persisted, free-text notes are
        manually reviewed before any use, and only aggregate results (rankings,
        statistics) are published — never an individual vote linked to a
        person. Submitting an already-public preprint (by arXiv identifier)
        avoids this risk entirely.
      </p>

      {/* ─── Research use / storage / deletion ───────────────────────── */}
      <h2 className="mt-10 text-xl font-semibold tracking-[-0.01em]">
        How the data is used, stored and deleted
      </h2>
      <p className="mt-3 text-[14.5px] leading-relaxed text-graphite">
        Generated reviews, votes, dimension picks, and notes are retained and
        analysed for academic research on automated peer review, and results
        are published only in aggregate (e.g. Elo rankings, statistical
        analyses). Study data is stored in an access-controlled, encrypted
        database operated by the UKP Lab and analysed on an encrypted work
        computer.
        Individual votes are never published in a form linked to you — there is
        nothing to link them to beyond the anonymous session identifier.{" "}
        <span className="text-ink">
          All study data is deleted upon completion of the study.
        </span>
      </p>

      {/* ─── Your rights & contact ───────────────────────────────────── */}
      <h2 className="mt-10 text-xl font-semibold tracking-[-0.01em]">
        Your rights and contact
      </h2>
      <p className="mt-3 text-[14.5px] leading-relaxed text-graphite">
        Participation is voluntary and has no consequence of any kind for you;
        you may stop at any time by closing the browser tab. Processing is based
        on your explicit consent under Art. 6 (1)(a) GDPR, with the safeguards
        of § 27 BDSG and §§ 22 ff. HDSIG, and you may withdraw it at any time
        with effect for the future. To request access to or deletion of your
        data, contact{" "}
        <a
          href={`mailto:${CONTACT_EMAIL}`}
          className="font-medium text-ink underline decoration-rule underline-offset-2"
        >
          {CONTACT_EMAIL}
        </a>{" "}
        and quote the session identifier below — it is the only way we can
        locate your data. Because results are only ever published in aggregate,
        no individual vote can be traced to you after publication.
      </p>

      {/* The caller's anonymous session id, so they can copy it into a
          deletion request. Also shown in the site-wide footer. */}
      <div className="mt-4 rounded-md border border-rule bg-paper2 px-4 py-3">
        <div className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-graphite">
          Your session identifier
        </div>
        <div className="mt-1.5 select-all break-all font-mono text-[13px] text-ink">
          {sessionId ?? "…"}
        </div>
      </div>

      <p className="mt-10 border-t border-rule pt-5 font-mono text-[11.5px] text-graphite">
        Questions or deletion requests: {CONTACT_EMAIL} · All study data is
        deleted upon completion of the study.
      </p>
    </div>
  );
}
