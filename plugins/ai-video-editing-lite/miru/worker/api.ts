// MIRU の API（2026-10-19。2026-10-21 に誰でも自分のチャンネルを作れる形へ）。
//
// 見られる人: チャンネルに招待された人だけ。サイトの持ち主にも特別な権限は無い（他の人のチャンネルは見えない）。
//   owner  … チャンネルの管理（招待・動画と版の削除・トンマナ（kit）と強調デザインの採用を決める）
//   editor … 動画と版を上げる（2026-10-22 から）・修正指示と画面での手直し・指示への返事
//   viewer … 見るだけ
// ログインした人は誰でもチャンネルを作れる（1 人 CHANNEL_LIMIT まで）。作った人が owner になり、容量はその人に数える。
// SITE_OWNERS（メールをカンマで）を置くと、チャンネルを作れるのはその人だけ（2026-10-22。持ち主の Cloudflare で他人の分を持たない）。
// ほかの人は招待されたチャンネルだけを見る。持ち主は容量の上限・チャンネルの数・古い版の自動削除がかからない（自分の費用で使う）。
// 容量の上限は users.quota_bytes（無ければ FREE_QUOTA_BYTES）。超える版は上げられない（402）。
// 動画・画像・音は R2（v/<動画>/<版>/<鍵>）、文字のデータは D1。毎日の掃除は cleanup()（index.ts の scheduled）。

import { claimInvites, currentUser, emailKey, isSiteOwner, json, mayEnter, random, siteOwners, sha256, TOKEN_DAYS, TOKEN_PREFIX, writable, type Who } from "./auth";
import { hookKind, notify, type Waiter } from "./notify";
import { activityOf, record } from "./activity";
import { cleanDrawing, drawingHint } from "./drawing";
import { exec, many, one, type D1Database } from "./db";
import { editionOf, VERSION } from "./version";

export type R2Object = {
  body: ReadableStream; size: number; etag: string; httpEtag: string;
  range?: { offset: number; length: number };
  httpMetadata?: { contentType?: string };
  writeHttpMetadata?(h: Headers): void;
};
export type R2MultipartUpload = {
  uploadId: string; key: string;
  uploadPart(n: number, body: ReadableStream | ArrayBuffer | Uint8Array): Promise<{ partNumber: number; etag: string }>;
  complete(parts: { partNumber: number; etag: string }[]): Promise<unknown>;
  abort(): Promise<void>;
};
export type R2Bucket = {
  get(key: string, opt?: { range?: { offset: number; length?: number } | { suffix: number } }): Promise<R2Object | null>;
  head(key: string): Promise<{ size: number; httpMetadata?: { contentType?: string } } | null>;
  put(key: string, body: ReadableStream | ArrayBuffer | Uint8Array | string, opt?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
  list(opt: { prefix: string; cursor?: string; limit?: number }): Promise<{ objects: { key: string; size: number }[]; truncated: boolean; cursor?: string }>;
  createMultipartUpload(key: string, opt?: { httpMetadata?: { contentType?: string } }): Promise<R2MultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload;
};
export type AI = { run(model: string, input: unknown): Promise<unknown> };

export type Env = {
  DB: D1Database;
  MEDIA: R2Bucket;
  AI?: AI;
  AI_MODEL?: string;
  FREE_QUOTA_BYTES?: string;   // 既定 2GB
  CHANNEL_LIMIT?: string;      // 1 人が作れるチャンネルの数。既定 3
  AI_DAILY_LIMIT?: string;     // AI で整える回数（1 人 1 日）。既定 200
  SITE_OWNERS?: string;        // チャンネルを作れる人（メールをカンマで）。空なら誰でも
  CONTACT_EMAIL?: string;      // プライバシーポリシーの連絡先。空なら SITE_OWNERS の 1 人目
  MIRU_EDITION?: string;       // "light" なら MIRU ライト（視聴者が自分の Cloudflare に立てたもの。worker/version.ts）
  OWNER_QUOTA_BYTES?: string;  // 持ち主の容量の上限。空なら上限なし（ライトは Cloudflare の無料の範囲を超えないように 9GB）
  UPDATE_FEED?: string;        // 新しい版の知らせ（VERSION.json の URL）。設定の画面が読み、今の版と比べる
};

export type Role = "owner" | "editor" | "viewer";
const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };
const ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const VER_RE = /^v\d{1,4}[a-z0-9-]{0,20}$/;
const PATH_RE = /^[\w.-]+(?:\/[\w.-]+){0,4}$/;
const MAX_EDIT_BYTES = 1_500_000;
const MAX_IMAGE_BYTES = 10_000_000;
const SHA_RE = /^[0-9a-f]{64}$/;
const DAY = 86_400_000;
const TICKET_MS = 10 * 60_000;
type EditorInfo = { version: string; sha256: string; size: number; uploaded_at: number };
const intEnv = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : d);
export const limits = (env: Env) => ({
  freeQuota: intEnv(env.FREE_QUOTA_BYTES, 2 * 1024 ** 3),
  channels: intEnv(env.CHANNEL_LIMIT, 3),
  aiPerDay: intEnv(env.AI_DAILY_LIMIT, 200),
});

const owners = siteOwners;
export { isSiteOwner };
/** チャンネルを作れるか（SITE_OWNERS が空なら誰でも） */
export const canCreate = (env: Env, email: string) => !owners(env).size || isSiteOwner(env, email);
const UNLIMITED = Number.MAX_SAFE_INTEGER;

export async function roleIn(env: Env, who: Who, channelId: string): Promise<Role | null> {
  const r = await one<{ role: Role }>(env.DB, "SELECT role FROM members WHERE channel_id = ?1 AND email = ?2", channelId, who.email.toLowerCase());
  return r?.role ?? null;
}

type Video = { id: string; channel_id: string; title: string; status: string; thumb: string | null; created_at: number; updated_at: number };
const videoOf = (db: D1Database, id: string) => one<Video>(db, "SELECT * FROM videos WHERE id = ?1", id);
/** 動画と、その人のチャンネルでの役割を 1 回の問い合わせで（データベースの往復 1 回 ≒ 0.1〜0.25 秒。2026-10-24 の実測） */
const videoWithRole = (db: D1Database, id: string, who: Who) => one<Video & { role: Role | null }>(db,
  "SELECT v.*, m.role AS role FROM videos v LEFT JOIN members m ON m.channel_id = v.channel_id AND m.email = ?2 WHERE v.id = ?1", id, who.email.toLowerCase());

/** 容量: チャンネルを作った人ごとに、その人のチャンネルの版（上げ途中も含む）・共有置き場・分割アップロードの途中の合計 */
export async function usageOf(env: Env, email: string) {
  const db = env.DB;
  const u = await one<{ quota_bytes: number | null }>(db, "SELECT quota_bytes FROM users WHERE email = ?1 ORDER BY quota_bytes DESC LIMIT 1", email.toLowerCase());
  const r = await one<{ bytes: number; channels: number }>(db,
    "SELECT coalesce((SELECT sum(x.bytes) FROM versions x JOIN videos v ON v.id = x.video_id JOIN channels c ON c.id = v.channel_id WHERE c.created_by = ?1), 0) + " +
    "coalesce((SELECT sum(b.size) FROM blobs b JOIN videos v ON v.id = b.video_id JOIN channels c ON c.id = v.channel_id WHERE c.created_by = ?1), 0) + " +
    "coalesce((SELECT sum(x.bytes) FROM uploads x JOIN videos v ON v.id = x.video_id JOIN channels c ON c.id = v.channel_id WHERE c.created_by = ?1), 0) AS bytes, " +
    "(SELECT count(*) FROM channels WHERE created_by = ?1) AS channels", email.toLowerCase());
  const lim = limits(env);
  const owner = isSiteOwner(env, email);
  const ownerQuota = intEnv(env.OWNER_QUOTA_BYTES, UNLIMITED);
  return { bytes: r?.bytes ?? 0, quota: u?.quota_bytes ?? (owner ? ownerQuota : lim.freeQuota), channels: r?.channels ?? 0, channelLimit: owner ? 100 : lim.channels };
}
const creatorOf = async (db: D1Database, channelId: string) =>
  (await one<{ created_by: string | null }>(db, "SELECT created_by FROM channels WHERE id = ?1", channelId))?.created_by ?? "";
/** これから len バイト足して、作った人の上限を超えるなら 402 */
async function needRoom(env: Env, channelId: string, len: number) {
  const creator = await creatorOf(env.DB, channelId);
  const u = await usageOf(env, creator);
  if (u.bytes + len > u.quota) {
    const why = editionOf(env) === "light" && isSiteOwner(env, creator)
      ? "Cloudflare の無料の範囲（R2 は 10GB）を超えて請求されないように止めています。古い版を消して空けてください。超えた分を払ってよいなら、AI に「MIRU の容量の上限を上げて」と頼みます（setup.mjs の --owner-quota-gb）"
      : "古い版を消すか、容量を増やしてください";
    throw new HttpError(402, `容量の上限（${gb(u.quota)}）を超えます。いま ${gb(u.bytes)} 使っています。${why}`);
  }
}
const gb = (n: number) => (n < 1024 ** 3 ? `${Math.round(n / 1024 ** 2)}MB` : `${(n / 1024 ** 3).toFixed(1)}GB`);
/** 英小文字と数字だけの短い印（動画の名前がぶつかったときの後ろに付ける） */
const shortTag = (n = 5) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");

const contentType = (path: string) => {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return ({ mp4: "video/mp4", m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    webp: "image/webp", json: "application/json; charset=utf-8", flac: "audio/flac" } as Record<string, string>)[ext] ?? "application/octet-stream";
};

/** R2 のファイルを Range 付きで返す（動画の頭出しのため） */
export async function serveObject(bucket: R2Bucket, key: string, req: Request,
  heads?: Map<string, { until: number; head: { size: number; httpMetadata?: { contentType?: string } } }>): Promise<Response> {
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  // 動画の Range は 1 本で何十回も来る: 大きさと種類は短い間覚えて、保管庫に聞くのを 1 回にする
  const hit = heads?.get(key), now = Date.now();
  const head = hit && hit.until > now ? hit.head : await bucket.head(key);
  // 完成版は置き直せるので覚えない（覚えた大きさのまま新しい中身を返すと壊れる。2026-10-25）
  const fresh = key.endsWith(".json") || key.endsWith("/final.mp4");
  if (heads && head && !(hit && hit.until > now) && !fresh) { if (heads.size > 5000) heads.clear(); heads.set(key, { until: now + 60_000, head }); }
  if (!head) return new Response("ありません", { status: 404 });
  const size = head.size;
  // 置いた時の種類は TYPES に限るが、念のため返す時も確かめる。HTML などとして開かれないよう、どれも sandbox で返す
  const stored = head.httpMetadata?.contentType ?? "";
  const type = TYPES.test(stored) ? stored : contentType(key);
  // JSON（manifest.json など）は版を上げ直すと中身が変わるので、毎回確かめる（2026-10-21: 古い manifest が 1 日残り、波形と軽い再生が出なかった）
  // 完成版は置き直すと中身が変わり、1 回落とせば足りるので、ブラウザに残さず、保存（ダウンロード）として返す（2026-10-25: 置き直したのに古いものが 1 日返った）
  const final = key.endsWith("/final.mp4");
  const cache = final ? "private, no-store" : type.startsWith("application/json") ? "private, no-cache" : "private, max-age=86400";
  const h = new Headers({ "content-type": type, "accept-ranges": "bytes", "cache-control": cache,
    "content-security-policy": "default-src 'none'; media-src 'self'; img-src 'self'; sandbox", "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin" });
  if (type === "application/octet-stream" || final) h.set("content-disposition", "attachment");
  if (range && (range[1] !== "" || range[2] !== "")) {
    let start: number, end: number;
    if (range[1] === "") { const n = Math.min(size, Number(range[2])); start = size - n; end = size - 1; }
    else { start = Number(range[1]); end = range[2] === "" ? size - 1 : Math.min(size - 1, Number(range[2])); }
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    const obj = await bucket.get(key, { range: { offset: start, length: end - start + 1 } });
    if (!obj) return new Response("ありません", { status: 404 });
    h.set("content-range", `bytes ${start}-${end}/${size}`);
    h.set("content-length", String(end - start + 1));
    return new Response(req.method === "HEAD" ? null : obj.body, { status: 206, headers: h });
  }
  const obj = await bucket.get(key);
  if (!obj) return new Response("ありません", { status: 404 });
  h.set("content-length", String(size));
  return new Response(req.method === "HEAD" ? null : obj.body, { status: 200, headers: h });
}

