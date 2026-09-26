const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { VeraStore } = require("../src/store");
const { decideActions } = require("../src/decision-engine");

const datasetRoot = path.resolve(__dirname, "../work/official-challenge/dataset");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

test("Phase 3 handles every actionable seed trigger in the attached official dataset", () => {
  const store = new VeraStore(":memory:");
  const deliveredAt = "2026-04-26T09:00:00Z";

  for (const categoryFile of fs.readdirSync(path.join(datasetRoot, "categories"))) {
    if (!categoryFile.endsWith(".json")) continue;
    const category = readJson(path.join(datasetRoot, "categories", categoryFile));
    store.putContext({
      scope: "category",
      context_id: category.slug,
      version: 1,
      payload: category,
      delivered_at: deliveredAt,
    });
  }

  const merchants = readJson(path.join(datasetRoot, "merchants_seed.json")).merchants;
  const customers = readJson(path.join(datasetRoot, "customers_seed.json")).customers;
  const triggers = readJson(path.join(datasetRoot, "triggers_seed.json")).triggers;

  for (const merchant of merchants) {
    store.putContext({ scope: "merchant", context_id: merchant.merchant_id, version: 1, payload: merchant, delivered_at: deliveredAt });
  }
  for (const customer of customers) {
    store.putContext({ scope: "customer", context_id: customer.customer_id, version: 1, payload: customer, delivered_at: deliveredAt });
  }
  for (const trigger of triggers) {
    store.putContext({ scope: "trigger", context_id: trigger.id, version: 1, payload: trigger, delivered_at: deliveredAt });
  }

  const produced = [];
  const skipped = [];
  const producedActions = [];
  for (const trigger of triggers) {
    const actions = decideActions({
      store,
      now: "2026-04-26T10:30:00Z",
      availableTriggerIds: [trigger.id],
    });
    if (actions.length === 1) {
      produced.push(trigger.id);
      producedActions.push(actions[0]);
    }
    else skipped.push(trigger.id);
  }

  assert.equal(produced.length, 24, `Unexpected skipped triggers: ${JSON.stringify(skipped)}`);
  assert.deepEqual(skipped, ["trg_006_festival_diwali"]);
  for (const action of producedActions) {
    for (const field of ["conversation_id", "merchant_id", "send_as", "trigger_id", "template_name", "body", "cta", "suppression_key", "rationale"]) {
      assert.ok(action[field], `Missing ${field} for ${action.trigger_id}`);
    }
    assert.ok(Array.isArray(action.template_params));
    assert.doesNotMatch(action.body, /https?:\/\/|www\./i);
    assert.ok((action.body.match(/\?/g) ?? []).length <= 1);
  }
  store.close();
});
