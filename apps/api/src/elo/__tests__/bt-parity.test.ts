import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { computeBT, preprocessForBT, DEFAULT_BT } from "../bt.js";
import type { Battle } from "../elo.js";

/**
 * Parity with the upstream estimator.
 *
 * bt.ts maximises the Bradley-Terry likelihood with an MM fixed point where
 * FastChat minimises the same likelihood with scipy's L-BFGS-B. Different
 * optimisers, one MLE — this pins that claim to actual numbers rather than to
 * the argument for it.
 *
 * The fixture holds a seeded battle log and the ratings FastChat's own
 * compute_bt returns for it; regenerate with fixtures/gen-bt-fixture.py.
 *
 * The two agree to ~5e-4 Elo points rather than exactly, and the residual is
 * FastChat's: L-BFGS-B stops at gtol=1e-6 with maxiter=100, so its answer sits
 * slightly off the optimum. Measured on this fixture with FastChat's own
 * bt_loss_and_grad:
 *
 *   fastchat  NLL = 806.0176863161   |grad|inf = 3.4e-03
 *   ours      NLL = 806.0176862997   |grad|inf = 1.5e-08
 *
 * So we check two things: that we agree with FastChat to within its own
 * stopping slack, and — the claim that actually matters — that our fit
 * satisfies the Bradley-Terry score equations, which is what "this is the
 * MLE" means.
 */
interface Fixture {
  battles: Battle[];
  fastchat_bt: Record<string, number>;
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/bt-fastchat.json", import.meta.url), "utf8"),
) as Fixture;

describe("Bradley-Terry parity with FastChat", () => {
  const expected = fixture.fastchat_bt;
  const { ratings, unranked, anchor, converged } = computeBT(fixture.battles);

  it("has a well-posed fixture: every system connected, fit converged", () => {
    expect(fixture.battles.length).toBe(1200);
    expect(unranked).toEqual([]);
    expect(converged).toBe(true);
    // FastChat's default baseline is absent from this field, so its
    // scale_and_offset applies no shift — we must match its mean-centring.
    expect(anchor).toBe("MEAN");
  });

  it("reproduces every FastChat rating to within its L-BFGS stopping slack", () => {
    expect(Object.keys(expected).length).toBe(7);
    for (const [slug, fastchatRating] of Object.entries(expected)) {
      expect(ratings.get(slug)).toBeDefined();
      expect(Math.abs(ratings.get(slug)! - fastchatRating)).toBeLessThan(5e-3);
    }
  });

  it("sits at a stationary point of the likelihood — the actual MLE claim", () => {
    // At the BT optimum each system's observed win credit equals its expected
    // win credit: W_i == sum over its rows of w * pi_i / (pi_i + pi_j).
    // Residuals are in units of wins, over 1200 battles.
    expect(maxScoreResidual(ratings)).toBeLessThan(1e-7);
  });

  it("reproduces FastChat's ranking exactly", () => {
    const order = (m: Record<string, number> | Map<string, number>) =>
      [...(m instanceof Map ? m : new Map(Object.entries(m)))]
        .sort((x, y) => y[1] - x[1])
        .map(([slug]) => slug);
    expect(order(ratings)).toEqual(order(expected));
  });

  it("keeps parity on the gaps when a baseline is anchored", () => {
    // Anchoring is a rigid shift, so every pairwise gap must survive it —
    // this is what lets us deviate from FastChat's baseline choice without
    // deviating from its estimator.
    const anchored = computeBT(fixture.battles, { baselineSlug: "gpt-5.2" }).ratings;
    expect(anchored.get("gpt-5.2")!).toBeCloseTo(1000, 9);
    const slugs = Object.keys(expected);
    for (const x of slugs) {
      for (const y of slugs) {
        // Same 5e-3 budget as above: the slack is FastChat's, and a gap
        // between two of its ratings can carry it from both ends.
        expect(
          Math.abs((anchored.get(x)! - anchored.get(y)!) - (expected[x]! - expected[y]!)),
        ).toBeLessThan(1e-2);
      }
    }
  });
});

/**
 * Largest violation of the Bradley-Terry score equations at a given set of
 * ratings, in units of wins. Zero exactly at the MLE.
 */
function maxScoreResidual(ratings: Map<string, number>): number {
  const { models, rows } = preprocessForBT(fixture.battles);
  const pi = models.map((slug) =>
    Math.pow(DEFAULT_BT.BASE, (ratings.get(slug)! - DEFAULT_BT.INIT_RATING) / DEFAULT_BT.SCALE),
  );
  const observed = new Float64Array(models.length);
  const predicted = new Float64Array(models.length);
  for (const r of rows) {
    observed[r.a]! += r.weight * r.outcome;
    observed[r.b]! += r.weight * (1 - r.outcome);
    const pA = pi[r.a]! / (pi[r.a]! + pi[r.b]!);
    predicted[r.a]! += r.weight * pA;
    predicted[r.b]! += r.weight * (1 - pA);
  }
  let worst = 0;
  for (let i = 0; i < models.length; i++) {
    worst = Math.max(worst, Math.abs(observed[i]! - predicted[i]!));
  }
  return worst;
}
