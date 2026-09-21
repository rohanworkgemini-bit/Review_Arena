import { Router } from "express";
import { ARENA_DISABLED_MESSAGE, isArenaEnabled } from "../settings.js";

/**
 * The handful of runtime switches the public site needs to render itself.
 *
 * Unauthenticated on purpose: it carries no data a visitor could not infer
 * by pressing the upload button, and the upload page has to know before
 * the visitor picks a file — a banner that only appears after a failed
 * submit is a worse version of the same information.
 *
 * Advisory, not the gate. /papers and /papers/arxiv enforce the switch
 * themselves (a client can ignore anything we say here), so this endpoint
 * exists to explain the refusal, not to cause it.
 */
export function publicConfigRouter(): Router {
  const router = Router();

  router.get("/config", async (_req, res, next) => {
    try {
      const arenaEnabled = await isArenaEnabled();
      res.json({
        arenaEnabled,
        // Null rather than the message when enabled, so the client has one
        // thing to check instead of two that can disagree.
        arenaDisabledMessage: arenaEnabled ? null : ARENA_DISABLED_MESSAGE,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
