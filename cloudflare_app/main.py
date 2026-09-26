import time
from urllib.parse import urlparse

from workers import Response, WorkerEntrypoint

try:
    from cloudflare_app.decision import decide_actions
    from cloudflare_app.reply import handle_reply
    from cloudflare_app.store import D1Store, SCOPES, utc_now
    from cloudflare_app.time_utils import parse_iso
except ModuleNotFoundError:
    from decision import decide_actions
    from reply import handle_reply
    from store import D1Store, SCOPES, utc_now
    from time_utils import parse_iso

MAX_BODY_BYTES = 500 * 1024
STARTED_AT = time.time()


def response(body, status=200):
    return Response.from_json(body, status=status, headers={
        "cache-control": "no-store", "x-content-type-options": "nosniff"
    })


def valid_context(body):
    allowed = {"scope", "context_id", "version", "payload", "delivered_at"}
    if not isinstance(body, dict) or set(body) - allowed:
        return False
    scope, context_id = body.get("scope"), body.get("context_id")
    version, payload, delivered_at = body.get("version"), body.get("payload"), body.get("delivered_at")
    if scope not in SCOPES or not isinstance(context_id, str) or not context_id.strip():
        return False
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        return False
    if not isinstance(payload, dict) or not isinstance(delivered_at, str):
        return False
    try:
        parse_iso(delivered_at)
        if scope == "category":
            return payload.get("slug") == context_id
        if scope == "merchant":
            return payload.get("merchant_id") == context_id and bool(payload.get("category_slug"))
        if scope == "customer":
            return payload.get("customer_id") == context_id and bool(payload.get("merchant_id"))
        required = (
            payload.get("id") == context_id
            and payload.get("scope") in {"merchant", "customer"}
            and bool(payload.get("kind"))
            and bool(payload.get("merchant_id"))
            and bool(payload.get("suppression_key"))
            and isinstance(payload.get("urgency"), (int, float))
            and not isinstance(payload.get("urgency"), bool)
            and bool(payload.get("expires_at"))
        )
        if not required:
            return False
        parse_iso(str(payload["expires_at"]))
        return payload["scope"] != "customer" or bool(payload.get("customer_id"))
    except (TypeError, ValueError):
        return False


def valid_tick(body):
    if not isinstance(body, dict) or set(body) != {"now", "available_triggers"}:
        return False
    if not isinstance(body["now"], str) or not isinstance(body["available_triggers"], list):
        return False
    try:
        parse_iso(body["now"])
    except (TypeError, ValueError):
        return False
    return all(isinstance(item, str) and item.strip() for item in body["available_triggers"])


def valid_reply(body):
    allowed = {"conversation_id", "merchant_id", "customer_id", "from_role", "message", "received_at", "turn_number"}
    required = {"conversation_id", "from_role", "message", "turn_number"}
    if not isinstance(body, dict) or set(body) - allowed or not required.issubset(body):
        return False
    if body["from_role"] not in {"merchant", "customer"}:
        return False
    if not all(isinstance(body[key], str) and body[key].strip() for key in ("conversation_id", "message")):
        return False
    turn = body["turn_number"]
    if not isinstance(turn, int) or isinstance(turn, bool) or turn < 1:
        return False
    for key in ("merchant_id", "customer_id"):
        if body.get(key) is not None and not isinstance(body[key], str):
            return False
    if body.get("received_at") is not None:
        try:
            parse_iso(body["received_at"])
        except (TypeError, ValueError):
            return False
    return True


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        path, method = urlparse(request.url).path, request.method.upper()
        store = D1Store(self.env.DB)
        if method == "GET" and path == "/v1/healthz":
            try:
                return response({"status": "ok", "uptime_seconds": max(0, int(time.time() - STARTED_AT)), "contexts_loaded": await store.counts()})
            except Exception:
                return response({"status": "error", "reason": "storage_unavailable"}, 503)
        if method == "GET" and path == "/v1/readyz":
            try:
                if not await store.ping():
                    raise RuntimeError("storage unavailable")
                return response({"status": "ready"})
            except Exception:
                return response({"status": "not_ready", "reason": "storage_unavailable"}, 503)
        if method == "GET" and path == "/v1/metadata":
            def env(name, fallback):
                value = getattr(self.env, name, None)
                return str(value) if value is not None else fallback
            return response({
                "team_name": env("TEAM_NAME", "Vera Challenge Candidate"),
                "team_members": [env("TEAM_MEMBER", "Candidate")],
                "model": "none (deterministic implementation)",
                "approach": "Deterministic, evidence-grounded Python composition with versioned D1 context, consent checks, suppression, and stateful replies",
                "contact_email": env("CONTACT_EMAIL", "not-configured@example.com"),
                "version": "1.2.0",
                "submitted_at": env("SUBMITTED_AT", "2026-09-26T00:00:00Z"),
            })
        if method != "POST" or path not in {"/v1/context", "/v1/tick", "/v1/reply", "/v1/teardown"}:
            return response({"error": "not_found"}, 404)
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > MAX_BODY_BYTES:
            return response({"accepted": False, "reason": "payload_too_large"}, 413)
        try:
            body = await request.json()
        except Exception:
            return response({"error": "invalid_json"}, 400)
        if path == "/v1/context":
            if not valid_context(body):
                return response({"accepted": False, "reason": "invalid_context"}, 400)
            try:
                result = await store.put_context(body)
                if not result["accepted"]:
                    return response({"accepted": False, "reason": "stale_version", "current_version": result["current_version"]}, 409)
                return response({"accepted": True, "ack_id": f"ack_{body['context_id']}_v{body['version']}", "stored_at": result["stored_at"]})
            except Exception as error:
                print({"event": "context_storage_failed", "error": str(error)})
                return response({"accepted": False, "reason": "storage_error"}, 500)
        if path == "/v1/tick":
            if not valid_tick(body):
                return response({"error": "invalid_tick"}, 400)
            try:
                return response({"actions": await decide_actions(store, body["now"], body["available_triggers"], 20)})
            except Exception as error:
                print({"event": "decision_failed", "error": str(error)})
                return response({"error": "decision_error"}, 500)
        if path == "/v1/reply":
            if not valid_reply(body):
                return response({"error": "invalid_reply"}, 400)
            try:
                return response(await handle_reply(store, body, body.get("received_at") or utc_now()))
            except Exception as error:
                print({"event": "reply_failed", "error": str(error)})
                return response({"error": "reply_error"}, 500)
        try:
            await store.teardown()
            return response({"cleared": True})
        except Exception:
            return response({"cleared": False, "reason": "storage_error"}, 500)
