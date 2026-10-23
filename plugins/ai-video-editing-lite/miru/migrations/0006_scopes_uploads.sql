-- セキュリティ確認の残り（2026-10-24）。
-- 鍵の範囲: Claude Code・Codex・上げる道具に置く鍵は「作業用」（work）。鍵を作る・消す、招待、消す操作、編集スキルの差し替えは
-- 画面（cookie）か、サイトの持ち主が画面で作る「持ち主用」（admin）の鍵だけができる。前からの鍵は作業用になる
ALTER TABLE tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'work';

-- 分割アップロードの途中（共有置き場の blob）。片ごとに大きさを積み、容量に数える。終わる・やめると消し、7 日で掃除する
-- （R2 は終わらなかった分割アップロードを 7 日で捨てる）
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,            -- R2 の uploadId
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS uploads_video ON uploads(video_id);
