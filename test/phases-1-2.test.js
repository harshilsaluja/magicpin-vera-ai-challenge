const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createHandler } = require("../src/server");
const { VeraStore } = require("../src/store");

let server;
let store;
let databasePath;
let baseUrl;

test.before(async () => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "vera-test-"));
  databasePath = path.join(tempDirectory, "vera.sqlite");
  store = new VeraStore(databasePath);
  server = http.createServer(createHandler({
    store,
    metadata: {
      team_name: "Test Team",
      team_members: ["Tester"],
      contact_email: "test@example.com",
      submitted_at: "2026-04-26T08:00:00Z",
    },
  }));
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

test("healthz starts with accurate zero counts", async () => {
  const response = await request("/v1/healthz");
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "ok");
  assert.deepEqual(response.body.contexts_loaded, { category: 0, merchant: 0, customer: 0, trigger: 0 });
});

test("metadata returns the required identity fields", async () => {
  const response = await request("/v1/metadata");
  assert.equal(response.status, 200);
  assert.equal(response.body.team_name, "Test Team");
  assert.deepEqual(response.body.team_members, ["Tester"]);
  assert.equal(response.body.submitted_at, "2026-04-26T08:00:00Z");
  assert.ok(response.body.model);
  assert.ok(response.body.approach);
  assert.ok(response.body.version);
});

test("context insertion, stale rejection, and higher-version replacement are correct", async () => {
  const versionOne = {
    scope: "merchant",
    context_id: "m_001",
    version: 1,
    payload: { merchant_id: "m_001", category_slug: "restaurants", performance: { views: 100 } },
    delivered_at: "2026-04-26T09:45:00Z",
  };

  const inserted = await request("/v1/context", "POST", versionOne);
  assert.equal(inserted.status, 200);
  assert.equal(inserted.body.accepted, true);
  assert.match(inserted.body.ack_id, /^ack_m_001_v1$/);

  const duplicate = await request("/v1/context", "POST", versionOne);
  assert.equal(duplicate.status, 409);
  assert.deepEqual(duplicate.body, { accepted: false, reason: "stale_version", current_version: 1 });

  const replaced = await request("/v1/context", "POST", {
    ...versionOne,
    version: 2,
    payload: { merchant_id: "m_001", category_slug: "restaurants", performance: { views: 250 } },
  });
  assert.equal(replaced.status, 200);
  assert.equal(store.getContext("merchant", "m_001").version, 2);
  assert.equal(store.getContext("merchant", "m_001").payload.performance.views, 250);

  const health = await request("/v1/healthz");
  assert.equal(health.body.contexts_loaded.merchant, 1);
});

test("stored context survives reopening the SQLite database", () => {
  const secondConnection = new VeraStore(databasePath);
  const saved = secondConnection.getContext("merchant", "m_001");
  assert.equal(saved.version, 2);
  assert.equal(saved.payload.performance.views, 250);
  secondConnection.close();
});

test("invalid context is rejected", async () => {
  const response = await request("/v1/context", "POST", {
    scope: "unknown",
    context_id: "x",
    version: 1,
    payload: {},
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.accepted, false);
});

test("tick has a valid Phase 1 response shape", async () => {
  const response = await request("/v1/tick", "POST", {
    now: "2026-04-26T10:30:00Z",
    available_triggers: ["trg_001"],
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { actions: [] });
});

test("reply has a valid Phase 4 response shape", async () => {
  const response = await request("/v1/reply", "POST", {
    conversation_id: "conv_001",
    merchant_id: "m_001",
    customer_id: null,
    from_role: "merchant",
    message: "Yes, send it",
    received_at: "2026-04-26T10:45:00Z",
    turn_number: 2,
  });
  assert.equal(response.status, 200);
  assert.ok(["send", "wait", "end"].includes(response.body.action));
  assert.ok(response.body.rationale);
});

test("teardown clears all stored contexts", async () => {
  const response = await request("/v1/teardown", "POST", {});
  assert.equal(response.status, 200);
  assert.deepEqual(store.counts(), { category: 0, merchant: 0, customer: 0, trigger: 0 });
});
