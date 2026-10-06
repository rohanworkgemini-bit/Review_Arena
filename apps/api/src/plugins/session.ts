import type { Request, Response, NextFunction } from "express";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Anonymous session id, set as an httpOnly cookie on first request.
// Used solely to dedupe / rate-limit votes. No PII is collected.
//
// The cookie is HMAC-signed (`<sid>.<sig>`): every abuse control in the
// app — vote dedupe, rate limits, upload throttles — keys on this value,
// so a client-invented sid must not be accepted. An unsigned or bad-sig
// cookie is treated as absent and a fresh signed one is minted, which
// also transparently migrates pre-signing sessions.
//
// cookie-parser (registered globally in server.ts) populates req.cookies.
const COOKIE_NAME = "ra_sid";
const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;

declare global {
  namespace Express {
    interface Request {
      sessionId: string;
    }
  }
}

function sign(sid: string, secret: string): string {
  // Domain-prefixed so a signature can never be confused with the pair-token
  // HMACs that share the secret.
  return createHmac("sha256", secret).update(`ra-session-v1:${sid}`).digest("base64url");
}

export function sessionMiddleware(secret: string) {
  return function (req: Request, res: Response, next: NextFunction): void {
    const existing = (req.cookies as Record<string, string>)[COOKIE_NAME];
    if (existing) {
      const dot = existing.lastIndexOf(".");
      if (dot > 0) {
        const sid = existing.slice(0, dot);
        const sig = existing.slice(dot + 1);
        const expected = sign(sid, secret);
        if (
          sig.length === expected.length &&
          timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
        ) {
          req.sessionId = sid;
          return next();
        }
      }
      // Unsigned, tampered, or legacy cookie: fall through and mint fresh.
    }
    const sid = randomBytes(24).toString("base64url");
    req.sessionId = sid;
    res.cookie(COOKIE_NAME, `${sid}.${sign(sid, secret)}`, {
    httpOnly: true,
    // `secure` requires HTTPS at the transport. Production always serves
    // over TLS; in dev we use http://localhost so secure would silently
    // drop the cookie. Gate on NODE_ENV.
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: ONE_YEAR_MS,
    path: "/",
    });
    next();
  };
}
