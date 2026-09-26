import re
from datetime import timedelta
from typing import Any

try:
    from cloudflare_app.time_utils import parse_iso
    from cloudflare_app.store import field
except ModuleNotFoundError:
    from time_utils import parse_iso
    from store import field


def normalize(text: Any) -> str:
    return re.sub(r"\s+", " ", str(text or "").lower().replace("’", "'")).strip()


def has_any(text: str, phrases: list[str]) -> bool:
    return any(phrase in text for phrase in phrases)


def classify_reply(message: str) -> str:
    text = normalize(message)
    if has_any(text, ["stop messaging", "don't message", "do not message", "unsubscribe", "not interested", "remove my number"]):
        return "opt_out"
    if has_any(text, ["useless spam", "this is spam", "shut up", "idiot", "bothering me", "bakwas"]):
        return "hostile"
    if has_any(text, ["thank you for contacting", "our team will respond", "we will get back", "we'll get back", "automated assistant", "auto-reply", "business hours are"]):
        return "auto_reply"
    if has_any(text, ["message me later", "call me later", "busy now", "later please", "tomorrow", "some time later"]):
        return "wait"
    if has_any(text, ["gst", "tax filing", "income tax", "file my tax", "personal loan"]):
        return "off_topic"
    if has_any(text, ["confirm", "yes", "yeah", "yep", "go ahead", "let's do it", "lets do it", "do it", "proceed", "send it", "what's next", "whats next", "sure"]):
        return "accept"
    if re.search(r"\b(1|2)\b|\b(mon|tue|wed|thu|fri|sat|sun)(day)?\b|\b\d{1,2}(:\d{2})?\s*(am|pm)\b", text):
        return "slot_selection"
    if has_any(text, ["sales", "revenue", "earning", "income", "business hua"]):
        return "sales_query"
    if has_any(text, ["performance", "views", "calls", "ctr", "directions", "leads", "how am i doing"]):
        return "performance_query"
    if has_any(text, ["offer", "discount", "campaign", "promotion", "deal"]):
        return "offer_query"
    if has_any(text, ["profile", "google business", "verified", "listing"]):
        return "profile_query"
    return "question"


def active_offers(merchant: dict | None) -> list[str]:
    return [
        str(offer.get("title"))
        for offer in (merchant or {}).get("offers", [])
        if offer.get("status") == "active" and offer.get("title")
    ]


def performance_summary(merchant: dict | None) -> str:
    performance = (merchant or {}).get("performance", {})
    entries = []
    for label, key in (("views", "views"), ("calls", "calls"), ("direction requests", "directions"), ("leads", "leads")):
        if performance.get(key) is not None:
            entries.append(f"{performance[key]} {label}")
    if performance.get("ctr") is not None:
        entries.append(f"{float(performance['ctr']) * 100:.1f}% CTR")
    return ", ".join(entries)


def match_slot(message: str, trigger: dict | None) -> str | None:
    payload = (trigger or {}).get("payload", {})
    slots = payload.get("available_slots") or payload.get("next_session_options") or []
    if not slots:
        return None
    text = normalize(message)
    numeric = re.search(r"\b([12])\b", text)
    if numeric:
        index = int(numeric.group(1)) - 1
        return slots[index].get("label") if index < len(slots) else None
    for slot in slots:
        label = normalize(slot.get("label"))
        if any(part in text for part in re.split(r"[ ,]+", label) if len(part) >= 3):
            return slot.get("label")
    return None


