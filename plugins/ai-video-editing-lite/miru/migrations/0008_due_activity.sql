-- 2026-10-25: 運用に要るもの（無料の範囲で）
-- 期限: 動画ごとの「いつまでに」（ミリ秒・その日の 0 時、日本時間）。NULL は期限なし
ALTER TABLE videos ADD COLUMN due_at INTEGER;
-- 履歴: 誰がいつ何をしたか（新しい版・修正指示・返事・済・消した・承認・状態・期限・完成版）。
-- 修正指示を消したときは、消す前の中身を data に残し、画面から戻せるようにする（D1 の巻き戻しは無料だと 7 日まで）
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  who TEXT,                       -- メール（画面では管理者以外に名前だけ見せる）
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  data TEXT                       -- 戻すための中身（消した修正指示の行など）
);
CREATE INDEX IF NOT EXISTS activity_video ON activity(video_id, at);
