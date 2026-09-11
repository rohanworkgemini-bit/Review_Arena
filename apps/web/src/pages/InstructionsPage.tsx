// Participant instructions for the controlled study ("/instructions").
// Reachable from the sidebar and the mobile header.
//
// One audience: an invited participant holding a code who needs to know what
// the next hour looks like. It is written so they can read it before their
// session and arrive knowing what to expect — everything here is procedural,
// and deliberately says nothing about which systems are in the lineup or how
// they are doing.
//
// Content notes must stay true to the code: eight dimensions from
// shared-types/dimensions.ts, two papers x three comparisons from
// study/rotation.ts.

import { Link } from "react-router-dom";

const DIMENSIONS: [string, string][] = [
  ["Core contribution accuracy", "Did it understand what the paper is claiming?"],
  ["Results interpretation", "Did it read the numbers correctly?"],
  ["Comparative analysis", "Did it place the work against the right prior research?"],
  ["Evidence-based critique", "Are the criticisms tied to specific parts of the paper?"],
  ["Critique clarity", "Could an author actually act on this?"],
  ["Completeness coverage", "Did it look at the whole paper, or just the abstract?"],
  ["Constructive tone", "Is it trying to help, or just to find fault?"],
  ["False or contradictory claims", "Did it invent problems that are not there?"],
];

function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-11 text-xl font-semibold tracking-[-0.01em]">{children}</h2>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 text-[14.5px] leading-relaxed text-graphite">{children}</p>
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
    <div className="grid grid-cols-[32px_1fr] gap-3 border-t border-rule py-4 first:border-t-0">
      <div className="pt-[2px] font-mono text-[13px] text-red">{n}</div>
      <div>
        <div className="font-serif text-[17px] font-medium tracking-[-0.01em]">
          {title}
        </div>
        <div className="mt-1.5 text-[14.5px] leading-relaxed text-graphite">
          {children}
        </div>
      </div>
    </div>
  );
}

export function InstructionsPage() {
  return (
    <div className="container max-w-[720px] py-10 pb-20">
      <div className="eyebrow mb-3">For study participants</div>
      <h1 className="text-3xl font-semibold tracking-[-0.01em]">
        Taking part in the study
      </h1>
      <p className="mt-3 text-[15px] leading-relaxed text-graphite">
   You read two
        reviews of the same paper without knowing who wrote them, and pick the
        one you would rather have received.
      </p>
      <p className="mt-3 text-[15px] leading-relaxed text-graphite">
        The study is a small, invited group. If you were given a code like{" "}
        <span className="font-mono text-ink">maple-1553</span>, this page is for
        you — it describes your whole session, start to finish. It runs at{" "}
        <Link
          to="/study"
          className="font-medium text-ink underline decoration-rule underline-offset-2"
        >
          /study
        </Link>
        .
      </p>

      {/* ─── The session, step by step ───────────────────────────────── */}
      <H2>Your session, step by step</H2>
      <P>
        In total you will make{" "}
        <span className="text-ink">six pairwise judgements</span> across two
        papers of your own choosing.
      </P>

      <div className="mt-5">
        <Step n="1." title="Enter your code">
          You are given a link and a code.
        </Step>
        <Step n="2." title="Bring a paper you know well">
          Your own published paper, if it is publicly available, or any public
          paper you have read before. Please avoid submitting an unpublished paper, if you do so please inform us with your session ID so that we can identify and delete it after the judgement is performed.
        </Step>
        <Step n="3." title="Pick the review format, upload, and accept the notice">
          Choose which venue's review form the systems should follow, then
          either attach a PDF or paste an arXiv link. The upload button stays
          disabled until you tick the data-processing box under it; the full
          text is in the{" "}
          <Link
            to="/consent"
            className="font-medium text-ink underline decoration-rule underline-offset-2"
          >
            data-processing document
          </Link>{" "}
        . Expect one to two minutes for
          the paper to be parsed and the reviews written.
        </Step>
        <Step n="4." title="Read the pair, left and right">
          Two reviews of your paper, side by side and aligned section by
          section. Neither is labelled. The tools described further down are
          there to make the reading easier.
        </Step>
        <Step n="5." title="Cast all eight dimension votes and the overall verdict">
          All nine picks are required before the vote submits. Each may be{" "}
          <span className="text-ink">A</span>,{" "}
          <span className="text-ink">B</span> or a tie, and each has an optional
          note. Then the same again for the other two pairs of that paper —
          three per paper, and which systems you are shown follows a fixed
          rotation rather than a random draw, so please work through all three.
        </Step>
        <Step n="6." title="Then your second paper, the same way">
          Three more comparisons, six pairwise judgements in total. The second
          paper cannot be uploaded until the first is finished. After each paper
          you find out which models wrote the reviews you judged — identities
          only. No scores or rankings during the session, so that nothing you
          learn early nudges your later choices.
        </Step>
      </div>

      {/* ─── The eight dimensions ────────────────────────────────────── */}
      <H2>What to look for</H2>
      <P>
        Every comparison asks the same eight questions. They are the dimensions of review quality that the study is measuring, and they are the same ones that the systems were trained to optimize for. You can read them all at once, or one at a time as you go.
      </P>

      {/* ─── The reading tools ───────────────────────────────────────── */}
      <H2>Tools while you read</H2>

      <div className="mt-5">
        <Step n="—" title="The two reviews line up section by section">
          Summary sits beside Summary, Weaknesses beside Weaknesses, all the
          way down. So you compare by looking across, not by scrolling up and
          down hunting for the matching part. If one review skipped a section
          entirely, its side says so rather than quietly closing the gap —
          that absence is worth seeing.
        </Step>

        <Step n="—" title="Highlight anything that strikes you">
          Select a sentence by left click and drag over teh text, a short list appears; choose which of the
          eight dimensions it belongs to and the passage takes that colour.
          Hover a coloured passage later and it tells you which dimension you
          filed it under. Click it to remove it.
          <br />
          <br />
          This is purely a memory aid for you. Highlights are never submitted,
          never scored, and nobody sees them — so mark up as much or as little
          as you like.
        </Step>

        <Step n="—" title="Rate as you go, not all at the end">
          Once you start scrolling, a bar appears at the top of the screen with
          one dimension on it and the same three choices. When you notice that
          one review is clearer, you have an option to record it right away. You can go to next or previous dimension any time.
          you can also change the judgment later using the buttons below or on the top bar.
        </Step>


        <Step n="—" title="Make the text comfortable">
          The controls above the reviews change the text size and widen the
          columns just below the papers titles.
        </Step>
      </div>

      <P>
        One reassurance: if your browser reloads or you close the tab by
        accident, your answers, notes and highlights come back. Nothing is
        submitted until you press the button that casts your vote.
      </P>

      <P>
        That is everything. Thank you for giving up an hour to this — and enjoy
        the reading.
      </P>

      <p className="mt-11 border-t border-rule pt-5 font-mono text-[11.5px] text-graphite">
        ReviewArena is research software from the UKP Lab, TU Darmstadt. See the{" "}
        <Link to="/consent" className="underline decoration-rule underline-offset-2">
          data-processing notice
        </Link>{" "}
        for how your data is handled.
      </p>
    </div>
  );
}