def action_artifact(merchant: dict | None, category: dict | None, trigger: dict | None) -> str:
    merchant = merchant or {}
    category = category or {}
    trigger = trigger or {}
    name = merchant.get("identity", {}).get("owner_first_name") or merchant.get("identity", {}).get("name") or "there"
    offers = active_offers(merchant)
    offer = offers[0] if offers else None
    kind, payload = trigger.get("kind"), trigger.get("payload", {})
    if kind in {"research_digest", "cde_opportunity", "regulation_change"}:
        item_id = payload.get("top_item_id") or payload.get("digest_item_id")
        item = next((value for value in category.get("digest", []) if value.get("id") == item_id), None)
        if item:
            extra = f" Next step: {item['actionable']}." if item.get("actionable") else ""
            return f"{name}, here is the useful summary: {item.get('summary') or item.get('title')}.{extra} Reply CONFIRM if you want a customer-ready version."
    if kind == "active_planning_intent":
        return f"{name}, I’m moving this into action. I’ll use {offer or 'your current business details'} as the grounded starting point and prepare the first message draft. Reply CONFIRM to continue."
    if kind in {"ipl_match_today", "festival_upcoming", "category_seasonal"}:
        event = payload.get("match") or payload.get("festival") or str(payload.get("season", "the current event")).replace("_", " ")
        return f"{name}, draft direction: lead with {event}{f' and feature {offer}' if offer else ''}, then close with one simple reply CTA. Reply CONFIRM to use this direction."
    if kind in {"perf_dip", "seasonal_perf_dip"}:
        return f"{name}, the next step is a focused recovery message around {str(payload.get('metric', 'the affected metric')).replace('_', ' ')}, using only the supplied performance change. Reply CONFIRM to continue with that direction."
    if kind == "supply_alert":
        batches = ", ".join(str(value) for value in payload.get("affected_batches", [])) or "the supplied batches"
        return f"{name}, action plan: isolate batches {batches}, verify affected stock, then prepare a factual customer notice. Reply CONFIRM to continue with the notice draft."
    if kind == "review_theme_emerged":
        return f"{name}, action plan: acknowledge the {str(payload.get('theme', 'review')).replace('_', ' ')} issue, state one corrective step, and invite the customer back without arguing. Reply CONFIRM to continue with the response draft."
    if kind == "competitor_opened":
        return f"{name}, I’ll position your message around your real strengths{f' and {offer}' if offer else ''}, without attacking the competitor. Reply CONFIRM to continue with the local draft."
    return f"{name}, understood. I’m switching to action mode and will use only the current account and trigger facts. Reply CONFIRM to continue."