/** 置くファイルの種類: 送り手が言う種類（動画・音・画像・JSON だけ）か、名前から */
const TYPES = /^(video\/mp4|audio\/(mp4|mpeg|wav|flac)|image\/(png|jpeg|webp)|application\/json)(;.*)?$/;
const typeOf = (req: Request, path: string) => { const t = req.headers.get("x-miru-type") ?? ""; return TYPES.test(t) ? t : contentType(path); };

const readJson = async <T>(req: Request, max = 200_000): Promise<T> => {
  const t = await req.text();
  if (t.length > max) throw new HttpError(413, "大きすぎます");
  try { return JSON.parse(t || "{}") as T; } catch { throw new HttpError(400, "JSON ではありません"); }
};
export class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

const now = () => Date.now();
const newId = () => random(9);
/** 作業用の鍵（Claude Code・Codex・上げる道具の設定に平文で置かれる）でできること（2026-10-24 セキュリティ確認）。
 *  編集の流れ（読む・上げる・指示に返事・手直し・状態・強調デザイン・トンマナ）は全部でき、漏れたときに困る操作だけを断る:
 *  消す操作全部・鍵を作る/消す・招待と役割・編集スキルの差し替え（招待した人の PC に配られる）。画面（cookie）と持ち主用の鍵はすべてできる */
export function workTokenMay(m: string, seg: string[]): boolean {
  if (m === "DELETE") return false;
  if (seg[1] === "tokens") return false;
  if (seg[1] === "channels" && seg[3] === "members" && m !== "GET") return false;
  if (seg[1] === "editor" && m === "PUT") return false;
  if (seg[1] === "channels" && seg[3] === "notify" && m !== "GET") return false;     // 通知の送り先を変える・試しに送る（2026-10-24）
  if (seg[1] === "videos" && seg[3] === "versions" && seg[5] === "approve") return false;   // 承認は人が画面で出す
  if (seg[1] === "videos" && seg[3] === "activity" && seg[5] === "restore") return false;   // 消した指示を戻すのも人が画面で（2026-10-25 の点検: 管理者が消した指示を鍵で戻せた）
  return true;
}
/** 画面での手直しの 1 件として受け取れるか。確認画面は op やコマを HTML に入れるので、形の決まった所は形を確かめる（2026-10-23） */
const EDIT_NUMS = ["frame", "old_frame", "start", "end", "old_start", "old_end"];
function editItemOk(x: Record<string, unknown>): boolean {
  if (x.op !== undefined && !(typeof x.op === "string" && /^[a-z_]{1,24}$/.test(x.op))) return false;
  return EDIT_NUMS.every((k) => x[k] === undefined || x[k] === null || (typeof x[k] === "number" && Number.isFinite(x[k])));
}

/** 再生の記録の上限（2026-10-24 の点検: 見るだけの人でも 1MB を回数の上限なく置けた）。
 *  見る人の再生を集めるためのものなので持ち主の容量には数えず、ここで抑える */
export const DIAG = { bytes: 256 * 1024, keep: 100, total: 20 * 1024 * 1024, gapMs: 10_000, days: 14 };
/** ライトは持ち主の容量（既定 9GB）を R2 の無料の 10GB に収めているので、数えない記録は小さく抑える（動画ごとに 20 件・2MB。2026-10-25） */
export const diagLimit = (env: Env) => (editionOf(env) === "light" ? { ...DIAG, keep: 20, total: 2 * 1024 * 1024 } : DIAG);
/** 再生の記録の置き場（時刻順＝名前の昇順）。cursor をたどって全部 */
async function diagKeys(env: Env, vid: string): Promise<{ key: string; size: number; uploaded: number }[]> {
  const out: { key: string; size: number; uploaded: number }[] = [];
  let cursor: string | undefined;
  do {
    const r = await env.MEDIA.list({ prefix: `v/${vid}/diag/`, cursor, limit: 1000 });
    for (const o of r.objects) out.push({ key: o.key, size: o.size, uploaded: diagTime(o.key) });
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
/** 記録の名前の頭の時刻（2026-10-23T12-44-18-217Z-…）。読めなければ 0 */
export function diagTime(key: string): number {
  const m = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(key.split("/").pop() ?? "");
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) || 0 : 0;
}
/** 新しいものから数えて、件数か合計の大きさを超えた古い記録の名前 */
export function diagOverflow(items: { key: string; size: number }[], lim: { keep: number; total: number } = DIAG): string[] {
  let n = 0, bytes = 0;
  const drop: string[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    n++; bytes += items[i].size;
    if (n > lim.keep || bytes > lim.total) drop.push(items[i].key);
  }
  return drop;
}
/** 送った人の印（メールは名前に入れない） */
async function diagTag(email: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.toLowerCase())));
  return "u" + [...h.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** 毎日の掃除: DIAG.days より前の再生の記録を消す */
export async function sweepDiag(env: Env, t = Date.now()): Promise<number> {
  let n = 0;
  for (const v of await many<{ id: string }>(env.DB, "SELECT id FROM videos")) {
    const old = (await diagKeys(env, v.id)).filter((o) => o.uploaded && o.uploaded < t - DIAG.days * DAY).map((o) => o.key);
    for (let i = 0; i < old.length; i += 1000) await env.MEDIA.delete(old.slice(i, i + 1000));
    n += old.length;
  }
  return n;
}

/** /api/* と /m/* の担当。担当でなければ null */
export async function handleApi(req: Request, env: Env, ctx?: Waiter): Promise<Response | null> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (p.startsWith("/dl/")) return download(env, p.slice(4));    // 使い捨てのリンク（ログイン不要。印そのものが鍵）
  if (!p.startsWith("/api/") && !p.startsWith("/m/")) return null;
  if (p === "/api/site") {           // ログインの前の画面が使う（連絡先・招待制か・版）
    return json({ contact: env.CONTACT_EMAIL || String(env.SITE_OWNERS ?? "").split(",")[0].trim(), invite_only: owners(env).size > 0,
      edition: editionOf(env), version: VERSION, update_feed: env.UPDATE_FEED || null });
  }
  if (p === "/api/health") {         // 回線と置き場と版の確かめ（ログイン不要。中身は返さない。導入ガイドのページからも読めるように誰にでも返す）
    const cors = { "access-control-allow-origin": "*" };
    try { await one(env.DB, "SELECT 1 AS x"); return json({ ok: true, time: new Date().toISOString(), edition: editionOf(env), version: VERSION }, 200, cors); }
    catch { return json({ ok: false, error: "データベースに届きません", edition: editionOf(env), version: VERSION }, 503, cors); }
  }
  try {
    return await route(req, env, url, p, ctx);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    const id = shortTag(8);
    console.error(JSON.stringify({ at: "api", id, method: req.method, path: p, error: String((e as Error)?.stack ?? e) }));
    return json({ error: `サーバーで問題が起きました（番号 ${id}）。しばらくしてからもう一度試してください`, id }, 500);
  }
}

// ── 動画・画像・音の道（/m/）の早道 ──
// 確認画面は 1 回の再生で何百回も取りに来る（字幕の画像・動画と音の Range）。毎回ログイン・招待・動画・権限・共有ファイルを
// データベースに順に聞くと 1 回 0.5〜1 秒かかり、再生が詰まり字幕が間に合わず、開くのも遅かった（2026-10-23 No.945、D1 は 1 回約 0.1 秒）。
// 通した結果（この印の人がこの動画を見てよい）と版ごとの共有ファイルの表を、この isolate の中で短い間だけ覚える。
// 断った結果は覚えない（招待されたらすぐ見られる）。招待を外した人が見られなくなるまでは最長 MEDIA_TTL。
const MEDIA_TTL = 60_000;
const mediaPass = new Map<string, number>();                       // `${印}|${動画}` → 期限
const mediaLinks = new Map<string, { until: number; links: Map<string, string> }>();   // `${動画}|${版}` → path → sha
const mediaHeads = new Map<string, { until: number; head: { size: number; httpMetadata?: { contentType?: string } } }>();

/** 試験で環境を作り直すとき（本番では使わない） */
export function resetMediaCache() { mediaPass.clear(); mediaLinks.clear(); mediaHeads.clear(); }

function credentialOf(req: Request): string | null {
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  // 鍵（miru_…）だけを覚える。ほかの Bearer は currentUser が見ないので、ここで覚えると cookie で通した結果をその文字列に貸してしまう
  if (bearer?.startsWith(TOKEN_PREFIX)) return "b:" + bearer;
  const c = /(?:^|;\s*)__Host-miru_s=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
  return c ? "c:" + c : null;
}
function remember<V>(m: Map<string, V>, k: string, v: V) {
  if (m.size > 5000) m.clear();
  m.set(k, v);
}
async function linksOf(db: D1Database, vid: string, ver: string): Promise<Map<string, string>> {
  const k = `${vid}|${ver}`, hit = mediaLinks.get(k), now = Date.now();
  if (hit && hit.until > now) return hit.links;
  const rows = await many<{ path: string; sha: string }>(db, "SELECT path, sha FROM links WHERE video_id = ?1 AND version = ?2", vid, ver);
  const links = new Map(rows.map((r) => [r.path, r.sha]));
  remember(mediaLinks, k, { until: now + MEDIA_TTL, links });
  return links;
}
async function serveMedia(env: Env, req: Request, vid: string, ver: string, path: string): Promise<Response> {
  const sha = (await linksOf(env.DB, vid, ver)).get(path);
  return serveObject(env.MEDIA, sha ? `v/${vid}/b/${sha}` : `v/${vid}/${ver}/${path}`, req, mediaHeads);
}

