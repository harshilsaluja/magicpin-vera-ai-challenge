const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { productionConfigErrors, startServer } = require("../src/server");
const { VeraStore } = require("../src/store");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForListening(server) {
  if (server.listening) return;
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
}

async function main() {
  const requiredFiles = ["Dockerfile", ".dockerignore", "compose.yaml", ".env.example", "src/server.js"];
  for (const file of requiredFiles) assert(fs.existsSync(path.resolve(file)), `Missing deployment file: ${file}`);

  const dockerfile = fs.readFileSync(path.resolve("Dockerfile"), "utf8");
  const compose = fs.readFileSync(path.resolve("compose.yaml"), "utf8");
  assert(/^FROM node:24-/m.test(dockerfile), "Container must pin Node 24.");
  assert(/USER node/.test(dockerfile), "Container must run as the unprivileged node user.");
  assert(/HEALTHCHECK/.test(dockerfile), "Container health check is missing.");
  assert(/\/app\/data/.test(dockerfile) && /vera_data:\/app\/data/.test(compose), "Persistent data volume is missing.");
  assert(/restart: unless-stopped/.test(compose), "Restart policy is missing.");

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vera-phase7-"));
  const databasePath = path.join(temporaryRoot, "data", "vera.sqlite");
  const validProductionEnv = {
    NODE_ENV: "production",
    PORT: "8080",
    DATABASE_PATH: databasePath,
    TEAM_NAME: "Deployment Preflight",
    TEAM_MEMBER: "Candidate",
    CONTACT_EMAIL: "candidate@example.com",
    SUBMITTED_AT: "2026-09-26T00:00:00Z",
  };
  assert(productionConfigErrors(validProductionEnv).length === 0, "Valid production configuration was rejected.");
  assert(productionConfigErrors({ NODE_ENV: "production" }).length >= 5, "Production placeholder validation is not strict enough.");

  let runtime;
  try {
    runtime = startServer({ env: {
      ...validProductionEnv,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: "0",
      SHUTDOWN_TIMEOUT_MS: "5000",
    } });
    await waitForListening(runtime.server);
    const baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;
    const health = await fetch(`${baseUrl}/v1/healthz`);
    const ready = await fetch(`${baseUrl}/v1/readyz`);
    assert(health.status === 200 && (await health.json()).status === "ok", "Live health check failed.");
    assert(ready.status === 200 && (await ready.json()).status === "ready", "Readiness check failed.");

    const context = await fetch(`${baseUrl}/v1/context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "category",
        context_id: "phase7_preflight",
        version: 1,
        payload: { slug: "phase7_preflight", voice: {}, digest: [] },
        delivered_at: "2026-09-26T00:00:00Z",
      }),
    });
    assert(context.status === 200, "Persistent context write failed.");
    await runtime.shutdown("preflight_restart");
    runtime = null;

    const reopened = new VeraStore(databasePath);
    assert(reopened.counts().category === 1, "Context did not survive a process-style database restart.");
    reopened.teardown();
    reopened.close();

    console.log(JSON.stringify({
      result: "pass",
      container_definition: "validated",
      unprivileged_runtime: true,
      persistent_volume: "configured",
      production_environment_validation: "passed",
      health_and_readiness: "passed",
      graceful_shutdown: "passed",
      sqlite_restart_persistence: "passed",
    }, null, 2));
  } finally {
    if (runtime) await runtime.shutdown("preflight_cleanup");
    const resolved = path.resolve(temporaryRoot);
    const safePrefix = path.resolve(os.tmpdir()) + path.sep;
    if (resolved.startsWith(safePrefix) && path.basename(resolved).startsWith("vera-phase7-")) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ result: "fail", error: error.message }, null, 2));
  process.exitCode = 1;
});
