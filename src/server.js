const http = require("node:http");
const path = require("node:path");
const { VeraStore } = require("./store");
const { decideActions } = require("./decision-engine");
const { handleReply } = require("./reply-engine");

const MAX_BODY_BYTES = 500 * 1024;

function json(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function productionConfigErrors(env = process.env) {
  if (env.NODE_ENV !== "production") return [];
  const errors = [];
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push("PORT must be an integer from 1 to 65535.");
  if (!env.DATABASE_PATH || env.DATABASE_PATH === ":memory:") errors.push("DATABASE_PATH must point to persistent storage.");
  if (!env.TEAM_NAME || /your team name/i.test(env.TEAM_NAME)) errors.push("TEAM_NAME must be configured.");
  if (!env.TEAM_MEMBER || /your full name/i.test(env.TEAM_MEMBER)) errors.push("TEAM_MEMBER must be configured.");
  if (!env.CONTACT_EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.CONTACT_EMAIL)) errors.push("CONTACT_EMAIL must be a valid email.");
  if (!env.SUBMITTED_AT || !Number.isFinite(Date.parse(env.SUBMITTED_AT))) errors.push("SUBMITTED_AT must be a valid ISO timestamp.");
  return errors;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let rejected = false;
    const chunks = [];
    request.on("data", (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        chunks.length = 0;
        reject(new Error("payload_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (rejected) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    request.on("error", reject);
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateContext(body) {
  const envelopeValid = isPlainObject(body)
    && ["category", "merchant", "customer", "trigger"].includes(body.scope)
    && isNonEmptyString(body.context_id)
    && Number.isInteger(body.version)
    && body.version >= 1
    && isPlainObject(body.payload)
    && isNonEmptyString(body.delivered_at)
    && Number.isFinite(Date.parse(body.delivered_at));
  if (!envelopeValid) return "Expected scope, context_id, positive integer version, object payload, and ISO delivered_at.";

  const payload = body.payload;
  if (body.scope === "category" && payload.slug !== body.context_id) {
    return "Category payload.slug must equal context_id.";
  }
  if (body.scope === "merchant" && (payload.merchant_id !== body.context_id || !isNonEmptyString(payload.category_slug))) {
    return "Merchant payload must contain matching merchant_id and category_slug.";
  }
  if (body.scope === "customer" && (payload.customer_id !== body.context_id || !isNonEmptyString(payload.merchant_id))) {
    return "Customer payload must contain matching customer_id and merchant_id.";
  }
  if (body.scope === "trigger") {
    const validTrigger = payload.id === body.context_id
      && ["merchant", "customer"].includes(payload.scope)
      && isNonEmptyString(payload.kind)
      && isNonEmptyString(payload.merchant_id)
      && isNonEmptyString(payload.suppression_key)
      && Number.isFinite(Number(payload.urgency))
      && Number.isFinite(Date.parse(payload.expires_at));
    if (!validTrigger) return "Trigger payload is missing a matching id, scope, kind, merchant, urgency, suppression key, or valid expiry.";
    if (payload.scope === "customer" && !isNonEmptyString(payload.customer_id)) {
      return "Customer-scoped trigger must contain customer_id.";
    }
  }
  return null;
}

function createHandler({ store, metadata = {} }) {
  const submittedAt = metadata.submitted_at || process.env.SUBMITTED_AT || new Date().toISOString();

  return async function handler(request, response) {
    const requestUrl = new URL(request.url, "http://localhost");
    const { method } = request;
    const url = requestUrl.pathname;

    if (method === "GET" && url === "/v1/healthz") {
      try {
        return json(response, 200, {
          status: "ok",
          uptime_seconds: Math.floor((Date.now() - store.startedAt) / 1000),
          contexts_loaded: store.counts(),
        });
      } catch {
        return json(response, 503, { status: "error", reason: "storage_unavailable" });
      }
    }

    if (method === "GET" && url === "/v1/readyz") {
      try {
        if (!store.ping()) throw new Error("storage_unavailable");
        return json(response, 200, { status: "ready" });
      } catch {
        return json(response, 503, { status: "not_ready", reason: "storage_unavailable" });
      }
    }

    if (method === "GET" && url === "/v1/metadata") {
      return json(response, 200, {
        team_name: metadata.team_name || process.env.TEAM_NAME || "Vera Challenge Candidate",
        team_members: metadata.team_members || [process.env.TEAM_MEMBER || "Candidate"],
        model: "none (deterministic implementation)",
        approach: "Deterministic, evidence-grounded composition with versioned SQLite context, consent checks, suppression, and stateful replies",
        contact_email: metadata.contact_email || process.env.CONTACT_EMAIL || "not-configured@example.com",
        version: "1.0.0",
        submitted_at: submittedAt,
      });
    }

    if (method !== "POST") return json(response, 404, { error: "not_found" });

    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      const status = error.message === "payload_too_large" ? 413 : 400;
      return json(response, status, { accepted: false, reason: error.message });
    }

    if (url === "/v1/context") {
      const contextError = validateContext(body);
      if (contextError) {
        return json(response, 400, { accepted: false, reason: "invalid_context", details: contextError });
      }
      let result;
      try {
        result = store.putContext(body);
      } catch {
        return json(response, 500, { accepted: false, reason: "storage_error" });
      }
      if (!result.accepted) {
        return json(response, 409, { accepted: false, reason: "stale_version", current_version: result.currentVersion });
      }
      return json(response, 200, {
        accepted: true,
        ack_id: `ack_${body.context_id}_v${body.version}`,
        stored_at: result.storedAt,
      });
    }

    if (url === "/v1/tick") {
      if (!isNonEmptyString(body.now)
        || !Number.isFinite(Date.parse(body.now))
        || !Array.isArray(body.available_triggers)
        || !body.available_triggers.every(isNonEmptyString)) {
        return json(response, 400, { error: "invalid_tick", details: "Expected now and an array of trigger IDs." });
      }
      let actions;
      try {
        actions = decideActions({
          store,
          now: body.now,
          availableTriggerIds: body.available_triggers,
          limit: 20,
        });
      } catch {
        return json(response, 500, { error: "decision_error" });
      }
      return json(response, 200, { actions });
    }

    if (url === "/v1/reply") {
      const valid = isNonEmptyString(body.conversation_id)
        && ["merchant", "customer"].includes(body.from_role)
        && isNonEmptyString(body.message)
        && Number.isInteger(body.turn_number)
        && body.turn_number >= 1
        && (body.received_at === undefined || Number.isFinite(Date.parse(body.received_at)));
      if (!valid) return json(response, 400, { error: "invalid_reply" });
      try {
        return json(response, 200, handleReply({
          store,
          reply: body,
          now: body.received_at || new Date().toISOString(),
        }));
      } catch {
        return json(response, 500, { error: "reply_error" });
      }
    }

    if (url === "/v1/teardown") {
      store.teardown();
      return json(response, 200, { cleared: true });
    }

    return json(response, 404, { error: "not_found" });
  };
}

function startServer({ env = process.env } = {}) {
  const errors = productionConfigErrors(env);
  if (errors.length) throw new Error(`Invalid production configuration: ${errors.join(" ")}`);

  const port = Number(env.PORT || 8080);
  const host = env.HOST || "0.0.0.0";
  const databasePath = path.resolve(env.DATABASE_PATH || "data/vera.sqlite");
  const store = new VeraStore(databasePath);
  const server = http.createServer(createHandler({ store }));
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;

  let shuttingDown = false;
  let shutdownPromise = null;
  const shutdown = (signal = "shutdown") => {
    if (shuttingDown) return shutdownPromise;
    shuttingDown = true;
    console.log(JSON.stringify({ event: "shutdown_started", signal }));
    const forceTimer = setTimeout(() => process.exit(1), Number(env.SHUTDOWN_TIMEOUT_MS || 10000));
    forceTimer.unref();
    shutdownPromise = new Promise((resolve) => {
      server.close(() => {
        clearTimeout(forceTimer);
        store.close();
        console.log(JSON.stringify({ event: "shutdown_complete" }));
        resolve();
        if (require.main === module) process.exit(0);
      });
    });
    return shutdownPromise;
  };

  server.listen(port, host, () => {
    const address = server.address();
    console.log(JSON.stringify({
      event: "server_started",
      host,
      port: typeof address === "object" ? address.port : port,
      database_path: databasePath,
      version: "1.0.0",
    }));
  });
  return { server, store, shutdown };
}

if (require.main === module) {
  try {
    const runtime = startServer();
    process.once("SIGTERM", () => runtime.shutdown("SIGTERM"));
    process.once("SIGINT", () => runtime.shutdown("SIGINT"));
  } catch (error) {
    console.error(JSON.stringify({ event: "startup_failed", error: error.message }));
    process.exitCode = 1;
  }
}

module.exports = { createHandler, productionConfigErrors, startServer };