async function route(req: Request, env: Env, url: URL, p: string, ctx?: Waiter): Promise<Response> {
  const db = env.DB;
  if (p.startsWith("/m/")) {
    const cred = credentialOf(req), seg = p.split("/").filter(Boolean).map(decodeURIComponent);
    const [, vid, ver, ...rest] = seg, path = rest.join("/");
    if (cred && vid && ver && VER_RE.test(ver) && PATH_RE.test(path) && (req.method === "GET" || req.method === "HEAD")
        && (mediaPass.get(`${cred}|${vid}`) ?? 0) > Date.now()) return serveMedia(env, req, vid, ver, path);
  }
  const who = await currentUser(req, db);
  // 完全招待制: 招待されていない人（招待を全部外された人も）のログインの印と鍵は消して、ログインしていない扱いにする
  if (who && !(await mayEnter(env, db, who.email))) {
    await exec(db, "DELETE FROM sessions WHERE user_id = ?1", who.id);
    await exec(db, "DELETE FROM tokens WHERE user_id = ?1", who.id);
    const gone = { "set-cookie": "__Host-miru_s=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" };
    return p === "/api/me" ? json({ user: null, denied: true }, 401, gone) : json({ error: "このサイトは招待された人だけが使えます", denied: true }, 401, gone);
  }
  if (p === "/api/me") {
    if (!who) return json({ user: null }, 401);
    await claimInvites(db, who.email);   // ログインしたままの人にも、書き方の違う招待を届ける
    return json({ user: { id: who.id, email: who.email, name: who.name, picture: who.picture }, usage: await usageOf(env, who.email), channels: await channelsFor(env, who),
      site: { can_create: canCreate(env, who.email), invite_only: owners(env).size > 0, edition: editionOf(env), version: VERSION, update_feed: env.UPDATE_FEED || null } });
  }
  if (!who) return json({ error: "ログインしてください" }, 401);
  const m = req.method;
  if (m !== "GET" && m !== "HEAD" && !writable(req, who)) return json({ error: "この画面からだけ" }, 403);
  const seg = p.split("/").filter(Boolean).map(decodeURIComponent);   // ["api", ...] / ["m", ...]
  if (who.via === "token" && who.scope !== "admin" && !workTokenMay(m, seg)) {
    return json({ error: "この鍵ではできません。MIRU の画面から操作してください（作業用の鍵では、消す・招待する・鍵を作る・編集スキルを置く・通知の送り先を変える・承認することはできません）" }, 403);
  }

  // ── 動画・画像・音（招待された人だけ） ──
  if (seg[0] === "m") {
    const [, vid, ver, ...rest] = seg;
    const path = rest.join("/");
    if (!vid || !ver || !VER_RE.test(ver) || !PATH_RE.test(path)) return json({ error: "ありません" }, 404);
    const v = await videoWithRole(db, vid, who);
    if (!v || !v.role) return json({ error: "ありません" }, 404);
    const cred = credentialOf(req);
    if (cred) remember(mediaPass, `${cred}|${vid}`, Date.now() + MEDIA_TTL);
    // 版をまたいで共有しているファイルなら、動画ごとの置き場から返す（serveMedia）
    return serveMedia(env, req, vid, ver, path);
  }

  // ── 鍵（Claude Code・書き出しの道具） ──
  if (seg[1] === "tokens") {
    if (who.via !== "cookie") return json({ error: "鍵は画面から作ってください" }, 403);
    if (m === "GET") return json({ tokens: await many(db, "SELECT substr(hash, 1, 8) AS id, label, scope, created_at, last_used_at, expires_at FROM tokens WHERE user_id = ?1 ORDER BY created_at DESC", who.id) });
    if (m === "POST") {
      const body = await readJson<{ label?: string; scope?: string }>(req);
      // 持ち主用の鍵は、個人用 MIRU のサイトの持ち主だけ（編集スキルを配る editor-publish のため）。ライトには配る道が無いので作らない
      const scope = body.scope === "admin" ? "admin" : "work";
      if (scope === "admin" && (editionOf(env) === "light" || !isSiteOwner(env, who.email))) return json({ error: "持ち主用の鍵は、サイトの持ち主だけが作れます" }, 403);
      const label = String(body.label ?? "Claude Code").slice(0, 60) || "Claude Code";
      const n = await one<{ n: number }>(db, "SELECT count(*) AS n FROM tokens WHERE user_id = ?1", who.id);
      if ((n?.n ?? 0) >= 10) return json({ error: "鍵は 10 本までです" }, 400);
      const token = TOKEN_PREFIX + random(32);
      const expires = now() + TOKEN_DAYS * DAY;
      await exec(db, "INSERT INTO tokens (hash, user_id, label, created_at, expires_at, scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6)", await sha256(token), who.id, label, now(), expires, scope);
      return json({ token, label, scope, expires_at: expires });
    }
    if (m === "DELETE" && seg[2]) {
      const ch = await exec(db, "DELETE FROM tokens WHERE user_id = ?1 AND substr(hash, 1, 8) = ?2", who.id, seg[2]);
      return json({ ok: ch > 0 });
    }
  }

  // ── MIRU AI動画編集（編集スキル）を配る（2026-10-22）──
  // 置くのはサイトの持ち主だけ（miru_sync.py editor-publish）。取るのは入れる人なら誰でも: MCP の install_editor が
  // 10 分だけ使えるリンク（/dl/…）を作り、AI がそれで zip を取って自分の PC に入れる（鍵を AI に見せずに済む）
  if (seg[1] === "editor") {
    // MIRU ライトの編集は AI動画編集 lite（GitHub から入れる）。サイトから配る道を開けておくと、漏れた鍵で差し替えられるだけなので閉じる
    if (editionOf(env) === "light") return json({ error: "MIRU ライトでは編集スキルを配りません（AI動画編集 lite を使います）" }, 404);
    const latest = async () => { const o = await env.MEDIA.get("editor/latest.json"); return o ? JSON.parse(await new Response(o.body).text()) as EditorInfo : null; };
    if (!seg[2] && m === "GET") { const l = await latest(); return l ? json(l) : json({ error: "MIRU AI動画編集はまだ置かれていません" }, 404); }
    if (seg[2] === "ticket" && m === "POST") {
      const l = await latest();
      if (!l) return json({ error: "MIRU AI動画編集がまだサイトに置かれていません（サイトの持ち主が miru_sync.py editor-publish で置きます）" }, 404);
      const t = random(24);
      await exec(db, "INSERT INTO tickets (hash, kind, user_id, ref, expires_at) VALUES (?1, 'editor', ?2, ?3, ?4)", await sha256(t), who.id, l.version, now() + TICKET_MS);
      return json({ ...l, url: `${url.origin}/dl/${t}`, expires_in: TICKET_MS / 1000 });
    }
    if (seg[2] && seg[2] !== "ticket" && m === "PUT") {
      if (!isSiteOwner(env, who.email)) return json({ error: "置けるのはサイトの持ち主だけです" }, 403);
      const ver = seg[2];
      if (!/^\d{1,3}\.\d{1,3}\.\d{1,4}$/.test(ver)) return json({ error: "版は 0.1.0 の形で" }, 400);
      const data = new Uint8Array(await req.arrayBuffer());
      if (!data.byteLength || data.byteLength > 50_000_000) return json({ error: "50MB までの zip を置いてください" }, 413);
      if (data[0] !== 0x50 || data[1] !== 0x4b) return json({ error: "zip ではありません" }, 400);
      const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), (b) => b.toString(16).padStart(2, "0")).join("");
      await env.MEDIA.put(`editor/${ver}.zip`, data, { httpMetadata: { contentType: "application/zip" } });
      const info: EditorInfo = { version: ver, sha256: sha, size: data.byteLength, uploaded_at: now() };
      await env.MEDIA.put("editor/latest.json", JSON.stringify(info), { httpMetadata: { contentType: "application/json" } });
      return json(info);
    }
  }

  // ── チャンネル ──
  if (seg[1] === "channels") {
    const cid = seg[2];
    if (!cid) {
      if (m === "GET") return json({ channels: await channelsFor(env, who) });
      if (m === "POST") {              // ログインした人は誰でも作れる。作った人が管理者
        const b = await readJson<{ id?: string; name?: string; color?: string }>(req);
        const id = String(b.id ?? "").toLowerCase();
        if (!ID_RE.test(id)) return json({ error: "名前（英小文字・数字・-）が使えません" }, 400);
        const name = String(b.name ?? "").trim().slice(0, 80);
        if (!name) return json({ error: "チャンネル名を入れてください" }, 400);
        const color = /^#[0-9a-f]{6}$/i.test(String(b.color)) ? String(b.color) : "#0a84ff";
        if (await one(db, "SELECT 1 AS x FROM channels WHERE id = ?1", id)) {
          // 自分が管理者のチャンネルなら名前と色を変えるだけ。他の人のものは上書きしない
          if ((await roleIn(env, who, id)) !== "owner") return json({ error: "その名前はもう使われています。別の名前にしてください" }, 409);
          await exec(db, "UPDATE channels SET name = ?2, color = ?3 WHERE id = ?1", id, name, color);
          return json({ ok: true, id });
        }
        if (!canCreate(env, who.email)) return json({ error: "このサイトでは、招待されたチャンネルだけを見られます。自分の動画を載せるなら、自分の MIRU を立ててください" }, 403);
        const u = await usageOf(env, who.email);
        if (u.channels >= u.channelLimit) return json({ error: `チャンネルは 1 人 ${u.channelLimit} つまでです` }, 400);
        const t = now(), email = who.email.toLowerCase();
        await db.batch([
          db.prepare("INSERT INTO channels (id, name, color, created_at, created_by) VALUES (?1, ?2, ?3, ?4, ?5)").bind(id, name, color, t, email),
          db.prepare("INSERT INTO members (channel_id, email, role, invited_by, created_at) VALUES (?1, ?2, 'owner', ?2, ?3)").bind(id, email, t),
        ]);
        return json({ ok: true, id });
      }
    }
    const role = await roleIn(env, who, cid);
    const ch = role ? await one<{ id: string; name: string; color: string }>(db, "SELECT id, name, color FROM channels WHERE id = ?1", cid) : null;
    if (!role || !ch) return json({ error: "ありません" }, 404);      // 無いのと見られないのは同じ答え
    if (!seg[3] && m === "DELETE") {   // チャンネルごと消す（動画・版・見本の絵も）
      if (role !== "owner") return json({ error: "管理者だけができます" }, 403);
      for (const v of await many<{ id: string }>(db, "SELECT id FROM videos WHERE channel_id = ?1", cid)) await deletePrefix(env.MEDIA, `v/${v.id}/`);
      await deletePrefix(env.MEDIA, `c/${cid}/`);
      await exec(db, "DELETE FROM channels WHERE id = ?1", cid);
      return json({ ok: true });
    }

    // 通知の送り先（Slack・Discord の Incoming Webhook）。管理者だけが見る・変える。送り先そのものは返さない
    if (seg[3] === "notify") {
      if (role !== "owner") return json({ error: "管理者だけができます" }, 403);
      const cur = await one<{ notify_url: string | null }>(db, "SELECT notify_url FROM channels WHERE id = ?1", cid);
      const shown = () => cur?.notify_url ? { set: true, kind: hookKind(cur.notify_url), tail: cur.notify_url.slice(-4) } : { set: false };
      if (!seg[4] && m === "GET") return json(shown());
      if (!seg[4] && m === "PUT") {
        const b = await readJson<{ url?: string }>(req);
        const u = String(b.url ?? "").trim();
        if (u && !hookKind(u)) return json({ error: "Slack か Discord の Incoming Webhook の URL（https://hooks.slack.com/services/… か https://discord.com/api/webhooks/…）を入れてください" }, 400);
        await exec(db, "UPDATE channels SET notify_url = ?2 WHERE id = ?1", cid, u || null);
        return json(u ? { set: true, kind: hookKind(u), tail: u.slice(-4) } : { set: false });
      }
      if (seg[4] === "test" && m === "POST") {
        if (!cur?.notify_url) return json({ error: "送り先がまだありません" }, 400);
        // 相手に断られたら、そう返す（2026-10-25。消されたウェブフックでも「送りました」と出ていた）
        const r = await notify(db, ctx, cid, "MIRU からの通知の試しです");
        if (!r.ok) return json({ error: `送れませんでした${r.status ? `（${r.status}）` : ""}。Slack・Discord でウェブフックを作り直し、新しい URL を保存し直してください` }, 502);
        return json({ ok: true });
      }
      return json({ error: "ありません" }, 404);
    }

    if (seg[3] === "members") {
      const self = who.email.toLowerCase();
      // 抜けるのは誰でもできる（最後の管理者を除く）
      if (m === "DELETE" && seg[4] && seg[4].toLowerCase() === self && role !== "owner") {
        await exec(db, "DELETE FROM members WHERE channel_id = ?1 AND email = ?2", cid, self);
        return json({ ok: true, members: [] });
      }
      // 招待した人の一覧（メール）は管理者だけが見られる
      if (RANK[role] < RANK.owner) return m === "GET" ? json({ members: [], role }) : json({ error: "招待できるのは管理者だけです" }, 403);
      if (m === "GET") return json({ members: await members(db, cid), role });
      const owners = async () => (await one<{ n: number }>(db, "SELECT count(*) AS n FROM members WHERE channel_id = ?1 AND role = 'owner'", cid))?.n ?? 0;
      const roleOf = async (email: string) => (await one<{ role: Role }>(db, "SELECT role FROM members WHERE channel_id = ?1 AND email = ?2", cid, email))?.role;
      // チャンネルを作った人（容量はこの人に数える）は、本人のほかが外したり役割を下げたりできない（2026-10-25）
      const creator = (await creatorOf(db, cid)).toLowerCase();
      const touchesCreator = (email: string) => !!creator && emailKey(email) === emailKey(creator) && emailKey(email) !== emailKey(self);
      if (m === "POST") {
        const b = await readJson<{ email?: string; role?: Role }>(req);
        let email = String(b.email ?? "").trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return json({ error: "メールアドレスが正しくありません" }, 400);
        // Gmail は書き方（点・+・googlemail.com）が違っても同じ受け箱。ログインしたことのある人のメールか、もう招待している行にそろえる
        if (/@(gmail|googlemail)\.com$/.test(email)) {
          const key = emailKey(email);
          const known = await many<{ email: string }>(db,
            "SELECT email FROM users WHERE email LIKE '%@gmail.com' OR email LIKE '%@googlemail.com' " +
            "UNION ALL SELECT email FROM members WHERE channel_id = ?1 AND (email LIKE '%@gmail.com' OR email LIKE '%@googlemail.com')", cid);
          email = known.find((k) => emailKey(k.email) === key)?.email ?? email;
        }
        const r: Role = b.role === "owner" || b.role === "editor" ? b.role : "viewer";
        if (r !== "owner" && touchesCreator(email)) return json({ error: "チャンネルを作った人の役割は変えられません" }, 403);
        const n = await one<{ n: number }>(db, "SELECT count(*) AS n FROM members WHERE channel_id = ?1", cid);
        if ((n?.n ?? 0) >= 50 && !(await roleOf(email))) return json({ error: "招待は 1 チャンネル 50 人までです" }, 400);
        if (r !== "owner" && (await roleOf(email)) === "owner" && (await owners()) <= 1) return json({ error: "管理者が 1 人もいなくなります。先に別の人を管理者にしてください" }, 400);
        await exec(db, "INSERT INTO members (channel_id, email, role, invited_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(channel_id, email) DO UPDATE SET role = ?3",
          cid, email, r, who.email, now());
        return json({ ok: true, members: await members(db, cid) });
      }
      if (m === "DELETE" && seg[4]) {
        const email = seg[4].toLowerCase();
        if (touchesCreator(email)) return json({ error: "チャンネルを作った人は外せません" }, 403);
        if ((await roleOf(email)) === "owner" && (await owners()) <= 1) return json({ error: "管理者が 1 人もいなくなります。先に別の人を管理者にしてください" }, 400);
        await exec(db, "DELETE FROM members WHERE channel_id = ?1 AND email = ?2", cid, email);
        return json({ ok: true, members: await members(db, cid) });
      }
    }
    if (seg[3] === "videos") {
      if (m === "GET") return json({ channel: ch, role, videos: await videosOf(db, cid) });
      if (m === "POST") {
        if (RANK[role] < RANK.editor) return json({ error: "動画を足せるのは「指示できる」以上の人だけです" }, 403);
        const b = await readJson<{ id?: string; title?: string }>(req);
        const id = String(b.id ?? "").toLowerCase();
        if (!ID_RE.test(id)) return json({ error: "動画の名前（英小文字・数字・-）が使えません" }, 400);
        const title = String(b.title ?? id).trim().slice(0, 160) || id;
        const other = await videoOf(db, id);
        if (other && other.channel_id === cid) {
          await exec(db, "UPDATE videos SET title = ?2, updated_at = ?3 WHERE id = ?1", id, title, now());
          return json({ ok: true, id, renamed: false });
        }
        // 名前が別のチャンネルとぶつかったら、後ろに印を付けた名前で作る（どのチャンネルのものかは教えない）。道具は返った id を使う
        let vid = id;
        for (let i = 0; other && i < 5; i++) {
          vid = `${id.slice(0, 73)}-${shortTag()}`;
          if (!(await videoOf(db, vid))) break;
        }
        const n = await one<{ n: number }>(db, "SELECT count(*) AS n FROM videos WHERE channel_id = ?1", cid);
        if ((n?.n ?? 0) >= 500) return json({ error: "動画は 1 チャンネル 500 本までです" }, 400);
        await exec(db, "INSERT INTO videos (id, channel_id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)", vid, cid, title, now());
        return json({ ok: true, id: vid, renamed: vid !== id });
      }
    }
    // 強調デザインの一覧（採用・不採用はサイトが正。決めるのは管理者）
    if (seg[3] === "designs") {
      const did = seg[4];
      if (!did && m === "GET") return json({ channel: ch, role, ...(await designsOf(db, cid, role === "owner")) });
      if (!did && m === "PUT") {          // スキル（miru_sync.py designs-push）が役割とデザインを上げる。決めた状態は上書きしない
        if (RANK[role] < RANK.owner) return json({ error: "管理者だけができます" }, 403);
        const b = await readJson<{ roles?: Record<string, unknown>[]; designs?: Record<string, unknown>[] }>(req, 1_000_000);
        const t = now(), stmts = [];
        for (const [i, r] of (b.roles ?? []).slice(0, 100).entries()) {
          if (typeof r.role !== "string" || !r.role) continue;
          stmts.push(db.prepare("INSERT INTO design_roles (channel_id, role, label, when_text, avoid, sort) VALUES (?1, ?2, ?3, ?4, ?5, ?6) " +
            "ON CONFLICT(channel_id, role) DO UPDATE SET label = ?3, when_text = ?4, avoid = ?5, sort = ?6")
            .bind(cid, r.role.slice(0, 60), String(r.label ?? r.role).slice(0, 80), String(r.when ?? "").slice(0, 400), String(r.avoid ?? "").slice(0, 400), i));
        }
        for (const [i, d] of (b.designs ?? []).slice(0, 500).entries()) {
          if (typeof d.id !== "string" || !/^[\w-]{1,40}$/.test(d.id) || typeof d.role !== "string") continue;
          const st = ["open", "adopt", "reject"].includes(String(d.status)) ? String(d.status) : "open";
          stmts.push(db.prepare("INSERT INTO designs (channel_id, id, role, name, style, status, memo, sort, decided_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) " +
            "ON CONFLICT(channel_id, id) DO UPDATE SET role = ?3, name = ?4, style = ?5, sort = ?8, updated_at = ?10")
            .bind(cid, d.id, d.role.slice(0, 60), String(d.name ?? d.id).slice(0, 80), JSON.stringify(d.style ?? {}).slice(0, 8000), st,
              String(d.memo ?? "").slice(0, 1000), i, st === "open" ? null : t, t));
        }
        if (stmts.length) await db.batch(stmts);
        return json({ ok: true, ...(await designsOf(db, cid, role === "owner")) });
      }
      if (did && seg[5] === "image") {
        const key = `c/${cid}/designs/${did.replace(/[^\w-]/g, "")}.jpg`;
        if (m === "GET") return serveObject(env.MEDIA, key, req);
        if (m === "PUT") {
          if (RANK[role] < RANK.owner) return json({ error: "管理者だけができます" }, 403);
          // 見本は容量に数えないので、デザインにある名前だけ・ライトは 1MB まで（2026-10-25 の点検: 無い名前でいくらでも置けた）
          if (!(await one(db, "SELECT 1 AS x FROM designs WHERE channel_id = ?1 AND id = ?2", cid, did))) return json({ error: "そのデザインはありません" }, 404);
          const maxImg = editionOf(env) === "light" ? 1_000_000 : MAX_IMAGE_BYTES;
          if (Number(req.headers.get("content-length") ?? 0) > maxImg) return json({ error: `画像が大きすぎます（${maxImg === MAX_IMAGE_BYTES ? "10MB" : "1MB"} まで）` }, 413);
          await env.MEDIA.put(key, req.body ?? new Uint8Array(), { httpMetadata: { contentType: "image/jpeg" } });
          await exec(db, "UPDATE designs SET image = ?3, updated_at = ?4 WHERE channel_id = ?1 AND id = ?2", cid, did, key, now());
          return json({ ok: true });
        }
      }
      if (did && !seg[5] && m === "PATCH") {
        if (RANK[role] < RANK.owner) return json({ error: "採用・不採用を決められるのは管理者だけです" }, 403);
        const d = await one<{ status: string; memo: string }>(db, "SELECT status, memo FROM designs WHERE channel_id = ?1 AND id = ?2", cid, did);
        if (!d) return json({ error: "ありません" }, 404);
        const b = await readJson<{ status?: string; memo?: string }>(req);
        const st = ["open", "adopt", "reject"].includes(String(b.status)) ? String(b.status) : d.status;
        const memo = b.memo === undefined ? d.memo : String(b.memo).slice(0, 1000);
        await exec(db, "UPDATE designs SET status = ?3, memo = ?4, decided_at = ?5, decided_by = ?6, updated_at = ?5 WHERE channel_id = ?1 AND id = ?2",
          cid, did, st, memo, now(), who.email);
        return json({ ok: true, ...(await designsOf(db, cid, role === "owner")) });
      }
    }
    // トンマナ（編集スキルのチャンネルの記憶）。編集の前に読み、同じように編集する。決める・変えるのは管理者
    if (seg[3] === "kit") {
      if (m === "GET") {
        const k = await one<{ body: string; updated_at: number; updated_by: string }>(db, "SELECT body, updated_at, updated_by FROM channel_kits WHERE channel_id = ?1", cid);
        return json({ channel: ch, role, kit: k ? JSON.parse(k.body) : null, updated_at: k?.updated_at ?? null, updated_by: k ? personOf(k.updated_by, await nameOf(db, k.updated_by), role === "owner") : null });
      }
      if (m === "PUT") {
        if (RANK[role] < RANK.owner) return json({ error: "トンマナを変えられるのは管理者だけです" }, 403);
        const b = await readJson<{ kit?: unknown }>(req, 500_000);
        if (!b.kit || typeof b.kit !== "object" || Array.isArray(b.kit)) return json({ error: "kit（JSON のオブジェクト）が要ります" }, 400);
        const body = JSON.stringify(b.kit), t = now();
        await db.batch([
          db.prepare("INSERT INTO channel_kits (channel_id, body, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4) " +
            "ON CONFLICT(channel_id) DO UPDATE SET body = ?2, updated_at = ?3, updated_by = ?4").bind(cid, body, t, who.email),
          db.prepare("INSERT INTO channel_kits_history (channel_id, body, saved_at, saved_by) VALUES (?1, ?2, ?3, ?4)").bind(cid, body, t, who.email),
        ]);
        return json({ ok: true, updated_at: t });
      }
    }
    if (!seg[3] && m === "GET") return json({ channel: ch, role });
  }

  // ── 動画 ──
  if (seg[1] === "videos" && seg[2]) {
    const v = await videoWithRole(db, seg[2], who);
    const role = v?.role ?? null;
    if (!v || !role) return json({ error: "ありません" }, 404);      // 無いのと見られないのは同じ答え
    const sub = seg[3];
    const need = (r: Role) => { if (RANK[role] < RANK[r]) throw new HttpError(403, r === "owner" ? "管理者だけができます" : "見るだけの権限です"); };
    const strong = who.via === "cookie" || who.scope === "admin";     // 画面か、持ち主用の鍵（作業用の鍵ではない）

    if (!sub) {
      if (m === "GET") {       // 版と未対応の数は並べて聞く（往復を 1 回分にする）
        const [versions, open, act] = await Promise.all([versionsOf(db, v.id, role === "owner"), openNotes(db, v.id), activityOf(db, v.id, 30)]);
        // 完成版（承認した版に置いた final.mp4）。承認のある版だけ見に行く
        const final = await Promise.all(versions.filter((x) => x.approved_at).map(async (x) => {
          const h = await env.MEDIA.head(`v/${v.id}/${x.name}/final.mp4`);
          return h ? { version: x.name as string, size: h.size } : null;
        }));
        const activity = act.map(({ who: w, who_name, data, ...a }) => ({ ...a, who: personOf(w, who_name, role === "owner"), restorable: a.kind === "note_deleted" && !!data }));
        return json({ video: v, role, versions, openNotes: open, activity, final: final.filter(Boolean) });
      }
      if (m === "PATCH") {
        need("editor");
        const b = await readJson<{ title?: string; status?: string; due?: string | null }>(req);
        const title = b.title === undefined ? v.title : String(b.title).trim().slice(0, 160) || v.title;
        const status = ["editing", "review", "fixing", "done"].includes(String(b.status)) ? String(b.status) : v.status;
        // 期限は日本の日付（YYYY-MM-DD）。null で外す
        let due = (v as { due_at?: number | null }).due_at ?? null;
        if (b.due === null || b.due === "") due = null;
        else if (b.due !== undefined) {
          // 本当にある日付で、2000〜2099 年だけ（2026-10-25 の点検: 2026-02-30 が 3/2 として入り、6 桁の年も来た）
          const at = Date.parse(`${b.due}T00:00:00+09:00`);
          if (!/^20\d{2}-\d{2}-\d{2}$/.test(String(b.due)) || !Number.isFinite(at) || new Date(at + 9 * 3600_000).toISOString().slice(0, 10) !== b.due) {
            return json({ error: "期限は 2026-11-01 の形で、2000〜2099 年の本当にある日付を入れてください" }, 400);
          }
          due = Date.parse(`${b.due}T00:00:00+09:00`);
        }
        await exec(db, "UPDATE videos SET title = ?2, status = ?3, due_at = ?4, updated_at = ?5 WHERE id = ?1", v.id, title, status, due, now());
        if (status !== v.status) await record(db, v.id, who.email, "status", status);
        if (due !== ((v as { due_at?: number | null }).due_at ?? null)) await record(db, v.id, who.email, "due", due ? String(b.due) : "");
        return json({ ok: true });
      }
      if (m === "DELETE") {
        need("owner");
        await deletePrefix(env.MEDIA, `v/${v.id}/`);
        await exec(db, "DELETE FROM videos WHERE id = ?1", v.id);
        return json({ ok: true });
      }
    }

    // 版（プレビュー）。書き出しの道具が作り、ファイルを上げ、最後に ready にする
    if (sub === "versions") {
      const ver = seg[4];
      if (!ver) {
        if (m === "GET") return json({ versions: await versionsOf(db, v.id, role === "owner") });
        if (m === "POST") {
          need("editor");
          const b = await readJson<{ name?: string; frames?: number; fps?: number; note?: string; bytes?: number }>(req);
          const name = String(b.name ?? "");
          if (!VER_RE.test(name)) return json({ error: "版の名前（v10 など）が使えません" }, 400);
          const frames = Math.max(1, Math.floor(Number(b.frames)) || 0), fps = Number(b.fps) || 30;
          // 上げ終わった版を作り直すと見えなくなる。消すのと同じなので、管理者が画面か持ち主用の鍵でするときだけ（2026-10-23。
          // 2026-10-25: 作業用の鍵も断る。鍵が漏れても版を消されないように）。作り直すときは置いた量を数え直さず、作った時刻を今にする
          const cur = await one<{ ready: number }>(db, "SELECT ready FROM versions WHERE video_id = ?1 AND name = ?2", v.id, name);
          if (cur?.ready && !(role === "owner" && strong)) {
            // ライトには持ち主用の鍵が無いので、画面で消す案内だけにする
            const how = editionOf(env) === "light" ? "同じ名前にしたいときは、管理者が MIRU の画面でこの版を消してから" : "上げ直せるのは、管理者が MIRU の画面か持ち主用の鍵でするときだけです";
            return json({ error: `${name} はもう上げ終わっています。別の版の名前（${name}-2 など）で上げてください（${how}）` }, 409);
          }
          await needRoom(env, v.channel_id, Math.max(0, Number(b.bytes) || 0));
          // 上げ直しは作った時刻も今にする（古いままだと、上げている途中に毎日の掃除が「2日たっても上がらない版」として消した。2026-10-24 の点検）
          await exec(db, "INSERT INTO versions (video_id, name, frames, fps, ready, note, created_at) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6) " +
            // 置いた量（bytes）は 0 に戻さない（中のファイルは R2 に残っていて容量を使っている。2026-10-25 の点検）
            "ON CONFLICT(video_id, name) DO UPDATE SET frames = ?3, fps = ?4, ready = 0, note = ?5, created_at = ?6, approved_by = NULL, approved_at = NULL", v.id, name, frames, fps, String(b.note ?? "").slice(0, 500), now());
          return json({ ok: true });
        }
      }
      if (!VER_RE.test(ver)) return json({ error: "版の名前が使えません" }, 400);
      const verRow = await one<{ name: string; ready: number; approved_at: number | null }>(db, "SELECT name, ready, approved_at FROM versions WHERE video_id = ?1 AND name = ?2", v.id, ver);
      if (!verRow) return json({ error: "その版はありません" }, 404);
      // 上げ終わった版は、字幕の見た目と書体（miru_sync.py style）のほかは変えない（2026-10-25。上書きされると元に戻せない）。
      // 変えられるのは管理者が画面か持ち主用の鍵でするときだけ
      const sealed = !!verRow.ready && !(role === "owner" && strong);
      const styleOnly = (path: string) => path === "caption-style.json" || path.startsWith("fonts/");
      // 完成版（final.mp4）は、承認された版にだけ置ける。置いても承認は外さない（2026-10-25。書き出した MP4 を相手に渡すため）
      const isFinal = (path: string) => path === "final.mp4";
      const putPath = seg[5] === "files" ? seg.slice(6).join("/") : seg[5] === "mpu" ? url.searchParams.get("path") ?? "" : "";
      if (isFinal(putPath) && !verRow.approved_at && !(seg[5] === "mpu" && seg[7] === "abort")) {
        return json({ error: `${ver} はまだ承認されていません。完成版は承認された版にだけ置けます` }, 409);
      }
      const refuseSealed = () => json({ error: `${ver} はもう上げ終わっています。変えるときは別の版の名前で上げてください` }, 409);
      // 承認された版は、作業用の鍵では完成版のほかは変えない（2026-10-25。字幕の見た目を置き直すと承認が外れ、鍵が漏れると OK を消せた）
      const frozen = !!verRow.approved_at && !(role === "owner" && strong);
      const refuseApproved = () => json({ error: `${ver} は承認されています。変えるときは新しい版で上げてください（承認を取り消すと、置いた完成版も消えます）` }, 409);
      const base = `v/${v.id}/${ver}/`;
      const op = seg[5];
      // 完成版を置き直すときは、前の完成版の大きさを引いて数える（2026-10-25。足すだけだと数 GB が二重に数えられ、ライトの 9GB にすぐ届いた）
      const finalSize = async () => (await env.MEDIA.head(base + "final.mp4"))?.size ?? 0;
      const shiftBytes = (delta: number) => exec(db, "UPDATE versions SET bytes = max(0, bytes + ?3) WHERE video_id = ?1 AND name = ?2", v.id, ver, Math.floor(delta));
      /** 完成版を消して容量を戻す。消したら true */
      const dropFinal = async () => {
        const h = await env.MEDIA.head(base + "final.mp4");
        if (!h) return false;
        await env.MEDIA.delete(base + "final.mp4");
        await shiftBytes(-h.size);
        await record(db, v.id, who.email, "final_deleted", ver);
        return true;
      };
      // 承認のあとに見られる版の中身（字幕の見た目など）を変えたら、承認を外して知らせる（2026-10-25。外さないと、変わる前の OK が残った）。
      // 完成版も一緒に消す（承認の無い版の完成版は画面に出ず、容量だけを使い、承認し直すと古いものが出てきた）
      const unapprove = async () => {
        if (!verRow.ready) return;
        if (!(await exec(db, "UPDATE versions SET approved_by = NULL, approved_at = NULL WHERE video_id = ?1 AND name = ?2 AND approved_at IS NOT NULL", v.id, ver))) return;
        await exec(db, "UPDATE videos SET status = 'review', updated_at = ?2 WHERE id = ?1 AND status = 'done'", v.id, now());
        await record(db, v.id, who.email, "unapprove_changed", ver);
        const gone = await dropFinal();
        void notify(db, ctx, v.channel_id, `「${v.title}」の ${ver} の中身（字幕の見た目など）が変わったので、承認${gone ? "と完成版" : ""}を外しました ${url.origin}/v/${encodeURIComponent(v.id)}?ver=${encodeURIComponent(ver)}`);
      };
      // 置いてある完成版を、作業用の鍵では置き換えない（2026-10-25。鍵が漏れると、相手が受け取る MP4 を差し替えられた）
      const workKey = who.via === "token" && who.scope !== "admin";
      const finalTaken = () => json({ error: `${ver} の完成版はもう置いてあります。置き直すときは、MIRU の画面で前の完成版を消してから渡してください` }, 409);
      const finalPlaced = () => void notify(db, ctx, v.channel_id, `「${v.title}」の ${ver} の完成版を置きました。MIRU のホームで動画を押すと、ダウンロードできます ${url.origin}/`);
      if (op === "files") {                       // 1 つのファイルを置く（95MB まで）
        need("editor");
        const path = seg.slice(6).join("/");
        if (m !== "PUT" || !PATH_RE.test(path)) return json({ error: "置けません" }, 400);
        if (frozen && !isFinal(path)) return refuseApproved();
        if (sealed && !styleOnly(path) && !isFinal(path)) return refuseSealed();
        const len = Number(req.headers.get("content-length") ?? NaN);
        if (!Number.isFinite(len)) return json({ error: "content-length が要ります" }, 411);
        if (len > 95_000_000) return json({ error: "95MB を超えるものは分けて上げてください（mpu）" }, 413);
        const old = isFinal(path) ? await finalSize() : 0;
        if (isFinal(path) && old && workKey) return finalTaken();
        await needRoom(env, v.channel_id, Math.max(0, len - old));
        await env.MEDIA.put(base + path, req.body ?? new Uint8Array(), { httpMetadata: { contentType: typeOf(req, path) } });
        if (isFinal(path)) { await shiftBytes(len - old); await record(db, v.id, who.email, "final", ver); finalPlaced(); }
        else { await addBytes(db, v.id, ver, len); await unapprove(); }
        return json({ ok: true, path });
      }
      // 完成版だけを消す（管理者だけ。2026-10-25。渡し終えたら容量を空けられるように。確認用の動画は残す）
      if (op === "final" && m === "DELETE") {
        need("owner");
        const size = await finalSize();
        if (!(await dropFinal())) return json({ error: "完成版がありません" }, 404);
        return json({ ok: true, freed: size });
      }
      if (op === "mpu") {                         // 大きいファイルを分けて上げる
        need("editor");
        const path = url.searchParams.get("path") ?? "";
        if (!PATH_RE.test(path)) return json({ error: "名前が使えません" }, 400);
        const id = seg[6];
        if (frozen && !isFinal(path) && seg[7] !== "abort") return refuseApproved();
        if (sealed && !styleOnly(path) && !isFinal(path) && seg[7] !== "abort") return refuseSealed();
        if (!id && m === "POST") {
          const t = url.searchParams.get("type") ?? "";
          const old = isFinal(path) ? await finalSize() : 0;
          if (old && workKey) return finalTaken();
          await needRoom(env, v.channel_id, Math.max(0, (Number(url.searchParams.get("size")) || 0) - old));
          const up = await env.MEDIA.createMultipartUpload(base + path, { httpMetadata: { contentType: TYPES.test(t) ? t : contentType(path) } });
          await exec(db, "INSERT INTO uploads (id, video_id, bytes, created_at) VALUES (?1, ?2, 0, ?3) ON CONFLICT(id) DO NOTHING", up.uploadId, v.id, now());
          return json({ uploadId: up.uploadId });
        }
        if (id && seg[7] && m === "PUT") {
          const n = Number(seg[7]);
          if (!Number.isInteger(n) || n < 1 || n > 10000 || !req.body) return json({ error: "番号が違います" }, 400);
          const len = Number(req.headers.get("content-length") ?? NaN);
          if (!Number.isFinite(len)) return json({ error: "content-length が要ります" }, 411);
          if (len > 100_000_000) return json({ error: "1 つの片は 100MB までです" }, 413);
          // 完成版の置き直しは、前の完成版の分までは増えない（終わると入れ替わる）。その分を超えた所だけを確かめる（2026-10-25: 1 片目で 402 になった）
          let grow = len;
          if (isFinal(path)) {
            const old = await finalSize(), sent = (await one<{ bytes: number }>(db, "SELECT bytes FROM uploads WHERE id = ?1 AND video_id = ?2", id, v.id))?.bytes ?? 0;
            grow = Math.max(old, sent + len) - old - sent;      // 数えている量（前の完成版＋送った片）から、終わったときの量までの差
          }
          await needRoom(env, v.channel_id, grow);
          const part = await env.MEDIA.resumeMultipartUpload(base + path, id).uploadPart(n, req.body);
          // 途中の片は版ではなく uploads に積む（2026-10-25。版に足すと、ready の数え直しで途中の片が消え、そのあと complete した分が数えられなかった）
          await addUpload(db, id, v.id, len);
          return json(part);
        }
        if (id && seg[7] === "complete" && m === "POST") {
          const b = await readJson<{ parts?: { partNumber: number; etag: string }[] }>(req);
          const old = isFinal(path) ? await finalSize() : 0;
          await env.MEDIA.resumeMultipartUpload(base + path, id).complete(b.parts ?? []);
          await exec(db, "DELETE FROM uploads WHERE id = ?1 AND video_id = ?2", id, v.id);
          const size = (await env.MEDIA.head(base + path))?.size ?? 0;     // できあがった大きさを版に数える
          if (isFinal(path)) { await shiftBytes(size - old); await record(db, v.id, who.email, "final", ver); finalPlaced(); }
          else { await addBytes(db, v.id, ver, size); await unapprove(); }
          return json({ ok: true, path });
        }
        if (id && seg[7] === "abort" && m === "POST") {     // 途中でやめた分を R2 から捨てる
          return json({ ok: await abortUpload(env, base + path, id, v.id) });
        }
      }
      if (op === "ready" && m === "POST") {       // 全部上がった
        need("editor");
        if (!(await env.MEDIA.head(base + "manifest.json")) && !(await one(db, "SELECT 1 AS x FROM links WHERE video_id = ?1 AND version = ?2 AND path = 'manifest.json'", v.id, ver))) {
          return json({ error: "manifest.json が上がっていません" }, 400);
        }
        let bytes = 0, cursor: string | undefined;
        do { const l = await env.MEDIA.list({ prefix: base, cursor, limit: 1000 }); for (const o of l.objects) bytes += o.size; cursor = l.truncated ? l.cursor : undefined; } while (cursor);
        // 正しい大きさに置き直してから、上限を確かめる（超えていれば見られる状態にしない。上げた分は 2 日後の掃除で消える）
        await exec(db, "UPDATE versions SET bytes = ?3 WHERE video_id = ?1 AND name = ?2", v.id, ver, bytes);
        await needRoom(env, v.channel_id, 0);
        await exec(db, "UPDATE versions SET ready = 1, bytes = ?3 WHERE video_id = ?1 AND name = ?2", v.id, ver, bytes);
        // 状態を確認待ちにして知らせるのは、はじめて見られるようになったときだけ（2026-10-25。送り直しで、承認したまま確認待ちに戻り、また通知が飛んだ）
        if (!verRow.ready) {
          await exec(db, "UPDATE videos SET status = 'review', updated_at = ?2 WHERE id = ?1", v.id, now());
          await record(db, v.id, who.email, "ready", ver);
          void notify(db, ctx, v.channel_id, `「${v.title}」の ${ver} を見られるようになりました ${url.origin}/v/${encodeURIComponent(v.id)}?ver=${encodeURIComponent(ver)}`);
        }
        return json({ ok: true, bytes });
      }
      if (op === "links" && m === "POST") {     // 共有の置き場にあるファイルを、この版の道につなぐ。無いものを返す
        need("editor");
        const b = await readJson<{ links?: { path?: string; sha?: string }[] }>(req, 2_000_000);
        const items = (b.links ?? []).filter((x) => typeof x.path === "string" && PATH_RE.test(x.path) && typeof x.sha === "string" && SHA_RE.test(x.sha))
          .slice(0, 5000).map((x) => ({ path: x.path as string, sha: x.sha as string }));
        if (frozen && items.length) return refuseApproved();
        if (sealed && items.some((x) => !styleOnly(x.path))) return refuseSealed();
        const arr = JSON.stringify(items);
        const has = "EXISTS (SELECT 1 FROM blobs b WHERE b.video_id = ?1 AND b.sha = j.value ->> 'sha')";
        const linked = await exec(db, "INSERT OR REPLACE INTO links (video_id, version, path, sha) " +
          `SELECT ?1, ?2, j.value ->> 'path', j.value ->> 'sha' FROM json_each(?3) j WHERE ${has}`, v.id, ver, arr);
        const missing = (await many<{ sha: string }>(db, `SELECT DISTINCT j.value ->> 'sha' AS sha FROM json_each(?2) j WHERE NOT ${has}`, v.id, arr)).map((r) => r.sha);
        if (linked) await unapprove();
        return json({ ok: true, linked, missing });
      }
      // 承認（「この版で OK」）。誰がいつ出したかを残し、動画を完了にする。取り消すと確認待ちに戻す
      if (op === "approve" && (m === "POST" || m === "DELETE")) {
        need("editor");
        const row = await one<{ ready: number }>(db, "SELECT ready FROM versions WHERE video_id = ?1 AND name = ?2", v.id, ver);
        if (!row?.ready) return json({ error: "まだ見られない版です" }, 400);
        const t = now(), on = m === "POST";
        await exec(db, "UPDATE versions SET approved_by = ?3, approved_at = ?4 WHERE video_id = ?1 AND name = ?2", v.id, ver, on ? who.email : null, on ? t : null);
        await exec(db, "UPDATE videos SET status = ?2, updated_at = ?3 WHERE id = ?1", v.id, on ? "done" : "review", t);
        await record(db, v.id, who.email, on ? "approve" : "unapprove", ver);
        // 取り消したら完成版も消す（承認の無い版の完成版は画面に出ず、容量だけを使った。2026-10-25）
        const gone = !on && (await dropFinal());
        void notify(db, ctx, v.channel_id, on ? `${personOf(who.email, who.name, false)} が「${v.title}」の ${ver} を承認しました ${url.origin}/v/${encodeURIComponent(v.id)}?ver=${encodeURIComponent(ver)}`
          : `${personOf(who.email, who.name, false)} が「${v.title}」の ${ver} の承認を取り消しました${gone ? "（置いてあった完成版も消えました）" : ""}`);
        return json({ ok: true, approved_by: on ? personOf(who.email, who.name, role === "owner") : null, approved_at: on ? t : null });
      }
      if (!op && m === "DELETE") {
        need("owner");
        await deletePrefix(env.MEDIA, base);
        await exec(db, "DELETE FROM versions WHERE video_id = ?1 AND name = ?2", v.id, ver);
        await gcBlobs(env, v.id, now() - 6 * 3600_000);     // どの版からもつながらなくなったファイルを消して容量を空ける
        return json({ ok: true });
      }
    }

    // 版をまたいで共有するファイルの置き場（v/<動画>/b/<sha256>）。版の files・mpu と同じ形で上げる
    if (sub === "blobs" && seg[4]) {
      need("editor");
      const sha = seg[4].toLowerCase();
      if (!SHA_RE.test(sha)) return json({ error: "sha256（16 進 64 文字）ではありません" }, 400);
      const key = `v/${v.id}/b/${sha}`;
      const t = url.searchParams.get("type") ?? req.headers.get("x-miru-type") ?? "";
      const type = TYPES.test(t) ? t : "application/octet-stream";
      const register = async () => {
        const h = await env.MEDIA.head(key);
        if (!h) throw new HttpError(400, "ファイルが上がっていません");
        // 置いてある中身の大きさを読んで、数えた大きさより大きければ数え直す（2026-10-25。同時に送ると、1 バイトで数えたまま大きな中身が残った）
        await exec(db, "INSERT INTO blobs (video_id, sha, size, type, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(video_id, sha) DO UPDATE SET size = max(size, excluded.size)", v.id, sha, h.size, type, now());
        return h.size;
      };
      const counted = async () => (await one<{ size: number }>(db, "SELECT size FROM blobs WHERE video_id = ?1 AND sha = ?2", v.id, sha))?.size;
      if (!seg[5] && m === "PUT") {
        const len = Number(req.headers.get("content-length") ?? NaN);
        if (!Number.isFinite(len)) return json({ error: "content-length が要ります" }, 411);
        if (len > 95_000_000) return json({ error: "95MB を超えるものは分けて上げてください（mpu）" }, 413);
        if ((await counted()) === undefined) {
          await needRoom(env, v.channel_id, len);
          await env.MEDIA.put(key, req.body ?? new Uint8Array(), { httpMetadata: { contentType: type } });
        }
        return json({ ok: true, size: await register() });
      }
      if (seg[5] === "mpu") {
        const id = seg[6];
        // 置いてある blob に上書きしない（2026-10-25。1 バイトで登録してから大きな中身で上書きすると、大きさが数えられなかった。
        // 共有なので、ほかの版の中身も変わってしまう）
        if (!id && m === "POST") {
          if ((await counted()) !== undefined) return json({ error: "もう置いてあります", exists: true }, 409);
          await needRoom(env, v.channel_id, Math.max(0, Number(url.searchParams.get("size")) || 0));
          const up = await env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: type } });
          await exec(db, "INSERT INTO uploads (id, video_id, bytes, created_at) VALUES (?1, ?2, 0, ?3) ON CONFLICT(id) DO NOTHING", up.uploadId, v.id, now());
          return json({ uploadId: up.uploadId });
        }
        if (id && seg[7] && /^\d+$/.test(seg[7]) && m === "PUT") {
          const n = Number(seg[7]);
          if (n < 1 || n > 10000 || !req.body) return json({ error: "番号が違います" }, 400);
          const len = Number(req.headers.get("content-length") ?? NaN);
          if (!Number.isFinite(len)) return json({ error: "content-length が要ります" }, 411);
          if (len > 100_000_000) return json({ error: "1 つの片は 100MB までです" }, 413);
          await needRoom(env, v.channel_id, len);
          const part = await env.MEDIA.resumeMultipartUpload(key, id).uploadPart(n, req.body);
          // 途中の片も容量に数える（2026-10-24。数えないと、終わらせないまま片を積んで上限をすり抜けられた）。同じ番号の上げ直しは多めに数える
          await addUpload(db, id, v.id, len);
          return json(part);
        }
        if (id && seg[7] === "complete" && m === "POST") {
          const b = await readJson<{ parts?: { partNumber: number; etag: string }[] }>(req);
          // もう置いてあれば上書きせずに、置いてあるものを返す（前の complete の返事が届かずに送り直したときも、ここで成功になる。
          // 2026-10-25: 前は 409 で、上げる道具が止まった）
          const had = await counted();
          if (had !== undefined) { await abortUpload(env, key, id, v.id); return json({ ok: true, size: had, exists: true }); }
          await env.MEDIA.resumeMultipartUpload(key, id).complete(b.parts ?? []);
          await exec(db, "DELETE FROM uploads WHERE id = ?1 AND video_id = ?2", id, v.id);    // 途中の分は blobs に移る
          // できあがった大きさでも上限を確かめる。超えていれば置かない（2026-10-23）。
          // 待つ間にほかの送信が同じ sha を小さく数えていたら、その差を確かめる（2026-10-25。数えたのが 1 バイトのまま、上限をすり抜けられた）
          const size = (await env.MEDIA.head(key))?.size ?? 0;
          try { await needRoom(env, v.channel_id, Math.max(0, size - ((await counted()) ?? 0))); } catch (e) {
            await env.MEDIA.delete(key);
            await exec(db, "DELETE FROM blobs WHERE video_id = ?1 AND sha = ?2", v.id, sha);    // 中身を消したので、数えも外す
            throw e;
          }
          return json({ ok: true, size: await register() });
        }
        if (id && seg[7] === "abort" && m === "POST") return json({ ok: await abortUpload(env, key, id, v.id) });
      }
    }

    if (sub === "thumb" && m === "PUT") {
      need("editor");
      const len = Number(req.headers.get("content-length") ?? NaN);
      if (!Number.isFinite(len)) return json({ error: "content-length が要ります" }, 411);
      // 見出しは容量に数えないので、ライトは 1MB まで（上げる道具の見出しは 640px の JPEG で数十 KB。2026-10-25）
      const maxThumb = editionOf(env) === "light" ? 1_000_000 : MAX_IMAGE_BYTES;
      if (len > maxThumb) return json({ error: `画像が大きすぎます（${maxThumb === MAX_IMAGE_BYTES ? "10MB" : "1MB"} まで）` }, 413);
      await env.MEDIA.put(`v/${v.id}/thumb.jpg`, req.body ?? new Uint8Array(), { httpMetadata: { contentType: "image/jpeg" } });
      await exec(db, "UPDATE videos SET thumb = ?2, updated_at = ?3 WHERE id = ?1", v.id, `v/${v.id}/thumb.jpg`, now());
      return json({ ok: true });
    }
    if (sub === "thumb" && m === "GET") return serveObject(env.MEDIA, `v/${v.id}/thumb.jpg`, req);

    // 再生の記録（2026-10-23「字幕が途中で消える・音待ち・映像が止まる」の原因を本番で確かめるため）。
    // ページが自分で記録して送る。動画ごとの置き場に置き、編集者以上が一覧・中身を読める
    if (sub === "diag") {
      const name = seg[4];
      if (!name && m === "POST") {
        const len = Number(req.headers.get("content-length") ?? 0);
        if (len > DIAG.bytes) return json({ error: "記録は 256KB までです" }, 413);
        const body = await req.text();
        const size = new TextEncoder().encode(body).length;
        if (size > DIAG.bytes) return json({ error: "記録は 256KB までです" }, 413);
        try { JSON.parse(body); } catch { return json({ error: "JSON ではありません" }, 400); }
        const tag = await diagTag(who.email);
        const all = await diagKeys(env, v.id);
        const mine = all.filter((o) => o.key.includes(`-${tag}-`)).pop();       // 同じ人は同じ動画に 10 秒に 1 回まで
        if (mine && mine.uploaded > Date.now() - DIAG.gapMs) return json({ error: "少し待ってから送ってください" }, 429);
        const key = `${new Date().toISOString().replace(/[:.]/g, "-")}-${tag}-${newId().slice(0, 6)}.json`;
        await env.MEDIA.put(`v/${v.id}/diag/${key}`, body, { httpMetadata: { contentType: "application/json" } });
        // 動画ごとに新しい keep 件・合計 total まで残し、古いものから消す（ライトは小さく）。名前は時刻順
        const drop = diagOverflow([...all, { key: `v/${v.id}/diag/${key}`, size, uploaded: Date.now() }], diagLimit(env));
        if (drop.length) await env.MEDIA.delete(drop);
        return json({ ok: true, name: key });
      }
      need("editor");
      if (!name && m === "GET") {      // 新しい順に 100 件（list は名前の昇順で 1000 件ずつなので、全部たどってから並べる）
        const all = await diagKeys(env, v.id);
        const items = all.slice(-100).reverse().map((o) => ({ name: o.key.split("/").pop(), size: o.size, at: o.uploaded }));
        return json({ items });
      }
      if (name && m === "GET" && /^[\w.-]{10,80}\.json$/.test(name)) return serveObject(env.MEDIA, `v/${v.id}/diag/${name}`, req);
      return json({ error: "ありません" }, 404);
    }

    // 修正指示
    // 履歴（2026-10-25）。消した修正指示は、ここから戻せる
    if (sub === "activity") {
      const aid = Number(seg[4]);
      if (!seg[4] && m === "GET") {
        const rows = await activityOf(db, v.id, Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100)));
        return json({ items: rows.map(({ who: w, who_name, data, ...a }) => ({ ...a, who: personOf(w, who_name, role === "owner"), restorable: a.kind === "note_deleted" && !!data })) });
      }
      if (Number.isInteger(aid) && seg[5] === "restore" && m === "POST") {
        need("editor");
        const a = await one<{ kind: string; data: string | null }>(db, "SELECT kind, data FROM activity WHERE id = ?1 AND video_id = ?2", aid, v.id);
        if (!a || a.kind !== "note_deleted" || !a.data) return json({ error: "戻せるものがありません" }, 404);
        const n = safeParse(a.data);
        if (typeof n.id !== "string" || typeof n.text !== "string") return json({ error: "戻せるものがありません" }, 404);
        if (await one(db, "SELECT 1 AS x FROM notes WHERE id = ?1", n.id)) return json({ error: "同じ指示がもうあります" }, 409);
        const cols = ["id", "version", "author", "frame", "end_frame", "tc", "end_tc", "text", "status", "category", "extra", "reply", "created_at"];
        await exec(db, `INSERT INTO notes (video_id, ${cols.join(", ")}, updated_at) VALUES (?1, ${cols.map((_, i) => `?${i + 2}`).join(", ")}, ?${cols.length + 2})`,
          v.id, ...cols.map((c) => n[c] ?? ({ version: "", author: who.email, status: "open", category: "", extra: "{}", created_at: now() } as Record<string, unknown>)[c] ?? null), now());
        await exec(db, "UPDATE activity SET data = NULL WHERE id = ?1", aid);
        await record(db, v.id, who.email, "note_restored", n.text.slice(0, 120));
        return json({ ok: true, id: n.id, notes: await notesOf(db, v.id, role === "owner") });
      }
      // 消した修正指示の中身を、履歴からも完全に消す（管理者だけ。2026-10-25 の点検: 電話番号などを書いて消しても、履歴に残り続けた）
      if (Number.isInteger(aid) && !seg[5] && m === "DELETE") {
        need("owner");
        const row = await one<{ detail: string; data: string | null }>(db, "SELECT detail, data FROM activity WHERE id = ?1 AND video_id = ?2 AND kind = 'note_deleted'", aid, v.id);
        if (!row) return json({ error: "消せるものがありません" }, 404);
        await exec(db, "UPDATE activity SET detail = '', data = NULL WHERE id = ?1", aid);
        // その指示を書いた・返事した・済にした履歴の文にも同じ中身があるので、そこからも消す（指示の頭の 40 字で探す）
        const head = String(safeParse(row.data ?? "{}").text ?? row.detail).slice(0, 40);
        if (head.length >= 4) {
          await exec(db, "UPDATE activity SET detail = '' WHERE video_id = ?1 AND kind IN ('note', 'reply', 'done', 'reopen', 'note_restored', 'note_deleted') AND instr(detail, ?2) > 0", v.id, head);
        }
        return json({ ok: true });
      }
      return json({ error: "ありません" }, 404);
    }

    if (sub === "notes") {
      const nid = seg[4];
      if (!nid && m === "GET") return json({ notes: await notesOf(db, v.id, role === "owner") });
      if (!nid && m === "POST") {
        need("editor");
        const b = await readJson<Record<string, unknown>>(req);
        const text = String(b.text ?? "").trim().slice(0, 4000);
        if (!text) return json({ error: "指示を入れてください" }, 400);
        let id = typeof b.id === "string" && /^[\w-]{4,40}$/.test(b.id) ? b.id : "n" + newId();
        const same = await one<{ video_id: string }>(db, "SELECT video_id FROM notes WHERE id = ?1", id);
        if (same?.video_id === v.id) return json({ error: "同じ id の指示があります" }, 409);
        if (same) id = "n" + newId();      // 別の動画の指示とぶつかったら、新しい id にする（どの動画かは教えない）
        const count = await one<{ n: number }>(db, "SELECT count(*) AS n FROM notes WHERE video_id = ?1", v.id);
        if ((count?.n ?? 0) >= 3000) return json({ error: "修正指示は 1 本 3000 件までです" }, 400);
        // 確認画面で描いた線（compare.ts）は、形を確かめてから一緒に残す（2026-10-25）
        // null は「線なし」（2026-10-25 の点検: ほかの道具が null を送ると書けなかった）
        const drawing = b.drawing === undefined || b.drawing === null ? null : cleanDrawing(b.drawing);
        if (b.drawing !== undefined && b.drawing !== null && !drawing) return json({ error: "描いた線の形が違います" }, 400);
        // 線の無い部分は前と同じ 6000 字で数え、線は cleanDrawing の上限（5000 字ほど）で別に抑える（2026-10-25 の点検: 線の無い指示でも 12000 字まで通った）
        const rest = { source: b.source ?? null, caption: b.caption ?? null, ...(typeof b.replacement === "string" ? { replacement: b.replacement.slice(0, 400) } : {}) };
        if (JSON.stringify(rest).length > 6000) return json({ error: "大きすぎます" }, 413);
        const extra = JSON.stringify({ ...rest, ...(drawing ? { drawing } : {}) });
        const t = now();
        await exec(db, "INSERT INTO notes (id, video_id, version, author, frame, end_frame, tc, end_tc, text, status, category, extra, created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'open', ?10, ?11, ?12, ?12)",
          id, v.id, String(b.version ?? "").slice(0, 30), who.email, numOrNull(b.frame), numOrNull(b.end_frame), strOrNull(b.tc), strOrNull(b.end_tc),
          text, String(b.category ?? "").slice(0, 20), extra, t);
        await exec(db, "UPDATE videos SET status = 'fixing', updated_at = ?2 WHERE id = ?1 AND status IN ('review', 'done')", v.id, t);
        await record(db, v.id, who.email, "note", `${b.tc ? String(b.tc).slice(0, 20) + " " : ""}${text.slice(0, 120)}`);
        void notify(db, ctx, v.channel_id, `${personOf(who.email, who.name, false)} が修正指示を書きました（「${v.title}」${b.version ? " " + String(b.version).slice(0, 30) : ""}${b.tc ? " " + String(b.tc).slice(0, 20) : ""}）\n${text.slice(0, 300)}\n${url.origin}/v/${encodeURIComponent(v.id)}`);
        return json({ ok: true, id, notes: await notesOf(db, v.id, role === "owner") });
      }
      if (nid && m === "PATCH") {
        const b = await readJson<{ status?: string; text?: string; reply?: string; category?: string }>(req);
        const n = await one<{ id: string; author: string; text: string; status: string; reply: string | null; category: string }>(db, "SELECT * FROM notes WHERE id = ?1 AND video_id = ?2", nid, v.id);
        if (!n) return json({ error: "ありません" }, 404);
        if (b.text !== undefined || b.status !== undefined || b.category !== undefined) need("editor");
        if (b.reply !== undefined) need("editor");
        const status = ["open", "doing", "done"].includes(String(b.status)) ? String(b.status) : n.status;
        const text = b.text === undefined ? n.text : String(b.text).trim().slice(0, 4000) || n.text;
        const reply = b.reply === undefined ? n.reply : String(b.reply).slice(0, 4000);
        const category = b.category === undefined ? n.category : String(b.category).slice(0, 20);
        await exec(db, "UPDATE notes SET status = ?2, text = ?3, reply = ?4, category = ?5, updated_at = ?6 WHERE id = ?1", nid, status, text, reply, category, now());
        if (reply && reply !== n.reply) await record(db, v.id, who.email, "reply", `${n.text.slice(0, 60)} → ${reply.slice(0, 120)}`);
        if (status !== n.status && (status === "done" || n.status === "done")) await record(db, v.id, who.email, status === "done" ? "done" : "reopen", n.text.slice(0, 120));
        if ((reply && reply !== n.reply) || (status === "done" && n.status !== "done")) {      // 返事・済は書いた人へ知らせる
          void notify(db, ctx, v.channel_id, `${personOf(who.email, who.name, false)} が修正指示に${reply && reply !== n.reply ? "返事しました" : "「済」を付けました"}（「${v.title}」）\n指示: ${n.text.slice(0, 120)}${reply && reply !== n.reply ? `\n返事: ${reply.slice(0, 300)}` : ""}\n${url.origin}/v/${encodeURIComponent(v.id)}`);
        }
        return json({ ok: true, notes: await notesOf(db, v.id, role === "owner") });
      }
      if (nid && m === "DELETE") {
        need("editor");
        // 消す前の中身を履歴に残す（画面から戻せる。2026-10-25）
        const gone = await one<Record<string, unknown> & { text: string }>(db, "SELECT * FROM notes WHERE id = ?1 AND video_id = ?2", nid, v.id);
        await exec(db, "DELETE FROM notes WHERE id = ?1 AND video_id = ?2", nid, v.id);
        if (gone) await record(db, v.id, who.email, "note_deleted", gone.text.slice(0, 120), gone);
        return json({ ok: true, notes: await notesOf(db, v.id, role === "owner") });
      }
    }

    // 画面での手直し（字幕・カット）。中身は手元の planning/caption-edits.json・cut-edits.json と同じ形
    if (sub === "edits" && (seg[4] === "caption" || seg[4] === "cut")) {
      const kind = seg[4];
      if (m === "GET") {
        const r = await one<{ body: string; saved_at: number }>(db, "SELECT body, saved_at FROM edits WHERE video_id = ?1 AND kind = ?2", v.id, kind);
        const body = r ? JSON.parse(r.body) : { items: [] };
        return json({ ...body, saved_at: r ? new Date(r.saved_at).toISOString() : null });
      }
      if (m === "PUT") {
        need("editor");
        const text = await req.text();
        if (text.length > MAX_EDIT_BYTES) return json({ error: "手直しが多すぎます" }, 413);
        let body: { schema?: string; items?: unknown[] };
        try { body = JSON.parse(text); } catch { return json({ error: "JSON ではありません" }, 400); }
        if (!Array.isArray(body.items) || body.items.length > 5000 || body.items.some((x) => !x || typeof x !== "object")) return json({ error: "items がありません" }, 400);
        if (body.items.some((x) => !editItemOk(x as Record<string, unknown>))) return json({ error: "手直しの形が違います（op は英小文字、コマと時刻は数）" }, 400);
        const t = now();
        const keep = JSON.stringify({ schema: body.schema ?? (kind === "cut" ? "review/cut-edits-v1" : "review/caption-edits-v1"), items: body.items });
        await db.batch([
          db.prepare("INSERT INTO edits (video_id, kind, body, saved_at, saved_by) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(video_id, kind) DO UPDATE SET body = ?3, saved_at = ?4, saved_by = ?5")
            .bind(v.id, kind, keep, t, who.email),
          db.prepare("INSERT INTO edits_history (video_id, kind, body, saved_at, saved_by) VALUES (?1, ?2, ?3, ?4, ?5)").bind(v.id, kind, keep, t, who.email),
          db.prepare("DELETE FROM edits_history WHERE video_id = ?1 AND kind = ?2 AND saved_at < (SELECT min(saved_at) FROM (SELECT saved_at FROM edits_history WHERE video_id = ?1 AND kind = ?2 ORDER BY saved_at DESC LIMIT 50))")
            .bind(v.id, kind),
        ]);
        return json({ ok: true, items: body.items, saved_at: new Date(t).toISOString() });
      }
    }
  }

  // ── タスク（見られる動画の修正指示を全部）──
  if (seg[1] === "notes" && !seg[2] && m === "GET") {
    const rows = await many<Record<string, unknown> & { extra: string }>(db,
      "SELECT n.*, v.title AS video_title, v.channel_id, m.role AS my_role, (SELECT name FROM users WHERE email = n.author ORDER BY created_at LIMIT 1) AS author_name " +
      "FROM notes n JOIN videos v ON v.id = n.video_id JOIN members m ON m.channel_id = v.channel_id AND m.email = ?1 " +
      "ORDER BY n.updated_at DESC LIMIT 500", who.email.toLowerCase());
    // タスクの一覧には描いた線を入れない（500 件分の線で重くなる。2026-10-25 の点検）
    return json({ notes: rows.map(({ extra, my_role, ...n }) => { const { drawing: _d, ...x } = safeParse(extra); return { ...n, author: personOf(n.author as string, n.author_name as string | null, my_role === "owner"), ...x }; }) });
  }

  // ── AI（Workers AI）: 音声入力の指示を読みやすく・種類を付ける／入力の候補 ──
  if (seg[1] === "ai") {
    const { aiTidy, aiSuggest } = await import("./ai");
    if (seg[2] === "tidy" && m === "POST") {
      // どこかのチャンネルに入っている人だけ。1 人 1 日の回数を数え、超えたら AI を使わずに返す
      const body = await readJson<{ text?: string }>(req);
      const member = await one(db, "SELECT 1 AS x FROM members WHERE email = ?1 AND role IN ('owner', 'editor') LIMIT 1", who.email.toLowerCase());
      if (!member) return json({ error: "チャンネルに入っている人だけが使えます" }, 403);
      const day = new Date().toISOString().slice(0, 10);
      await exec(db, "INSERT INTO usage (user_id, day, kind, n) VALUES (?1, ?2, 'ai', 1) ON CONFLICT(user_id, day, kind) DO UPDATE SET n = n + 1", who.id, day);
      const used = (await one<{ n: number }>(db, "SELECT n FROM usage WHERE user_id = ?1 AND day = ?2 AND kind = 'ai'", who.id, day))?.n ?? 0;
      return json(await aiTidy(used > limits(env).aiPerDay ? { ...env, AI: undefined } : env, body));
    }
    if (seg[2] === "suggest" && m === "POST") return json(await aiSuggest(env, who, await readJson<{ text?: string; videoId?: string }>(req)));
  }
  return json({ error: "ありません" }, 404);
}

