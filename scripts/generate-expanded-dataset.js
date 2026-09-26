const fs = require("node:fs");
const path = require("node:path");

const seedRoot = path.resolve(__dirname, "../work/official-challenge/dataset");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadSeeds() {
  const categories = {};
  for (const file of fs.readdirSync(path.join(seedRoot, "categories")).filter((name) => name.endsWith(".json"))) {
    const item = readJson(path.join(seedRoot, "categories", file));
    categories[item.slug] = item;
  }
  return {
    categories,
    merchants: readJson(path.join(seedRoot, "merchants_seed.json")).merchants,
    customers: readJson(path.join(seedRoot, "customers_seed.json")).customers,
    triggers: readJson(path.join(seedRoot, "triggers_seed.json")).triggers,
  };
}

function triggerPayload(kind, category) {
  const digestId = category.digest?.[0]?.id;
  const payloads = {
    research_digest: { top_item_id: digestId },
    perf_dip: { metric: "views", delta_pct: -0.18, window: "the last 7 days", is_expected_seasonal: false },
    perf_spike: { metric: "calls", delta_pct: 0.22, window: "the last 7 days", likely_driver: "profile_update" },
    milestone_reached: { metric: "profile_views", value_now: 995, milestone_value: 1000 },
    dormant_with_vera: { days_since_last_merchant_message: 21 },
    review_theme_emerged: { theme: "fast_service", occurrences_30d: 4, common_quote: "Quick and helpful service" },
    competitor_opened: { competitor_name: "New Local Competitor", distance_km: 1.4, their_offer: "Introductory offer" },
    festival_upcoming: { festival: "Local Festival", days_until: 7 },
    recall_due: { service_due: "routine follow-up", due_date: "2026-05-03", available_slots: [{ label: "Monday 10:00 AM" }] },
    customer_lapsed_soft: { days_since_last_visit: 75, previous_focus: "regular care" },
    appointment_tomorrow: { appointment_time: "tomorrow at 10:00 AM" },
    chronic_refill_due: { molecule_list: ["Metformin 500 mg"], stock_runs_out_iso: "2026-05-01" },
    trial_followup: { trial_date: "2026-04-24", next_session_options: [{ label: "Tuesday 6:00 PM" }] },
    renewal_due: { days_remaining: 12, plan: "Pro" },
    curious_ask_due: { topic: "weekly customer demand" },
  };
  return payloads[kind];
}

