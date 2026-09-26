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
  created_at TEXT NOT NULL,
  claim_token TEXT
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
  evidence_json TEXT,
  checks_json TEXT,
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