/** 分割アップロードの途中の片を uploads に積む（容量に数える）。同じ番号の上げ直しは多めに数える */
const addUpload = (db: D1Database, id: string, vid: string, len: number) =>
  exec(db, "INSERT INTO uploads (id, video_id, bytes, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET bytes = bytes + ?3 WHERE video_id = ?2",
    id, vid, Math.floor(len), Date.now());
/** 分割アップロードをやめる。R2 でやめられたときだけ uploads から外す（2026-10-25。違う道で送ると、R2 ではやめられないのに数えから外れた）。
 *  外せなかった行は毎日の掃除で 7 日後に消える */
async function abortUpload(env: Env, key: string, id: string, vid: string): Promise<boolean> {
  try { await env.MEDIA.resumeMultipartUpload(key, id).abort(); } catch { return false; }
  await exec(env.DB, "DELETE FROM uploads WHERE id = ?1 AND video_id = ?2", id, vid);
  return true;
}
const addBytes = (db: D1Database, vid: string, ver: string, len: number) =>
  // 上げ終わった版に足したもの（字幕の見た目・書体の置き直しなど）も数える。数えないと上限をすり抜けられた（2026-10-23）
  len > 0 ? exec(db, "UPDATE versions SET bytes = bytes + ?3 WHERE video_id = ?1 AND name = ?2", vid, ver, Math.floor(len)) : Promise.resolve(0);
