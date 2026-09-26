const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { VeraStore } = require("../src/store");
const { createHandler } = require("../src/server");
const { decideActions } = require("../src/decision-engine");
const { generateDataset } = require("../scripts/generate-expanded-dataset");

const NOW = "2026-04-26T10:30:00Z";

function category() {
  return { slug: "restaurants", voice: { tone: "warm_busy_practical", vocab_taboo: ["guaranteed packed house"] }, digest: [] };
}

function merchant(views = 100) {
  return {
    merchant_id: "m_phase6",
    category_slug: "restaurants",
    identity: { name: "Phase Six Kitchen", owner_first_name: "Harshil", verified: true },
    performance: { window_days: 30, views, calls: 12, directions: 20, ctr: 0.03 },
    offers: [{ title: "Weeknight Delivery Combo", status: "active" }],
  };
}

function trigger() {
  return {
    id: "trg_phase6",
    scope: "merchant",
    kind: "active_planning_intent",
    source: "internal",
    merchant_id: "m_phase6",
    customer_id: null,
    payload: { intent_topic: "a delivery campaign" },
    urgency: 4,
    suppression_key: "phase6:planning",
    expires_at: "2026-04-27T10:30:00Z",
  };
}

function put(store, scope, id, payload, version = 1) {
  store.putContext({ scope, context_id: id, version, payload, delivered_at: NOW });
}

