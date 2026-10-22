-- MIRU（動画の確認サイト）の置き場（2026-10-19）。動画・画像・音は R2、ここは文字のデータだけ
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,            -- Google の sub
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  picture TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS users_email ON users(email);

CREATE TABLE IF NOT EXISTS sessions (
  hash TEXT PRIMARY KEY,          -- ログインの印の SHA-256（印そのものは置かない）
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- Claude Code（MCP）と書き出しの道具が使う鍵。鍵そのものは置かず SHA-256 だけ
CREATE TABLE IF NOT EXISTS tokens (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,            -- 英小文字の名前（susume など）
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#0a84ff',
  created_at INTEGER NOT NULL
);

-- チャンネルに招待した人。まだログインしたことが無い人もメールで招ける
CREATE TABLE IF NOT EXISTS members (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  email TEXT NOT NULL,            -- 小文字
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  invited_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, email)
);
CREATE INDEX IF NOT EXISTS members_email ON members(email);

CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,            -- 案件の名前（no51-katte-yokatta-mono など）
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'editing' CHECK (status IN ('editing', 'review', 'fixing', 'done')),
  thumb TEXT,                     -- R2 の鍵（見出しの画像）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS videos_channel ON videos(channel_id, updated_at);

CREATE TABLE IF NOT EXISTS versions (
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  name TEXT NOT NULL,             -- v10 など
  frames INTEGER NOT NULL,
  fps REAL NOT NULL,
  ready INTEGER NOT NULL DEFAULT 0,  -- ファイルが全部上がって見られる
  bytes INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (video_id, name)
);

-- 修正指示（確認画面の「修正指示」。タスクとしてフリックで状態を変える）
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  author TEXT NOT NULL,           -- メール
  frame INTEGER,
  end_frame INTEGER,
  tc TEXT,
  end_tc TEXT,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'doing', 'done')),
  category TEXT NOT NULL DEFAULT '',
  reply TEXT,
  extra TEXT NOT NULL DEFAULT '{}',   -- 元素材の時刻・その時の字幕など（JSON）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_video ON notes(video_id, created_at);

-- 画面での手直し（字幕・カット）。中身は手元の planning/*-edits.json と同じ形
CREATE TABLE IF NOT EXISTS edits (
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('caption', 'cut')),
  body TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  saved_by TEXT NOT NULL,
  PRIMARY KEY (video_id, kind)
);
CREATE TABLE IF NOT EXISTS edits_history (
  video_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  saved_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS edits_history_video ON edits_history(video_id, saved_at);