const numOrNull = (x: unknown) => (Number.isFinite(Number(x)) && x !== null && x !== "" ? Math.round(Number(x)) : null);
const strOrNull = (x: unknown) => (typeof x === "string" ? x.slice(0, 40) : null);

async function channelsFor(env: Env, who: Who) {
  const db = env.DB;
  const rows = await many<{ id: string; name: string; color: string; role: Role; mine: number }>(db,
    "SELECT c.id, c.name, c.color, m.role, c.created_by = ?1 AS mine FROM members m JOIN channels c ON c.id = m.channel_id WHERE m.email = ?1 ORDER BY c.created_at", who.email.toLowerCase());
  const out = [];
  for (const r of rows) {
    const n = await one<{ videos: number; open: number }>(db,
      "SELECT (SELECT count(*) FROM videos WHERE channel_id = ?1) AS videos, (SELECT count(*) FROM notes n JOIN videos v ON v.id = n.video_id WHERE v.channel_id = ?1 AND n.status != 'done') AS open", r.id);
    out.push({ ...r, videos: n?.videos ?? 0, open: n?.open ?? 0 });
  }
  return out;
}
const members = (db: D1Database, cid: string) =>
  many(db, "SELECT m.email, m.role, m.invited_by, m.created_at, u.name, u.picture FROM members m LEFT JOIN users u ON u.email = m.email WHERE m.channel_id = ?1 ORDER BY m.created_at, m.rowid", cid);