async function withServer(run) {
  const store = new VeraStore(":memory:");
  const server = http.createServer(createHandler({ store, metadata: {
    team_name: "Phase 6 Test", team_members: ["Candidate"], contact_email: "test@example.com",
  } }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, method = "GET", body, raw = false) => {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    await run({ store, request });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
}

async function push(request, scope, id, payload, version = 1) {
  return request("/v1/context", "POST", {
    scope, context_id: id, version, payload, delivered_at: NOW,
  });
}

test("all endpoint response schemas remain contract-compatible", async () => withServer(async ({ request }) => {
  const health = await request("/v1/healthz");
  assert.deepEqual(Object.keys(health.body).sort(), ["contexts_loaded", "status", "uptime_seconds"]);
  assert.deepEqual(Object.keys(health.body.contexts_loaded).sort(), ["category", "customer", "merchant", "trigger"]);

  const metadata = await request("/v1/metadata");
  assert.deepEqual(Object.keys(metadata.body).sort(), ["approach", "contact_email", "model", "submitted_at", "team_members", "team_name", "version"]);

  const contextAck = await push(request, "category", "restaurants", category());
  assert.equal(contextAck.status, 200);
  assert.deepEqual(Object.keys(contextAck.body).sort(), ["accepted", "ack_id", "stored_at"]);
  await push(request, "merchant", "m_phase6", merchant());
  await push(request, "trigger", "trg_phase6", trigger());

  const tick = await request("/v1/tick", "POST", { now: NOW, available_triggers: ["trg_phase6"] });
  assert.deepEqual(Object.keys(tick.body), ["actions"]);
  const action = tick.body.actions[0];
  assert.deepEqual(Object.keys(action).sort(), [
    "body", "conversation_id", "cta", "customer_id", "merchant_id", "rationale", "send_as",
    "suppression_key", "template_name", "template_params", "trigger_id",
  ]);

  const reply = await request("/v1/reply", "POST", {
    conversation_id: action.conversation_id,
    merchant_id: action.merchant_id,
    customer_id: null,
    from_role: "merchant",
    message: "What is my performance?",
    received_at: NOW,
    turn_number: 2,
  });
  assert.deepEqual(Object.keys(reply.body).sort(), ["action", "body", "cta", "rationale"]);

  const teardown = await request("/v1/teardown", "POST", {});
  assert.deepEqual(teardown.body, { cleared: true });
}));

test("a version-2 merchant injection affects the next turn of an existing conversation", async () => withServer(async ({ request }) => {
  await push(request, "category", "restaurants", category());
  await push(request, "merchant", "m_phase6", merchant(100));
  await push(request, "trigger", "trg_phase6", trigger());
  const tick = await request("/v1/tick", "POST", { now: NOW, available_triggers: ["trg_phase6"] });
  const conversationId = tick.body.actions[0].conversation_id;

  const update = await push(request, "merchant", "m_phase6", merchant(9876), 2);
  assert.equal(update.status, 200);
  const reply = await request("/v1/reply", "POST", {
    conversation_id: conversationId,
    merchant_id: "m_phase6",
    customer_id: null,
    from_role: "merchant",
    message: "How is my performance?",
    received_at: "2026-04-26T10:31:00Z",
    turn_number: 2,
  });
  assert.equal(reply.status, 200);
  assert.match(reply.body.body, /9876 views/);
  assert.doesNotMatch(reply.body.body, /100 views/);
}));

test("fresh stores replay identical inputs with identical outputs", () => {
  const compose = () => {
    const store = new VeraStore(":memory:");
    try {
      put(store, "category", "restaurants", category());
      put(store, "merchant", "m_phase6", merchant());
      put(store, "trigger", "trg_phase6", trigger());
      return decideActions({ store, now: NOW, availableTriggerIds: ["trg_phase6"] });
    } finally {
      store.close();
    }
  };
  assert.deepEqual(compose(), compose());
});

test("unknown contexts, empty ticks, malformed dates, and oversized bodies fail safely", async () => withServer(async ({ request }) => {
  assert.deepEqual((await request("/v1/tick", "POST", { now: NOW, available_triggers: [] })).body, { actions: [] });
  assert.deepEqual((await request("/v1/tick", "POST", { now: NOW, available_triggers: ["unknown"] })).body, { actions: [] });
  assert.equal((await request("/v1/tick", "POST", { now: "not-a-date", available_triggers: [] })).status, 400);
  assert.equal((await request("/v1/reply", "POST", {
    conversation_id: "x", from_role: "merchant", message: "hello", turn_number: -1,
  })).status, 400);

  const oversized = JSON.stringify({ payload: "x".repeat(500 * 1024 + 1) });
  const response = await request("/v1/context", "POST", oversized, true);
  assert.equal(response.status, 413);
  assert.equal(response.body.reason, "payload_too_large");
}));

test("health endpoint sustains more than 10 concurrent requests within its latency target", async () => withServer(async ({ request }) => {
  const started = performance.now();
  const results = await Promise.all(Array.from({ length: 50 }, () => request("/v1/healthz")));
  const elapsed = performance.now() - started;
  assert.ok(results.every((result) => result.status === 200));
  assert.ok(elapsed < 2000, `50 health requests took ${Math.round(elapsed)}ms`);
}));

test("expanded 5/50/200/100 dataset covers every generated trigger family safely", () => {
  const dataset = generateDataset();
  assert.equal(Object.keys(dataset.categories).length, 5);
  assert.equal(dataset.merchants.length, 50);
  assert.equal(dataset.customers.length, 200);
  assert.equal(dataset.triggers.length, 100);

  const store = new VeraStore(":memory:");
  try {
    for (const item of Object.values(dataset.categories)) put(store, "category", item.slug, item);
    for (const item of dataset.merchants) put(store, "merchant", item.merchant_id, item);
    for (const item of dataset.customers) put(store, "customer", item.customer_id, item);
    for (const item of dataset.triggers) put(store, "trigger", item.id, item);

    let actionCount = 0;
    const generatedKinds = new Set();
    for (const item of dataset.triggers) {
      const actions = decideActions({ store, now: NOW, availableTriggerIds: [item.id] });
      assert.ok(actions.length <= 1);
      for (const action of actions) {
        actionCount += 1;
        assert.ok(action.body.length > 0 && action.body.length <= 700);
        assert.doesNotMatch(action.body, /https?:\/\/|www\./i);
        assert.ok((action.body.match(/\?/g) ?? []).length <= 1);
        assert.ok(store.getCompositionAudit(action.conversation_id));
      }
      if (item.id.startsWith("trg_phase6_")) generatedKinds.add(item.kind);
    }
    assert.equal(generatedKinds.size, 15);
    assert.equal(actionCount, 99);
  } finally {
    store.close();
  }
});
