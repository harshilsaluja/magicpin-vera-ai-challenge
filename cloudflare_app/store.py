import hashlib
import json
import uuid
from datetime import UTC, datetime
from typing import Any


SCOPES = ("category", "merchant", "customer", "trigger")


def utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def field(row: Any, name: str, default=None):
    if row is None:
        return default
    if isinstance(row, dict):
        return row.get(name, default)
    try:
        value = getattr(row, name)
        return default if value is None else value
    except (AttributeError, TypeError):
        return default


def changes(result: Any) -> int:
    return int(field(field(result, "meta"), "changes", 0) or 0)


def decode_context(row: Any) -> dict[str, Any] | None:
    if row is None:
        return None
    return {
        "version": int(field(row, "version", 0)),
        "payload": json.loads(str(field(row, "payload_json", "{}"))),
        "delivered_at": field(row, "delivered_at"),
        "stored_at": field(row, "stored_at"),
    }


def groups(values: list[str], size: int = 90):
    for index in range(0, len(values), size):
        yield values[index : index + size]


class D1Store:
    def __init__(self, database):
        self.db = database

    async def put_context(self, envelope: dict[str, Any]) -> dict[str, Any]:
        stored_at = utc_now()
        result = await (
            self.db.prepare(
                """
                INSERT INTO contexts(scope, context_id, version, payload_json, delivered_at, stored_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(scope, context_id) DO UPDATE SET
                  version = excluded.version,
                  payload_json = excluded.payload_json,
                  delivered_at = excluded.delivered_at,
                  stored_at = excluded.stored_at
                WHERE contexts.version < excluded.version
                """
            )
            .bind(
                envelope["scope"],
                envelope["context_id"],
                envelope["version"],
                json.dumps(envelope["payload"], separators=(",", ":"), ensure_ascii=False),
                envelope.get("delivered_at"),
                stored_at,
            )
            .run()
        )
        if changes(result) > 0:
            return {"accepted": True, "stored_at": stored_at}
        current = await (
            self.db.prepare("SELECT version FROM contexts WHERE scope = ? AND context_id = ?")
            .bind(envelope["scope"], envelope["context_id"])
            .first()
        )
        return {
            "accepted": False,
            "current_version": int(field(current, "version", envelope["version"])),
        }

    async def get_context(self, scope: str, context_id: str | None):
        if not context_id:
            return None
        row = await (
            self.db.prepare(
                "SELECT version, payload_json, delivered_at, stored_at "
                "FROM contexts WHERE scope = ? AND context_id = ?"
            )
            .bind(scope, context_id)
            .first()
        )
        return decode_context(row)

    async def get_contexts(self, scope: str, context_ids: list[str | None]):
        unique = list(dict.fromkeys(value for value in context_ids if value))
        records: dict[str, dict[str, Any]] = {}
        for group in groups(unique):
            placeholders = ",".join("?" for _ in group)
            result = await (
                self.db.prepare(
                    "SELECT context_id, version, payload_json, delivered_at, stored_at "
                    f"FROM contexts WHERE scope = ? AND context_id IN ({placeholders})"
                )
                .bind(scope, *group)
                .all()
            )
            for row in field(result, "results", []) or []:
                records[str(field(row, "context_id"))] = decode_context(row)
        return records

    async def counts(self) -> dict[str, int]:
        output = {scope: 0 for scope in SCOPES}
        result = await self.db.prepare(
            "SELECT scope, COUNT(*) AS count FROM contexts GROUP BY scope"
        ).all()
        for row in field(result, "results", []) or []:
            scope = str(field(row, "scope", ""))
            if scope in output:
                output[scope] = int(field(row, "count", 0))
        return output

    async def ping(self) -> bool:
        row = await self.db.prepare("SELECT 1 AS ok").first()
        return int(field(row, "ok", 0)) == 1

    async def active_suppressions(self, keys: list[str], now: str) -> set[str]:
        unique = list(dict.fromkeys(key for key in keys if key))
        active: set[str] = set()
        for group in groups(unique):
            placeholders = ",".join("?" for _ in group)
            result = await (
                self.db.prepare(
                    "SELECT suppression_key FROM suppressions "
                    f"WHERE suppression_key IN ({placeholders}) AND active_until > ?"
                )
                .bind(*group, now)
                .all()
            )
            for row in field(result, "results", []) or []:
                active.add(str(field(row, "suppression_key")))
        return active

    async def claim_action(
        self,
        action: dict[str, Any],
        category_slug: str,
        active_until: str,
        created_at: str,
        evidence: dict[str, Any],
        checks: dict[str, Any],
    ) -> bool:
        token = str(uuid.uuid4())
        claim = await (
            self.db.prepare(
                """
                INSERT INTO suppressions(
                  suppression_key, trigger_id, merchant_id, customer_id,
                  active_until, reason, created_at, claim_token
                ) VALUES (?, ?, ?, ?, ?, 'proactive_message_sent', ?, ?)
                ON CONFLICT(suppression_key) DO UPDATE SET
                  trigger_id = excluded.trigger_id,
                  merchant_id = excluded.merchant_id,
                  customer_id = excluded.customer_id,
                  active_until = excluded.active_until,
                  reason = excluded.reason,
                  created_at = excluded.created_at,
                  claim_token = excluded.claim_token
                WHERE suppressions.active_until <= excluded.created_at
                """
            )
            .bind(
                action["suppression_key"],
                action["trigger_id"],
                action["merchant_id"],
                action.get("customer_id"),
                active_until,
                created_at,
                token,
            )
            .run()
        )
        if changes(claim) == 0:
            return False
        conversation = await (
            self.db.prepare(
                """
                INSERT OR IGNORE INTO conversations(
                  conversation_id, merchant_id, customer_id, trigger_id, category_slug,
                  status, initial_body, last_body, turn_number, auto_reply_count,
                  evidence_json, checks_json, created_at, updated_at
                )
                SELECT ?, ?, ?, ?, ?, 'open', ?, ?, 1, 0, ?, ?, ?, ?
                WHERE EXISTS (
                  SELECT 1 FROM suppressions WHERE suppression_key = ? AND claim_token = ?
                )
                """
            )
            .bind(
                action["conversation_id"],
                action["merchant_id"],
                action.get("customer_id"),
                action["trigger_id"],
                category_slug,
                action["body"],
                action["body"],
                json.dumps(evidence, separators=(",", ":")),
                json.dumps(checks, separators=(",", ":")),
                created_at,
                created_at,
                action["suppression_key"],
                token,
            )
            .run()
        )
        return changes(conversation) > 0

    async def get_conversation(self, conversation_id: str):
        return await (
            self.db.prepare("SELECT * FROM conversations WHERE conversation_id = ?")
            .bind(conversation_id)
            .first()
        )

    async def ensure_inbound_conversation(
        self,
        conversation_id: str,
        merchant_id: str | None,
        customer_id: str | None,
        category_slug: str | None,
        created_at: str,
    ):
        if not merchant_id or not category_slug:
            return None
        await (
            self.db.prepare(
                """
                INSERT OR IGNORE INTO conversations(
                  conversation_id, merchant_id, customer_id, trigger_id, category_slug,
                  status, initial_body, last_body, turn_number, auto_reply_count,
                  created_at, updated_at
                ) VALUES (?, ?, ?, 'inbound', ?, 'open', '', '', 0, 0, ?, ?)
                """
            )
            .bind(conversation_id, merchant_id, customer_id, category_slug, created_at, created_at)
            .run()
        )
        return await self.get_conversation(conversation_id)

    @staticmethod
    def hash_body(body: str) -> str:
        return hashlib.sha256(body.strip().lower().encode()).hexdigest()

    async def insert_turn(
        self,
        conversation_id: str,
        turn_number: int,
        role: str,
        body: str,
        action: str | None,
        created_at: str,
    ) -> None:
        await (
            self.db.prepare(
                """
                INSERT OR IGNORE INTO turns(
                  conversation_id, turn_number, role, body, body_hash, action, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """
            )
            .bind(
                conversation_id,
                turn_number,
                role,
                body,
                self.hash_body(body),
                action,
                created_at,
            )
            .run()
        )

    async def count_inbound_body_for_merchant(self, merchant_id: str, body: str) -> int:
        row = await (
            self.db.prepare(
                """
                SELECT COUNT(*) AS count FROM turns t
                JOIN conversations c ON c.conversation_id = t.conversation_id
                WHERE c.merchant_id = ?
                  AND t.role IN ('merchant', 'customer') AND t.body_hash = ?
                """
            )
            .bind(merchant_id, self.hash_body(body))
            .first()
        )
        return int(field(row, "count", 0))

    async def has_sent_body(self, conversation_id: str, body: str) -> bool:
        normalized = body.strip().lower()
        row = await (
            self.db.prepare(
                """
                SELECT 1 AS found FROM conversations
                WHERE conversation_id = ? AND (
                  lower(trim(initial_body)) = ? OR lower(trim(last_body)) = ?
                )
                UNION ALL
                SELECT 1 AS found FROM turns
                WHERE conversation_id = ? AND role = 'vera' AND body_hash = ?
                LIMIT 1
                """
            )
            .bind(
                conversation_id,
                normalized,
                normalized,
                conversation_id,
                self.hash_body(body),
            )
            .first()
        )
        return row is not None

    async def update_conversation(
        self,
        conversation_id: str,
        status: str,
        last_body: str | None,
        turn_number: int,
        auto_reply_count: int,
        last_intent: str,
        updated_at: str,
    ) -> None:
        await (
            self.db.prepare(
                """
                UPDATE conversations SET status = ?, last_body = COALESCE(?, last_body),
                  turn_number = ?, auto_reply_count = ?, last_intent = ?, updated_at = ?
                WHERE conversation_id = ?
                """
            )
            .bind(
                status,
                last_body,
                turn_number,
                auto_reply_count,
                last_intent,
                updated_at,
                conversation_id,
            )
            .run()
        )

    async def save_reply_response(
        self, conversation_id: str, turn_number: int, response: dict[str, Any], created_at: str
    ) -> None:
        await (
            self.db.prepare(
                """
                INSERT OR REPLACE INTO reply_responses(
                  conversation_id, turn_number, response_json, created_at
                ) VALUES (?, ?, ?, ?)
                """
            )
            .bind(conversation_id, turn_number, json.dumps(response), created_at)
            .run()
        )

    async def get_reply_response(self, conversation_id: str, turn_number: int):
        row = await (
            self.db.prepare(
                "SELECT response_json FROM reply_responses "
                "WHERE conversation_id = ? AND turn_number = ?"
            )
            .bind(conversation_id, turn_number)
            .first()
        )
        return json.loads(str(field(row, "response_json"))) if row is not None else None

    async def suppress_merchant(
        self, merchant_id: str, active_until: str, reason: str, created_at: str
    ) -> None:
        key = f"merchant:{merchant_id}:global"
        await (
            self.db.prepare(
                """
                INSERT INTO suppressions(
                  suppression_key, trigger_id, merchant_id, customer_id,
                  active_until, reason, created_at
                ) VALUES (?, 'conversation_opt_out', ?, NULL, ?, ?, ?)
                ON CONFLICT(suppression_key) DO UPDATE SET
                  active_until = excluded.active_until,
                  reason = excluded.reason,
                  created_at = excluded.created_at
                """
            )
            .bind(key, merchant_id, active_until, reason, created_at)
            .run()
        )

    async def teardown(self) -> None:
        for table in ("reply_responses", "turns", "conversations", "suppressions", "contexts"):
            await self.db.prepare(f"DELETE FROM {table}").run()
