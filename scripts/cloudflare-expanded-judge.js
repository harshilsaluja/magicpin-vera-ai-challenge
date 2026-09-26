const { generateDataset } = require("./generate-expanded-dataset");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const baseUrl = (process.env.BOT_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
  if (process.env.JUDGE_ALLOW_TEARDOWN !== "1") {
    throw new Error("Set JUDGE_ALLOW_TEARDOWN=1; this check uploads and deletes synthetic data.");
  }
  const request = async (route, method = "GET", body) => {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const now = "2026-04-26T10:30:00Z";
  const push = (scope, id, payload) => request("/v1/context", "POST", {
    scope, context_id: id, version: 1, payload, delivered_at: now,
  });
  const dataset = generateDataset();
  await request("/v1/teardown", "POST", {});
  try {
    for (const item of Object.values(dataset.categories)) assert((await push("category", item.slug, item)).status === 200, `category ${item.slug}`);
    for (const item of dataset.merchants) assert((await push("merchant", item.merchant_id, item)).status === 200, `merchant ${item.merchant_id}`);
    for (const item of dataset.customers) assert((await push("customer", item.customer_id, item)).status === 200, `customer ${item.customer_id}`);
    for (const item of dataset.triggers) assert((await push("trigger", item.id, item)).status === 200, `trigger ${item.id}`);

    const health = await request("/v1/healthz");
    assert(JSON.stringify(health.body.contexts_loaded) === JSON.stringify({ category: 5, merchant: 50, customer: 200, trigger: 100 }), "expanded health counts mismatch");

    const concurrencyProbe = dataset.triggers.find((item) => item.kind === "active_planning_intent");
    const duplicateResults = await Promise.all([
      request("/v1/tick", "POST", { now, available_triggers: [concurrencyProbe.id] }),
      request("/v1/tick", "POST", { now, available_triggers: [concurrencyProbe.id] }),
    ]);
    const duplicateActionCount = duplicateResults.reduce((sum, item) => sum + item.body.actions.length, 0);
    assert(duplicateActionCount === 1, `concurrent suppression emitted ${duplicateActionCount} actions`);

    let actionCount = duplicateActionCount;
    const kinds = new Set([concurrencyProbe.kind]);
    for (const item of dataset.triggers) {
      const result = await request("/v1/tick", "POST", { now, available_triggers: [item.id] });
      assert(result.status === 200 && Array.isArray(result.body.actions), `tick ${item.id}`);
      assert(result.body.actions.length <= 1, `multiple actions ${item.id}`);
      for (const action of result.body.actions) {
        actionCount += 1;
        kinds.add(item.kind);
        assert(action.body.length > 0 && action.body.length <= 700, `body length ${item.id}`);
        assert(!/https?:\/\/|www\./i.test(action.body), `URL ${item.id}`);
        assert((action.body.match(/\?/g) ?? []).length <= 1, `CTA count ${item.id}`);
      }
    }
    assert(actionCount === 99, `expected 99 actions, received ${actionCount}`);
    console.log(JSON.stringify({ result: "pass", contexts: health.body.contexts_loaded, actions: actionCount, trigger_kinds_sent: kinds.size }, null, 2));
  } finally {
    await request("/v1/teardown", "POST", {});
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ result: "fail", error: error.message }, null, 2));
  process.exitCode = 1;
});
