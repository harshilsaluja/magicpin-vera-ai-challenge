const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createHandler } = require("../src/server");
const { VeraStore } = require("../src/store");

let server;
let store;
let baseUrl;
let version = 1;

test.before(async () => {
  store = new VeraStore(":memory:");
  server = http.createServer(createHandler({ store }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  store.close();
});

async function request(route, method = "GET", body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function push(scope, contextId, payload) {
  const response = await request("/v1/context", "POST", {
    scope,
    context_id: contextId,
    version: version++,
    payload,
    delivered_at: "2026-04-26T09:00:00Z",
  });
  assert.equal(response.status, 200);
}

const restaurantCategory = {
  slug: "restaurants",
  voice: {
    tone: "warm_busy_practical",
    vocab_taboo: ["guaranteed packed house"],
  },
  digest: [],
};

function merchant(id, owner = "Harshil") {
  return {
    merchant_id: id,
    category_slug: "restaurants",
    identity: { name: `${owner}'s Kitchen`, owner_first_name: owner, languages: ["en", "hi"] },
    performance: { views: 2200, calls: 12, directions: 38, ctr: 0.02 },
    offers: [{ id: `offer_${id}`, title: "Buy 1 Pizza Get 1 Free (Tue-Thu)", status: "active" }],
  };
}

function trigger(overrides = {}) {
  return {
    id: "trg_ipl_harshil",
    scope: "merchant",
    kind: "ipl_match_today",
    source: "external",
    merchant_id: "m_harshil",
    customer_id: null,
    payload: { match: "DC vs MI", match_time_iso: "2026-04-26T19:30:00+05:30" },
    urgency: 3,
    suppression_key: "ipl:m_harshil:2026-04-26",
    expires_at: "2026-04-26T23:59:59+05:30",
    ...overrides,
  };
}

test("tick composes a complete, grounded merchant action", async () => {
  await push("category", "restaurants", restaurantCategory);
  await push("merchant", "m_harshil", merchant("m_harshil"));
  await push("trigger", "trg_ipl_harshil", trigger());

  const response = await request("/v1/tick", "POST", {
    now: "2026-04-26T10:30:00Z",
    available_triggers: ["trg_ipl_harshil"],
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.actions.length, 1);
  const action = response.body.actions[0];
  assert.equal(action.merchant_id, "m_harshil");
  assert.equal(action.customer_id, null);
  assert.equal(action.send_as, "vera");
  assert.equal(action.trigger_id, "trg_ipl_harshil");
  assert.equal(action.suppression_key, "ipl:m_harshil:2026-04-26");
  assert.match(action.body, /DC vs MI/);
  assert.match(action.body, /Buy 1 Pizza Get 1 Free/);
  assert.ok(action.template_name);
  assert.ok(Array.isArray(action.template_params));
  assert.ok(action.cta);
  assert.ok(action.rationale);
  assert.ok(store.getConversation(action.conversation_id));
});

test("the same suppression key cannot send twice", async () => {
  const response = await request("/v1/tick", "POST", {
    now: "2026-04-26T10:35:00Z",
    available_triggers: ["trg_ipl_harshil", "trg_ipl_harshil"],
  });
  assert.deepEqual(response.body, { actions: [] });
});

test("expired and unsupported triggers are skipped", async () => {
  const expired = trigger({
    id: "trg_expired",
    merchant_id: "m_expired",
    suppression_key: "expired:key",
    expires_at: "2026-04-25T00:00:00Z",
  });
  const unsupported = trigger({
    id: "trg_unknown",
    kind: "unknown_kind",
    merchant_id: "m_unknown",
    suppression_key: "unknown:key",
  });
  await push("merchant", "m_expired", merchant("m_expired", "Expired"));
  await push("merchant", "m_unknown", merchant("m_unknown", "Unknown"));
  await push("trigger", expired.id, expired);
  await push("trigger", unsupported.id, unsupported);

  const response = await request("/v1/tick", "POST", {
    now: "2026-04-26T10:30:00Z",
    available_triggers: [expired.id, unsupported.id],
  });
  assert.deepEqual(response.body, { actions: [] });
});

test("only the highest-priority trigger is selected for one merchant per tick", async () => {
  await push("merchant", "m_priority", merchant("m_priority", "Priya"));
  const curious = trigger({
    id: "trg_curious",
    kind: "curious_ask_due",
    merchant_id: "m_priority",
    payload: { ask_template: "what_service_in_demand_this_week" },
    urgency: 1,
    suppression_key: "curious:m_priority",
  });
  const alert = trigger({
    id: "trg_alert",
    kind: "supply_alert",
    merchant_id: "m_priority",
    payload: { molecule: "atorvastatin", affected_batches: ["AT-101", "AT-102"], manufacturer: "MfrZ" },
    urgency: 5,
    suppression_key: "alert:m_priority",
  });
  await push("trigger", curious.id, curious);
  await push("trigger", alert.id, alert);

  const response = await request("/v1/tick", "POST", {
    now: "2026-04-26T10:30:00Z",
    available_triggers: [curious.id, alert.id],
  });
  assert.equal(response.body.actions.length, 1);
  assert.equal(response.body.actions[0].trigger_id, alert.id);
});

test("customer messages require matching merchant, channel, and consent", async () => {
  const dentistCategory = {
    slug: "dentists",
    voice: { tone: "peer_clinical", vocab_taboo: ["guaranteed"] },
    digest: [],
  };
  const dentist = {
    merchant_id: "m_dentist",
    category_slug: "dentists",
    identity: { name: "Dr. Meera's Clinic", owner_first_name: "Meera", languages: ["en", "hi"] },
    offers: [{ title: "Dental Cleaning @ ₹299", status: "active" }],
  };
  const consentedCustomer = {
    customer_id: "c_priya",
    merchant_id: "m_dentist",
    identity: { name: "Priya", language_pref: "hi-en mix" },
    preferences: { channel: "whatsapp", preferred_slots: "weekday_evening" },
    consent: { opted_in_at: "2025-11-04", scope: ["recall_reminders"] },
  };
  const blockedCustomer = {
    ...consentedCustomer,
    customer_id: "c_blocked",
    consent: { opted_in_at: null, scope: [] },
  };
  const recall = {
    id: "trg_recall",
    scope: "customer",
    kind: "recall_due",
    source: "internal",
    merchant_id: "m_dentist",
    customer_id: "c_priya",
    payload: {
      service_due: "6_month_cleaning",
      due_date: "2026-11-12",
      available_slots: [{ label: "Wed 5 Nov, 6pm" }, { label: "Thu 6 Nov, 5pm" }],
    },
    urgency: 3,
    suppression_key: "recall:c_priya:6mo",
    expires_at: "2026-11-30T00:00:00Z",
  };
  const blockedRecall = {
    ...recall,
    id: "trg_blocked_recall",
    customer_id: "c_blocked",
    suppression_key: "recall:c_blocked:6mo",
  };

  await push("category", "dentists", dentistCategory);
  await push("merchant", dentist.merchant_id, dentist);
  await push("customer", consentedCustomer.customer_id, consentedCustomer);
  await push("customer", blockedCustomer.customer_id, blockedCustomer);
  await push("trigger", recall.id, recall);
  await push("trigger", blockedRecall.id, blockedRecall);

  const response = await request("/v1/tick", "POST", {
    now: "2026-11-01T10:30:00Z",
    available_triggers: [recall.id, blockedRecall.id],
  });
  assert.equal(response.body.actions.length, 1);
  const action = response.body.actions[0];
  assert.equal(action.customer_id, "c_priya");
  assert.equal(action.send_as, "merchant_on_behalf");
  assert.match(action.body, /^Namaste Priya/);
  assert.match(action.body, /Dental Cleaning @ ₹299/);
});

test("far-away festival triggers are suppressed as low-value outreach", async () => {
  await push("merchant", "m_festival", merchant("m_festival", "Festival"));
  const festival = trigger({
    id: "trg_festival",
    kind: "festival_upcoming",
    merchant_id: "m_festival",
    payload: { festival: "Diwali", days_until: 188, date: "2026-10-31" },
    urgency: 1,
    suppression_key: "festival:m_festival:diwali",
    expires_at: "2026-11-02T00:00:00Z",
  });
  await push("trigger", festival.id, festival);

  const response = await request("/v1/tick", "POST", {
    now: "2026-04-26T10:30:00Z",
    available_triggers: [festival.id],
  });
  assert.deepEqual(response.body, { actions: [] });
});

test("invalid tick timestamps are rejected", async () => {
  const response = await request("/v1/tick", "POST", {
    now: "not-a-date",
    available_triggers: [],
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "invalid_tick");
});
