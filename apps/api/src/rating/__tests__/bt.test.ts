import { describe, it, expect } from "vitest";
import {
  computeBT,
  bootstrapBTCI,
  leaderboardBT,
  preprocessForBT,
  largestStronglyConnected,
  multinomialCounts,
  btWinProbability,
  mulberry32,
  outcomeOf,
  percentile,
  DEFAULT_BT,
  type Battle,
} from "../bt.js";

const battle = (a: string, b: string, outcome: 0 | 0.5 | 1): Battle => ({ a, b, outcome });

/** n battles of `a` beating `b`, then m of `b` beating `a`. */
function record(a: string, b: string, aWins: number, bWins: number): Battle[] {
  return [
    ...Array.from({ length: aWins }, () => battle(a, b, 1)),
    ...Array.from({ length: bWins }, () => battle(a, b, 0)),
  ];
}

describe("preprocessForBT", () => {
  it("collapses repeated (matchup, outcome) triples into weights", () => {
    const { models, rows } = preprocessForBT(record("a", "b", 3, 1));
    expect(models).toEqual(["a", "b"]);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.outcome === 1)!.weight).toBe(3);
    expect(rows.find((r) => r.outcome === 0)!.weight).toBe(1);
  });

  it("keeps (a,b) and (b,a) apart — orientation carries the outcome", () => {
    const { rows } = preprocessForBT([battle("a", "b", 1), battle("b", "a", 1)]);
    expect(rows).toHaveLength(2);
  });

  it("does not grow with battle count once the matchups repeat", () => {
    const many = preprocessForBT(record("a", "b", 5000, 2500));
    expect(many.rows).toHaveLength(2);
  });
});

describe("computeBT", () => {
  it("returns nothing for an empty battle log", () => {
    const { ratings, unranked } = computeBT([]);
    expect(ratings.size).toBe(0);
    expect(unranked).toEqual([]);
  });

  it("recovers the closed form: a 3-1 record is a 400*log10(3) gap", () => {
    const { ratings, converged } = computeBT(record("a", "b", 3, 1));
    expect(converged).toBe(true);
    const gap = ratings.get("a")! - ratings.get("b")!;
    expect(gap).toBeCloseTo(400 * Math.log10(3), 6);
  });

  it("implies exactly the observed win rate", () => {
    const { ratings } = computeBT(record("a", "b", 3, 1));
    expect(btWinProbability(ratings.get("a")!, ratings.get("b")!)).toBeCloseTo(0.75, 9);
  });

  it("is invariant to battle order — the property Elo does not have", () => {
    const battles = [
      ...record("a", "b", 4, 2),
      ...record("b", "c", 3, 3),
      ...record("a", "c", 5, 1),
    ];
    const forward = computeBT(battles).ratings;
    const reversed = computeBT([...battles].reverse()).ratings;
    const shuffled = computeBT(shuffle(battles, mulberry32(7))).ratings;
    for (const slug of forward.keys()) {
      expect(reversed.get(slug)!).toBeCloseTo(forward.get(slug)!, 9);
      expect(shuffled.get(slug)!).toBeCloseTo(forward.get(slug)!, 9);
    }
  });

  it("is invariant to duplicating the whole dataset", () => {
    const battles = [...record("a", "b", 4, 2), ...record("b", "c", 3, 3)];
    const once = computeBT(battles).ratings;
    const thrice = computeBT([...battles, ...battles, ...battles]).ratings;
    for (const slug of once.keys()) {
      expect(thrice.get(slug)!).toBeCloseTo(once.get(slug)!, 9);
    }
  });

  it("rates an all-ties field dead level at INIT_RATING", () => {
    const battles = [
      battle("a", "b", 0.5),
      battle("b", "c", 0.5),
      battle("a", "c", 0.5),
    ];
    const { ratings } = computeBT(battles);
    for (const r of ratings.values()) expect(r).toBeCloseTo(DEFAULT_BT.INIT_RATING, 6);
  });

  it("counts a tie as half a win to each side", () => {
    // 2 wins + 2 ties for `a` is the same evidence as 3 wins and 1 loss.
    const withTies = [...record("a", "b", 2, 0), battle("a", "b", 0.5), battle("a", "b", 0.5)];
    const gap = (bs: Battle[]) => {
      const r = computeBT(bs).ratings;
      return r.get("a")! - r.get("b")!;
    };
    expect(gap(withTies)).toBeCloseTo(gap(record("a", "b", 3, 1)), 6);
  });

  it("orders a transitive field correctly", () => {
    const battles = [
      ...record("strong", "mid", 8, 2),
      ...record("mid", "weak", 8, 2),
      ...record("strong", "weak", 9, 1),
    ];
    const { ratings } = computeBT(battles);
    expect(ratings.get("strong")!).toBeGreaterThan(ratings.get("mid")!);
    expect(ratings.get("mid")!).toBeGreaterThan(ratings.get("weak")!);
  });

  describe("anchoring", () => {
    const battles = [...record("a", "b", 4, 2), ...record("b", "c", 3, 3)];

    it("pins the baseline slug to INIT_RATING", () => {
      const { ratings, anchor } = computeBT(battles, { baselineSlug: "b" });
      expect(anchor).toBe("BASELINE");
      expect(ratings.get("b")!).toBeCloseTo(DEFAULT_BT.INIT_RATING, 9);
    });

    it("shifts every system by the same amount, leaving gaps untouched", () => {
      const centred = computeBT(battles).ratings;
      const anchored = computeBT(battles, { baselineSlug: "b" }).ratings;
      const shift = anchored.get("b")! - centred.get("b")!;
      for (const slug of centred.keys()) {
        expect(anchored.get(slug)! - centred.get(slug)!).toBeCloseTo(shift, 9);
      }
    });

    it("falls back to mean-centring when the baseline never battled", () => {
      const { ratings, anchor } = computeBT(battles, { baselineSlug: "not-in-this-board" });
      expect(anchor).toBe("MEAN");
      const mean = [...ratings.values()].reduce((s, r) => s + r, 0) / ratings.size;
      expect(mean).toBeCloseTo(DEFAULT_BT.INIT_RATING, 6);
    });
  });

  describe("connectivity guard (Ford's condition)", () => {
    it("leaves an unbeaten system unranked instead of diverging", () => {
      const battles = [
        ...record("a", "b", 3, 3),
        battle("unbeaten", "a", 1),
        battle("unbeaten", "b", 1),
      ];
      const { ratings, unranked, converged } = computeBT(battles);
      expect(unranked).toEqual(["unbeaten"]);
      expect(ratings.has("unbeaten")).toBe(false);
      expect([...ratings.keys()].sort()).toEqual(["a", "b"]);
      expect(converged).toBe(true);
      for (const r of ratings.values()) expect(Number.isFinite(r)).toBe(true);
    });

    it("leaves a winless system unranked", () => {
      const battles = [
        ...record("a", "b", 3, 3),
        battle("a", "winless", 1),
        battle("b", "winless", 1),
      ];
      expect(computeBT(battles).unranked).toEqual(["winless"]);
    });

    it("ranks a system that only ever tied — a tie connects both ways", () => {
      const battles = [...record("a", "b", 3, 3), battle("a", "drawer", 0.5)];
      const { ratings, unranked } = computeBT(battles);
      expect(unranked).toEqual([]);
      expect(ratings.has("drawer")).toBe(true);
    });

    it("ranks nobody when a single battle leaves no cycle at all", () => {
      const { ratings, unranked } = computeBT([battle("a", "b", 1)]);
      expect(ratings.size).toBe(0);
      expect(unranked).toEqual(["a", "b"]);
    });
  });
});

