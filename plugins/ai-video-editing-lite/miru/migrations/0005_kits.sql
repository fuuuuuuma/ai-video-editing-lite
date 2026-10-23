-- チャンネルのトンマナ（2026-10-22）。招待された人の MIRU AI動画編集が、編集の前に読んで同じように編集する。
-- 中身は編集スキルのチャンネルの記憶（字幕の見た目・続けるルールなど）の JSON。強調デザインは designs・design_roles（0002）にある。
-- 決める・変えるのはチャンネルの管理者（owner）。前の形は channel_kits_history に残す
CREATE TABLE IF NOT EXISTS channel_kits (
  channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS channel_kits_history (
  channel_id TEXT NOT NULL,
  body TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  saved_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS channel_kits_history_ch ON channel_kits_history(channel_id, saved_at);

-- 編集スキルを取りに来る使い捨てのリンク（MCP の install_editor が作る。10 分で切れる）。印そのものは置かず SHA-256 だけ
CREATE TABLE IF NOT EXISTS tickets (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  user_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
