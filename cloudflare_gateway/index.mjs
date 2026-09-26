const STARTED_AT = Date.now();
const SCOPES = ["category", "merchant", "customer", "trigger"];
const CONTEXT_STATE_URL = "https://vera-state.invalid/context-index-v1";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function emptyState() {
  return Object.fromEntries(SCOPES.map((scope) => [scope, []]));
}

function countsFrom(state) {
  return Object.fromEntries(SCOPES.map((scope) => [scope, state[scope]?.length ?? 0]));
}

async function storeState(state) {
  const response = new Response(JSON.stringify(state), {
    headers: { "cache-control": "public, max-age=86400" },
  });
  await caches.default.put(new Request(CONTEXT_STATE_URL), response);
}

async function loadState(env) {
  const cached = await caches.default.match(new Request(CONTEXT_STATE_URL));
  if (cached) return cached.json();

  const state = emptyState();
  const result = await env.DB.prepare("SELECT scope, context_id FROM contexts").all();
  for (const row of result.results ?? []) {
    if (SCOPES.includes(row.scope)) state[row.scope].push(String(row.context_id));
  }
  await storeState(state);
  return state;
}

async function health(env) {
  try {
    const state = await loadState(env);
    return json({
      status: "ok",
      uptime_seconds: Math.max(0, Math.floor((Date.now() - STARTED_AT) / 1000)),
      contexts_loaded: countsFrom(state),
    });
  } catch {
    return json({ status: "error", reason: "storage_unavailable" }, 503);
  }
}

async function fetchBackend(request, env) {
  let lastResponse;
  let lastError;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      lastResponse = await env.VERA_BACKEND.fetch(request.clone());
      const contentType = lastResponse.headers.get("content-type") ?? "";
      const transientHtmlFailure = lastResponse.status >= 500
        && !contentType.toLowerCase().includes("application/json");
      if (!transientHtmlFailure) return lastResponse;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 11) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (lastResponse) return lastResponse;
  throw lastError ?? new Error("backend unavailable");
}

async function proxy(request, env, pathname) {
  let contextEnvelope;
  if (request.method === "POST" && pathname === "/v1/context") {
    try {
      contextEnvelope = await request.clone().json();
    } catch {
      contextEnvelope = undefined;
    }
  }

  const response = await fetchBackend(request, env);

  if (request.method === "POST" && pathname === "/v1/teardown" && response.ok) {
    try {
      const result = await response.clone().json();
      if (result.cleared === true) await storeState(emptyState());
    } catch {
      // The backend response remains authoritative if cache maintenance fails.
    }
  }

  if (
    request.method === "POST"
    && pathname === "/v1/context"
    && response.ok
    && contextEnvelope
    && SCOPES.includes(contextEnvelope.scope)
  ) {
    try {
      const result = await response.clone().json();
      if (result.accepted === true) {
        const state = await loadState(env);
        const ids = new Set(state[contextEnvelope.scope] ?? []);
        ids.add(String(contextEnvelope.context_id));
        state[contextEnvelope.scope] = [...ids];
        await storeState(state);
      }
    } catch {
      // A later cache miss reconstructs the index directly from D1.
    }
  }

  return response;
}

async function ready(env) {
  try {
    await env.DB.prepare("SELECT 1 AS ok").first();
    return json({ status: "ready" });
  } catch {
    return json({ status: "not_ready", reason: "storage_unavailable" }, 503);
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/v1/healthz") return health(env);
    if (request.method === "GET" && pathname === "/v1/readyz") return ready(env);
    return proxy(request, env, pathname);
  },
};