describe("largestStronglyConnected", () => {
  it("picks the bigger component when the field splits", () => {
    const { models, rows } = preprocessForBT([
      ...record("a", "b", 1, 1),
      ...record("b", "c", 1, 1),
      battle("x", "y", 1),
    ]);
    const members = largestStronglyConnected(rows, models.length).map((i) => models[i]!);
    expect(members.sort()).toEqual(["a", "b", "c"]);
  });
});

describe("bootstrapBTCI", () => {
  const battles = [
    ...record("strong", "mid", 30, 10),
    ...record("mid", "weak", 28, 12),
    ...record("strong", "weak", 34, 6),
  ];

  it("returns an empty map for no battles", () => {
    expect(bootstrapBTCI([]).size).toBe(0);
  });

  it("brackets every point estimate: ciLow <= rating <= ciHigh", () => {
    for (const iv of bootstrapBTCI(battles, 100).values()) {
      expect(iv.ciLow).toBeLessThanOrEqual(iv.rating);
      expect(iv.rating).toBeLessThanOrEqual(iv.ciHigh);
    }
  });

  it("is reproducible for a fixed seed and moves for a different one", () => {
    const a = bootstrapBTCI(battles, 50, {}, mulberry32(1));
    const b = bootstrapBTCI(battles, 50, {}, mulberry32(1));
    const c = bootstrapBTCI(battles, 50, {}, mulberry32(2));
    expect([...b.values()].map((v) => v.rating)).toEqual([...a.values()].map((v) => v.rating));
    expect([...c.values()].map((v) => v.rating)).not.toEqual([...a.values()].map((v) => v.rating));
  });

  it("separates a dominant system's interval from a weak one's", () => {
    const ci = bootstrapBTCI(battles, 200);
    expect(ci.get("strong")!.ciLow).toBeGreaterThan(ci.get("weak")!.ciHigh);
  });

  it("lands near the point estimate", () => {
    // The bootstrap median is not the MLE — resampling a skewed likelihood
    // biases it slightly — so the check is that it stays well inside its own
    // interval rather than that it reproduces the point estimate exactly.
    const ci = bootstrapBTCI(battles, 200);
    const point = computeBT(battles).ratings;
    for (const [slug, iv] of ci) {
      expect(Math.abs(iv.rating - point.get(slug)!)).toBeLessThan(
        0.25 * (iv.ciHigh - iv.ciLow),
      );
    }
  });

  it("counts battles per system the way the Elo bootstrap does", () => {
    const ci = bootstrapBTCI(battles, 20);
    expect(ci.get("strong")!.voteCount).toBe(80);
    expect(ci.get("mid")!.voteCount).toBe(80);
    expect(ci.get("weak")!.voteCount).toBe(80);
  });

  it("keeps the baseline pinned in every resample, so its CI has zero width", () => {
    const ci = bootstrapBTCI(battles, 100, { baselineSlug: "mid" });
    const iv = ci.get("mid")!;
    expect(iv.ciHigh - iv.ciLow).toBeCloseTo(0, 9);
  });
});

