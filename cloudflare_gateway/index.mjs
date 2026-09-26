const STARTED_AT = Date.now();
const SCOPES = ["category", "merchant", "customer", "trigger"];

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

function health() {
  const counts = Object.fromEntries(SCOPES.map((scope) => [scope, 0]));
  return json({
    status: "ok",
    uptime_seconds: Math.max(0, Math.floor((Date.now() - STARTED_AT) / 1000)),
    contexts_loaded: counts,
  });
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
    if (request.method === "GET" && pathname === "/v1/healthz") return health();
    if (request.method === "GET" && pathname === "/v1/readyz") return ready(env);
    return env.VERA_BACKEND.fetch(request);
  },
};
