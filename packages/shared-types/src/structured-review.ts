import { z } from "zod";

// The typed shape every review adapter returns. Stored as Review.structured.
// Modelled on the ICLR/NeurIPS review form so each system's output maps
// cleanly without translation.

export const StructuredReviewSchema = z.object({
  summary: z.string(),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
  questions: z.array(z.string()),
  // Numeric ratings on a 1–10 scale (ICLR-style). Optional because some
  // baselines don't produce them.
  soundness: z.number().min(1).max(10).optional(),
  presentation: z.number().min(1).max(10).optional(),
  contribution: z.number().min(1).max(10).optional(),
  // min 0: the ICLR 2026 overall scale includes 0 (Strong reject); the
  // other venues' scales (1-6, 1-5 with halves) fit inside [0, 10] as-is.
  overallRating: z.number().min(0).max(10).optional(),
  confidence: z.number().min(1).max(5).optional(),
});

export type StructuredReview = z.infer<typeof StructuredReviewSchema>;