describe("leaderboardBT", () => {
  const battles = [
    ...record("strong", "mid", 30, 10),
    ...record("mid", "weak", 28, 12),
    ...record("strong", "weak", 34, 6),
  ];

  it("reports the full-data fit as the rating, like FastChat", () => {
    const { rows } = leaderboardBT(battles, 50);
    const point = computeBT(battles).ratings;
    for (const [slug, iv] of rows) expect(iv.rating).toBeCloseTo(point.get(slug)!, 9);
  });

  it("takes the interval from the bootstrap quantiles", () => {
    const { rows } = leaderboardBT(battles, 50, {}, mulberry32(4));
    const ci = bootstrapBTCI(battles, 50, {}, mulberry32(4));
    for (const [slug, iv] of rows) {
      expect(iv.ciLow).toBe(ci.get(slug)!.ciLow);
      expect(iv.ciHigh).toBe(ci.get(slug)!.ciHigh);
      expect(iv.voteCount).toBe(80);
    }
  });

  it("reports the anchor of the full fit", () => {
    expect(leaderboardBT(battles, 10, { baselineSlug: "mid" }).anchor).toBe("BASELINE");
    expect(leaderboardBT(battles, 10, { baselineSlug: "absent" }).anchor).toBe("MEAN");
    expect(leaderboardBT(battles, 10, { baselineSlug: "mid" }).rows.get("mid")!.rating).toBeCloseTo(1000, 9);
  });

  it("returns an empty board for no battles", () => {
    expect(leaderboardBT([]).rows.size).toBe(0);
  });
});

describe("multinomialCounts", () => {
  it("always distributes exactly n draws", () => {
    const rng = mulberry32(3);
    const probs = [0.5, 0.2, 0.2, 0.1];
    for (const n of [0, 1, 17, 5000]) {
      const counts = multinomialCounts(n, probs, rng);
      expect(counts.reduce((s, c) => s + c, 0)).toBe(n);
      expect(counts.every((c) => c >= 0)).toBe(true);
    }
  });

  it("tracks the category probabilities on average", () => {
    const rng = mulberry32(4);
    const probs = [0.7, 0.3];
    const n = 20000;
    const counts = multinomialCounts(n, probs, rng);
    expect(counts[0]! / n).toBeCloseTo(0.7, 2);
  });

  it("stays exact for a large n where a pmf recursion would underflow", () => {
    // (1-p)^n = 0.5^200000 underflows to 0 in float64; the geometric-gap
    // sampler never forms that term.
    const counts = multinomialCounts(200_000, [0.5, 0.5], mulberry32(5));
    expect(counts.reduce((s, c) => s + c, 0)).toBe(200_000);
    expect(counts[0]! / 200_000).toBeCloseTo(0.5, 2);
  });
});

function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("percentile", () => {
  it("matches numpy linear interpolation on a known sample", () => {
    // np.percentile([10,20,30,40], [2.5, 50, 97.5])
    //   = array([10.75, 25. , 39.25])
    const data = [10, 20, 30, 40];
    expect(percentile(data, 0.025)).toBeCloseTo(10.75, 6);
    expect(percentile(data, 0.5)).toBeCloseTo(25, 6);
    expect(percentile(data, 0.975)).toBeCloseTo(39.25, 6);
  });
});

describe("outcomeOf", () => {
  it("maps A / B / TIE to 1 / 0 / 0.5", () => {
    expect(outcomeOf("A")).toBe(1);
    expect(outcomeOf("B")).toBe(0);
    expect(outcomeOf("TIE")).toBe(0.5);
  });
});