def build_response(
    intent: str,
    message: str,
    conversation: Any,
    contexts: dict[str, Any],
    repeated_auto_reply_count: int,
) -> dict[str, Any]:
    merchant, trigger = contexts.get("merchant") or {}, contexts.get("trigger")
    name = merchant.get("identity", {}).get("owner_first_name") or merchant.get("identity", {}).get("name") or "there"
    if intent in {"opt_out", "hostile"}:
        return {"action": "end", "rationale": "Explicit refusal or hostility detected; conversation ended and merchant outreach suppressed for 30 days."}
    if intent == "auto_reply":
        if repeated_auto_reply_count >= 3:
            return {"action": "end", "rationale": "Identical automated reply detected three times for this merchant; ending without wasting another turn."}
        return {"action": "wait", "wait_seconds": 14400 if repeated_auto_reply_count == 1 else 86400, "rationale": f"Detected WhatsApp Business auto-reply ({repeated_auto_reply_count}/3); waiting for a human response."}
    if intent == "wait":
        return {"action": "wait", "wait_seconds": 86400 if "tomorrow" in normalize(message) else 1800, "rationale": "Merchant/customer requested time; backing off instead of sending another message."}
    if intent == "off_topic":
        return {"action": "send", "body": "I’ll leave GST, tax, and unrelated services to the appropriate professional. I can help with your merchant profile, offers, campaigns, performance, and customer messages. Would you like to continue with the current business task?", "cta": "binary_yes_no", "rationale": "Politely declined an out-of-scope request and redirected to Vera’s supported merchant-growth work."}
    if intent == "accept":
        if field(conversation, "last_intent") in {"accept", "slot_selection"}:
            return {"action": "end", "rationale": "Confirmation received; the planning/selection step is complete and no external execution tool is available."}
        return {"action": "send", "body": action_artifact(merchant, contexts.get("category"), trigger), "cta": "binary_confirm_cancel", "rationale": "Explicit commitment detected; switched immediately from qualification to an action-ready next step."}
    if intent == "slot_selection":
        slot = match_slot(message, trigger)
        if slot:
            return {"action": "send", "body": f"I’ve noted {slot} as your preferred slot. Reply CONFIRM so the merchant team can finalize it.", "cta": "binary_confirm_cancel", "rationale": "Matched the reply to an offered slot without claiming the booking was completed."}
        return {"action": "send", "body": "I couldn’t match that to one of the offered slots. Please reply with the slot number or the day and time shown in the earlier message.", "cta": "open_ended", "rationale": "Slot-like reply detected but it did not safely match the trigger’s supplied options."}
    if intent == "sales_query":
        performance = merchant.get("performance", {})
        sales = performance.get("sales", performance.get("revenue", performance.get("monthly_sales")))
        if sales is not None:
            return {"action": "send", "body": f"{name}, the stored monthly sales figure is {sales}. Would you like the available performance summary as well?", "cta": "binary_yes_no", "rationale": "Answered with an explicitly stored sales field."}
        available = performance_summary(merchant)
        return {"action": "send", "body": f"{name}, monthly sales are not present in the connected account data, so I won’t guess.{f' I can see {available}.' if available else ''} Would you like a summary of the available metrics?", "cta": "binary_yes_no", "rationale": "Sales data was unavailable; avoided fabrication and offered only stored metrics."}
    if intent == "performance_query":
        available = performance_summary(merchant)
        body = f"{name}, for the stored {merchant.get('performance', {}).get('window_days', 30)}-day window I can see {available}. Which one should I explain first?" if available else f"{name}, I don’t have a performance snapshot in the connected context yet. Would you like to check offers or profile status instead?"
        return {"action": "send", "body": body, "cta": "open_ended", "rationale": "Returned only the merchant performance fields currently stored."}
    if intent == "offer_query":
        offers = active_offers(merchant)
        body = f"{name}, your active offer{'s are' if len(offers) > 1 else ' is'}: {'; '.join(offers)}. Which one should the next campaign focus on?" if offers else f"{name}, there is no active offer in the connected merchant context. Would you like to start by choosing one category-appropriate offer?"
        return {"action": "send", "body": body, "cta": "open_ended", "rationale": "Answered from active merchant offers only."}
    if intent == "profile_query":
        verified = merchant.get("identity", {}).get("verified")
        status = "verified" if verified is True else "not verified" if verified is False else "missing verification status"
        return {"action": "send", "body": f"{name}, the connected profile is {status}. Would you like the next profile action?", "cta": "binary_yes_no", "rationale": "Answered using the stored merchant verification field."}
    if trigger:
        return {"action": "send", "body": f"I can clarify the current {str(trigger.get('kind')).replace('_', ' ')} update using the facts already shared. Which part would you like explained?", "cta": "open_ended", "rationale": "Unrecognized question within an active trigger conversation; stayed on-topic without inventing an answer."}
    return {"action": "send", "body": "I can help with performance, active offers, profile status, campaigns, or customer follow-up. Which one do you want to check?", "cta": "open_ended", "rationale": "New inbound question without trigger context; offered a bounded set of supported merchant intents."}


def valid_response(response: dict, category: dict | None) -> bool:
    if response.get("action") not in {"send", "wait", "end"} or not str(response.get("rationale", "")).strip():
        return False
    if response["action"] == "wait":
        return isinstance(response.get("wait_seconds"), int) and 0 < response["wait_seconds"] <= 604800
    if response["action"] == "end":
        return True
    body = response.get("body")
    if not isinstance(body, str) or not body.strip() or len(body) > 700 or re.search(r"https?://|www\.", body, re.I) or body.count("?") > 1:
        return False
    taboos = (category or {}).get("voice", {}).get("vocab_taboo") or (category or {}).get("voice", {}).get("taboos") or []
    return not any(str(taboo).lower() in body.lower() for taboo in taboos if taboo)


