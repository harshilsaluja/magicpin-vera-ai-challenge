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
  await push("category", "restaurants", {
    slug: "restaurants",
    voice: { tone: "warm_busy_practical", vocab_taboo: ["guaranteed packed house"] },
    digest: [],
  });
  for (const [id, owner] of [
    ["m_intent", "Harshil"],
    ["m_auto", "Amit"],
    ["m_optout", "Suresh"],
    ["m_questions", "Karan"],
  ]) {
    await push("merchant", id, restaurantMerchant(id, owner));
  }
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

async function reply(body) {
  return request("/v1/reply", "POST", {
    customer_id: null,
    received_at: "2026-04-26T10:45:00Z",
    ...body,
  });
}

function restaurantMerchant(id, owner) {
  return {
    merchant_id: id,
    category_slug: "restaurants",
    identity: { name: `${owner}'s Kitchen`, owner_first_name: owner, verified: true, languages: ["en", "hi"] },
    performance: { window_days: 30, views: 2200, calls: 12, directions: 38, ctr: 0.02, leads: 4 },
    offers: [{ title: "Buy 1 Pizza Get 1 Free (Tue-Thu)", status: "active" }],
  };
}

function merchantTrigger(id, merchantId, kind, payload, urgency = 3) {
  return {
    id,
    scope: "merchant",
    kind,
    source: "internal",
    merchant_id: merchantId,
    customer_id: null,
    payload,
    urgency,
    suppression_key: `${kind}:${merchantId}:${id}`,
    expires_at: "2026-06-30T00:00:00Z",
  };
}

test("explicit commitment switches immediately to action and is idempotent", async () => {
  const trigger = merchantTrigger(
    "trg_planning",
    "m_intent",
    "active_planning_intent",
    { intent_topic: "corporate_bulk_thali_package", merchant_last_message: "Yes, what would it look like?" },
    4,
  );
  await push("trigger", trigger.id, trigger);
  const tick = await request("/v1/tick", "POST", {
    now: "2026-04-26T10:30:00Z",
    available_triggers: [trigger.id],
  });
  const conversationId = tick.body.actions[0].conversation_id;
  const input = {
    conversation_id: conversationId,
    merchant_id: "m_intent",
    from_role: "merchant",
    message: "Ok, let's do it. What's next?",
    turn_number: 2,
  };

  const first = await reply(input);
  assert.equal(first.body.action, "send");
  assert.match(first.body.body, /action|prepare|draft/i);
  assert.doesNotMatch(first.body.body, /would you say|can you tell/i);

  const replay = await reply(input);
  assert.deepEqual(replay.body, first.body);

  const confirmation = await reply({
    conversation_id: conversationId,
    merchant_id: "m_intent",
    from_role: "merchant",
    message: "CONFIRM",
    turn_number: 4,
  });
  assert.equal(confirmation.body.action, "end");
});

test("identical WhatsApp auto-replies across conversations wait, then end", async () => {
  const autoMessage = "Thank you for contacting us! Our team will respond shortly.";
  const outcomes = [];
  for (let index = 1; index <= 3; index += 1) {
    const response = await reply({
      conversation_id: `conv_auto_${index}`,
      merchant_id: "m_auto",
      from_role: "merchant",
      message: autoMessage,
      turn_number: 2,
    });
    outcomes.push(response.body.action);
  }
  assert.deepEqual(outcomes, ["wait", "wait", "end"]);
});

test("opt-out ends the conversation and suppresses future proactive sends", async () => {
  const firstTrigger = merchantTrigger("trg_optout_first", "m_optout", "curious_ask_due", { ask_template: "service" }, 1);
  const laterTrigger = merchantTrigger("trg_optout_later", "m_optout", "review_theme_emerged", {
    theme: "delivery_late",
    occurrences_30d: 4,
    common_quote: "delivery took too long",
  }, 3);
  await push("trigger", firstTrigger.id, firstTrigger);
  await push("trigger", laterTrigger.id, laterTrigger);

  const tick = await request("/v1/tick", "POST", {
    now: "2026-04-26T10:30:00Z",
    available_triggers: [firstTrigger.id],
  });
  const conversationId = tick.body.actions[0].conversation_id;
  const stopped = await reply({
    conversation_id: conversationId,
    merchant_id: "m_optout",
    from_role: "merchant",
    message: "Not interested. Stop messaging me.",
    turn_number: 2,
  });
  assert.equal(stopped.body.action, "end");

  const afterEnd = await reply({
    conversation_id: conversationId,
    merchant_id: "m_optout",
    from_role: "merchant",
    message: "Can you help with GST instead?",
    turn_number: 3,
  });
  assert.equal(afterEnd.body.action, "end");

  const laterTick = await request("/v1/tick", "POST", {
    now: "2026-04-26T11:00:00Z",
    available_triggers: [laterTrigger.id],
  });
  assert.deepEqual(laterTick.body, { actions: [] });
});

