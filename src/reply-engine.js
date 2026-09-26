function normalize(text) {
  return String(text ?? "").toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
}

function includesAny(text, phrases) {
  return phrases.some((phrase) => text.includes(phrase));
}

function classifyReply(message) {
  const text = normalize(message);
  if (includesAny(text, ["stop messaging", "don't message", "do not message", "unsubscribe", "not interested", "remove my number"])) return "opt_out";
  if (includesAny(text, ["useless spam", "this is spam", "shut up", "idiot", "bothering me", "bakwas"])) return "hostile";
  if (includesAny(text, ["thank you for contacting", "our team will respond", "we will get back", "we'll get back", "automated assistant", "auto-reply", "business hours are"])) return "auto_reply";
  if (includesAny(text, ["message me later", "call me later", "busy now", "later please", "tomorrow", "some time later"])) return "wait";
  if (includesAny(text, ["gst", "tax filing", "income tax", "file my tax", "personal loan"])) return "off_topic";
  if (includesAny(text, ["confirm", "yes", "yeah", "yep", "go ahead", "let's do it", "lets do it", "do it", "proceed", "send it", "what's next", "whats next", "sure"])) return "accept";
  if (/\b(1|2)\b/.test(text) || /\b(mon|tue|wed|thu|fri|sat|sun)(day)?\b/.test(text) || /\b\d{1,2}(:\d{2})?\s*(am|pm)\b/.test(text)) return "slot_selection";
  if (includesAny(text, ["sales", "revenue", "earning", "income", "business hua"])) return "sales_query";
  if (includesAny(text, ["performance", "views", "calls", "ctr", "directions", "leads", "how am i doing"])) return "performance_query";
  if (includesAny(text, ["offer", "discount", "campaign", "promotion", "deal"])) return "offer_query";
  if (includesAny(text, ["profile", "google business", "verified", "listing"])) return "profile_query";
  return "question";
}

function getPayload(store, scope, id) {
  return id ? store.getContext(scope, id)?.payload ?? null : null;
}

function activeOffers(merchant) {
  return (merchant?.offers ?? []).filter((offer) => offer.status === "active").map((offer) => offer.title);
}

function availableMetricSummary(merchant) {
  const performance = merchant?.performance ?? {};
  const entries = [
    ["views", performance.views],
    ["calls", performance.calls],
    ["direction requests", performance.directions],
    ["leads", performance.leads],
    ["CTR", performance.ctr === undefined ? undefined : `${(Number(performance.ctr) * 100).toFixed(1)}%`],
  ].filter(([, value]) => value !== undefined && value !== null);
  return entries.map(([label, value]) => `${value} ${label}`).join(", ");
}

function triggerContexts(store, conversation) {
  const merchant = getPayload(store, "merchant", conversation.merchant_id);
  const category = getPayload(store, "category", conversation.category_slug || merchant?.category_slug);
  const trigger = conversation.trigger_id === "inbound" ? null : getPayload(store, "trigger", conversation.trigger_id);
  const customer = conversation.customer_id ? getPayload(store, "customer", conversation.customer_id) : null;
  return { merchant, category, trigger, customer };
}

