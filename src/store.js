const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

class VeraStore {
  constructor(databasePath = ":memory:") {
    if (databasePath !== ":memory:") {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    }

    this.databasePath = databasePath;
    this.db = new DatabaseSync(databasePath);
    this.startedAt = Date.now();
    this.initialize();
  }

  initialize() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS contexts (
        scope TEXT NOT NULL CHECK (scope IN ('category', 'merchant', 'customer', 'trigger')),
        context_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1),
        payload_json TEXT NOT NULL,
        delivered_at TEXT,
        stored_at TEXT NOT NULL,
        PRIMARY KEY (scope, context_id)
      );

      CREATE INDEX IF NOT EXISTS idx_contexts_scope ON contexts(scope);

      CREATE TABLE IF NOT EXISTS suppressions (
        suppression_key TEXT PRIMARY KEY,
        trigger_id TEXT NOT NULL,
        merchant_id TEXT NOT NULL,
        customer_id TEXT,
        active_until TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_suppressions_merchant ON suppressions(merchant_id);

      CREATE TABLE IF NOT EXISTS conversations (
        conversation_id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL,
        customer_id TEXT,
        trigger_id TEXT NOT NULL,
        category_slug TEXT NOT NULL,
        status TEXT NOT NULL,
        initial_body TEXT NOT NULL,
        last_body TEXT NOT NULL,
        turn_number INTEGER NOT NULL DEFAULT 1,
        auto_reply_count INTEGER NOT NULL DEFAULT 0,
        last_intent TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_conversations_merchant ON conversations(merchant_id);

      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        turn_number INTEGER NOT NULL,
        role TEXT NOT NULL,
        body TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        action TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(conversation_id, turn_number, role)
      );

      CREATE INDEX IF NOT EXISTS idx_turns_conversation ON turns(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_turns_body_hash ON turns(body_hash);

      CREATE TABLE IF NOT EXISTS reply_responses (
        conversation_id TEXT NOT NULL,
        turn_number INTEGER NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(conversation_id, turn_number)
      );

      CREATE TABLE IF NOT EXISTS composition_audits (
        conversation_id TEXT PRIMARY KEY,
        trigger_id TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        checks_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    this.ensureColumn("conversations", "auto_reply_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("conversations", "last_intent", "TEXT");
  }

  ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((entry) => entry.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  putContext({ scope, context_id: contextId, version, payload, delivered_at: deliveredAt }) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db
        .prepare("SELECT version FROM contexts WHERE scope = ? AND context_id = ?")
        .get(scope, contextId);

      if (current && current.version >= version) {
        this.db.exec("ROLLBACK");
        return { accepted: false, currentVersion: current.version };
      }

      const storedAt = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO contexts(scope, context_id, version, payload_json, delivered_at, stored_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope, context_id) DO UPDATE SET
          version = excluded.version,
          payload_json = excluded.payload_json,
          delivered_at = excluded.delivered_at,
          stored_at = excluded.stored_at
      `).run(scope, contextId, version, JSON.stringify(payload), deliveredAt ?? null, storedAt);

      this.db.exec("COMMIT");
      return { accepted: true, storedAt };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The original database error is more useful than a secondary rollback error.
      }
      throw error;
    }
  }

  getContext(scope, contextId) {
    const row = this.db.prepare(`
      SELECT version, payload_json, delivered_at, stored_at
      FROM contexts
      WHERE scope = ? AND context_id = ?
    `).get(scope, contextId);

    if (!row) return null;
    return {
      version: row.version,
      payload: JSON.parse(row.payload_json),
      deliveredAt: row.delivered_at,
      storedAt: row.stored_at,
    };
  }

  counts() {
    const result = { category: 0, merchant: 0, customer: 0, trigger: 0 };
    const rows = this.db.prepare("SELECT scope, COUNT(*) AS count FROM contexts GROUP BY scope").all();
    for (const row of rows) {
      if (row.scope in result) result[row.scope] = Number(row.count);
    }
    return result;
  }

  ping() {
    return this.db.prepare("SELECT 1 AS ok").get()?.ok === 1;
  }

  isSuppressed(suppressionKey, now) {
    if (!suppressionKey) return false;
    const row = this.db.prepare(`
      SELECT active_until
      FROM suppressions
      WHERE suppression_key = ?
    `).get(suppressionKey);

    if (!row) return false;
    if (Date.parse(row.active_until) <= Date.parse(now)) {
      this.db.prepare("DELETE FROM suppressions WHERE suppression_key = ?").run(suppressionKey);
      return false;
    }
    return true;
  }

  claimAction({ action, categorySlug, activeUntil, createdAt, evidence = {}, checks = {} }) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare(`
        SELECT active_until
        FROM suppressions
        WHERE suppression_key = ?
      `).get(action.suppression_key);

      if (existing && Date.parse(existing.active_until) > Date.parse(createdAt)) {
        this.db.exec("ROLLBACK");
        return false;
      }

      if (existing) {
        this.db.prepare("DELETE FROM suppressions WHERE suppression_key = ?").run(action.suppression_key);
      }

      this.db.prepare(`
        INSERT INTO suppressions(
          suppression_key, trigger_id, merchant_id, customer_id,
          active_until, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        action.suppression_key,
        action.trigger_id,
        action.merchant_id,
        action.customer_id,
        activeUntil,
        "proactive_message_sent",
        createdAt,
      );

      this.db.prepare(`
        INSERT INTO conversations(
          conversation_id, merchant_id, customer_id, trigger_id, category_slug,
          status, initial_body, last_body, turn_number, auto_reply_count,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, 1, 0, ?, ?)
      `).run(
        action.conversation_id,
        action.merchant_id,
        action.customer_id,
        action.trigger_id,
        categorySlug,
        action.body,
        action.body,
        createdAt,
        createdAt,
      );

      this.insertTurn({
        conversationId: action.conversation_id,
        turnNumber: 1,
        role: "vera",
        body: action.body,
        action: "send",
        createdAt,
      });

      this.db.prepare(`
        INSERT INTO composition_audits(
          conversation_id, trigger_id, evidence_json, checks_json, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        action.conversation_id,
        action.trigger_id,
        JSON.stringify(evidence),
        JSON.stringify(checks),
        createdAt,
      );

      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original database error.
      }
      throw error;
    }
  }

  getConversation(conversationId) {
    return this.db.prepare(`
      SELECT * FROM conversations WHERE conversation_id = ?
    `).get(conversationId) ?? null;
  }

  getCompositionAudit(conversationId) {
    const row = this.db.prepare(`
      SELECT trigger_id, evidence_json, checks_json, created_at
      FROM composition_audits WHERE conversation_id = ?
    `).get(conversationId);
    if (!row) return null;
    return {
      triggerId: row.trigger_id,
      evidence: JSON.parse(row.evidence_json),
      checks: JSON.parse(row.checks_json),
      createdAt: row.created_at,
    };
  }

  ensureInboundConversation({ conversationId, merchantId, customerId, categorySlug, createdAt }) {
    const existing = this.getConversation(conversationId);
    if (existing) return existing;
    if (!merchantId || !categorySlug) return null;

    this.db.prepare(`
      INSERT OR IGNORE INTO conversations(
        conversation_id, merchant_id, customer_id, trigger_id, category_slug,
        status, initial_body, last_body, turn_number, auto_reply_count,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'inbound', ?, 'open', '', '', 0, 0, ?, ?)
    `).run(conversationId, merchantId, customerId ?? null, categorySlug, createdAt, createdAt);
    return this.getConversation(conversationId);
  }

  hashBody(body) {
    return crypto.createHash("sha256").update(String(body).trim().toLowerCase()).digest("hex");
  }

  insertTurn({ conversationId, turnNumber, role, body, action = null, createdAt }) {
    this.db.prepare(`
      INSERT OR IGNORE INTO turns(
        conversation_id, turn_number, role, body, body_hash, action, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(conversationId, turnNumber, role, body, this.hashBody(body), action, createdAt);
  }

  countInboundBodyForMerchant(merchantId, body) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM turns t
      JOIN conversations c ON c.conversation_id = t.conversation_id
      WHERE c.merchant_id = ? AND t.role IN ('merchant', 'customer') AND t.body_hash = ?
    `).get(merchantId, this.hashBody(body));
    return Number(row?.count ?? 0);
  }

  hasSentBody(conversationId, body) {
    const row = this.db.prepare(`
      SELECT 1
      FROM turns
      WHERE conversation_id = ? AND role = 'vera' AND body_hash = ?
      LIMIT 1
    `).get(conversationId, this.hashBody(body));
    return Boolean(row);
  }

  updateConversation({ conversationId, status, lastBody, turnNumber, autoReplyCount, lastIntent, updatedAt }) {
    this.db.prepare(`
      UPDATE conversations SET
        status = COALESCE(?, status),
        last_body = COALESCE(?, last_body),
        turn_number = COALESCE(?, turn_number),
        auto_reply_count = COALESCE(?, auto_reply_count),
        last_intent = COALESCE(?, last_intent),
        updated_at = ?
      WHERE conversation_id = ?
    `).run(
      status ?? null,
      lastBody ?? null,
      turnNumber ?? null,
      autoReplyCount ?? null,
      lastIntent ?? null,
      updatedAt,
      conversationId,
    );
  }

  saveReplyResponse(conversationId, turnNumber, response, createdAt) {
    this.db.prepare(`
      INSERT OR REPLACE INTO reply_responses(conversation_id, turn_number, response_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(conversationId, turnNumber, JSON.stringify(response), createdAt);
  }

  getReplyResponse(conversationId, turnNumber) {
    const row = this.db.prepare(`
      SELECT response_json FROM reply_responses
      WHERE conversation_id = ? AND turn_number = ?
    `).get(conversationId, turnNumber);
    return row ? JSON.parse(row.response_json) : null;
  }

  suppressMerchant(merchantId, activeUntil, reason, createdAt) {
    const key = `merchant:${merchantId}:global`;
    this.db.prepare(`
      INSERT INTO suppressions(
        suppression_key, trigger_id, merchant_id, customer_id,
        active_until, reason, created_at
      ) VALUES (?, 'conversation_opt_out', ?, NULL, ?, ?, ?)
      ON CONFLICT(suppression_key) DO UPDATE SET
        active_until = excluded.active_until,
        reason = excluded.reason,
        created_at = excluded.created_at
    `).run(key, merchantId, activeUntil, reason, createdAt);
  }

  isMerchantSuppressed(merchantId, now) {
    return this.isSuppressed(`merchant:${merchantId}:global`, now);
  }

  teardown() {
    this.db.exec(`
      DELETE FROM composition_audits;
      DELETE FROM reply_responses;
      DELETE FROM turns;
      DELETE FROM conversations;
      DELETE FROM suppressions;
      DELETE FROM contexts;
    `);
  }

  close() {
    this.db.close();
  }
}

module.exports = { VeraStore };
