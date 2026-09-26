const crypto = require("node:crypto");

const KIND_PRIORITY = {
  supply_alert: 500,
  regulation_change: 480,
  active_planning_intent: 460,
  appointment_tomorrow: 440,
  chronic_refill_due: 430,
  recall_due: 420,
  perf_dip: 360,
  review_theme_emerged: 350,
  renewal_due: 340,
  perf_spike: 300,
  milestone_reached: 280,
  trial_followup: 270,
  customer_lapsed_hard: 260,
  customer_lapsed_soft: 250,
  wedding_package_followup: 240,
  ipl_match_today: 230,
  competitor_opened: 220,
  research_digest: 200,
  cde_opportunity: 190,
  category_seasonal: 180,
  gbp_unverified: 170,
  winback_eligible: 160,
  dormant_with_vera: 140,
  curious_ask_due: 100,
  festival_upcoming: 80,
  seasonal_perf_dip: 70,
};

const CUSTOMER_CONSENT = {
  recall_due: ["recall_reminders", "appointment_reminders"],
  appointment_tomorrow: ["appointment_reminders"],
  chronic_refill_due: ["refill_reminders", "delivery_notifications"],
  customer_lapsed_hard: ["winback_offers", "renewal_reminders"],
  customer_lapsed_soft: ["winback_offers", "promotional_offers"],
  trial_followup: ["program_updates", "kids_program_updates"],
  wedding_package_followup: ["bridal_package_followup", "bridal_followup", "promotional_offers"],
};

function contextPayload(store, scope, id) {
  return id ? store.getContext(scope, id)?.payload ?? null : null;
}

function activeOffer(merchant) {
  return (merchant.offers ?? []).find((offer) => offer.status === "active")?.title ?? null;
}

function activeOffers(merchant) {
  return (merchant.offers ?? []).filter((offer) => offer.status === "active").map((offer) => offer.title);
}

function relevantOffer(merchant, terms = []) {
  const offers = activeOffers(merchant);
  const normalizedTerms = terms.map((term) => String(term).toLowerCase());
  if (!normalizedTerms.length) return offers[0] ?? null;
  return offers.find((title) => normalizedTerms.some((term) => title.toLowerCase().includes(term))) ?? null;
}

function firstSentence(text) {
  if (!text) return null;
  return String(text).split(/(?<=[.!?])\s/)[0].trim();
}

function cleanLabel(value) {
  return String(value ?? "").replaceAll("_", " ").replace(/\s+/g, " ").trim();
}

function ownerLabel(category, merchant) {
  const owner = merchant.identity?.owner_first_name || merchant.identity?.name || "there";
  if (category.slug !== "dentists") return owner;
  return /^dr\.?\s/i.test(owner) ? owner : `Dr. ${owner}`;
}

function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const percentage = Math.abs(numeric) <= 1 ? numeric * 100 : numeric;
  const sign = percentage > 0 ? "+" : "";
  return `${sign}${Math.round(percentage)}%`;
}

function formatDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  }).format(date);
}

function digestItem(category, payload) {
  const id = payload.top_item_id || payload.digest_item_id || payload.alert_id;
  return (category.digest ?? []).find((item) => item.id === id) ?? null;
}

function deterministicConversationId(trigger) {
  const source = [trigger.id, trigger.merchant_id, trigger.customer_id || "merchant", trigger.suppression_key, trigger.expires_at].join("|");
  return `conv_${crypto.createHash("sha256").update(source).digest("hex").slice(0, 20)}`;
}

function priority(trigger) {
  const urgency = Number.isFinite(Number(trigger.urgency)) ? Number(trigger.urgency) : 0;
  return urgency * 1000 + (KIND_PRIORITY[trigger.kind] ?? 0);
}

