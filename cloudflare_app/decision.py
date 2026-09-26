import hashlib
import re
from datetime import datetime
from typing import Any

try:
    from cloudflare_app.time_utils import parse_iso
except ModuleNotFoundError:
    from time_utils import parse_iso


KIND_PRIORITY = {
    "supply_alert": 500,
    "regulation_change": 480,
    "active_planning_intent": 460,
    "appointment_tomorrow": 440,
    "chronic_refill_due": 430,
    "recall_due": 420,
    "perf_dip": 360,
    "review_theme_emerged": 350,
    "renewal_due": 340,
    "perf_spike": 300,
    "milestone_reached": 280,
    "trial_followup": 270,
    "customer_lapsed_hard": 260,
    "customer_lapsed_soft": 250,
    "wedding_package_followup": 240,
    "ipl_match_today": 230,
    "competitor_opened": 220,
    "research_digest": 200,
    "cde_opportunity": 190,
    "category_seasonal": 180,
    "gbp_unverified": 170,
    "winback_eligible": 160,
    "dormant_with_vera": 140,
    "curious_ask_due": 100,
    "festival_upcoming": 80,
    "seasonal_perf_dip": 70,
}

CUSTOMER_CONSENT = {
    "recall_due": {"recall_reminders", "appointment_reminders"},
    "appointment_tomorrow": {"appointment_reminders"},
    "chronic_refill_due": {"refill_reminders", "delivery_notifications"},
    "customer_lapsed_hard": {"winback_offers", "renewal_reminders"},
    "customer_lapsed_soft": {"winback_offers", "promotional_offers"},
    "trial_followup": {"program_updates", "kids_program_updates"},
    "wedding_package_followup": {
        "bridal_package_followup",
        "bridal_followup",
        "promotional_offers",
    },
}


