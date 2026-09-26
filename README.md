# Vera Challenge Bot

A staged, no-LLM implementation for the magicpin Vera AI Challenge.

## Supported stacks

- Recommended public deployment: a lightweight Cloudflare JavaScript gateway, native Python Worker, and Cloudflare D1.
- Reference/local deployment: Node.js 24, native `http`, and built-in SQLite (`node:sqlite`).
- Both targets implement the same deterministic decision and reply behavior; no external LLM is required.
- Both targets provide durable, versioned context and stateful conversation storage.

Phases 1–7 provide the API foundation, durable context storage, proactive message composition, stateful conversations, quality/safety hardening, judge-focused verification, and production deployment packaging. The implementation is deterministic and does not require an external LLM.

## Run

```powershell
node src/server.js
```

The service listens on `http://localhost:8080` by default. Set `PORT` to use a different port. The database defaults to `data/vera.sqlite`; set `DATABASE_PATH` to change it.

Copy the values from `.env.example` into your deployment environment. The current default identity fields are placeholders and must be replaced before submission.

For the Cloudflare target, follow `CLOUDFLARE_DEPLOYMENT.md`. Its local development commands are:

```powershell
uv sync
uv run pywrangler d1 migrations apply vera-production --local
uv run pywrangler dev
```

## Test

```powershell
node --test
uv run pytest
```

Run the repeatable local contract judge:

```powershell
node scripts/phase6-judge.js
```

Generate the expanded 5-category, 50-merchant, 200-customer, 100-trigger stress dataset:

```powershell
node scripts/generate-expanded-dataset.js
```

## Implemented endpoints

- `GET /v1/healthz`
- `GET /v1/metadata`
- `POST /v1/context`
- `POST /v1/tick`
- `POST /v1/reply`
- `POST /v1/teardown` (optional cleanup endpoint)

## Phase status

- Phase 1 — API foundation: complete.
- Phase 2 — SQLite context storage: complete.
- Phase 3 — proactive decision and message composition: complete.
- Phase 4 — multi-turn conversation handling: complete.
- Phase 5 — quality, integrity, safety, and judge-edge hardening: complete.
- Phase 6 — expanded-data, contract, replay, and load testing: complete.
- Phase 7 — production hardening and deployment packaging: complete locally; public hosting requires the submitter's hosting account and final identity values.

`/v1/tick` resolves and ranks active triggers, verifies linked identities, checks expiry/consent/suppression, composes deterministic category-aware messages, records their evidence versions, and returns no more than 20 actions. `/v1/reply` handles acceptance, business questions, slot selection, waits, auto-replies, opt-outs, hostility, and off-topic requests with persistent state and a final output-safety gate.

## Reliability and safety

- Context updates are versioned; stale writes are rejected and the newest accepted version is used.
- Category, merchant, trigger, and customer identities must join correctly before any message is composed.
- Customer outreach requires matching stored WhatsApp consent.
- Suppression claims and conversation creation are atomic, including concurrent duplicate ticks.
- Category taboo terms, links, oversized messages, and multiple-question replies are blocked.
- Each proactive message stores an internal composition audit with source context IDs and versions.
- No message claims an unsupported sale, booking, publication, payment, or external action.

## Phase 6 verification scope

- Exact response-shape checks for every endpoint.
- The official attached seed pack is replayed by a local contract judge.
- A deterministic expanded dataset exercises all generated trigger families.
- Version-2 context is injected during an active conversation.
- Identical fresh inputs are checked for byte-equivalent JSON output.
- Empty, unknown, malformed, stale, oversized, duplicate, and concurrent inputs are tested.
- Health traffic is tested above the stated 10-requests-per-second requirement.

## Production deployment

The recommended free deployment uses a lightweight JavaScript health gateway in front of a native Python Worker with D1. This keeps the public health route fast while preserving the deterministic Python engine and accurate D1-backed state. See `CLOUDFLARE_DEPLOYMENT.md` for deployment and judge steps.

The original container deployment remains available as a fallback.

The repository includes a non-root Node 24 `Dockerfile`, persistent-volume `compose.yaml`, container health check, storage readiness endpoint, strict production environment validation, graceful SIGTERM shutdown, and restart-persistence preflight.

Run the final deployment preflight with:

```powershell
node scripts/deployment-preflight.js
```

See `DEPLOYMENT.md` for hosting requirements and public verification. Use exactly one application instance with a persistent volume mounted at `/app/data`.