function generateDataset() {
  const seeds = loadSeeds();
  const merchants = clone(seeds.merchants);
  for (const slug of Object.keys(seeds.categories).sort()) {
    const templates = seeds.merchants.filter((merchant) => merchant.category_slug === slug);
    let count = templates.length;
    while (count < 10) {
      const item = clone(templates[count % templates.length]);
      item.merchant_id = `m_phase6_${slug}_${String(count + 1).padStart(2, "0")}`;
      item.identity.name = `Phase 6 ${seeds.categories[slug].display_name || slug} ${count + 1}`;
      item.identity.owner_first_name = `Owner${count + 1}`;
      item.identity.locality = `Test Locality ${count + 1}`;
      item.performance.views = 700 + count * 113;
      item.performance.calls = 5 + count;
      item.conversation_history = [];
      merchants.push(item);
      count += 1;
    }
  }

  const customers = clone(seeds.customers);
  let customerIndex = customers.length + 1;
  while (customers.length < 200) {
    const merchant = merchants[(customers.length - seeds.customers.length) % merchants.length];
    customers.push({
      customer_id: `c_phase6_${String(customerIndex).padStart(3, "0")}`,
      merchant_id: merchant.merchant_id,
      identity: { name: `Customer${customerIndex}`, phone_redacted: "<phone>", language_pref: customerIndex % 2 ? "en" : "hi-en mix" },
      relationship: { first_visit: "2025-09-01", last_visit: "2026-04-01", visits_total: 3, services_received: [], lifetime_value: 1500 },
      state: "active",
      preferences: { channel: "whatsapp", reminder_opt_in: true },
      consent: {
        opted_in_at: "2025-09-01",
        scope: ["recall_reminders", "appointment_reminders", "refill_reminders", "delivery_notifications", "winback_offers", "promotional_offers", "program_updates"],
      },
    });
    customerIndex += 1;
  }

  const triggers = clone(seeds.triggers);
  const families = [
    ["research_digest", "external", "merchant", 1], ["perf_dip", "internal", "merchant", 3],
    ["perf_spike", "internal", "merchant", 1], ["milestone_reached", "internal", "merchant", 1],
    ["dormant_with_vera", "internal", "merchant", 2], ["review_theme_emerged", "internal", "merchant", 3],
    ["competitor_opened", "external", "merchant", 2], ["festival_upcoming", "external", "merchant", 1],
    ["recall_due", "internal", "customer", 3], ["customer_lapsed_soft", "internal", "customer", 3],
    ["appointment_tomorrow", "internal", "customer", 2], ["chronic_refill_due", "internal", "customer", 2],
    ["trial_followup", "internal", "customer", 2], ["renewal_due", "internal", "merchant", 4],
    ["curious_ask_due", "internal", "merchant", 1],
  ];
  let generatedIndex = 0;
  for (const [kind, source, scope, urgency] of families) {
    for (let copyIndex = 0; copyIndex < 5; copyIndex += 1) {
      const merchant = merchants[(generatedIndex * 7 + copyIndex) % merchants.length];
      let customer = null;
      if (scope === "customer") {
        customer = customers.find((item) => item.merchant_id === merchant.merchant_id && item.customer_id.startsWith("c_phase6_"));
        if (!customer) customer = customers.find((item) => item.merchant_id === merchant.merchant_id);
      }
      const id = `trg_phase6_${String(generatedIndex + 1).padStart(3, "0")}_${kind}`;
      triggers.push({
        id, scope, kind, source,
        merchant_id: merchant.merchant_id,
        customer_id: customer?.customer_id ?? null,
        payload: triggerPayload(kind, seeds.categories[merchant.category_slug]),
        urgency,
        suppression_key: `phase6:${kind}:${generatedIndex + 1}`,
        expires_at: "2026-06-30T00:00:00Z",
      });
      generatedIndex += 1;
    }
  }
  return { categories: seeds.categories, merchants, customers, triggers };
}

function writeDataset(dataset, outputRoot) {
  for (const directory of ["categories", "merchants", "customers", "triggers"]) {
    fs.mkdirSync(path.join(outputRoot, directory), { recursive: true });
  }
  for (const category of Object.values(dataset.categories)) {
    fs.writeFileSync(path.join(outputRoot, "categories", `${category.slug}.json`), `${JSON.stringify(category, null, 2)}\n`);
  }
  for (const [directory, items, key] of [
    ["merchants", dataset.merchants, "merchant_id"], ["customers", dataset.customers, "customer_id"], ["triggers", dataset.triggers, "id"],
  ]) {
    for (const item of items) fs.writeFileSync(path.join(outputRoot, directory, `${item[key]}.json`), `${JSON.stringify(item, null, 2)}\n`);
  }
  const pairs = dataset.triggers.slice(0, 30).map((item, index) => ({
    test_id: `T${String(index + 1).padStart(2, "0")}`,
    trigger_id: item.id,
    merchant_id: item.merchant_id,
    customer_id: item.customer_id,
  }));
  fs.writeFileSync(path.join(outputRoot, "test_pairs.json"), `${JSON.stringify({ pairs }, null, 2)}\n`);
}

if (require.main === module) {
  const outputRoot = path.resolve(process.argv[2] || path.join(__dirname, "../work/expanded-phase6"));
  const dataset = generateDataset();
  writeDataset(dataset, outputRoot);
  console.log(JSON.stringify({
    output: outputRoot,
    categories: Object.keys(dataset.categories).length,
    merchants: dataset.merchants.length,
    customers: dataset.customers.length,
    triggers: dataset.triggers.length,
  }, null, 2));
}

module.exports = { generateDataset, writeDataset };
