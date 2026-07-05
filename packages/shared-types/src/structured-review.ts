import { z } from "zod";

// The typed shape every review adapter returns. Stored as Review.structured.
// Modelled on the ICLR/NeurIPS review form so DeepReviewer's output maps
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
  overallRating: z.number().min(1).max(10).optional(),
  confidence: z.number().min(1).max(5).optional(),
});

export type StructuredReview = z.infer<typeof StructuredReviewSchema>;