function actionArtifact({ merchant, category, trigger }) {
  const name = merchant?.identity?.owner_first_name || merchant?.identity?.name || "there";
  const offer = activeOffers(merchant)[0];
  const kind = trigger?.kind;
  const payload = trigger?.payload ?? {};

  if (["research_digest", "cde_opportunity", "regulation_change"].includes(kind)) {
    const itemId = payload.top_item_id || payload.digest_item_id;
    const item = (category?.digest ?? []).find((entry) => entry.id === itemId);
    if (item) {
      return `${name}, here is the useful summary: ${item.summary || item.title}${item.actionable ? ` Next step: ${item.actionable}.` : "."} Reply CONFIRM if you want a customer-ready version.`;
    }
  }

  if (kind === "active_planning_intent") {
    return `${name}, I’m moving this into action. I’ll use ${offer || "your current business details"} as the grounded starting point and prepare the first message draft. Reply CONFIRM to continue.`;
  }

  if (["ipl_match_today", "festival_upcoming", "category_seasonal"].includes(kind)) {
    const event = payload.match || payload.festival || String(payload.season || "the current event").replaceAll("_", " ");
    return `${name}, draft direction: lead with ${event}${offer ? ` and feature ${offer}` : ""}, then close with one simple reply CTA. Reply CONFIRM to use this direction.`;
  }

  if (["perf_dip", "seasonal_perf_dip"].includes(kind)) {
    return `${name}, the next step is a focused recovery message around ${String(payload.metric || "the affected metric").replaceAll("_", " ")}, using only the supplied performance change. Reply CONFIRM and I’ll continue with that direction.`;
  }

  if (kind === "supply_alert") {
    const batches = Array.isArray(payload.affected_batches) ? payload.affected_batches.join(", ") : "the supplied batches";
    return `${name}, action plan: isolate batches ${batches}, verify affected stock, then prepare a factual customer notice. Reply CONFIRM to continue with the notice draft.`;
  }

  if (kind === "review_theme_emerged") {
    return `${name}, action plan: acknowledge the ${String(payload.theme || "review").replaceAll("_", " ")} issue, state one corrective step, and invite the customer back without arguing. Reply CONFIRM to continue with the response draft.`;
  }

  if (kind === "competitor_opened") {
    return `${name}, I’ll position your message around your real strengths${offer ? ` and ${offer}` : ""}, without attacking the competitor. Reply CONFIRM to continue with the local draft.`;
  }

  return `${name}, understood. I’m switching to action mode and will use only the current account and trigger facts. Reply CONFIRM to continue.`;
}

function matchSlot(message, trigger) {
  const slots = trigger?.payload?.available_slots || trigger?.payload?.next_session_options || [];
  if (!slots.length) return null;
  const text = normalize(message);
  const numeric = text.match(/\b([12])\b/);
  if (numeric) return slots[Number(numeric[1]) - 1]?.label ?? null;
  return slots.find((slot) => {
    const label = normalize(slot.label);
    return label.split(/[ ,]+/).filter((part) => part.length >= 3).some((part) => text.includes(part));
  })?.label ?? null;
}