function consentAllows(customer, trigger) {
  if (trigger.scope !== "customer") return true;
  if (!customer || customer.merchant_id !== trigger.merchant_id) return false;
  if (!customer.consent?.opted_in_at) return false;
  const channel = customer.preferences?.channel;
  if (!channel || channel === "none_recorded") return false;
  const granted = customer.consent.scope ?? [];
  const required = CUSTOMER_CONSENT[trigger.kind];
  if (!required) return granted.length > 0;
  return required.some((scope) => granted.includes(scope));
}

function eligible({ store, trigger, customer, now }) {
  if (!trigger?.id || !trigger.merchant_id || !trigger.suppression_key) return false;
  if (!["merchant", "customer"].includes(trigger.scope)) return false;
  const expiry = Date.parse(trigger.expires_at);
  const current = Date.parse(now);
  if (!Number.isFinite(expiry) || !Number.isFinite(current) || expiry <= current) return false;
  if (store.isSuppressed(trigger.suppression_key, now)) return false;
  if (store.isMerchantSuppressed(trigger.merchant_id, now)) return false;
  if (!consentAllows(customer, trigger)) return false;
  if (trigger.kind === "festival_upcoming" && Number(trigger.payload?.days_until) > 30) return false;
  return true;
}

function merchantPlan({ category, merchant, trigger }) {
  const payload = trigger.payload ?? {};
  const who = ownerLabel(category, merchant);
  const offer = activeOffer(merchant);
  const item = digestItem(category, payload);

  if (["research_digest", "cde_opportunity"].includes(trigger.kind)) {
    if (!item?.title || !item?.source) return null;
    const action = item.actionable ? ` Practical takeaway: ${item.actionable}.` : "";
    const cohortCount = item.patient_segment === "high_risk_adults" ? merchant.customer_aggregate?.high_risk_adult_count : null;
    const merchantAnchor = cohortCount
      ? ` It is relevant to your ${cohortCount} high-risk adult patients.`
      : merchant.identity?.locality
        ? ` This is relevant to your ${merchant.identity.locality} practice.`
        : "";
    return {
      body: `${who}, ${item.title}.${merchantAnchor}${action} Want me to prepare a short merchant-ready summary? — ${item.source}`,
      cta: "binary_yes_no",
      reason: "source-backed category update",
    };
  }

  if (trigger.kind === "regulation_change") {
    if (!item?.title || !item?.source) return null;
    const deadline = formatDate(payload.deadline_iso);
    return {
      body: `${who}, compliance update: ${item.title}.${deadline ? ` Deadline: ${deadline}.` : ""} ${item.actionable || ""} Want me to prepare a checklist? — ${item.source}`.replace(/\s+/g, " ").trim(),
      cta: "binary_yes_no",
      reason: "time-bound compliance update",
    };
  }

  if (["perf_dip", "seasonal_perf_dip"].includes(trigger.kind)) {
    const change = formatPercent(payload.delta_pct);
    if (!payload.metric || !change) return null;
    const metricValue = merchant.performance?.[payload.metric];
    const peerKey = {
      views: "avg_views_30d",
      calls: "avg_calls_30d",
      directions: "avg_directions_30d",
      ctr: "avg_ctr",
    }[payload.metric];
    const peerValue = peerKey ? category.peer_stats?.[peerKey] : null;
    const currentFact = metricValue !== undefined ? ` Your current 30-day ${cleanLabel(payload.metric)} value is ${payload.metric === "ctr" ? formatPercent(metricValue) : metricValue}.` : "";
    const peerFact = peerValue !== undefined && peerValue !== null ? ` Category peer reference: ${payload.metric === "ctr" ? formatPercent(peerValue) : peerValue}.` : "";
    const seasonalItem = payload.is_expected_seasonal
      ? (category.digest ?? []).find((entry) => entry.kind === "seasonal" && /april|acquisition|resolution/i.test(`${entry.title} ${entry.summary}`))
      : null;
    const seasonal = seasonalItem
      ? ` This matches the supplied seasonal note: ${firstSentence(seasonalItem.summary)}.`
      : payload.is_expected_seasonal ? " This is marked as an expected seasonal pattern." : "";
    const retentionAnchor = payload.is_expected_seasonal && merchant.customer_aggregate?.total_active_members
      ? ` You have ${merchant.customer_aggregate.total_active_members} active members to focus on.`
      : "";
    return {
      body: `${who}, your ${cleanLabel(payload.metric)} changed ${change} over ${payload.window || "the latest period"}.${currentFact}${peerFact}${seasonal}${retentionAnchor} Want me to prepare one focused recovery action?`,
      cta: "binary_yes_no",
      reason: "merchant performance change",
    };
  }

  if (trigger.kind === "perf_spike") {
    const change = formatPercent(payload.delta_pct);
    if (!payload.metric || !change) return null;
    const driver = payload.likely_driver ? ` The supplied signal points to ${cleanLabel(payload.likely_driver)} as the likely driver.` : "";
    return {
      body: `${who}, your ${cleanLabel(payload.metric)} is ${change} over ${payload.window || "the latest period"}.${driver} Want me to draft a follow-up that builds on it?`,
      cta: "binary_yes_no",
      reason: "positive performance signal",
    };
  }

  if (trigger.kind === "milestone_reached") {
    if (!payload.metric || payload.milestone_value === undefined) return null;
    const current = Number(payload.value_now);
    const milestone = Number(payload.milestone_value);
    const gap = Number.isFinite(current) && Number.isFinite(milestone) ? milestone - current : null;
    return {
      body: `${who}, ${cleanLabel(payload.metric)} is at ${payload.value_now}; the ${payload.milestone_value} milestone is ${gap > 0 ? `${gap} away` : "reached"}. Want me to draft a milestone post?`,
      cta: "binary_yes_no",
      reason: "merchant milestone",
    };
  }

  if (trigger.kind === "ipl_match_today") {
    if (!payload.match || !payload.match_time_iso) return null;
    const matchTime = new Date(payload.match_time_iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
    const iplInsight = (category.digest ?? []).find((entry) => /ipl/i.test(`${entry.title} ${entry.summary}`));
    if (payload.is_weeknight === false && iplInsight) {
      return {
        body: `${who}, ${payload.match} is on today at ${matchTime}, but ${iplInsight.title}. Skip a dine-in match promo today.${offer ? ` Keep ${offer} for its listed days.` : ""} Want me to draft the next weeknight match message? — ${iplInsight.source}`,
        cta: "binary_yes_no",
        reason: "contrarian event decision grounded in category data",
      };
    }
    return {
      body: `${who}, ${payload.match} is on today at ${matchTime}.${offer ? ` Your active offer is ${offer}.` : ""} Want me to draft one delivery-focused match message?`,
      cta: "binary_yes_no",
      reason: "same-day restaurant event",
    };
  }

  if (trigger.kind === "festival_upcoming") {
    if (!payload.festival || payload.days_until === undefined) return null;
    return {
      body: `${who}, ${payload.festival} is ${payload.days_until} days away.${offer ? ` Your active offer is ${offer}.` : ""} Want me to prepare one timely campaign draft?`,
      cta: "binary_yes_no",
      reason: "near-term festival opportunity",
    };
  }

  if (trigger.kind === "category_seasonal") {
    const trends = Array.isArray(payload.trends) ? payload.trends.slice(0, 2).map(cleanLabel).join("; ") : null;
    if (!payload.season || !trends) return null;
    return {
      body: `${who}, ${cleanLabel(payload.season)} demand signals show ${trends}. Want me to prepare a stock and customer-message checklist?`,
      cta: "binary_yes_no",
      reason: "category seasonal signal",
    };
  }

  if (trigger.kind === "review_theme_emerged") {
    if (!payload.theme || payload.occurrences_30d === undefined) return null;
    return {
      body: `${who}, ${payload.occurrences_30d} reviews in the last 30 days mention ${cleanLabel(payload.theme)}.${payload.common_quote ? ` One says: “${payload.common_quote}”.` : ""} Want me to draft a response and action checklist?`,
      cta: "binary_yes_no",
      reason: "repeated review theme",
    };
  }

  if (trigger.kind === "active_planning_intent") {
    if (!payload.intent_topic) return null;
    return {
      body: `${who}, you asked about ${cleanLabel(payload.intent_topic)}.${offer ? ` Your current offer, ${offer}, gives us a grounded starting point.` : ""} Want me to prepare the first message draft now?`,
      cta: "binary_yes_no",
      reason: "continuation of explicit planning intent",
    };
  }

  if (trigger.kind === "supply_alert") {
    const batches = Array.isArray(payload.affected_batches) ? payload.affected_batches.join(", ") : null;
    if (!payload.molecule || !batches) return null;
    const alertItem = digestItem(category, payload);
    const boundedRisk = alertItem?.summary ? ` ${firstSentence(alertItem.summary)}` : "";
    return {
      body: `${who}, urgent supply alert for ${payload.molecule}: affected batches ${batches}${payload.manufacturer ? ` from ${payload.manufacturer}` : ""}.${boundedRisk} Want me to draft the customer notice and replacement checklist?${alertItem?.source ? ` — ${alertItem.source}` : ""}`,
      cta: "binary_yes_no",
      reason: "specific medicine supply alert",
    };
  }

  if (trigger.kind === "competitor_opened") {
    if (!payload.competitor_name || payload.distance_km === undefined) return null;
    return {
      body: `${who}, ${payload.competitor_name} opened ${payload.distance_km} km away.${payload.their_offer ? ` Their listed offer is ${payload.their_offer}.` : ""}${offer ? ` Your active offer is ${offer}.` : ""} Want me to draft a differentiated local message?`,
      cta: "binary_yes_no",
      reason: "verified nearby competitor event",
    };
  }

  if (trigger.kind === "curious_ask_due") {
    return {
      body: `${who}, what service has customers asked for most this week at ${merchant.identity?.name || "your business"}? I can turn your answer into one short post draft.`,
      cta: "open_ended",
      reason: "low-friction merchant insight request",
    };
  }

  if (["renewal_due", "winback_eligible", "dormant_with_vera", "gbp_unverified"].includes(trigger.kind)) {
    let fact = null;
    if (payload.days_remaining !== undefined) fact = `${payload.days_remaining} days remain on your ${payload.plan || "current"} plan`;
    if (payload.days_since_expiry !== undefined) fact = `${payload.days_since_expiry} days have passed since expiry`;
    if (payload.days_since_last_merchant_message !== undefined) fact = `${payload.days_since_last_merchant_message} days have passed since your last Vera message`;
    if (payload.verified === false) fact = "your Google Business Profile is currently unverified";
    if (!fact) return null;
    return {
      body: `${who}, quick account update: ${fact}. Want me to prepare the simplest next step?`,
      cta: "binary_yes_no",
      reason: "merchant account action",
    };
  }

  return null;
}

function customerPlan({ merchant, trigger, customer }) {
  const payload = trigger.payload ?? {};
  const customerName = customer.identity?.name || "there";
  const merchantName = merchant.identity?.name || "the merchant";
  const hindi = /(^hi$|hi-en|hindi)/i.test(customer.identity?.language_pref || "");
  const greeting = hindi ? `Namaste ${customerName}` : `Hi ${customerName}`;

  if (trigger.kind === "recall_due") {
    if (!payload.service_due || !payload.due_date) return null;
    const slots = (payload.available_slots ?? []).map((slot) => slot.label).filter(Boolean);
    const offer = relevantOffer(merchant, ["cleaning", "recall", cleanLabel(payload.service_due)]);
    return {
      body: `${greeting}, ${merchantName} here. Your ${cleanLabel(payload.service_due)} is due on ${formatDate(payload.due_date)}.${offer ? ` ${offer} is currently active.` : ""}${slots.length ? ` Available: ${slots.join(" or ")}. Reply with your preferred slot.` : " Reply YES and the clinic will help choose a slot."}`,
      cta: slots.length ? "multi_choice_slot" : "binary_yes_no",
      reason: "consented customer recall",
    };
  }

  if (trigger.kind === "chronic_refill_due") {
    const medicines = Array.isArray(payload.molecule_list) ? payload.molecule_list.join(", ") : null;
    if (!medicines || !payload.stock_runs_out_iso) return null;
    const benefitOffers = activeOffers(merchant).filter((title) => /delivery|senior/i.test(title)).slice(0, 2);
    const benefits = benefitOffers.length ? ` Current benefits: ${benefitOffers.join("; ")}.` : "";
    return {
      body: `${greeting}, ${merchantName} here. Your ${medicines} supply is expected to run out on ${formatDate(payload.stock_runs_out_iso)}.${benefits} Reply CONFIRM if you want the pharmacy to prepare the refill.`,
      cta: "binary_confirm_cancel",
      reason: "consented chronic refill reminder",
    };
  }

  if (trigger.kind === "appointment_tomorrow") {
    const appointment = payload.appointment_time || payload.appointment_at || payload.slot;
    if (!appointment) return null;
    return {
      body: `${greeting}, ${merchantName} here. Reminder: your appointment is ${appointment}. Reply CONFIRM to acknowledge, or tell us if you need to reschedule.`,
      cta: "binary_confirm_cancel",
      reason: "consented appointment reminder",
    };
  }

  if (trigger.kind === "trial_followup") {
    const slots = (payload.next_session_options ?? []).map((slot) => slot.label).filter(Boolean);
    if (!payload.trial_date && !slots.length) return null;
    const offer = relevantOffer(merchant, ["trial", "first month", "class"]);
    return {
      body: `${greeting}, ${merchantName} here. Following up after your trial${payload.trial_date ? ` on ${formatDate(payload.trial_date)}` : ""}.${offer ? ` ${offer} is active.` : ""}${slots.length ? ` The next option is ${slots.join(" or ")}. Reply YES to hold it.` : " Reply YES if you want the next-session options."}`,
      cta: "binary_yes_no",
      reason: "consented trial follow-up",
    };
  }

  if (["customer_lapsed_hard", "customer_lapsed_soft"].includes(trigger.kind)) {
    if (payload.days_since_last_visit === undefined) return null;
    const focus = payload.previous_focus ? ` around your ${cleanLabel(payload.previous_focus)} goal` : "";
    const offer = relevantOffer(merchant, ["trial", "first month", "return", "free"]);
    return {
      body: `${greeting}, ${merchantName} here. It has been ${payload.days_since_last_visit} days since your last visit—no pressure.${focus ? ` We have an option${focus}.` : ""}${offer ? ` ${offer} is active.` : ""} Want the details?`,
      cta: "binary_yes_no",
      reason: "consented, non-judgmental win-back",
    };
  }

  if (trigger.kind === "wedding_package_followup") {
    if (!payload.wedding_date) return null;
    const offer = relevantOffer(merchant, ["bridal", "skin", "wedding"]);
    const countdown = payload.days_to_wedding !== undefined ? ` (${payload.days_to_wedding} days away)` : "";
    return {
      body: `${greeting}, ${merchantName} here. Your wedding date is ${formatDate(payload.wedding_date)}${countdown}, so this is the right time to plan the next bridal step.${offer ? ` ${offer} is active.` : ""} Want the available plan details?`,
      cta: "binary_yes_no",
      reason: "consented bridal follow-up",
    };
  }

  return null;
}

function validatePlan({ plan, category, trigger }) {
  if (!plan?.body || !plan?.cta || !plan?.reason) return false;
  if (plan.body.length > 700 || /https?:\/\/|www\./i.test(plan.body)) return false;
  if ((plan.body.match(/\?/g) ?? []).length > 1) return false;
  const taboos = category.voice?.vocab_taboo ?? category.voice?.taboos ?? [];
  const lower = plan.body.toLowerCase();
  if (taboos.some((taboo) => taboo && lower.includes(String(taboo).toLowerCase()))) return false;
  if (trigger.scope === "customer" && !/^hi |^namaste /i.test(plan.body)) return false;
  return true;
}

function buildAction({ category, merchant, trigger, customer }) {
  const plan = trigger.scope === "customer"
    ? customerPlan({ category, merchant, trigger, customer })
    : merchantPlan({ category, merchant, trigger });
  if (!validatePlan({ plan, category, trigger })) return null;

  return {
    conversation_id: deterministicConversationId(trigger),
    merchant_id: merchant.merchant_id,
    customer_id: customer?.customer_id ?? null,
    send_as: trigger.scope === "customer" ? "merchant_on_behalf" : "vera",
    trigger_id: trigger.id,
    template_name: trigger.scope === "customer" ? `merchant_${trigger.kind}_v1` : `vera_${trigger.kind}_v1`,
    template_params: [
      customer?.identity?.name || merchant.identity?.name || merchant.merchant_id,
      plan.body,
    ],
    body: plan.body,
    cta: plan.cta,
    suppression_key: trigger.suppression_key,
    rationale: `${plan.reason}; composed only from stored ${category.slug}, merchant, trigger${customer ? ", and customer" : ""} context.`,
  };
}

function decideActions({ store, now, availableTriggerIds, limit = 20 }) {
  const candidates = [];
  for (const triggerId of [...new Set(availableTriggerIds)]) {
    const triggerRecord = store.getContext("trigger", triggerId);
    const trigger = triggerRecord?.payload;
    if (!trigger || trigger.id !== triggerId) continue;
    const merchantRecord = store.getContext("merchant", trigger.merchant_id);
    const merchant = merchantRecord?.payload;
    if (!merchant || merchant.merchant_id !== trigger.merchant_id) continue;
    const categoryRecord = store.getContext("category", merchant.category_slug);
    const category = categoryRecord?.payload;
    if (!category || category.slug !== merchant.category_slug) continue;
    const customerRecord = trigger.customer_id ? store.getContext("customer", trigger.customer_id) : null;
    const customer = customerRecord?.payload ?? null;
    if (trigger.scope === "customer"
      && (!customer || customer.customer_id !== trigger.customer_id || customer.merchant_id !== merchant.merchant_id)) continue;
    if (!eligible({ store, trigger, customer, now })) continue;
    candidates.push({
      trigger, merchant, category, customer,
      score: priority(trigger),
      records: { trigger: triggerRecord, merchant: merchantRecord, category: categoryRecord, customer: customerRecord },
    });
  }

  candidates.sort((a, b) => b.score - a.score
    || Date.parse(a.trigger.expires_at) - Date.parse(b.trigger.expires_at)
    || a.trigger.id.localeCompare(b.trigger.id));

  const actions = [];
  const selectedMerchants = new Set();
  for (const candidate of candidates) {
    if (actions.length >= limit) break;
    if (selectedMerchants.has(candidate.merchant.merchant_id)) continue;
    const action = buildAction(candidate);
    if (!action) continue;
    const claimed = store.claimAction({
      action,
      categorySlug: candidate.category.slug,
      activeUntil: candidate.trigger.expires_at,
      createdAt: now,
      evidence: {
        category: { id: candidate.category.slug, version: candidate.records.category.version },
        merchant: { id: candidate.merchant.merchant_id, version: candidate.records.merchant.version },
        trigger: { id: candidate.trigger.id, version: candidate.records.trigger.version },
        customer: candidate.customer
          ? { id: candidate.customer.customer_id, version: candidate.records.customer.version }
          : null,
      },
      checks: {
        identity_links_match: true,
        consent_verified: candidate.trigger.scope !== "customer" || consentAllows(candidate.customer, candidate.trigger),
        voice_and_output_validated: true,
        suppression_claimed_atomically: true,
      },
    });
    if (!claimed) continue;
    actions.push(action);
    selectedMerchants.add(candidate.merchant.merchant_id);
  }
  return actions;
}

module.exports = {
  decideActions,
  buildAction,
  consentAllows,
  priority,
};
