const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { VeraStore } = require("../src/store");
const { createHandler } = require("../src/server");
const { decideActions } = require("../src/decision-engine");
const { handleReply, validateReplyResponse } = require("../src/reply-engine");

const NOW = "2026-04-26T10:30:00Z";

function put(store, scope, id, payload, version = 1) {
  return store.putContext({ scope, context_id: id, version, payload, delivered_at: NOW });
}

function category(taboos = []) {
  return { slug: "restaurants", voice: { tone: "warm_busy_practical", vocab_taboo: taboos }, digest: [] };
}

function merchant(id, offer = "Weeknight Delivery Combo") {
  return {
    merchant_id: id,
    category_slug: "restaurants",
    identity: { name: `${id} Kitchen`, owner_first_name: id },
    performance: { views: 100, calls: 5 },
    offers: [{ title: offer, status: "active" }],
  };
}

function trigger(id, merchantId, overrides = {}) {
  return {
    id,
    scope: "merchant",
    kind: "active_planning_intent",
    source: "internal",
    merchant_id: merchantId,
    customer_id: null,
    payload: { intent_topic: "a delivery campaign" },
    urgency: 3,
    suppression_key: `phase5:${id}`,
    expires_at: "2026-04-27T10:30:00Z",
    ...overrides,
  };
}

test("latest context version is used and its evidence is audited", () => {
  const store = new VeraStore(":memory:");
  try {
    put(store, "category", "restaurants", category());
    put(store, "merchant", "m_versioned", merchant("m_versioned", "Old Offer"));
    put(store, "merchant", "m_versioned", merchant("m_versioned", "Latest Offer"), 2);
    put(store, "trigger", "trg_versioned", trigger("trg_versioned", "m_versioned"));

    const [action] = decideActions({ store, now: NOW, availableTriggerIds: ["trg_versioned"] });
    assert.match(action.body, /Latest Offer/);
    assert.doesNotMatch(action.body, /Old Offer/);
    assert.deepEqual(action.template_params, ["m_versioned Kitchen", action.body]);

    const audit = store.getCompositionAudit(action.conversation_id);
    assert.equal(audit.evidence.merchant.version, 2);
    assert.equal(audit.evidence.trigger.id, "trg_versioned");
    assert.equal(audit.checks.identity_links_match, true);
    assert.equal(audit.checks.suppression_claimed_atomically, true);
  } finally {
    store.close();
  }
});

test("cross-merchant customer data is never joined into a message", () => {
  const store = new VeraStore(":memory:");
  try {
    put(store, "category", "restaurants", category());
    put(store, "merchant", "m_right", merchant("m_right"));
    put(store, "customer", "c_wrong", {
      customer_id: "c_wrong",
      merchant_id: "m_other",
      identity: { name: "Riya", language_pref: "en" },
      preferences: { channel: "whatsapp" },
      consent: { opted_in_at: NOW, scope: ["appointment_reminders"] },
    });
    put(store, "trigger", "trg_customer_join", trigger("trg_customer_join", "m_right", {
      scope: "customer",
      kind: "appointment_tomorrow",
      customer_id: "c_wrong",
      payload: { appointment_time: "tomorrow at 10:00 AM" },
    }));
    assert.deepEqual(decideActions({ store, now: NOW, availableTriggerIds: ["trg_customer_join"] }), []);
  } finally {
    store.close();
  }
});

test("category taboo and final reply gates block unsafe output", () => {
  const store = new VeraStore(":memory:");
  try {
    put(store, "category", "restaurants", category(["guaranteed packed house"]));
    put(store, "merchant", "m_taboo", merchant("m_taboo", "Guaranteed Packed House"));
    put(store, "trigger", "trg_taboo", trigger("trg_taboo", "m_taboo"));
    assert.deepEqual(decideActions({ store, now: NOW, availableTriggerIds: ["trg_taboo"] }), []);
  } finally {
    store.close();
  }

  assert.equal(validateReplyResponse({
    action: "send", body: "Visit https://example.com now", cta: "link", rationale: "test",
  }, category()), false);
  assert.equal(validateReplyResponse({
    action: "send", body: "Guaranteed packed house. Continue?", cta: "yes_no", rationale: "test",
  }, category(["guaranteed packed house"])), false);
  assert.equal(validateReplyResponse({ action: "wait", wait_seconds: 900000, rationale: "test" }, category()), false);
});

test("tick hard cap remains 20 even with more eligible merchants", () => {
  const store = new VeraStore(":memory:");
  try {
    put(store, "category", "restaurants", category());
    const ids = [];
    for (let index = 0; index < 25; index += 1) {
      const merchantId = `m_cap_${index}`;
      const triggerId = `trg_cap_${index}`;
      put(store, "merchant", merchantId, merchant(merchantId));
      put(store, "trigger", triggerId, trigger(triggerId, merchantId));
      ids.push(triggerId);
    }
    const actions = decideActions({ store, now: NOW, availableTriggerIds: ids, limit: 20 });
    assert.equal(actions.length, 20);
    assert.equal(new Set(actions.map((action) => action.merchant_id)).size, 20);
  } finally {
    store.close();
  }
});

test("parallel duplicate ticks can claim a suppression key only once", async () => {
  const store = new VeraStore(":memory:");
  const server = http.createServer(createHandler({ store }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, body) => {
    const response = await fetch(`${baseUrl}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const push = (scope, id, payload) => post("/v1/context", {
    scope, context_id: id, version: 1, payload, delivered_at: NOW,
  });

  try {
    await push("category", "restaurants", category());
    await push("merchant", "m_parallel", merchant("m_parallel"));
    await push("trigger", "trg_parallel", trigger("trg_parallel", "m_parallel"));
    const body = { now: NOW, available_triggers: ["trg_parallel"] };
    const results = await Promise.all(Array.from({ length: 8 }, () => post("/v1/tick", body)));
    assert.ok(results.every((result) => result.status === 200));
    assert.equal(results.reduce((sum, result) => sum + result.body.actions.length, 0), 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});

test("context endpoint rejects envelope and payload identity mismatches", async () => {
  const store = new VeraStore(":memory:");
  const server = http.createServer(createHandler({ store }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "merchant",
        context_id: "m_expected",
        version: 1,
        payload: merchant("m_different"),
        delivered_at: NOW,
      }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.reason, "invalid_context");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});

test("reply identity must match the stored conversation", () => {
  const store = new VeraStore(":memory:");
  try {
    put(store, "category", "restaurants", category());
    put(store, "merchant", "m_owner", merchant("m_owner"));
    put(store, "trigger", "trg_identity", trigger("trg_identity", "m_owner"));
    const [action] = decideActions({ store, now: NOW, availableTriggerIds: ["trg_identity"] });
    const response = handleReply({
      store,
      now: NOW,
      reply: {
        conversation_id: action.conversation_id,
        merchant_id: "m_attacker",
        customer_id: null,
        from_role: "merchant",
        message: "show my performance",
        turn_number: 2,
      },
    });
    assert.equal(response.action, "end");
    assert.match(response.rationale, /identity did not match/);
  } finally {
    store.close();
  }
});
