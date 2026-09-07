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
        <Step n="iii." title="Read both, then choose">
          Pick the review you would rather have received as the author. Then say
          which one did better on each of the eight dimensions below. You can
          call any of them a tie.
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

      <div className="mt-5">
        <Step n="i." title="Enter your code">
          It identifies your session and nothing else. No account, no name, no
          e-mail. Do not share it — it is what keeps your two papers and six
          comparisons together as one record.
        </Step>
        <Step n="ii." title="Read the data-processing notice, then accept it">
          It says exactly where your paper goes and what is kept. Worth two
          minutes before you tick the box —{" "}
          <Link
            to="/consent"
            className="font-medium text-ink underline decoration-rule underline-offset-2"
          >
            read it here
          </Link>
          . Taking part is voluntary and you can stop at any point by closing
          the tab.
        </Step>
        <Step n="iii." title="Upload two papers">
          Your choice, one at a time. Papers you know well work best — you will
          be judging whether a review understood them, which is hard to do with
          a paper you are reading for the first time.
        </Step>
        <Step n="iv." title="Make three comparisons per paper">
          Six in total. Each one is a fresh pair of reviews of that paper, and
          which systems you get is decided in advance rather than at random, so
          please work through all six.
        </Step>
        <Step n="v." title="See the systems revealed">
          After each paper you find out which models wrote the reviews you
          judged. You will not see any scores or rankings during the session —
          that is deliberate, so nothing you learn early nudges your later
          choices.
        </Step>
      </div>

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