function buildResponse({ intent, message, conversation, contexts, repeatedAutoReplyCount }) {
  const { merchant, trigger } = contexts;
  const name = merchant?.identity?.owner_first_name || merchant?.identity?.name || "there";

  if (intent === "opt_out" || intent === "hostile") {
    return { action: "end", rationale: "Explicit refusal or hostility detected; conversation ended and merchant outreach suppressed for 30 days." };
  }

  if (intent === "auto_reply") {
    if (repeatedAutoReplyCount >= 3) {
      return { action: "end", rationale: "Identical automated reply detected three times for this merchant; ending without wasting another turn." };
    }
    return {
      action: "wait",
      wait_seconds: repeatedAutoReplyCount === 1 ? 14400 : 86400,
      rationale: `Detected WhatsApp Business auto-reply (${repeatedAutoReplyCount}/3); waiting for a human response.`,
    };
  }

  if (intent === "wait") {
    const tomorrow = normalize(message).includes("tomorrow");
    return { action: "wait", wait_seconds: tomorrow ? 86400 : 1800, rationale: "Merchant/customer requested time; backing off instead of sending another message." };
  }

  if (intent === "off_topic") {
    return {
      action: "send",
      body: "I’ll leave GST, tax, and unrelated services to the appropriate professional. I can help with your merchant profile, offers, campaigns, performance, and customer messages. Would you like to continue with the current business task?",
      cta: "binary_yes_no",
      rationale: "Politely declined an out-of-scope request and redirected to Vera’s supported merchant-growth work.",
    };
  }

  if (intent === "accept") {
    if (["accept", "slot_selection"].includes(conversation.last_intent)) {
      return { action: "end", rationale: "Confirmation received; the planning/selection step is complete and no external execution tool is available." };
    }
    return {
      action: "send",
      body: actionArtifact({ ...contexts }),
      cta: "binary_confirm_cancel",
      rationale: "Explicit commitment detected; switched immediately from qualification to an action-ready next step.",
    };
  }

  if (intent === "slot_selection") {
    const slot = matchSlot(message, trigger);
    if (slot) {
      return {
        action: "send",
        body: `I’ve noted ${slot} as your preferred slot. Reply CONFIRM so the merchant team can finalize it.`,
        cta: "binary_confirm_cancel",
        rationale: "Matched the reply to an offered slot without claiming the booking was completed.",
      };
    }
    return {
      action: "send",
      body: "I couldn’t match that to one of the offered slots. Please reply with the slot number or the day and time shown in the earlier message.",
      cta: "open_ended",
      rationale: "Slot-like reply detected but it did not safely match the trigger’s supplied options.",
    };
  }

  if (intent === "sales_query") {
    const performance = merchant?.performance ?? {};
    const sales = performance.sales ?? performance.revenue ?? performance.monthly_sales;
    if (sales !== undefined) {
      return {
        action: "send",
        body: `${name}, the stored monthly sales figure is ${sales}. Would you like the available performance summary as well?`,
        cta: "binary_yes_no",
        rationale: "Answered with an explicitly stored sales field.",
      };
    }
    const available = availableMetricSummary(merchant);
    return {
      action: "send",
      body: `${name}, monthly sales are not present in the connected account data, so I won’t guess.${available ? ` I can see ${available}.` : ""} Would you like a summary of the available metrics?`,
      cta: "binary_yes_no",
      rationale: "Sales data was unavailable; avoided fabrication and offered only stored metrics.",
    };
  }

  if (intent === "performance_query") {
    const available = availableMetricSummary(merchant);
    return {
      action: "send",
      body: available
        ? `${name}, for the stored ${merchant.performance?.window_days || 30}-day window I can see ${available}. Which one should I explain first?`
        : `${name}, I don’t have a performance snapshot in the connected context yet. Would you like to check offers or profile status instead?`,
      cta: "open_ended",
      rationale: "Returned only the merchant performance fields currently stored.",
    };
  }

  if (intent === "offer_query") {
    const offers = activeOffers(merchant);
    return {
      action: "send",
      body: offers.length
        ? `${name}, your active offer${offers.length > 1 ? "s are" : " is"}: ${offers.join("; ")}. Which one should the next campaign focus on?`
        : `${name}, there is no active offer in the connected merchant context. Would you like to start by choosing one category-appropriate offer?`,
      cta: "open_ended",
      rationale: "Answered from active merchant offers only.",
    };
  }

  if (intent === "profile_query") {
    const verified = merchant?.identity?.verified;
    return {
      action: "send",
      body: `${name}, the connected profile is ${verified === true ? "verified" : verified === false ? "not verified" : "missing verification status"}. Would you like the next profile action?`,
      cta: "binary_yes_no",
      rationale: "Answered using the stored merchant verification field.",
    };
  }

  if (trigger) {
    return {
      action: "send",
      body: `I can clarify the current ${String(trigger.kind).replaceAll("_", " ")} update using the facts already shared. Which part would you like explained?`,
      cta: "open_ended",
      rationale: "Unrecognized question within an active trigger conversation; stayed on-topic without inventing an answer.",
    };
  }

  return {
    action: "send",
    body: "I can help with performance, active offers, profile status, campaigns, or customer follow-up. Which one do you want to check?",
    cta: "open_ended",
    rationale: "New inbound question without trigger context; offered a bounded set of supported merchant intents.",
  };
}

function validateReplyResponse(response, category) {
  if (!response || !["send", "wait", "end"].includes(response.action)) return false;
  if (typeof response.rationale !== "string" || !response.rationale.trim()) return false;
  if (response.action === "wait") {
    return Number.isInteger(response.wait_seconds) && response.wait_seconds > 0 && response.wait_seconds <= 604800;
  }
  if (response.action === "end") return true;
  if (typeof response.body !== "string" || !response.body.trim() || response.body.length > 700) return false;
  if (typeof response.cta !== "string" || !response.cta.trim()) return false;
  if (/https?:\/\/|www\./i.test(response.body)) return false;
  if ((response.body.match(/\?/g) ?? []).length > 1) return false;
  const taboos = category?.voice?.vocab_taboo ?? category?.voice?.taboos ?? [];
  const lower = response.body.toLowerCase();
  return !taboos.some((taboo) => taboo && lower.includes(String(taboo).toLowerCase()));
}

