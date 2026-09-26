from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


Scope = Literal["category", "merchant", "customer", "trigger"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ContextEnvelope(StrictModel):
    scope: Scope
    context_id: str = Field(min_length=1)
    version: int = Field(ge=1)
    payload: dict[str, Any]
    delivered_at: str

    @field_validator("context_id", "delivered_at")
    @classmethod
    def non_empty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be empty")
        return value

    @field_validator("delivered_at")
    @classmethod
    def valid_delivered_at(cls, value: str) -> str:
        parse_iso(value)
        return value

    @model_validator(mode="after")
    def validate_payload_identity(self):
        payload = self.payload
        if self.scope == "category" and payload.get("slug") != self.context_id:
            raise ValueError("Category payload.slug must equal context_id")
        if self.scope == "merchant":
            if payload.get("merchant_id") != self.context_id or not payload.get("category_slug"):
                raise ValueError("Merchant payload must contain matching merchant_id and category_slug")
        if self.scope == "customer":
            if payload.get("customer_id") != self.context_id or not payload.get("merchant_id"):
                raise ValueError("Customer payload must contain matching customer_id and merchant_id")
        if self.scope == "trigger":
            required = (
                payload.get("id") == self.context_id
                and payload.get("scope") in {"merchant", "customer"}
                and bool(payload.get("kind"))
                and bool(payload.get("merchant_id"))
                and bool(payload.get("suppression_key"))
                and isinstance(payload.get("urgency"), (int, float))
                and bool(payload.get("expires_at"))
            )
            if not required:
                raise ValueError("Trigger payload is missing required identity or scheduling fields")
            parse_iso(str(payload["expires_at"]))
            if payload["scope"] == "customer" and not payload.get("customer_id"):
                raise ValueError("Customer-scoped trigger must contain customer_id")
        return self


class TickRequest(StrictModel):
    now: str
    available_triggers: list[str]

    @field_validator("now")
    @classmethod
    def valid_now(cls, value: str) -> str:
        parse_iso(value)
        return value

    @field_validator("available_triggers")
    @classmethod
    def valid_trigger_ids(cls, values: list[str]) -> list[str]:
        if any(not isinstance(value, str) or not value.strip() for value in values):
            raise ValueError("trigger IDs must be non-empty strings")
        return values


class ReplyRequest(StrictModel):
    conversation_id: str = Field(min_length=1)
    merchant_id: str | None = None
    customer_id: str | None = None
    from_role: Literal["merchant", "customer"]
    message: str = Field(min_length=1)
    received_at: str | None = None
    turn_number: int = Field(ge=1)

    @field_validator("conversation_id", "message")
    @classmethod
    def stripped_non_empty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be empty")
        return value

    @field_validator("received_at")
    @classmethod
    def valid_received_at(cls, value: str | None) -> str | None:
        if value is not None:
            parse_iso(value)
        return value


def parse_iso(value: str) -> datetime:
    normalized = value.replace("Z", "+00:00")
    return datetime.fromisoformat(normalized)
