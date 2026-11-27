// Local business data schema (SQLite). The harness creates it on first run.
// Starter skills read and write it with the db_query / db_execute tools.
// Evals seed it through EvalCase.db. Tables that start with "_os_" are
// harness-private: db_query and db_execute must refuse them.

export const BUSINESS_TABLES = [
  "customers",
  "purchases",
  "messages",
  "invoices",
  "invoice_items",
  "proposals",
  "tickets",
  "posts",
  "metrics",
  "brand",
] as const;

export type BusinessTable = (typeof BUSINESS_TABLES)[number];

export const PRIVATE_TABLE_PREFIX = "_os_";

export const BUSINESS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  company TEXT,
  phone TEXT,
  tags TEXT NOT NULL DEFAULT '',          -- comma-separated
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  product TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  purchased_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS purchases_customer ON purchases(customer_id);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  customer_id TEXT REFERENCES customers(id),
  channel TEXT NOT NULL CHECK (channel IN ('email','chat','social','phone','other')),
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  sent_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_customer ON messages(customer_id);
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','paid','overdue','void')),
  issued_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  total_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS invoice_items (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_cents INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  customer_id TEXT REFERENCES customers(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','declined')),
  body_md TEXT NOT NULL DEFAULT '',
  total_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  valid_until TEXT
);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  customer_id TEXT REFERENCES customers(id),
  subject TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','closed')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  category TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL,
  draft_reply TEXT NOT NULL DEFAULT '',
  assignee TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,                  -- linkedin, instagram, x, facebook, newsletter ...
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','published')),
  scheduled_for TEXT,
  published_at TEXT,
  campaign TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS metrics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,                     -- e.g. revenue, new_customers, tickets_closed
  value REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS metrics_name_period ON metrics(name, period_start);
CREATE TABLE IF NOT EXISTS brand (
  key TEXT PRIMARY KEY,                   -- company_name, primary_color, font_display, voice ...
  value TEXT NOT NULL
);
CREATE VIEW IF NOT EXISTS customer_ltv AS
  SELECT c.id AS customer_id, c.name, c.email,
         COALESCE(SUM(p.amount_cents), 0) AS ltv_cents,
         COUNT(p.id) AS purchase_count,
         MAX(p.purchased_at) AS last_purchase_at
  FROM customers c LEFT JOIN purchases p ON p.customer_id = c.id
  GROUP BY c.id;
`;

/** True if SQL text names a harness-private table. Conservative: matches anywhere in the text. */
export function touchesPrivateTable(sql: string): boolean {
  return /\b_os_\w*/i.test(sql);
}
