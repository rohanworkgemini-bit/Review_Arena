import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { pairRouter, signPairToken, verifyPairToken } from "../pair.js";
import type { Config } from "../../config.js";

describe("pairToken", () => {
  const SECRET = "test-secret-do-not-use-in-prod";
  const payload = {
    paperId: "pap_123456789012345678",
    reviewAId: "rev_aaaaaaaaaaaaaaaaaa",
    reviewBId: "rev_bbbbbbbbbbbbbbbbbb",
    sessionId: "sess_xxxxxxxxxxxxxx",
  };

  it("round-trips a signed payload", () => {
    const token = signPairToken(payload, SECRET);
    const verified = verifyPairToken(token, SECRET);
    // The signed payload includes an `iat` timestamp that wasn't in the input payload.
    expect(verified).toMatchObject(payload);
    expect(verified?.iat).toBeDefined();
    expect(typeof verified?.iat).toBe("number");
  });

  it("rejects a token signed with a different secret", () => {
    const token = signPairToken(payload, SECRET);
    expect(verifyPairToken(token, "wrong-secret")).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const token = signPairToken(payload, SECRET);
    const [b64, mac] = token.split(".");
    const tampered = `${b64}AAAA.${mac}`;
    expect(verifyPairToken(tampered, SECRET)).toBeNull();
  });

  it("rejects garbage", () => {
    expect(verifyPairToken("", SECRET)).toBeNull();
    expect(verifyPairToken("nodot", SECRET)).toBeNull();
    expect(verifyPairToken("a.b", SECRET)).toBeNull();
  });
});

// ─── GET /pair: resume with a FAILED side ──────────────────────────────────
// Once one side of a pair FAILED the paper has < 2 GENERATING/COMPLETED
// reviews; a valid resume token must still return the pair instead of the
// NotReady the UI would poll for its whole generation budget.

const dbMock = vi.hoisted(() => ({
  db: {
    query: {
      papers: { findFirst: vi.fn() },
      reviewSystems: { findMany: vi.fn() },
      reviews: { findMany: vi.fn() },
      votes: { findMany: vi.fn() },
    },
  },
}));
vi.mock("../../db/client.js", () => dbMock);

describe("GET /pair resume", () => {
  const SECRET = "x".repeat(40);
  const sessionId = "sess_resume_test_000000";
  const paperId = "pap_resume_test_000000000";
  const sys = { slug: "s", sampleWeight: 1, outage: false, anon: "A" };
  const rows = [
    { id: "rev_a", reviewSystemId: "sysA", status: "COMPLETED", structured: { summary: "x" }, rawOutput: "x", reviewSystem: { ...sys, slug: "a" } },
    { id: "rev_b", reviewSystemId: "sysB", status: "FAILED", structured: null, rawOutput: null, reviewSystem: { ...sys, slug: "b" } },
  ];

  async function call(query: Record<string, string>) {
    const app = express();
    app.use((req, _res, next) => {
      (req as unknown as { sessionId: string }).sessionId = sessionId;
      next();
    });
    app.use(pairRouter({ PAIR_TOKEN_SECRET: SECRET } as unknown as Config));
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const qs = new URLSearchParams({ paperId, ...query }).toString();
      const r = await fetch(`http://127.0.0.1:${port}/pair?${qs}`);
      return { status: r.status, body: (await r.json()) as Record<string, any> };
    } finally {
      server.close();
    }
  }

  beforeEach(() => {
    dbMock.db.query.papers.findFirst.mockResolvedValue({
      id: paperId, userTitle: "T", extractedTitle: null, conference: "general",
    });
    dbMock.db.query.reviewSystems.findMany.mockResolvedValue([{ id: "sysA" }, { id: "sysB" }]);
    dbMock.db.query.reviews.findMany.mockResolvedValue(rows);
    dbMock.db.query.votes.findMany.mockResolvedValue([]);
  });

  it("serves the token's pair even when one side FAILED", async () => {
    const token = signPairToken({ paperId, reviewAId: "rev_a", reviewBId: "rev_b", sessionId }, SECRET);
    const { status, body } = await call({ pairToken: token });
    expect(status).toBe(200);
    expect(body.pairToken).toBe(token);
    expect(body.reviewA).toMatchObject({ reviewId: "rev_a", status: "COMPLETED" });
    expect(body.reviewB).toMatchObject({ reviewId: "rev_b", status: "FAILED", structured: null });
  });

  it("still answers NotReady without a token", async () => {
    const { status, body } = await call({});
    expect(status).toBe(404);
    expect(body.error).toBe("NotReady");
  });

  it("ignores a token for another session and falls back to NotReady", async () => {
    const token = signPairToken(
      { paperId, reviewAId: "rev_a", reviewBId: "rev_b", sessionId: "someone_else_000000" },
      SECRET,
    );
    const { status, body } = await call({ pairToken: token });
    expect(status).toBe(404);
    expect(body.error).toBe("NotReady");
  });
});
