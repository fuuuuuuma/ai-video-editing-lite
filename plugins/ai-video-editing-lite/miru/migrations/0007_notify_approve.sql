-- 2026-10-24: 運用に要るもの（同種サービスの調査と点検から）
-- 通知: チャンネルごとの Incoming Webhook（Slack・Discord）。新しい版・修正指示・返事・承認を知らせる。空なら送らない
ALTER TABLE channels ADD COLUMN notify_url TEXT;
-- 承認: 「この版で OK」を誰がいつ出したか（揉めたときの証拠・完成版を作る合図）
ALTER TABLE versions ADD COLUMN approved_by TEXT;
ALTER TABLE versions ADD COLUMN approved_at INTEGER;
