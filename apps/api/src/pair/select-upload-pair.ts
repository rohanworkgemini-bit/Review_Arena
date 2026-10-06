/**
 * Upload-time pair selection.
 *
 * Picks 2 systems from review_systems BEFORE generation starts, so we
 * only spend GPU/API budget on the pair the user will actually see.
 * The draw is uniform over eligible pairs (see select-pair.ts for why the
 * adaptive alternative is future work rather than a setting).
 *
 * Returns the chosen pair as slug strings, ready to be passed to
 * `orchestrator.precreateReviews(paper, slugs)`.
 */
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { reviewSystems } from "../db/schema.js";
import {
  selectPairUniform,
  type SystemForPairing,
  type SelectedPair,
} from "./select-pair.js";

export interface UploadPair {
  slugA: string;
  slugB: string;
}

/**
 * Select an upload-time pair. Returns the two chosen slugs in stable
 * (A, B) order — caller can shuffle for blinding if desired (the sampler
 * already coin-flips internally).
 */
export async function selectUploadPair(
  options: { rng?: () => number } = {},
): Promise<UploadPair | null> {
  // Pull enabled systems with the flags that decide eligibility.
  const systems = await db.query.reviewSystems.findMany({
    where: eq(reviewSystems.enabled, true),
  });
  if (systems.length < 2) return null;

  // Each system gets a synthetic reviewId="pending-{slug}" since
  // the sampler expects per-review identifiers. We never use these
  // IDs downstream — only the slugs survive into the orchestrator.
  const candidates: SystemForPairing[] = systems.map((s) => ({
    systemId: s.id,
    reviewId: `pending-${s.slug}`,
    slug: s.slug,
    sampleWeight: s.sampleWeight,
    outage: s.outage,
    anon: s.anon,
  }));

  const chosen: SelectedPair | null = selectPairUniform(candidates, {
    // No "already seen" preference at upload time — that's per-session and
    // only meaningful when a paper already has multiple completed pairs.
    rng: options.rng,
  });
  if (!chosen) return null;
  return { slugA: chosen.reviewA.slug, slugB: chosen.reviewB.slug };
}
