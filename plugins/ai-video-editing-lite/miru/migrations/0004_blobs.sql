-- 版をまたいで同じファイルを 1 回だけ置く（2026-10-21）。カメラの proxy や音の片は版が変わっても同じなので、
-- 動画ごとの置き場（R2 の v/<動画>/b/<sha256>）に 1 つだけ置き、版からは「この道はこのファイル」とつなぐ。
CREATE TABLE IF NOT EXISTS blobs (
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  sha TEXT NOT NULL,              -- 中身の SHA-256（16 進 64 文字）
  size INTEGER NOT NULL,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (video_id, sha)
);
CREATE TABLE IF NOT EXISTS links (
  video_id TEXT NOT NULL,
  version TEXT NOT NULL,
  path TEXT NOT NULL,             -- 版の中の道（media/v0001 など）
  sha TEXT NOT NULL,
  PRIMARY KEY (video_id, version, path),
  FOREIGN KEY (video_id, version) REFERENCES versions(video_id, name) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS links_blob ON links(video_id, sha);
