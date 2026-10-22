-- 強調デザインの一覧（チャンネルごと・2026-10-20）。採用・不採用はサイトが正。見本の絵は R2（c/<チャンネル>/designs/<id>.jpg）
CREATE TABLE IF NOT EXISTS design_roles (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  label TEXT NOT NULL,
  when_text TEXT NOT NULL DEFAULT '',
  avoid TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, role)
);
CREATE TABLE IF NOT EXISTS designs (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  role TEXT NOT NULL,
  name TEXT NOT NULL,
  style TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'adopt', 'reject')),
  memo TEXT NOT NULL DEFAULT '',
  image TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  decided_at INTEGER,
  decided_by TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, id)
);
