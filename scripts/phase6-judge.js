const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createHandler } = require("../src/server");
const { VeraStore } = require("../src/store");

const datasetRoot = path.resolve(__dirname, "../work/official-challenge/dataset");
const fixedNow = "2026-04-26T10:30:00Z";

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(datasetRoot, relativePath), "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validAction(action) {
  const strings = ["conversation_id", "merchant_id", "send_as", "trigger_id", "template_name", "body", "cta", "suppression_key", "rationale"];
  return strings.every((field) => typeof action[field] === "string" && action[field].length > 0)
    && (action.customer_id === null || typeof action.customer_id === "string")
    && Array.isArray(action.template_params)
    && action.template_params.every((value) => typeof value === "string")
    && action.body.length <= 700
    && !/https?:\/\/|www\./i.test(action.body)
    && (action.body.match(/\?/g) ?? []).length <= 1;
}

async function main() {
  const externalUrl = process.env.BOT_URL?.trim().replace(/\/$/, "");
  if (externalUrl && process.env.JUDGE_ALLOW_TEARDOWN !== "1") {
    throw new Error("Remote judge mode writes and tears down test data. Set JUDGE_ALLOW_TEARDOWN=1 only for your own fresh deployment.");
  }
  const store = externalUrl ? null : new VeraStore(":memory:");
  const server = externalUrl ? null : http.createServer(createHandler({
    store,
    metadata: { team_name: "Phase 6 local judge", team_members: ["Candidate"], contact_email: "local@example.com" },
  }));
  if (server) await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = externalUrl || `http://127.0.0.1:${server.address().port}`;
  const request = async (route, method = "GET", body) => {
    const started = performance.now();
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const responseText = await response.text();
    let responseBody;
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      const preview = responseText.replace(/\s+/g, " ").slice(0, 180);
      throw new Error(`${method} ${route} returned HTTP ${response.status} with non-JSON body: ${preview}`);
    }
    return { status: response.status, body: responseBody, ms: performance.now() - started };
  };
  const push = (scope, id, payload, version = 1) => request("/v1/context", "POST", {
    scope, context_id: id, version, payload, delivered_at: fixedNow,
  });

  try {
    if (externalUrl) {
      const reset = await request("/v1/teardown", "POST", {});
      assert(reset.status === 200 && reset.body.cleared === true, "remote pre-test teardown failed");
    }
    const health = await request("/v1/healthz");
    const metadata = await request("/v1/metadata");
    assert(health.status === 200 && health.body.status === "ok", "health contract failed");
    assert(metadata.status === 200 && metadata.body.team_name, "metadata contract failed");

    const categoryFiles = fs.readdirSync(path.join(datasetRoot, "categories")).filter((name) => name.endsWith(".json"));
    const merchants = readJson("merchants_seed.json").merchants;
    const customers = readJson("customers_seed.json").customers;
    const triggers = readJson("triggers_seed.json").triggers;
    for (const file of categoryFiles) {
      const item = readJson(path.join("categories", file));
      assert((await push("category", item.slug, item)).status === 200, `category push failed: ${item.slug}`);
    }
    for (const item of merchants) assert((await push("merchant", item.merchant_id, item)).status === 200, `merchant push failed: ${item.merchant_id}`);
    for (const item of customers) assert((await push("customer", item.customer_id, item)).status === 200, `customer push failed: ${item.customer_id}`);
    for (const item of triggers) assert((await push("trigger", item.id, item)).status === 200, `trigger push failed: ${item.id}`);

    const actions = [];
    for (const item of triggers) {
      const tick = await request("/v1/tick", "POST", { now: fixedNow, available_triggers: [item.id] });
      assert(tick.status === 200 && Array.isArray(tick.body.actions), `tick failed: ${item.id}`);
      assert(tick.body.actions.length <= 1, `single trigger returned multiple actions: ${item.id}`);
      for (const action of tick.body.actions) {
        assert(validAction(action), `invalid action schema: ${item.id}`);
        actions.push(action);
      }
    }
    assert(actions.length === 24, `expected 24 eligible seed actions, received ${actions.length}`);

    const merchantId = merchants[0].merchant_id;
    const autoMessage = "Thank you for contacting us! Our team will respond shortly.";
    const autoActions = [];
    for (let index = 1; index <= 3; index += 1) {
      const result = await request("/v1/reply", "POST", {
        conversation_id: `phase6_auto_${index}`,
        merchant_id: merchantId,
        customer_id: null,
        from_role: "merchant",
        message: autoMessage,
        received_at: fixedNow,
        turn_number: 2,
      });
      assert(result.status === 200, "auto-reply scenario failed");
      autoActions.push(result.body.action);
    }
    assert(JSON.stringify(autoActions) === JSON.stringify(["wait", "wait", "end"]), "auto-reply progression failed");

    const commit = await request("/v1/reply", "POST", {
      conversation_id: "phase6_commit",
      merchant_id: merchantId,
      customer_id: null,
      from_role: "merchant",
      message: "Okay, let's do it. What's next?",
      received_at: fixedNow,
      turn_number: 2,
    });
    assert(commit.status === 200 && commit.body.action === "send" && /action|confirm|continue/i.test(commit.body.body), "commit transition failed");

    const hostile = await request("/v1/reply", "POST", {
      conversation_id: "phase6_hostile",
      merchant_id: merchants[1].merchant_id,
      customer_id: null,
      from_role: "merchant",
      message: "Stop messaging me. This is useless spam.",
      received_at: fixedNow,
      turn_number: 2,
    });
    assert(hostile.status === 200 && hostile.body.action === "end", "hostile exit failed");

    const loadStarted = performance.now();
    const loadResults = [];
    for (let second = 0; second < 3; second += 1) {
      const wave = await Promise.all(Array.from({ length: 10 }, () => request("/v1/healthz")));
      loadResults.push(...wave);
      if (second < 2) await new Promise((resolve) => setTimeout(resolve, Math.max(0, 1000 - (performance.now() - loadStarted - second * 1000))));
    }
    assert(loadResults.every((result) => result.status === 200), "10 requests/second health load failed");
    const loadLatencies = loadResults.map((result) => Math.round(result.ms));
    const maximumLoadLatency = Math.max(...loadLatencies);
    assert(
      maximumLoadLatency < 2000,
      `health latency exceeded 2 seconds (max ${maximumLoadLatency}ms; samples ${loadLatencies.join(",")})`,
    );

    const teardown = await request("/v1/teardown", "POST", {});
    const cleanHealth = await request("/v1/healthz");
    assert(teardown.status === 200 && teardown.body.cleared === true, "teardown failed");
    assert(Object.values(cleanHealth.body.contexts_loaded).every((count) => count === 0), "teardown left contexts behind");

    console.log(JSON.stringify({
      result: "pass",
      contexts_tested: { categories: categoryFiles.length, merchants: merchants.length, customers: customers.length, triggers: triggers.length },
      eligible_actions_validated: actions.length,
      reply_scenarios: { auto_reply: autoActions, commitment: commit.body.action, hostile: hostile.body.action },
      load_test: { requests: loadResults.length, rate_per_second: 10, max_latency_ms: maximumLoadLatency },
      teardown_verified: true,
    }, null, 2));
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (store) store.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ result: "fail", error: error.message }, null, 2));
  process.exitCode = 1;
});
