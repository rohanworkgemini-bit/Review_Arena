// Public "how to use this" page ("/instructions"). Reachable from the
// sidebar and the mobile header, alongside Vote and Leaderboard.
//
// Two audiences on one page: someone who wandered in and wants to try the
// arena, and an invited participant holding a code who needs to know what
// the next hour looks like. The study half is written so a participant can
// read it before their session and arrive knowing what to expect —
// everything here is procedural, and deliberately says nothing about which
// systems are in the lineup or how they are doing.
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
      <div className="eyebrow mb-3">How it works</div>
      <h1 className="text-3xl font-semibold tracking-[-0.01em]">
        Using ReviewArena
      </h1>
      <p className="mt-3 text-[15px] leading-relaxed text-graphite">
        AI models can all write something that looks like a peer review. The
        harder question is whether the review is any{" "}
        <span className="text-ink">good</span> — and that is a judgement people
        make, not a number a benchmark reports. So we ask people. You read two
        reviews of the same paper without knowing who wrote them, and pick the
        one you would rather have received.
      </p>
      <p className="mt-3 text-[15px] leading-relaxed text-graphite">
        There are two ways to take part. Anyone can use the open arena. If
        someone from the lab gave you a code, skip ahead to{" "}
        <a
          href="#study"
          className="font-medium text-ink underline decoration-rule underline-offset-2"
        >
          taking part in the study
        </a>
        .
      </p>

      {/* ─── The arena ───────────────────────────────────────────────── */}
      <H2>Trying it yourself</H2>
      <P>
        Takes about five minutes. Nothing is kept about you beyond an anonymous
        session cookie.
      </P>
      <div className="mt-5">
        <Step n="i." title="Bring a paper">
          Upload a PDF, or paste an arXiv link. Use your own work or any public
          preprint — but not a manuscript you are reviewing confidentially for a
          venue, since the text is sent to commercial AI providers.
        </Step>
        <Step n="ii." title="Watch two reviews get written">
          Your paper goes to two systems at once and the reviews stream in live,
          usually in under a minute. You will not be told which models they are.
        </Step>
        <Step n="iii." title="Read both and say which is better">
          Answer the eight questions below — which review did better on each,
          or whether they tied — and then pick the one you would rather have
          received as the author. You can answer as you read or all at the
          end; the next section describes the tools for either.
        </Step>
        <Step n="iv." title="See who wrote them">
          The names are revealed, along with how your vote moved both systems on
          the leaderboard.
        </Step>
      </div>
      <P>
        Ready when you are —{" "}
        <Link
          to="/upload"
          className="font-medium text-ink underline decoration-rule underline-offset-2"
        >
          start a comparison
        </Link>
        .
      </P>

      {/* ─── The eight dimensions ────────────────────────────────────── */}
      <H2>What to look for</H2>
      <P>
        Every comparison asks the same eight questions. They exist because
        &ldquo;which review is better&rdquo; hides a lot — a review can be
        beautifully written and completely wrong about the paper, or blunt and
        genuinely useful.
      </P>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full border-collapse text-[13.5px]">
          <tbody>
            {DIMENSIONS.map(([name, q]) => (
              <tr key={name}>
                <td className="w-[42%] border-b border-rule py-2.5 pr-4 align-top font-medium text-ink">
                  {name}
                </td>
                <td className="border-b border-rule py-2.5 align-top text-graphite">
                  {q}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <P>
        There is no right answer, and we are not testing you. If a review is
        confidently wrong about the paper, say so — that is exactly the signal
        that is hardest to measure any other way.
      </P>

      {/* ─── The reading tools ───────────────────────────────────────── */}
      <H2>Tools while you read</H2>
      <P>
        Two reviews of the same paper is a lot to hold in your head at once.
        These are here to take some of that load off. All of them are
        optional — the comparison works perfectly well if you ignore every
        one.
      </P>

      <div className="mt-5">
        <Step n="—" title="The two reviews line up section by section">
          Summary sits beside Summary, Weaknesses beside Weaknesses, all the
          way down. So you compare by looking across, not by scrolling up and
          down hunting for the matching part. If one review skipped a section
          entirely, its side says so rather than quietly closing the gap —
          that absence is worth seeing.
        </Step>

        <Step n="—" title="Highlight anything that strikes you">
          Select a sentence and a short list appears; choose which of the
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
          one review is clearer, record it right then, while the sentence that
          convinced you is still in front of you. It will not move on by
          itself — press <span className="text-ink">Next</span> when you are
          ready for the following dimension.
          <br />
          <br />
          Anything you record there fills in the full form lower down, and the
          form still works on its own. It is the same eight answers either way.
        </Step>

        <Step n="—" title="Jump to the relevant section">
          The bar has a <span className="text-ink">jump</span> link that
          scrolls both reviews to the part that dimension is usually answered
          from — Questions for critique clarity, Weaknesses for evidence, and
          so on. It only moves the page; nothing is hidden and nothing is
          off-limits. Evidence for a dimension can sit anywhere, and often
          does.
          <br />
          <br />
          Two dimensions have no jump: completeness and tone are judged across
          a whole review, so pointing you at one section would be misleading.
        </Step>

        <Step n="—" title="Make the text comfortable">
          The controls above the reviews change the text size and widen the
          columns. Both sides always change together — you cannot enlarge one
          review and not the other, because that would quietly favour it.
        </Step>
      </div>

      <P>
        One reassurance: if your browser reloads or you close the tab by
        accident, your answers, notes and highlights come back. Nothing is
        submitted until you press the button that casts your vote.
      </P>

      {/* ─── The study ───────────────────────────────────────────────── */}
      <H2>
        <span id="study" />
        Taking part in the study
      </H2>
      <P>
        The controlled study is a small, invited group. If you were given a code
        like <span className="font-mono text-ink">maple-1553</span>, this part is
        for you. It runs at{" "}
        <Link
          to="/study"
          className="font-medium text-ink underline decoration-rule underline-offset-2"
        >
          /study
        </Link>{" "}
        and works a little differently from the open arena.
      </P>

      <P>
        In total you will make{" "}
        <span className="text-ink">six pairwise judgements</span> across two
        papers of your own choosing. Start to finish, step by step:
      </P>

      <div className="mt-5">
        <Step n="1." title="Enter your code">
          You are given a link and a code. It identifies your session and
          nothing else — no account, no name, no e-mail. Do not share it: it is
          what keeps your two papers and six comparisons together as one
          record.
        </Step>
        <Step n="2." title="Bring a paper you know well">
          Your own submitted paper, if it is publicly available, or any public
          paper you have read before. You will be judging whether a review
          understood the work, which is hard to do with a paper you are reading
          for the first time. Not a manuscript you are reviewing confidentially
          for a venue — the text is sent to commercial AI providers.
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
          and is worth two minutes first. Taking part is voluntary and you can
          stop at any point by closing the tab. Expect one to two minutes for
          the paper to be parsed and the reviews written.
        </Step>
        <Step n="4." title="Read the pair, left and right">
          Two reviews of your paper, side by side and aligned section by
          section. Neither is labelled. As you read you can select any passage
          the way you would select text anywhere else — click and drag — and a
          small menu offers the eight dimensions to tag it with. That
          highlighting is a reading aid for you only: it is never submitted and
          never stored.
        </Step>
        <Step n="5." title="Cast all eight dimension votes and the overall verdict">
          All nine picks are required before the vote submits. Each may be{" "}
          <span className="text-ink">A</span>,{" "}
          <span className="text-ink">B</span> or a tie, and each has an optional
          note. Then the same again for the other two pairs of that paper —
          three per paper, and which systems you are shown is decided in advance
          rather than at random, so please work through all three.
        </Step>
        <Step n="6." title="Then your second paper, the same way">
          Three more comparisons, six pairwise judgements in total. The second
          paper cannot be uploaded until the first is finished. After each paper
          you find out which models wrote the reviews you judged — identities
          only. No scores or rankings during the session, so that nothing you
          learn early nudges your later choices.
        </Step>
      </div>

      <P>
        That is everything. Thank you for giving up an hour to this — and enjoy
        the reading.
      </P>

      <H2>What to expect on the day</H2>
      <div className="mt-3 space-y-2.5 text-[14.5px] leading-relaxed text-graphite">
        <p>
          <span className="text-ink">About 45 minutes to an hour.</span> Most of
          it is reading. There is no time limit on any comparison and no benefit
          to rushing — we record how long you take, but only to spot votes cast
          too quickly to be real, never to compare people with each other.
        </p>
        <p>
          <span className="text-ink">Write a note when you have one.</span> Every
          comparison has an optional free-text box. A single sentence saying{" "}
          <em>why</em> you preferred one review is worth more to this research
          than the click itself, because it is the only part that explains the
          numbers. Please do not put personal information in it.
        </p>
        <p>
          <span className="text-ink">Ask about the interface, not the papers.</span>{" "}
          Whoever is running your session is glad to help with anything
          confusing, but will not tell you which review is better. That is the
          whole measurement.
        </p>
        <p>
          <span className="text-ink">Finish the session in one sitting.</span> If
          something goes wrong — a review fails to generate, the page hangs —
          say so rather than working around it. A half-finished session is a gap
          in the design that no other participant can fill.
        </p>
      </div>

      <H2>Questions people ask</H2>
      <div className="mt-3 space-y-4 text-[14.5px] leading-relaxed text-graphite">
        <div>
          <div className="text-ink">Do I need to be an expert?</div>
          <p className="mt-1">
            For the open arena, no. For the study we ask people with research
            experience, because judging whether a review understood a paper
            takes having read papers.
          </p>
        </div>
        <div>
          <div className="text-ink">Is my paper stored?</div>
          <p className="mt-1">
            The PDF is not kept — only the extracted text, which is needed to
            generate the reviews. Your paper is never published, and results
            appear only in aggregate. The{" "}
            <Link
              to="/consent"
              className="font-medium text-ink underline decoration-rule underline-offset-2"
            >
              processing notice
            </Link>{" "}
            has the full detail.
          </p>
        </div>
        <div>
          <div className="text-ink">What if both reviews are bad?</div>
          <p className="mt-1">
            Then pick the less bad one, and say why in the note. &ldquo;Both
            missed the point&rdquo; is a finding, not a failed vote.
          </p>
        </div>
        <div>
          <div className="text-ink">Can I change my mind after voting?</div>
          <p className="mt-1">
            No — once submitted, a comparison is final and the systems are
            revealed. Take the time you need before you commit.
          </p>
        </div>
      </div>

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
