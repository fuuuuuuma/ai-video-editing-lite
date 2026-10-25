// 履歴（2026-10-25）。誰がいつ何をしたかを動画ごとに残す。揉めたときの証拠と、消した修正指示を戻すため。
// 1 回の書き込みは小さな INSERT だけ（無料の Workers の CPU 10ms に収まるように、まとめての書き出しはしない）。
import { exec, many, type D1Database } from "./db";

export type Kind = "ready" | "note" | "reply" | "done" | "reopen" | "note_deleted" | "note_restored" | "approve" | "unapprove" | "unapprove_changed"
  | "status" | "due" | "final" | "final_deleted";
/** 動画ごとに残す件数（古いものから消す） */
export const ACTIVITY_KEEP = 500;

/** 戻すための中身。切ると JSON が壊れて戻せなくなるので切らない。大きすぎるもの（1MB 超）は残さない（2026-10-25 の点検: 長い指示が「戻す」で 404 になった） */
const dataOf = (data: unknown) => {
  if (data === undefined) return null;
  const s = JSON.stringify(data);
  return s.length <= 1_000_000 ? s : null;
};

/** 履歴に 1 件残す。失敗しても本来の操作は止めない */
export async function record(db: D1Database, videoId: string, who: string | null, kind: Kind, detail = "", data?: unknown): Promise<void> {
  try {
    await exec(db, "INSERT INTO activity (video_id, at, who, kind, detail, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      videoId, Date.now(), who, kind, detail.slice(0, 300), dataOf(data));
    await exec(db, "DELETE FROM activity WHERE video_id = ?1 AND id <= (SELECT id FROM activity WHERE video_id = ?1 ORDER BY id DESC LIMIT 1 OFFSET ?2)",
      videoId, ACTIVITY_KEEP);
  } catch (e) {
    console.error(JSON.stringify({ at: "activity", video: videoId, error: String(e) }));
  }
}

export type Row = { id: number; at: number; who: string | null; who_name: string | null; kind: Kind; detail: string; data: string | null };
/** 新しい順に limit 件 */
export const activityOf = (db: D1Database, videoId: string, limit = 50) =>
  many<Row>(db, "SELECT a.id, a.at, a.who, (SELECT name FROM users WHERE email = a.who ORDER BY created_at LIMIT 1) AS who_name, a.kind, a.detail, a.data " +
    "FROM activity a WHERE a.video_id = ?1 ORDER BY a.id DESC LIMIT ?2", videoId, limit);
