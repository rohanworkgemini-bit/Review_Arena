"""FastAPI entry point for the review-generation microservice.

Endpoints:
  POST /parse           — PDF → ParsedPaper via Datalab's hosted Chandra API
  POST /parse-arxiv     — arXiv ID/URL → ParsedPaper via arxiv2md
  POST /generate        — produce a structured review
  POST /stream-generate — streaming variant: yields tokens then 'done'
  POST /judge           — LLM-as-judge scoring (overall + per-dimension),
                          the single automatic quality metric
  GET  /health
"""
from __future__ import annotations

import asyncio
import hmac
import logging
import os
import time
from pathlib import Path

# Load the project-root .env BEFORE importing adapters, so OPENAI_API_KEY /
# GEMINI_API_KEY are available when the adapter registry first introspects them.
#
# Container path safety: in local dev, main.py lives at
# services/review-gen/app/main.py (4 levels deep from repo root, so
# parents[3] is the root). In Docker (Cloud Run), main.py lives at
# /app/app/main.py with only 2 parent levels, so parents[3] raises
# IndexError — and Cloud Run gets env vars from --set-env-vars /
# --set-secrets instead of a .env file. Tolerate both worlds.
from dotenv import load_dotenv

try:
    _ROOT_ENV = Path(__file__).resolve().parents[3] / ".env"
    if _ROOT_ENV.is_file():
        load_dotenv(_ROOT_ENV)
except IndexError:
    # Containerised — no monorepo root; env comes from the platform.
    pass

from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, UploadFile
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from app import adapters
from app.adapters._budget import (
    count_tokens,
    render_canonical,
)
from app.judge import judge_pair, judge_review
from app.parsing import (
    Arxiv2MdError,
    ChandraError,
    parse_from_arxiv,
    parse_with_chandra,
)
from app.paper_render import render_paper_text
from app.schemas import (
    GenerateRequest,
    GenerateResponse,
    GenerationMetricsOut,
    ParsedPaper,
)


def _attach_canonical(paper: ParsedPaper) -> ParsedPaper:
    """FAIRNESS A1: render the ONE canonical paper string once, at parse
    time, and stamp it on the ParsedPaper so every system is later handed
    the byte-identical text. Also records the full (untruncated) token
    count for fraction-of-paper-used accounting."""
    full_text = render_paper_text(paper, max_chars=10_000_000)  # effectively untruncated
    canonical = render_canonical(paper)  # full paper — no input cap
    paper.canonicalText = canonical
    paper.canonicalTokens = count_tokens(canonical)
    paper.fullTokens = count_tokens(full_text)
    return paper


def _metrics_out(metrics) -> GenerationMetricsOut | None:
    if metrics is None:
        return None
    return GenerationMetricsOut(
        input_tokens=metrics.input_tokens,
        output_tokens=metrics.output_tokens,
        context_window=metrics.context_window,
        fair_input_tokens=metrics.fair_input_tokens,
        fair_output_tokens=metrics.fair_output_tokens,
    )

logger = logging.getLogger("review-gen")
logging.basicConfig(level=logging.INFO)


# ─── Auth ─────────────────────────────────────────────────────────────────
# Every billable endpoint requires X-API-Key matching REVIEW_GEN_API_KEY.
# - Dev (REVIEWARENA_ENV != "production"): if the key is unset, we run
#   open and log a warning. Convenient for local hacking.
# - Prod (REVIEWARENA_ENV == "production"): missing key is a HARD FAILURE
#   at startup. Refusing to boot is much safer than silently accepting
#   unauthenticated traffic that drains the LLM budget.
_REVIEW_GEN_API_KEY = os.environ.get("REVIEW_GEN_API_KEY", "").strip()
# Default CLOSED: open mode must be asked for by name. The old gate only
# fired when REVIEWARENA_ENV was exactly "production", so a VM deploy that
# forgot the variable (or spelled it "prod") served every billable endpoint
# unauthenticated with nothing but a log line to show for it.
_IS_DEV = os.environ.get("REVIEWARENA_ENV", "").strip().lower() in (
    "development",
    "dev",
    "test",
)

if not _REVIEW_GEN_API_KEY:
    if not _IS_DEV:
        # Fail fast — uvicorn never finishes startup.
        raise RuntimeError(
            "REVIEW_GEN_API_KEY is required unless REVIEWARENA_ENV=development. "
            "Refusing to boot — would otherwise serve unauthenticated "
            "requests that bill OpenAI / Anthropic / Google / DeepSeek / Datalab."
        )
    logger.warning(
        "REVIEW_GEN_API_KEY not set — running in OPEN mode "
        "(REVIEWARENA_ENV=development). Any caller can trigger billable "
        "LLM endpoints."
    )