function handleReply({ store, reply, now }) {
  const cached = store.getReplyResponse(reply.conversation_id, reply.turn_number);
  if (cached) return cached;

  let conversation = store.getConversation(reply.conversation_id);
  if (!conversation) {
    const merchant = getPayload(store, "merchant", reply.merchant_id);
    conversation = store.ensureInboundConversation({
      conversationId: reply.conversation_id,
      merchantId: reply.merchant_id,
      customerId: reply.customer_id,
      categorySlug: merchant?.category_slug,
      createdAt: now,
    });
  }

  if (!conversation) {
    const response = { action: "end", rationale: "Conversation and merchant context were unavailable, so continuing could fabricate information." };
    store.saveReplyResponse(reply.conversation_id, reply.turn_number, response, now);
    return response;
  }

  const merchantMismatch = reply.merchant_id && reply.merchant_id !== conversation.merchant_id;
  const customerMismatch = reply.customer_id && reply.customer_id !== conversation.customer_id;
  if (merchantMismatch || customerMismatch) {
    const response = { action: "end", rationale: "Reply identity did not match the stored conversation, so no account or customer data was disclosed." };
    store.saveReplyResponse(reply.conversation_id, reply.turn_number, response, now);
    return response;
  }

  if (conversation.status === "ended") {
    const response = { action: "end", rationale: "Conversation was already ended; no further message is appropriate." };
    store.saveReplyResponse(reply.conversation_id, reply.turn_number, response, now);
    return response;
  }

  const role = reply.from_role === "customer" ? "customer" : "merchant";
  store.insertTurn({
    conversationId: reply.conversation_id,
    turnNumber: reply.turn_number,
    role,
    body: reply.message,
    action: null,
    createdAt: now,
  });

  let intent = classifyReply(reply.message);
  const repeatedAutoReplyCount = intent === "auto_reply"
    ? store.countInboundBodyForMerchant(conversation.merchant_id, reply.message)
    : 0;
  const contexts = triggerContexts(store, conversation);
  if (intent === "accept" && matchSlot(reply.message, contexts.trigger)) intent = "slot_selection";
  let response = buildResponse({ intent, message: reply.message, conversation, contexts, repeatedAutoReplyCount });

  if (!validateReplyResponse(response, contexts.category)) {
    response = { action: "end", rationale: "Reply failed the final safety and output validation gate, so nothing was sent." };
  }

  if (response.action === "send" && store.hasSentBody(reply.conversation_id, response.body)) {
    response = { action: "end", rationale: "Generated reply would repeat an earlier message verbatim; ended to satisfy anti-repetition rules." };
  }

  if (["opt_out", "hostile"].includes(intent)) {
    const until = new Date(Date.parse(now) + 30 * 86400000).toISOString();
    store.suppressMerchant(conversation.merchant_id, until, intent, now);
  }

  const botTurn = response.action === "send" ? reply.turn_number + 1 : reply.turn_number;
  if (response.action === "send") {
    store.insertTurn({
      conversationId: reply.conversation_id,
      turnNumber: botTurn,
      role: "vera",
      body: response.body,
      action: "send",
      createdAt: now,
    });
  }

  store.updateConversation({
    conversationId: reply.conversation_id,
    status: response.action === "end" ? "ended" : response.action === "wait" ? "waiting" : "open",
    lastBody: response.body,
    turnNumber: botTurn,
    autoReplyCount: intent === "auto_reply" ? repeatedAutoReplyCount : conversation.auto_reply_count,
    lastIntent: intent,
    updatedAt: now,
  });
  store.saveReplyResponse(reply.conversation_id, reply.turn_number, response, now);
  return response;
}

module.exports = { handleReply, classifyReply, validateReplyResponse };
