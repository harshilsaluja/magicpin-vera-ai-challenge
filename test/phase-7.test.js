const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createHandler, productionConfigErrors, startServer } = require("../src/server");
const { VeraStore } = require("../src/store");

test("production configuration rejects placeholders and accepts complete persistent settings", () => {
  const invalid = productionConfigErrors({ NODE_ENV: "production", PORT: "invalid", DATABASE_PATH: ":memory:" });
  assert.ok(invalid.length >= 6);
  assert.deepEqual(productionConfigErrors({
    NODE_ENV: "production",
    PORT: "8080",
    DATABASE_PATH: "/app/data/vera.sqlite",
    TEAM_NAME: "Vera Submission",
    TEAM_MEMBER: "Candidate Name",
    CONTACT_EMAIL: "candidate@example.com",
    SUBMITTED_AT: "2026-09-26T00:00:00Z",
  }), []);
});

test("readiness and production response headers are exposed", async () => {
  const store = new VeraStore(":memory:");
  const server = http.createServer(createHandler({ store }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const ready = await fetch(`${base}/v1/readyz`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: "ready" });
    assert.equal(ready.headers.get("cache-control"), "no-store");
    assert.equal(ready.headers.get("x-content-type-options"), "nosniff");
    const metadata = await (await fetch(`${base}/v1/metadata`)).json();
    assert.equal(metadata.version, "1.0.0");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});

test("graceful shutdown closes SQLite and state survives restart", async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vera-phase7-test-"));
  const databasePath = path.join(temporaryRoot, "data", "vera.sqlite");
  let runtime;
  try {
    runtime = startServer({ env: {
      NODE_ENV: "test", HOST: "127.0.0.1", PORT: "0", DATABASE_PATH: databasePath, SHUTDOWN_TIMEOUT_MS: "5000",
    } });
    if (!runtime.server.listening) await new Promise((resolve) => runtime.server.once("listening", resolve));
    const response = await fetch(`http://127.0.0.1:${runtime.server.address().port}/v1/context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "category", context_id: "restart_test", version: 1,
        payload: { slug: "restart_test" }, delivered_at: "2026-09-26T00:00:00Z",
      }),
    });
    assert.equal(response.status, 200);
    await runtime.shutdown("test");
    runtime = null;
    const reopened = new VeraStore(databasePath);
    assert.equal(reopened.counts().category, 1);
    reopened.close();
  } finally {
    if (runtime) await runtime.shutdown("test_cleanup");
    const resolved = path.resolve(temporaryRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("vera-phase7-test-")) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
});

test("container files pin the runtime, use a non-root user, and mount persistent data", () => {
  const dockerfile = fs.readFileSync(path.resolve(__dirname, "../Dockerfile"), "utf8");
  const compose = fs.readFileSync(path.resolve(__dirname, "../compose.yaml"), "utf8");
  assert.match(dockerfile, /^FROM node:24-bookworm-slim/m);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /VOLUME \["\/app\/data"\]/);
  assert.match(compose, /vera_data:\/app\/data/);
  assert.match(compose, /restart: unless-stopped/);
});
