from datetime import datetime
from pathlib import Path

import pytest
from pydantic import ValidationError

from cloudflare_app.decision import build_action, consent_allows, conversation_id
from cloudflare_app.models import ContextEnvelope, ReplyRequest, TickRequest
from cloudflare_app.reply import classify_reply, valid_response


def category():
    return {"slug": "restaurants", "voice": {"vocab_taboo": ["guaranteed packed house"]}, "digest": []}


def merchant():
    return {
        "merchant_id": "m_1",
        "category_slug": "restaurants",
        "identity": {"name": "Harshil Kitchen", "owner_first_name": "Harshil"},
        "performance": {"window_days": 30, "views": 100},
        "offers": [{"title": "Match Combo ₹399", "status": "active"}],
    }


def trigger():
    return {
        "id": "trg_1",
        "scope": "merchant",
        "kind": "active_planning_intent",
        "merchant_id": "m_1",
        "customer_id": None,
        "payload": {"intent_topic": "a delivery campaign"},
        "urgency": 4,
        "suppression_key": "planning:m_1",
        "expires_at": "2026-04-27T10:30:00Z",
    }


def test_context_models_reject_identity_mismatch_and_bad_dates():
    valid = {
        "scope": "merchant",
        "context_id": "m_1",
        "version": 1,
        "payload": {"merchant_id": "m_1", "category_slug": "restaurants"},
        "delivered_at": "2026-04-26T10:00:00Z",
    }
    assert ContextEnvelope(**valid).context_id == "m_1"
    with pytest.raises(ValidationError):
        ContextEnvelope(**{**valid, "payload": {"merchant_id": "m_2", "category_slug": "restaurants"}})
    with pytest.raises(ValidationError):
        TickRequest(now="not-a-date", available_triggers=[])
    with pytest.raises(ValidationError):
        ReplyRequest(conversation_id="x", from_role="merchant", message="yes", turn_number=0)


def test_deterministic_action_is_complete_grounded_and_replayable():
    first = build_action(category(), merchant(), trigger(), None)
    second = build_action(category(), merchant(), trigger(), None)
    assert first == second
    assert first["conversation_id"] == conversation_id(trigger())
    assert first["send_as"] == "vera"
    assert first["template_name"] == "vera_active_planning_intent_v1"
    assert "Match Combo ₹399" in first["body"]
    assert first["body"].count("?") == 1


def test_customer_outreach_requires_relationship_channel_and_scope():
    customer_trigger = {
        **trigger(),
        "scope": "customer",
        "kind": "recall_due",
        "customer_id": "c_1",
    }
    customer = {
        "customer_id": "c_1",
        "merchant_id": "m_1",
        "preferences": {"channel": "whatsapp"},
        "consent": {"opted_in_at": "2026-01-01T00:00:00Z", "scope": ["recall_reminders"]},
    }
    assert consent_allows(customer, customer_trigger)
    assert not consent_allows({**customer, "merchant_id": "m_2"}, customer_trigger)
    assert not consent_allows({**customer, "consent": {"opted_in_at": None, "scope": []}}, customer_trigger)


@pytest.mark.parametrize(
    ("message", "intent"),
    [
        ("Yes, let's do it", "accept"),
        ("Thank you for contacting us! Our team will respond", "auto_reply"),
        ("Stop messaging me", "opt_out"),
        ("I am busy now, message me later", "wait"),
        ("Can you file my GST?", "off_topic"),
        ("What were my monthly sales?", "sales_query"),
    ],
)
def test_reply_classifier(message, intent):
    assert classify_reply(message) == intent


def test_reply_output_gate_blocks_links_repetition_pressure_and_taboos():
    base = {"action": "send", "body": "Harshil, views are down 10%. Want one recovery action?", "cta": "binary_yes_no", "rationale": "grounded"}
    assert valid_response(base, category())
    assert not valid_response({**base, "body": "Visit https://example.com now?"}, category())
    assert not valid_response({**base, "body": "First question? Second question?"}, category())
    assert not valid_response({**base, "body": "A guaranteed packed house. Continue?"}, category())


def test_cloudflare_configuration_uses_python_fastapi_runtime_and_d1():
    config = Path("wrangler.toml").read_text(encoding="utf-8")
    assert 'main = "cloudflare_app/main.py"' in config
    assert 'compatibility_flags = ["python_workers"]' in config
    assert 'binding = "DB"' in config
    assert 'database_name = "vera-production"' in config