test("off-topic requests are declined and redirected", async () => {
  const response = await reply({
    conversation_id: "conv_gst",
    merchant_id: "m_questions",
    from_role: "merchant",
    message: "Can you also help me file my GST?",
    turn_number: 1,
  });
  assert.equal(response.body.action, "send");
  assert.match(response.body.body, /leave GST.*professional/i);
  assert.match(response.body.body, /profile|offers|campaigns|performance/i);
});

test("inbound sales question refuses to invent unavailable sales", async () => {
  const response = await reply({
    conversation_id: "conv_sales",
    merchant_id: "m_questions",
    from_role: "merchant",
    message: "What are my monthly sales?",
    turn_number: 1,
  });
  assert.equal(response.body.action, "send");
  assert.match(response.body.body, /sales are not present/i);
  assert.match(response.body.body, /2200 views/);
  assert.doesNotMatch(response.body.body, /₹\d/);
});

test("inbound performance and offer questions use stored merchant facts", async () => {
  const performance = await reply({
    conversation_id: "conv_performance",
    merchant_id: "m_questions",
    from_role: "merchant",
    message: "How is my performance this month?",
    turn_number: 1,
  });
  assert.match(performance.body.body, /2200 views/);
  assert.match(performance.body.body, /12 calls/);

  const offers = await reply({
    conversation_id: "conv_offers",
    merchant_id: "m_questions",
    from_role: "merchant",
    message: "Which offer is active?",
    turn_number: 1,
  });
  assert.match(offers.body.body, /Buy 1 Pizza Get 1 Free/);
});

test("customer slot selection is matched to the original trigger without claiming a booking", async () => {
  const category = { slug: "dentists", voice: { tone: "peer_clinical", vocab_taboo: ["guaranteed"] }, digest: [] };
  const merchant = {
    merchant_id: "m_dentist_reply",
    category_slug: "dentists",
    identity: { name: "Dr. Meera's Clinic", owner_first_name: "Meera", verified: true, languages: ["en", "hi"] },
    offers: [{ title: "Dental Cleaning @ ₹299", status: "active" }],
  };
  const customer = {
    customer_id: "c_slot",
    merchant_id: merchant.merchant_id,
    identity: { name: "Priya", language_pref: "hi-en mix" },
    preferences: { channel: "whatsapp", preferred_slots: "weekday_evening" },
    consent: { opted_in_at: "2025-11-04", scope: ["recall_reminders"] },
  };
  const trigger = {
    id: "trg_slot",
    scope: "customer",
    kind: "recall_due",
    source: "internal",
    merchant_id: merchant.merchant_id,
    customer_id: customer.customer_id,
    payload: {
      service_due: "6_month_cleaning",
      due_date: "2026-11-12",
      available_slots: [{ label: "Wed 5 Nov, 6pm" }, { label: "Thu 6 Nov, 5pm" }],
    },
    urgency: 3,
    suppression_key: "recall:c_slot:6mo",
    expires_at: "2026-11-30T00:00:00Z",
  };
  await push("category", category.slug, category);
  await push("merchant", merchant.merchant_id, merchant);
  await push("customer", customer.customer_id, customer);
  await push("trigger", trigger.id, trigger);

  const tick = await request("/v1/tick", "POST", {
    now: "2026-11-01T10:00:00Z",
    available_triggers: [trigger.id],
  });
  const conversationId = tick.body.actions[0].conversation_id;
  const selection = await reply({
    conversation_id: conversationId,
    merchant_id: merchant.merchant_id,
    customer_id: customer.customer_id,
    from_role: "customer",
    message: "Yes, Thursday 5pm works",
    received_at: "2026-11-01T10:05:00Z",
    turn_number: 2,
  });
  assert.equal(selection.body.action, "send");
  assert.match(selection.body.body, /Thu 6 Nov, 5pm/);
  assert.match(selection.body.body, /preferred slot/);
  assert.doesNotMatch(selection.body.body, /booked|confirmed appointment/i);

  const confirmed = await reply({
    conversation_id: conversationId,
    merchant_id: merchant.merchant_id,
    customer_id: customer.customer_id,
    from_role: "customer",
    message: "CONFIRM",
    received_at: "2026-11-01T10:06:00Z",
    turn_number: 4,
  });
  assert.equal(confirmed.body.action, "end");
});

test("wait requests produce wait rather than another message", async () => {
  const response = await reply({
    conversation_id: "conv_wait",
    merchant_id: "m_questions",
    from_role: "merchant",
    message: "I am busy now, message me later please",
    turn_number: 1,
  });
  assert.equal(response.body.action, "wait");
  assert.equal(response.body.wait_seconds, 1800);
});
