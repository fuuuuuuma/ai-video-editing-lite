-- 他の人も使える形へ（2026-10-21）。サイトの持ち主の特別扱いをやめ、誰でも自分のチャンネルを作れる。
-- 容量は人ごと（チャンネルを作った人に数える）。鍵には期限。AI の回数を数える。

ALTER TABLE channels ADD COLUMN created_by TEXT;             -- 作った人のメール（容量はこの人に数える）
ALTER TABLE tokens ADD COLUMN expires_at INTEGER;            -- 鍵の期限（ミリ秒）。NULL は期限なし（古い鍵）
ALTER TABLE users ADD COLUMN quota_bytes INTEGER;            -- 容量の上限。NULL は既定（FREE_QUOTA_BYTES）。有料にしたら増やす

CREATE TABLE IF NOT EXISTS usage (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,              -- YYYY-MM-DD（UTC）
  kind TEXT NOT NULL,             -- ai など
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, kind)
);

-- 今までのチャンネルは持ち主が作ったもの。持ち主の特別扱いをやめるので、管理者として招待しておく
UPDATE channels SET created_by = 'pinpon.fuuma@gmail.com' WHERE created_by IS NULL;
INSERT INTO members (channel_id, email, role, invited_by, created_at)
  SELECT id, 'pinpon.fuuma@gmail.com', 'owner', 'migration-0003', created_at FROM channels WHERE true
  ON CONFLICT(channel_id, email) DO UPDATE SET role = 'owner';
UPDATE tokens SET expires_at = created_at + 365 * 86400000 WHERE expires_at IS NULL;
CREATE INDEX IF NOT EXISTS channels_created_by ON channels(created_by);
-- 持ち主は自分の費用で使うので、容量の上限と古い版の自動削除をかけない（上限を大きく取る）
UPDATE users SET quota_bytes = 1000000000000 WHERE email = 'pinpon.fuuma@gmail.com';
CREATE INDEX IF NOT EXISTS versions_created ON versions(ready, created_at);
