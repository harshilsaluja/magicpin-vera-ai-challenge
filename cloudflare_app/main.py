import time

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

try:
    from cloudflare_app.decision import decide_actions
    from cloudflare_app.models import ContextEnvelope, ReplyRequest, TickRequest
    from cloudflare_app.reply import handle_reply
    from cloudflare_app.store import D1Store, utc_now
except ModuleNotFoundError:  # Cloudflare attaches sibling Python modules at top level.
    from decision import decide_actions
    from models import ContextEnvelope, ReplyRequest, TickRequest
    from reply import handle_reply
    from store import D1Store, utc_now


MAX_BODY_BYTES = 500 * 1024
STARTED_AT = time.time()
HEALTH_COUNTS = {scope: 0 for scope in ("category", "merchant", "customer", "trigger")}
HEALTH_COUNTS_REFRESH_AT = 0.0
app = FastAPI(title="Vera Challenge API", version="1.1.0", docs_url=None, redoc_url=None)


def env_value(request: Request, name: str, fallback: str) -> str:
    env = request.scope["env"]
    try:
        value = getattr(env, name)
        return str(value) if value is not None else fallback
    except (AttributeError, TypeError):
        return fallback


def store(request: Request) -> D1Store:
    return D1Store(request.scope["env"].DB)


@app.middleware("http")
async def safety_headers_and_size(request: Request, call_next):
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
        return JSONResponse({"accepted": False, "reason": "payload_too_large"}, status_code=413)
    if request.method == "POST" and len(await request.body()) > MAX_BODY_BYTES:
        return JSONResponse({"accepted": False, "reason": "payload_too_large"}, status_code=413)
    response = await call_next(request)
    response.headers["cache-control"] = "no-store"
    response.headers["x-content-type-options"] = "nosniff"
    return response


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, error: RequestValidationError):
    if request.url.path == "/v1/context":
        return JSONResponse(
            {"accepted": False, "reason": "invalid_context", "details": "Request failed schema or identity validation."},
            status_code=400,
        )
    code = "invalid_tick" if request.url.path == "/v1/tick" else "invalid_reply"
    return JSONResponse({"error": code}, status_code=400)


@app.get("/v1/healthz")
async def health(request: Request):
    global HEALTH_COUNTS, HEALTH_COUNTS_REFRESH_AT
    now = time.time()
    if now >= HEALTH_COUNTS_REFRESH_AT:
        # Move the refresh deadline before awaiting D1 so concurrent health
        # checks do not create a database-query stampede.
        HEALTH_COUNTS_REFRESH_AT = now + 2.0
        try:
            HEALTH_COUNTS = await store(request).counts()
        except Exception:
            # Health remains a lightweight liveness endpoint. /v1/readyz is
            # the authoritative live database-readiness check.
            pass
    return {
        "status": "ok",
        "uptime_seconds": max(0, int(now - STARTED_AT)),
        "contexts_loaded": HEALTH_COUNTS,
    }


@app.get("/v1/readyz")
async def ready(request: Request):
    try:
        if not await store(request).ping():
            raise RuntimeError("storage unavailable")
        return {"status": "ready"}
    except Exception:
        return JSONResponse({"status": "not_ready", "reason": "storage_unavailable"}, status_code=503)


@app.get("/v1/metadata")
async def metadata(request: Request):
    return {
        "team_name": env_value(request, "TEAM_NAME", "Vera Challenge Candidate"),
        "team_members": [env_value(request, "TEAM_MEMBER", "Candidate")],
        "model": "none (deterministic implementation)",
        "approach": "Deterministic, evidence-grounded FastAPI composition with versioned D1 context, consent checks, suppression, and stateful replies",
        "contact_email": env_value(request, "CONTACT_EMAIL", "not-configured@example.com"),
        "version": "1.1.0",
        "submitted_at": env_value(request, "SUBMITTED_AT", "2026-09-26T00:00:00Z"),
    }


@app.post("/v1/context")
async def put_context(envelope: ContextEnvelope, request: Request):
    global HEALTH_COUNTS_REFRESH_AT
    try:
        body = envelope.model_dump(mode="json")
        result = await store(request).put_context(body)
        if not result["accepted"]:
            return JSONResponse(
                {
                    "accepted": False,
                    "reason": "stale_version",
                    "current_version": result["current_version"],
                },
                status_code=409,
            )
        HEALTH_COUNTS_REFRESH_AT = 0.0
        return {
            "accepted": True,
            "ack_id": f"ack_{envelope.context_id}_v{envelope.version}",
            "stored_at": result["stored_at"],
        }
    except Exception as error:
        print({"event": "context_storage_failed", "error": str(error)})
        return JSONResponse({"accepted": False, "reason": "storage_error"}, status_code=500)


@app.post("/v1/tick")
async def tick(body: TickRequest, request: Request):
    try:
        actions = await decide_actions(store(request), body.now, body.available_triggers, 20)
        return {"actions": actions}
    except Exception as error:
        print({"event": "decision_failed", "error": str(error)})
        return JSONResponse({"error": "decision_error"}, status_code=500)


@app.post("/v1/reply")
async def reply(body: ReplyRequest, request: Request):
    try:
        payload = body.model_dump(mode="json")
        return await handle_reply(store(request), payload, body.received_at or utc_now())
    except Exception as error:
        print({"event": "reply_failed", "error": str(error)})
        return JSONResponse({"error": "reply_error"}, status_code=500)


@app.post("/v1/teardown")
async def teardown(request: Request):
    global HEALTH_COUNTS, HEALTH_COUNTS_REFRESH_AT
    try:
        await store(request).teardown()
        HEALTH_COUNTS = {
            "category": 0,
            "merchant": 0,
            "customer": 0,
            "trigger": 0,
        }
        HEALTH_COUNTS_REFRESH_AT = time.time() + 2.0
        return {"cleared": True}
    except Exception:
        return JSONResponse({"cleared": False, "reason": "storage_error"}, status_code=500)


import asgi

Default = asgi.entrypoint(app)