def clean(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").replace("_", " ")).strip()


def owner_label(category: dict, merchant: dict) -> str:
    identity = merchant.get("identity", {})
    owner = identity.get("owner_first_name") or identity.get("name") or "there"
    if category.get("slug") == "dentists" and not re.match(r"^dr\.?\s", owner, re.I):
        return f"Dr. {owner}"
    return owner


def active_offers(merchant: dict) -> list[str]:
    return [
        str(item.get("title"))
        for item in merchant.get("offers", [])
        if item.get("status") == "active" and item.get("title")
    ]


def relevant_offer(merchant: dict, terms: list[str]) -> str | None:
    offers = active_offers(merchant)
    lowered = [term.lower() for term in terms if term]
    return next(
        (offer for offer in offers if any(term in offer.lower() for term in lowered)),
        offers[0] if not lowered and offers else None,
    )


def format_percent(value: Any) -> str | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    percent = number * 100 if abs(number) <= 1 else number
    return f"{'+' if percent > 0 else ''}{round(percent)}%"


def format_date(value: Any) -> str | None:
    if not value:
        return None
    try:
        parsed = parse_iso(str(value))
        return f"{parsed.day} {parsed.strftime('%b %Y')}"
    except (ValueError, TypeError):
        return str(value)


def digest_item(category: dict, payload: dict) -> dict | None:
    item_id = payload.get("top_item_id") or payload.get("digest_item_id") or payload.get("alert_id")
    return next((item for item in category.get("digest", []) if item.get("id") == item_id), None)


def conversation_id(trigger: dict) -> str:
    source = "|".join(
        str(value)
        for value in (
            trigger.get("id"),
            trigger.get("merchant_id"),
            trigger.get("customer_id") or "merchant",
            trigger.get("suppression_key"),
            trigger.get("expires_at"),
        )
    )
    return f"conv_{hashlib.sha256(source.encode()).hexdigest()[:20]}"


def priority(trigger: dict) -> int:
    return int(float(trigger.get("urgency", 0)) * 1000) + KIND_PRIORITY.get(trigger.get("kind"), 0)


def consent_allows(customer: dict | None, trigger: dict) -> bool:
    if trigger.get("scope") != "customer":
        return True
    if not customer or customer.get("merchant_id") != trigger.get("merchant_id"):
        return False
    consent = customer.get("consent", {})
    if not consent.get("opted_in_at"):
        return False
    channel = customer.get("preferences", {}).get("channel")
    if not channel or channel == "none_recorded":
        return False
    granted = set(consent.get("scope", []))
    required = CUSTOMER_CONSENT.get(trigger.get("kind"))
    return bool(granted) if required is None else bool(granted & required)


def merchant_plan(category: dict, merchant: dict, trigger: dict) -> dict | None:
    payload = trigger.get("payload", {})
    kind = trigger.get("kind")
    who = owner_label(category, merchant)
    offers = active_offers(merchant)
    offer = offers[0] if offers else None
    item = digest_item(category, payload)

    if kind in {"research_digest", "cde_opportunity"}:
        if not item or not item.get("title") or not item.get("source"):
            return None
        aggregate = merchant.get("customer_aggregate", {})
        cohort = aggregate.get("high_risk_adult_count") if item.get("patient_segment") == "high_risk_adults" else None
        anchor = (
            f" It is relevant to your {cohort} high-risk adult patients."
            if cohort
            else f" This is relevant to your {merchant.get('identity', {}).get('locality')} practice."
            if merchant.get("identity", {}).get("locality")
            else ""
        )
        action = f" Practical takeaway: {item['actionable']}." if item.get("actionable") else ""
        return {
            "body": f"{who}, {item['title']}.{anchor}{action} Want me to prepare a short merchant-ready summary? — {item['source']}",
            "cta": "binary_yes_no",
            "reason": "source-backed category update",
        }

    if kind == "regulation_change":
        if not item or not item.get("title") or not item.get("source"):
            return None
        deadline = format_date(payload.get("deadline_iso"))
        body = f"{who}, compliance update: {item['title']}."
        if deadline:
            body += f" Deadline: {deadline}."
        if item.get("actionable"):
            body += f" {item['actionable']}"
        body += f" Want me to prepare a checklist? — {item['source']}"
        return {"body": clean(body), "cta": "binary_yes_no", "reason": "time-bound compliance update"}

    if kind in {"perf_dip", "seasonal_perf_dip"}:
        metric = payload.get("metric")
        change = format_percent(payload.get("delta_pct"))
        if not metric or not change:
            return None
        performance = merchant.get("performance", {})
        current = performance.get(metric)
        current_text = ""
        if current is not None:
            shown = format_percent(current) if metric == "ctr" else current
            current_text = f" Your current 30-day {clean(metric)} value is {shown}."
        seasonal = " This is marked as an expected seasonal pattern." if payload.get("is_expected_seasonal") else ""
        return {
            "body": f"{who}, your {clean(metric)} changed {change} over {payload.get('window', 'the latest period')}.{current_text}{seasonal} Want me to prepare one focused recovery action?",
            "cta": "binary_yes_no",
            "reason": "merchant performance change",
        }

    if kind == "perf_spike":
        metric, change = payload.get("metric"), format_percent(payload.get("delta_pct"))
        if not metric or not change:
            return None
        driver = f" The supplied signal points to {clean(payload['likely_driver'])} as the likely driver." if payload.get("likely_driver") else ""
        return {
            "body": f"{who}, your {clean(metric)} is {change} over {payload.get('window', 'the latest period')}.{driver} Want me to draft a follow-up that builds on it?",
            "cta": "binary_yes_no",
            "reason": "positive performance signal",
        }

    if kind == "milestone_reached":
        if not payload.get("metric") or payload.get("milestone_value") is None:
            return None
        current, milestone = payload.get("value_now"), payload.get("milestone_value")
        try:
            gap = float(milestone) - float(current)
            status = f"{int(gap) if gap.is_integer() else gap} away" if gap > 0 else "reached"
        except (TypeError, ValueError):
            status = "the next target"
        return {
            "body": f"{who}, {clean(payload['metric'])} is at {current}; the {milestone} milestone is {status}. Want me to draft a milestone post?",
            "cta": "binary_yes_no",
            "reason": "merchant milestone",
        }

    if kind == "ipl_match_today":
        if not payload.get("match") or not payload.get("match_time_iso"):
            return None
        try:
            match_time = parse_iso(payload["match_time_iso"]).strftime("%I:%M %p").lstrip("0")
        except ValueError:
            match_time = payload["match_time_iso"]
        insight = next((entry for entry in category.get("digest", []) if "ipl" in f"{entry.get('title')} {entry.get('summary')}".lower()), None)
        if payload.get("is_weeknight") is False and insight:
            body = f"{who}, {payload['match']} is on today at {match_time}, but {insight.get('title')}. Skip a dine-in match promo today."
            if offer:
                body += f" Keep {offer} for its listed days."
            body += f" Want me to draft the next weeknight match message? — {insight.get('source')}"
            return {"body": body, "cta": "binary_yes_no", "reason": "contrarian event decision grounded in category data"}
        return {
            "body": f"{who}, {payload['match']} is on today at {match_time}.{f' Your active offer is {offer}.' if offer else ''} Want me to draft one delivery-focused match message?",
            "cta": "binary_yes_no",
            "reason": "same-day restaurant event",
        }

    if kind == "festival_upcoming":
        if not payload.get("festival") or payload.get("days_until") is None:
            return None
        return {
            "body": f"{who}, {payload['festival']} is {payload['days_until']} days away.{f' Your active offer is {offer}.' if offer else ''} Want me to prepare one timely campaign draft?",
            "cta": "binary_yes_no",
            "reason": "near-term festival opportunity",
        }

    if kind == "category_seasonal":
        trends = "; ".join(clean(value) for value in payload.get("trends", [])[:2])
        if not payload.get("season") or not trends:
            return None
        return {
            "body": f"{who}, {clean(payload['season'])} demand signals show {trends}. Want me to prepare a stock and customer-message checklist?",
            "cta": "binary_yes_no",
            "reason": "category seasonal signal",
        }

    if kind == "review_theme_emerged":
        if not payload.get("theme") or payload.get("occurrences_30d") is None:
            return None
        quote = f" One says: “{payload['common_quote']}”." if payload.get("common_quote") else ""
        return {
            "body": f"{who}, {payload['occurrences_30d']} reviews in the last 30 days mention {clean(payload['theme'])}.{quote} Want me to draft a response and action checklist?",
            "cta": "binary_yes_no",
            "reason": "repeated review theme",
        }

    if kind == "active_planning_intent":
        if not payload.get("intent_topic"):
            return None
        return {
            "body": f"{who}, you asked about {clean(payload['intent_topic'])}.{f' Your current offer, {offer}, gives us a grounded starting point.' if offer else ''} Want me to prepare the first message draft now?",
            "cta": "binary_yes_no",
            "reason": "continuation of explicit planning intent",
        }

    if kind == "supply_alert":
        batches = ", ".join(str(value) for value in payload.get("affected_batches", []))
        if not payload.get("molecule") or not batches:
            return None
        return {
            "body": f"{who}, urgent supply alert for {payload['molecule']}: affected batches {batches}{f' from {payload.get("manufacturer")}' if payload.get('manufacturer') else ''}. Want me to draft the customer notice and replacement checklist?",
            "cta": "binary_yes_no",
            "reason": "specific medicine supply alert",
        }

    if kind == "competitor_opened":
        if not payload.get("competitor_name") or payload.get("distance_km") is None:
            return None
        return {
            "body": f"{who}, {payload['competitor_name']} opened {payload['distance_km']} km away.{f' Their listed offer is {payload.get("their_offer")}.' if payload.get('their_offer') else ''}{f' Your active offer is {offer}.' if offer else ''} Want me to draft a differentiated local message?",
            "cta": "binary_yes_no",
            "reason": "verified nearby competitor event",
        }

    if kind == "curious_ask_due":
        return {
            "body": f"{who}, what service has customers asked for most this week at {merchant.get('identity', {}).get('name', 'your business')}? I can turn your answer into one short post draft.",
            "cta": "open_ended",
            "reason": "low-friction merchant insight request",
        }

    if kind in {"renewal_due", "winback_eligible", "dormant_with_vera", "gbp_unverified"}:
        fact = None
        if payload.get("days_remaining") is not None:
            fact = f"{payload['days_remaining']} days remain on your {payload.get('plan', 'current')} plan"
        elif payload.get("days_since_expiry") is not None:
            fact = f"{payload['days_since_expiry']} days have passed since expiry"
        elif payload.get("days_since_last_merchant_message") is not None:
            fact = f"{payload['days_since_last_merchant_message']} days have passed since your last Vera message"
        elif payload.get("verified") is False:
            fact = "your Google Business Profile is currently unverified"
        if not fact:
            return None
        return {
            "body": f"{who}, quick account update: {fact}. Want me to prepare the simplest next step?",
            "cta": "binary_yes_no",
            "reason": "merchant account action",
        }

    return None


def customer_plan(merchant: dict, trigger: dict, customer: dict) -> dict | None:
    payload = trigger.get("payload", {})
    kind = trigger.get("kind")
    customer_name = customer.get("identity", {}).get("name") or "there"
    merchant_name = merchant.get("identity", {}).get("name") or "the merchant"
    language = customer.get("identity", {}).get("language_pref", "")
    greeting = f"Namaste {customer_name}" if re.search(r"(^hi$|hi-en|hindi)", language, re.I) else f"Hi {customer_name}"

    if kind == "recall_due":
        if not payload.get("service_due") or not payload.get("due_date"):
            return None
        slots = [slot.get("label") for slot in payload.get("available_slots", []) if slot.get("label")]
        offer = relevant_offer(merchant, ["cleaning", "recall", clean(payload["service_due"])])
        ending = f" Available: {' or '.join(slots)}. Reply with your preferred slot." if slots else " Reply YES and the clinic will help choose a slot."
        return {
            "body": f"{greeting}, {merchant_name} here. Your {clean(payload['service_due'])} is due on {format_date(payload['due_date'])}.{f' {offer} is currently active.' if offer else ''}{ending}",
            "cta": "multi_choice_slot" if slots else "binary_yes_no",
            "reason": "consented customer recall",
        }

    if kind == "chronic_refill_due":
        medicines = ", ".join(str(value) for value in payload.get("molecule_list", []))
        if not medicines or not payload.get("stock_runs_out_iso"):
            return None
        benefits = [offer for offer in active_offers(merchant) if re.search(r"delivery|senior", offer, re.I)][:2]
        benefit_text = f" Current benefits: {'; '.join(benefits)}." if benefits else ""
        return {
            "body": f"{greeting}, {merchant_name} here. Your {medicines} supply is expected to run out on {format_date(payload['stock_runs_out_iso'])}.{benefit_text} Reply CONFIRM if you want the pharmacy to prepare the refill.",
            "cta": "binary_confirm_cancel",
            "reason": "consented chronic refill reminder",
        }

    if kind == "appointment_tomorrow":
        appointment = payload.get("appointment_time") or payload.get("appointment_at") or payload.get("slot")
        if not appointment:
            return None
        return {
            "body": f"{greeting}, {merchant_name} here. Reminder: your appointment is {appointment}. Reply CONFIRM to acknowledge, or tell us if you need to reschedule.",
            "cta": "binary_confirm_cancel",
            "reason": "consented appointment reminder",
        }

    if kind == "trial_followup":
        slots = [slot.get("label") for slot in payload.get("next_session_options", []) if slot.get("label")]
        if not payload.get("trial_date") and not slots:
            return None
        offer = relevant_offer(merchant, ["trial", "first month", "class"])
        ending = f" The next option is {' or '.join(slots)}. Reply YES to hold it." if slots else " Reply YES if you want the next-session options."
        return {
            "body": f"{greeting}, {merchant_name} here. Following up after your trial{f' on {format_date(payload.get("trial_date"))}' if payload.get('trial_date') else ''}.{f' {offer} is active.' if offer else ''}{ending}",
            "cta": "binary_yes_no",
            "reason": "consented trial follow-up",
        }

    if kind in {"customer_lapsed_hard", "customer_lapsed_soft"}:
        if payload.get("days_since_last_visit") is None:
            return None
        focus = f" around your {clean(payload['previous_focus'])} goal" if payload.get("previous_focus") else ""
        offer = relevant_offer(merchant, ["trial", "first month", "return", "free"])
        return {
            "body": f"{greeting}, {merchant_name} here. It has been {payload['days_since_last_visit']} days since your last visit—no pressure.{f' We have an option{focus}.' if focus else ''}{f' {offer} is active.' if offer else ''} Want the details?",
            "cta": "binary_yes_no",
            "reason": "consented, non-judgmental win-back",
        }

    if kind == "wedding_package_followup":
        if not payload.get("wedding_date"):
            return None
        offer = relevant_offer(merchant, ["bridal", "skin", "wedding"])
        countdown = f" ({payload['days_to_wedding']} days away)" if payload.get("days_to_wedding") is not None else ""
        return {
            "body": f"{greeting}, {merchant_name} here. Your wedding date is {format_date(payload['wedding_date'])}{countdown}, so this is the right time to plan the next bridal step.{f' {offer} is active.' if offer else ''} Want the available plan details?",
            "cta": "binary_yes_no",
            "reason": "consented bridal follow-up",
        }

    return None


def valid_plan(plan: dict | None, category: dict, trigger: dict) -> bool:
    if not plan or not all(plan.get(key) for key in ("body", "cta", "reason")):
        return False
    body = plan["body"]
    if len(body) > 700 or re.search(r"https?://|www\.", body, re.I) or body.count("?") > 1:
        return False
    taboos = category.get("voice", {}).get("vocab_taboo") or category.get("voice", {}).get("taboos") or []
    if any(str(taboo).lower() in body.lower() for taboo in taboos if taboo):
        return False
    if trigger.get("scope") == "customer" and not re.match(r"^(hi|namaste) ", body, re.I):
        return False
    return True


def build_action(category: dict, merchant: dict, trigger: dict, customer: dict | None):
    plan = customer_plan(merchant, trigger, customer) if trigger.get("scope") == "customer" and customer else merchant_plan(category, merchant, trigger)
    if not valid_plan(plan, category, trigger):
        return None
    return {
        "conversation_id": conversation_id(trigger),
        "merchant_id": merchant["merchant_id"],
        "customer_id": customer.get("customer_id") if customer else None,
        "send_as": "merchant_on_behalf" if trigger.get("scope") == "customer" else "vera",
        "trigger_id": trigger["id"],
        "template_name": f"{'merchant' if trigger.get('scope') == 'customer' else 'vera'}_{trigger['kind']}_v1",
        "template_params": [
            (customer or {}).get("identity", {}).get("name")
            or merchant.get("identity", {}).get("name")
            or merchant["merchant_id"],
            plan["body"],
        ],
        "body": plan["body"],
        "cta": plan["cta"],
        "suppression_key": trigger["suppression_key"],
        "rationale": f"{plan['reason']}; composed only from stored {category['slug']}, merchant, trigger{' and customer' if customer else ''} context.",
    }


async def decide_actions(store, now: str, available_trigger_ids: list[str], limit: int = 20):
    trigger_ids = list(dict.fromkeys(available_trigger_ids))
    trigger_records = await store.get_contexts("trigger", trigger_ids)
    triggers = [
        (trigger_id, trigger_records[trigger_id])
        for trigger_id in trigger_ids
        if trigger_id in trigger_records and trigger_records[trigger_id]["payload"].get("id") == trigger_id
    ]
    merchant_records = await store.get_contexts(
        "merchant", [record["payload"].get("merchant_id") for _, record in triggers]
    )
    category_records = await store.get_contexts(
        "category", [record["payload"].get("category_slug") for record in merchant_records.values()]
    )
    customer_records = await store.get_contexts(
        "customer", [record["payload"].get("customer_id") for _, record in triggers]
    )
    suppression_keys = []
    for _, record in triggers:
        trigger = record["payload"]
        suppression_keys.extend(
            [trigger.get("suppression_key"), f"merchant:{trigger.get('merchant_id')}:global"]
        )
    active = await store.active_suppressions(suppression_keys, now)
    now_value = parse_iso(now)
    candidates = []
    for _, trigger_record in triggers:
        trigger = trigger_record["payload"]
        merchant_record = merchant_records.get(trigger.get("merchant_id"))
        merchant = merchant_record["payload"] if merchant_record else None
        if not merchant or merchant.get("merchant_id") != trigger.get("merchant_id"):
            continue
        category_record = category_records.get(merchant.get("category_slug"))
        category = category_record["payload"] if category_record else None
        if not category or category.get("slug") != merchant.get("category_slug"):
            continue
        customer_record = customer_records.get(trigger.get("customer_id")) if trigger.get("customer_id") else None
        customer = customer_record["payload"] if customer_record else None
        if trigger.get("scope") == "customer" and (
            not customer
            or customer.get("customer_id") != trigger.get("customer_id")
            or customer.get("merchant_id") != merchant.get("merchant_id")
        ):
            continue
        if trigger.get("scope") not in {"merchant", "customer"}:
            continue
        try:
            if parse_iso(trigger["expires_at"]) <= now_value:
                continue
        except (KeyError, ValueError):
            continue
        if trigger.get("suppression_key") in active or f"merchant:{trigger.get('merchant_id')}:global" in active:
            continue
        if not consent_allows(customer, trigger):
            continue
        if trigger.get("kind") == "festival_upcoming" and float(trigger.get("payload", {}).get("days_until", 0)) > 30:
            continue
        candidates.append(
            {
                "trigger": trigger,
                "merchant": merchant,
                "category": category,
                "customer": customer,
                "score": priority(trigger),
                "records": {
                    "trigger": trigger_record,
                    "merchant": merchant_record,
                    "category": category_record,
                    "customer": customer_record,
                },
            }
        )
    candidates.sort(
        key=lambda item: (
            -item["score"],
            parse_iso(item["trigger"]["expires_at"]),
            item["trigger"]["id"],
        )
    )
    actions, selected_merchants = [], set()
    for candidate in candidates:
        if len(actions) >= limit:
            break
        merchant_id = candidate["merchant"]["merchant_id"]
        if merchant_id in selected_merchants:
            continue
        action = build_action(
            candidate["category"], candidate["merchant"], candidate["trigger"], candidate["customer"]
        )
        if not action:
            continue
        records = candidate["records"]
        claimed = await store.claim_action(
            action,
            candidate["category"]["slug"],
            candidate["trigger"]["expires_at"],
            now,
            {
                "category": {"id": candidate["category"]["slug"], "version": records["category"]["version"]},
                "merchant": {"id": merchant_id, "version": records["merchant"]["version"]},
                "trigger": {"id": candidate["trigger"]["id"], "version": records["trigger"]["version"]},
                "customer": {"id": candidate["customer"]["customer_id"], "version": records["customer"]["version"]}
                if candidate["customer"]
                else None,
            },
            {
                "identity_links_match": True,
                "consent_verified": candidate["trigger"].get("scope") != "customer"
                or consent_allows(candidate["customer"], candidate["trigger"]),
                "voice_and_output_validated": True,
                "suppression_claimed_atomically": True,
            },
        )
        if claimed:
            actions.append(action)
            selected_merchants.add(merchant_id)
    return actions