const videosOf = (db: D1Database, cid: string) =>
  many(db, "SELECT v.*, (SELECT name FROM versions WHERE video_id = v.id AND ready = 1 ORDER BY created_at DESC LIMIT 1) AS latest, " +
    "(SELECT count(*) FROM notes WHERE video_id = v.id AND status != 'done') AS open FROM videos v WHERE v.channel_id = ?1 ORDER BY v.updated_at DESC", cid);
const versionsOf = async (db: D1Database, vid: string, owner: boolean) =>
  (await many<Record<string, unknown> & { name: string; approved_at: number | null; approved_by: string | null; approver_name: string | null }>(db,
    "SELECT s.name, s.frames, s.fps, s.ready, s.bytes, s.note, s.created_at, s.approved_by, s.approved_at, " +
    "(SELECT name FROM users WHERE email = s.approved_by ORDER BY created_at LIMIT 1) AS approver_name FROM versions s WHERE s.video_id = ?1 ORDER BY s.created_at DESC", vid))
    .map(({ approver_name, ...r }) => ({ ...r, approved_by: personOf(r.approved_by, approver_name, owner) }));
/** 人のメールは管理者だけに見せる（2026-10-24 セキュリティ確認）。ほかの人には Google の名前（無ければ「チャンネルの人」）。
 *  招待した人の一覧（members）は前から管理者だけ。修正指示を書いた人・デザインを決めた人・トンマナを直した人も同じにする */