async def get_payload(store, scope: str, context_id: str | None):
    record = await store.get_context(scope, context_id)
    return record["payload"] if record else None


async def handle_reply(store, reply: dict[str, Any], now: str):
    cached = await store.get_reply_response(reply["conversation_id"], reply["turn_number"])
    if cached:
        return cached
    conversation = await store.get_conversation(reply["conversation_id"])
    if conversation is None:
        merchant = await get_payload(store, "merchant", reply.get("merchant_id"))
        conversation = await store.ensure_inbound_conversation(
            reply["conversation_id"], reply.get("merchant_id"), reply.get("customer_id"),
            merchant.get("category_slug") if merchant else None, now,
        )
    if conversation is None:
        response = {"action": "end", "rationale": "Conversation and merchant context were unavailable, so continuing could fabricate information."}
        await store.save_reply_response(reply["conversation_id"], reply["turn_number"], response, now)
        return response
    if (reply.get("merchant_id") and reply["merchant_id"] != field(conversation, "merchant_id")) or (reply.get("customer_id") and reply["customer_id"] != field(conversation, "customer_id")):
        response = {"action": "end", "rationale": "Reply identity did not match the stored conversation, so no account or customer data was disclosed."}
        await store.save_reply_response(reply["conversation_id"], reply["turn_number"], response, now)
        return response
    if field(conversation, "status") == "ended":
        response = {"action": "end", "rationale": "Conversation was already ended; no further message is appropriate."}
        await store.save_reply_response(reply["conversation_id"], reply["turn_number"], response, now)
        return response
    role = "customer" if reply["from_role"] == "customer" else "merchant"
    await store.insert_turn(reply["conversation_id"], reply["turn_number"], role, reply["message"], None, now)
    intent = classify_reply(reply["message"])
    repeated = await store.count_inbound_body_for_merchant(field(conversation, "merchant_id"), reply["message"]) if intent == "auto_reply" else 0
    merchant = await get_payload(store, "merchant", field(conversation, "merchant_id"))
    category = await get_payload(store, "category", field(conversation, "category_slug") or (merchant or {}).get("category_slug"))
    trigger = None if field(conversation, "trigger_id") == "inbound" else await get_payload(store, "trigger", field(conversation, "trigger_id"))
    customer = await get_payload(store, "customer", field(conversation, "customer_id")) if field(conversation, "customer_id") else None
    contexts = {"merchant": merchant, "category": category, "trigger": trigger, "customer": customer}
    if intent == "accept" and match_slot(reply["message"], trigger):
        intent = "slot_selection"
    response = build_response(intent, reply["message"], conversation, contexts, repeated)
    if not valid_response(response, category):
        response = {"action": "end", "rationale": "Reply failed the final safety and output validation gate, so nothing was sent."}
    if response["action"] == "send" and await store.has_sent_body(reply["conversation_id"], response["body"]):
        response = {"action": "end", "rationale": "Generated reply would repeat an earlier message verbatim; ended to satisfy anti-repetition rules."}
    if intent in {"opt_out", "hostile"}:
        until = (parse_iso(now) + timedelta(days=30)).isoformat().replace("+00:00", "Z")
        await store.suppress_merchant(field(conversation, "merchant_id"), until, intent, now)
    bot_turn = reply["turn_number"] + 1 if response["action"] == "send" else reply["turn_number"]
    if response["action"] == "send":
        await store.insert_turn(reply["conversation_id"], bot_turn, "vera", response["body"], "send", now)
    await store.update_conversation(
        reply["conversation_id"],
        "ended" if response["action"] == "end" else "waiting" if response["action"] == "wait" else "open",
        response.get("body"), bot_turn,
        repeated if intent == "auto_reply" else int(field(conversation, "auto_reply_count", 0)),
        intent, now,
    )
    await store.save_reply_response(reply["conversation_id"], reply["turn_number"], response, now)
    return response