def verify_api_key(x_api_key: str | None = Header(default=None)) -> None:
    """FastAPI dependency: rejects requests without a valid X-API-Key.
    No-op when REVIEW_GEN_API_KEY is unset (dev mode only — prod refuses
    to boot in that state, see above)."""
    if not _REVIEW_GEN_API_KEY:
        return  # open mode — explicit dev only; everything else is gated at startup
    if not x_api_key or not hmac.compare_digest(x_api_key, _REVIEW_GEN_API_KEY):
        raise HTTPException(status_code=401, detail="invalid or missing X-API-Key")


# Longest tolerated silence between streamed events before the stream is
# declared dead (matches the Node bridge's idle watchdog).
STREAM_IDLE_TIMEOUT_S = float(os.environ.get("STREAM_IDLE_TIMEOUT_S", "120"))

# Reject absurd request bodies before reading them: the canonical paper text
# rides inside /generate | /stream-generate | /judge JSON, so legitimate
# requests are large-ish, but nothing sane exceeds this — and uvicorn itself
# imposes no limit at all.
MAX_BODY_BYTES = int(os.environ.get("MAX_BODY_BYTES", str(30 * 1024 * 1024)))

app = FastAPI(title="ReviewArena · review-gen", version="0.1.0")


@app.middleware("http")
async def _reject_oversized_bodies(request: Request, call_next):
    cl = request.headers.get("content-length")
    if cl is not None:
        try:
            if int(cl) > MAX_BODY_BYTES:
                from fastapi.responses import JSONResponse
                return JSONResponse(
                    status_code=413,
                    content={"detail": f"request body exceeds {MAX_BODY_BYTES} bytes"},
                )
        except ValueError:
            pass
    return await call_next(request)


@app.on_event("startup")
async def _production_knobs() -> None:
    # The default anyio limiter gives sync `def` routes and run_in_threadpool
    # 40 threads TOTAL. Generation, judging, and Chandra parsing each hold a
    # thread for minutes, so a classroom burst exhausts the pool and every
    # route — /health included — queues forever (observed live: TCP accepted,
    # no headers, 0% CPU). 100 threads of headroom + timeouts in the adapters
    # turn that wedge into individual request failures.
    import anyio.to_thread

    anyio.to_thread.current_default_thread_limiter().total_tokens = 100

    # Pre-warm the tiktoken encoder: its first use downloads the BPE file
    # with blocking IO and no timeout, which must never happen on the event
    # loop mid-request (see _attach_canonical).
    from app.adapters import _budget

    await run_in_threadpool(_budget._encoder)


@app.get("/health")
async def healthz() -> dict[str, object]:
    # No auth — used by load balancers, monitoring, smoke tests.
    # async def on purpose: it must never need a threadpool token, so it
    # keeps answering (and healthchecks keep passing) even when the pool
    # is saturated — a wedged pool then shows up as slow requests, not as
    # an unreachable service.
    return {"ok": True, "adapters": adapters.known_keys()}


# ─── /parse ────────────────────────────────────────────────────────────────


@app.post("/parse", response_model=ParsedPaper, dependencies=[Depends(verify_api_key)])
async def parse(file: UploadFile = File(...)) -> ParsedPaper:
    """Parse a PDF via Datalab's hosted Chandra API and return the
    canonical ParsedPaper.

    Failure modes:
      - 502 if Datalab is unreachable, times out, or returns no usable
        markdown. The Node API marks the paper PARSE_FAILED so the user
        knows their upload didn't process.

    Implementation note: parse_with_chandra uses a synchronous httpx
    client and polls Datalab for up to ~5 minutes. We offload it to a
    worker thread so the event loop stays free for other requests.
    """
    if file.content_type not in (None, "application/pdf", "application/octet-stream"):
        raise HTTPException(status_code=415, detail=f"unsupported type {file.content_type}")
    pdf_bytes = await file.read()
    filename = file.filename or "paper.pdf"
    try:
        paper = await run_in_threadpool(parse_with_chandra, pdf_bytes, filename)
        # _attach_canonical renders the full paper twice and tokenizes it —
        # seconds of pure CPU for a long paper — so it must not run on the
        # event loop.
        return await run_in_threadpool(_attach_canonical, paper)
    except ChandraError as e:
        logger.warning("Chandra parse failed: %s", e)
        raise HTTPException(status_code=502, detail=str(e)) from e


