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

-- （個人用 MIRU の前からのチャンネルを持ち主のものにする移し替えは、新しく立てた MIRU では何もしないので外した）
UPDATE tokens SET expires_at = created_at + 365 * 86400000 WHERE expires_at IS NULL;
CREATE INDEX IF NOT EXISTS channels_created_by ON channels(created_by);
CREATE INDEX IF NOT EXISTS versions_created ON versions(ready, created_at);