export const personOf = (email: string | null | undefined, name: string | null | undefined, owner: boolean) =>
  !email ? null : owner ? email : name && !name.includes("@") ? name : "チャンネルの人";    // 名前が無い人は name にメールが入る（auth.ts）
const nameOf = async (db: D1Database, email: string | null) =>
  email ? (await one<{ name: string }>(db, "SELECT name FROM users WHERE email = ?1 ORDER BY created_at LIMIT 1", email))?.name ?? null : null;
const notesOf = async (db: D1Database, vid: string, owner: boolean) =>
  (await many<Record<string, unknown> & { extra: string; author: string; author_name: string | null }>(db,
    "SELECT n.*, (SELECT name FROM users WHERE email = n.author ORDER BY created_at LIMIT 1) AS author_name FROM notes n WHERE n.video_id = ?1 ORDER BY coalesce(n.frame, 0), n.created_at", vid))
    .map(({ extra, ...n }) => { const x = safeParse(extra); return { ...n, author: personOf(n.author, n.author_name, owner), ...x, ...(x.drawing ? { drawing_hint: drawingHint(x.drawing) } : {}) }; });
const openNotes = async (db: D1Database, vid: string) => (await one<{ n: number }>(db, "SELECT count(*) AS n FROM notes WHERE video_id = ?1 AND status != 'done'", vid))?.n ?? 0;
const safeParse = (s: string) => { try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; } };