# ─── /parse-arxiv ──────────────────────────────────────────────────────────


class ParseArxivRequest(BaseModel):
    url: str  # arXiv URL or bare ID; normalized server-side


@app.post("/parse-arxiv", response_model=ParsedPaper, dependencies=[Depends(verify_api_key)])
def parse_arxiv(req: ParseArxivRequest) -> ParsedPaper:
    """Parse an arXiv paper via timf34's hosted arxiv2md.org service.

    Failure modes:
      - 400 if the URL/ID is malformed.
      - 502 if arxiv2md.org is down, rate-limited, or returns no content
        (e.g. the paper has no HTML rendering on arXiv).
    """
    try:
        return _attach_canonical(parse_from_arxiv(req.url))
    except Arxiv2MdError as e:
        logger.warning("arxiv2md parse failed for %s: %s", req.url, e)
        raise HTTPException(status_code=502, detail=str(e)) from e


# ─── /generate ─────────────────────────────────────────────────────────────


_INSTANCE_CACHE: dict[tuple, adapters.Adapter] = {}


def _cache_key(adapter_key: str, config: dict) -> tuple:
    return (adapter_key, tuple(sorted(config.items())))


@app.post("/generate", response_model=GenerateResponse, dependencies=[Depends(verify_api_key)])
def generate(req: GenerateRequest) -> GenerateResponse:
    # Fold the venue into the adapter config: prompt-based adapters read
    # config["conference"] to build their review-form prompt, and the
    # cache key then keeps one instance per (adapter, config, venue).
    cfg = {**req.config, "conference": req.conference}
    key = _cache_key(req.adapter_key, cfg)
    instance = _INSTANCE_CACHE.get(key)
    if instance is None:
        try:
            instance = adapters.get(req.adapter_key, cfg)
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e))
        except RuntimeError as e:
            raise HTTPException(status_code=503, detail=str(e))
        _INSTANCE_CACHE[key] = instance

    start = time.perf_counter()
    try:
        result = instance.generate(req.paper)
    except Exception as e:
        logger.exception("adapter %s failed", req.adapter_key)
        raise HTTPException(status_code=502, detail=f"adapter failure: {e}") from e
    elapsed_ms = int((time.perf_counter() - start) * 1000)

    return GenerateResponse(
        review=result.review,
        raw_output=result.raw_output,
        generation_ms=elapsed_ms,
        adapter_key=req.adapter_key,
        metrics=_metrics_out(result.metrics),
    )


# ─── /stream-generate ──────────────────────────────────────────────────────