async function designsOf(db: D1Database, cid: string, owner: boolean) {
  const roles = await many(db, "SELECT role, label, when_text AS \"when\", avoid FROM design_roles WHERE channel_id = ?1 ORDER BY sort", cid);
  const designs = (await many<Record<string, unknown> & { style: string }>(db,
    "SELECT id, role, name, style, status, memo, image IS NOT NULL AS has_image, decided_at, decided_by, updated_at, " +
    "(SELECT name FROM users WHERE email = designs.decided_by ORDER BY created_at LIMIT 1) AS decided_by_name FROM designs WHERE channel_id = ?1 ORDER BY sort", cid))
    .map(({ decided_by_name, ...d }) => ({ ...d, decided_by: personOf(d.decided_by as string | null, decided_by_name as string | null, owner), style: safeParse(d.style) }));
  return { roles, designs };
}

async function deletePrefix(bucket: R2Bucket, prefix: string) {
  let cursor: string | undefined;
  do {
    const l = await bucket.list({ prefix, cursor, limit: 1000 });
    if (l.objects.length) await bucket.delete(l.objects.map((o) => o.key));
    cursor = l.truncated ? l.cursor : undefined;
  } while (cursor);
}

/** 毎日の掃除（index.ts の scheduled から）。費用をほとんどかけないため:
 *  - 期限の切れたログインの印と鍵を消す
 *  - 2 日たっても上げ終わっていない版を消す
 *  - 容量の上限が既定の人（無料）の、各動画の新しい 2 つより前で 30 日たった版を消す（サイトの持ち主の分は消さない）
 *  - 古い利用回数の記録を消す
 *  - 完全招待制のとき、どのチャンネルにも招待されていない人の記録を消す */
export async function cleanup(env: Env, t = Date.now()) {
  const db = env.DB;
  const out = { sessions: 0, tokens: 0, unready: 0, old: 0, blobs: 0, strays: 0 };
  out.sessions = await exec(db, "DELETE FROM sessions WHERE expires_at < ?1", t);
  out.tokens = await exec(db, "DELETE FROM tokens WHERE expires_at IS NOT NULL AND expires_at < ?1", t);
  await exec(db, "DELETE FROM tickets WHERE expires_at < ?1", t);
  await exec(db, "DELETE FROM uploads WHERE created_at < ?1", t - 7 * DAY);   // R2 も終わらなかった分割アップロードを 7 日で捨てる
  await exec(db, "DELETE FROM usage WHERE day < ?1", new Date(t - 40 * DAY).toISOString().slice(0, 10));
  const drop = async (rows: { video_id: string; name: string }[]) => {
    for (const r of rows) {
      await deletePrefix(env.MEDIA, `v/${r.video_id}/${r.name}/`);
      await exec(db, "DELETE FROM versions WHERE video_id = ?1 AND name = ?2", r.video_id, r.name);
    }
    return rows.length;
  };
  const gc = async () => {
    let n = 0;
    for (const r of await many<{ video_id: string }>(db, "SELECT DISTINCT video_id FROM blobs WHERE created_at < ?1 LIMIT 500", t - 2 * DAY)) n += await gcBlobs(env, r.video_id, t - 2 * DAY);
    return n;
  };
  // 完全招待制: どのチャンネルにも招待されていない人の記録（前にログインした跡）を消す。持ち主は残す
  if (owners(env).size) {
    const strays = (await many<{ id: string; email: string }>(db, "SELECT id, email FROM users WHERE email NOT IN (SELECT email FROM members)"))
      .filter((u) => !isSiteOwner(env, u.email));
    for (const u of strays) {
      await exec(db, "DELETE FROM sessions WHERE user_id = ?1", u.id);
      await exec(db, "DELETE FROM tokens WHERE user_id = ?1", u.id);
      await exec(db, "DELETE FROM users WHERE id = ?1", u.id);
      await exec(db, "UPDATE activity SET who = NULL WHERE who = ?1", u.email);     // 履歴からもメールを外す（2026-10-25）
    }
    out.strays = strays.length;
  }
  // 持ち主のチャンネルの版は自動で消さない（作った人のメールの書き方のまま照らす）
  const ownerCreators = (await many<{ e: string }>(db, "SELECT DISTINCT created_by AS e FROM channels WHERE created_by IS NOT NULL")).map((r) => r.e).filter((e) => isSiteOwner(env, e));
  out.unready = await drop(await many(db, "SELECT video_id, name FROM versions WHERE ready = 0 AND created_at < ?1 LIMIT 200", t - 2 * DAY));
  const old = await drop(await many(db,
    "SELECT x.video_id, x.name FROM versions x JOIN videos v ON v.id = x.video_id JOIN channels c ON c.id = v.channel_id " +
    "LEFT JOIN (SELECT email, max(quota_bytes) AS q FROM users GROUP BY email) u ON u.email = c.created_by " +
    "WHERE x.ready = 1 AND x.created_at < ?1 AND u.q IS NULL AND coalesce(c.created_by, '') NOT IN (SELECT value FROM json_each(?2)) " +
    "AND (SELECT count(*) FROM versions y WHERE y.video_id = x.video_id AND y.ready = 1 AND y.created_at > x.created_at) >= 2 LIMIT 200", t - 30 * DAY, JSON.stringify(ownerCreators)));
  out.old = old;
  out.blobs = await gc();
  return out;
}

/** 使い捨てのリンクで MIRU AI動画編集の zip を返す（10 分の間は何度でも。切れたら 404） */
async function download(env: Env, t: string): Promise<Response> {
  if (!/^[\w-]{20,64}$/.test(t)) return json({ error: "ありません" }, 404);
  const tk = await one<{ ref: string }>(env.DB, "SELECT ref FROM tickets WHERE hash = ?1 AND kind = 'editor' AND expires_at > ?2", await sha256(t), now());
  if (!tk) return json({ error: "リンクの期限が切れています。AI に MIRU の install_editor をもう一度使ってもらってください" }, 404);
  const o = await env.MEDIA.get(`editor/${tk.ref}.zip`);
  if (!o) return json({ error: "ありません" }, 404);
  return new Response(o.body, { headers: { "content-type": "application/zip", "content-length": String(o.size),
    "content-disposition": `attachment; filename="miru-ai-video-editing-${tk.ref}.zip"`, "cache-control": "no-store" } });
}

/** どの版からもつながっていない共有ファイルを消す（olderThan より前に置かれたものだけ。上げている途中のものは残す） */
async function gcBlobs(env: Env, vid: string, olderThan: number) {
  const rows = await many<{ sha: string }>(env.DB,
    "SELECT sha FROM blobs b WHERE video_id = ?1 AND created_at < ?2 AND NOT EXISTS (SELECT 1 FROM links l WHERE l.video_id = b.video_id AND l.sha = b.sha) LIMIT 1000", vid, olderThan);
  if (!rows.length) return 0;
  await env.MEDIA.delete(rows.map((r) => `v/${vid}/b/${r.sha}`));
  for (const r of rows) await exec(env.DB, "DELETE FROM blobs WHERE video_id = ?1 AND sha = ?2", vid, r.sha);
  return rows.length;
}