@app.post("/stream-generate", dependencies=[Depends(verify_api_key)])
async def stream_generate(req: GenerateRequest, request: Request):
    """Server-Sent Events variant of /generate.

    Yields per-token deltas so the Node API can forward them to the
    browser. Same request shape as /generate; response is text/event-stream
    with events:
       event: token   data: {"text": "<delta>"}
       event: done    data: {"review": {...}, "raw_output": "...", "generation_ms": N}
       event: error   data: {"message": "..."}

    Disconnect handling: the generator polls request.is_disconnected()
    between events so the model call stops as soon as the Node bridge
    (which is itself reacting to a browser close) drops its socket.
    Saves real provider spend on abandoned generations.
    """
    from fastapi.responses import StreamingResponse

    # Fold the venue into the adapter config: prompt-based adapters read
    # config["conference"] to build their review-form prompt, and the
    # cache key then keeps one instance per (adapter, config, venue).
    cfg = {**req.config, "conference": req.conference}
    key = _cache_key(req.adapter_key, cfg)
    instance = _INSTANCE_CACHE.get(key)
    if instance is None:
        try:
            instance = adapters.get(req.adapter_key, cfg)
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e))
        except RuntimeError as e:
            raise HTTPException(status_code=503, detail=str(e))
        _INSTANCE_CACHE[key] = instance

    async def event_source():
        import json as _json
        start = time.perf_counter()
        iterator = None
        try:
            # Run the (synchronous) adapter generator in a worker thread
            # via an iterator hop so we can interleave is_disconnected()
            # checks on the asyncio loop. The hop is cheap — one
            # run_in_threadpool per emitted event.
            iterator = instance.generate_stream(req.paper)  # noqa: F841 — closed in finally
            sentinel = object()

            def _next():
                try:
                    return next(iterator)
                except StopIteration:
                    return sentinel

            while True:
                if await request.is_disconnected():
                    logger.info(
                        "stream-generate aborted: client disconnected (%s)",
                        req.adapter_key,
                    )
                    return
                # Idle deadline on the hop itself: while _next blocks in the
                # worker thread, is_disconnected() is never polled, so a
                # quiet model used to hold this thread (and bill tokens)
                # indefinitely for a browser that left long ago. Provider
                # timeouts bound each SDK attempt; this bounds the gap the
                # caller will tolerate between events — mirroring the Node
                # bridge's own 120s idle watchdog.
                try:
                    evt = await asyncio.wait_for(
                        run_in_threadpool(_next), timeout=STREAM_IDLE_TIMEOUT_S
                    )
                except asyncio.TimeoutError:
                    logger.warning(
                        "stream-generate idle timeout after %ss (%s)",
                        STREAM_IDLE_TIMEOUT_S, req.adapter_key,
                    )
                    payload = _json.dumps(
                        {"message": f"model produced no output for {STREAM_IDLE_TIMEOUT_S}s (timeout)"}
                    )
                    yield f"event: error\ndata: {payload}\n\n"
                    return
                if evt is sentinel:
                    return
                if evt.type == "token":
                    payload = _json.dumps({"text": evt.text}, ensure_ascii=False)
                    yield f"event: token\ndata: {payload}\n\n"
                elif evt.type == "done":
                    elapsed_ms = int((time.perf_counter() - start) * 1000)
                    m = _metrics_out(evt.metrics)
                    payload = _json.dumps(
                        {
                            "review": evt.result.model_dump() if evt.result else None,
                            "raw_output": evt.raw_output,
                            "generation_ms": elapsed_ms,
                            "adapter_key": req.adapter_key,
                            "metrics": m.model_dump() if m else None,
                        },
                        ensure_ascii=False,
                    )
                    yield f"event: done\ndata: {payload}\n\n"
                elif evt.type == "error":
                    payload = _json.dumps({"message": evt.error}, ensure_ascii=False)
                    yield f"event: error\ndata: {payload}\n\n"
        except Exception as e:  # noqa: BLE001
            logger.exception("stream-generate %s failed", req.adapter_key)
            payload = _json.dumps({"message": str(e)}, ensure_ascii=False)
            yield f"event: error\ndata: {payload}\n\n"

        finally:
            # Abandoning a live provider stream without close() leaves the
            # HTTP response to nondeterministic GC — and some SDKs keep
            # billing until the connection actually drops.
            if iterator is not None:
                close = getattr(iterator, "close", None)
                if close is not None:
                    try:
                        await run_in_threadpool(close)
                    except Exception:  # noqa: BLE001 — best-effort cleanup
                        logger.debug("iterator close failed", exc_info=True)

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={
            # Prevent intermediary buffering (proxies, nginx); SSE relies
            # on flushing every chunk.
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# ─── /judge ────────────────────────────────────────────────────────────────


class JudgeRequest(BaseModel):
    review_text: str
    paper_text: str
    # Required: the judge is a panel and every call names its member.
    model: str


@app.post("/judge", dependencies=[Depends(verify_api_key)])
def judge(req: JudgeRequest) -> dict:
    result = judge_review(req.review_text, req.paper_text, model=req.model)
    return {
        "overall_score": result.overall_score,
        "dimension_scores": result.dimension_scores,
    }


class JudgePairRequest(BaseModel):
    review_a: str
    review_b: str
    paper_text: str
    # Required: the judge is a panel and every call names its member.
    model: str


@app.post("/judge-pair", dependencies=[Depends(verify_api_key)])
def judge_pair_endpoint(req: JudgePairRequest) -> dict:
    """One panel member's pairwise verdict: paper + both reviews in one
    request per pass, two order-swapped passes (position-bias control).
    'A'/'B' in the response refer to review_a/review_b of THIS request.
    The Node side fans out one call per panel member."""
    result = judge_pair(req.review_a, req.review_b, req.paper_text, model=req.model)
    return {
        "judge_model": req.model,
        "overall_preference": result.overall_preference,
        "dimension_preferences": result.dimension_preferences,
        "review_a": {
            "overall_score": result.review_a.overall_score,
            "dimension_scores": result.review_a.dimension_scores,
        },
        "review_b": {
            "overall_score": result.review_b.overall_score,
            "dimension_scores": result.review_b.dimension_scores,
        },
        "passes_used": result.passes_used,
        "raw_passes": result.raw_passes,
    }
