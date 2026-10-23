// Google でログイン（KIRU の worker/auth.ts と同じ流れ。2026-10-19）。
//
//   /auth/google   … 使い捨ての state と code_verifier を cookie に置いて、Google の同意画面へ（PKCE）
//   /auth/callback … state を照らし、code を Google と直に交換して id_token を受け取る（TLS で Google から直接なので、
//                    署名の検査は省ける。OIDC Core 3.1.3.7）。aud・iss・期限・メールの確認済みを確かめ、ログインの印を cookie に置く。
//                    D1 にはその SHA-256 だけを置く
//   /auth/logout   … 印を消す（POST・この画面からだけ）
//
// もう一つの入り口は Claude Code と書き出しの道具の鍵（Authorization: Bearer miru_…）。設定の画面で本人が作る。
// 書き換える要求（POST・PUT・PATCH・DELETE）は、cookie で来たものはこのサイトの画面からだけ（Origin と x-miru を照らす）。

import { exec, one, type D1Database, type User } from "./db";

export type AuthEnv = { GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string; DB?: D1Database; DEV_LOGIN?: string; SITE_OWNERS?: string };

const SESSION_COOKIE = "__Host-miru_s";
const FLOW_COOKIE = "__Host-miru_oauth";
const SESSION_DAYS = 30;
export const TOKEN_PREFIX = "miru_";
export const TOKEN_DAYS = 365;
/** ログインの後に戻る先: このサイトの中の道だけ（//… や /\… は別のサイトへ行けるので断る） */
export const safeNext = (s: string | null | undefined) => {
  const v = String(s ?? "/");
  return /^\/(?![\/\\])[^\s\\]*$/.test(v) && v.length <= 500 ? v : "/";
};

export const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
export async function sha256(s: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}
export function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const setCookie = (name: string, value: string, maxAge: number) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const redirect = (to: string, headers: Record<string, string> = {}) =>
  new Response(null, { status: 302, headers: { location: to, "cache-control": "no-store", ...headers } });

export type Who = User & { via: "cookie" | "token" };

/** 同じ受け箱かを比べる形。Gmail は点と + 以降を見ず、googlemail.com も gmail.com と同じ（Google の決まり）。
 *  ほかのメールは大文字小文字だけそろえる（点や + の扱いは会社ごとに違うので触らない） */
export function emailKey(email: string): string {
  const e = String(email ?? "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1) return e;
  const domain = e.slice(at + 1);
  if (domain !== "gmail.com" && domain !== "googlemail.com") return e;
  return e.slice(0, at).split("+")[0].replace(/\./g, "") + "@gmail.com";
}
/** サイトの持ち主（SITE_OWNERS。メールをカンマで）。空なら誰も持ち主ではなく、招待制にもならない */
export const siteOwners = (env: { SITE_OWNERS?: string }) => new Set(String(env.SITE_OWNERS ?? "").split(",").map((e) => emailKey(e)).filter((e) => e.includes("@")));
export const isSiteOwner = (env: { SITE_OWNERS?: string }, email: string) => siteOwners(env).has(emailKey(email));

/** このサイトに入れるか。SITE_OWNERS があるときは完全招待制（2026-10-22）: 持ち主と、どこかのチャンネルに招待されたメールだけ。
 *  招待されていない人は Google でログインしても入れず、印も作らない。招待を全部外された人も入れなくなる */
export async function mayEnter(env: { SITE_OWNERS?: string }, db: D1Database, email: string): Promise<boolean> {
  const own = siteOwners(env);
  if (!own.size || own.has(emailKey(email))) return true;
  await claimInvites(db, email);
  return !!(await one(db, "SELECT 1 AS x FROM members WHERE email = ?1 LIMIT 1", email.trim().toLowerCase()));
}

const isGmail = (email: string) => /@(gmail|googlemail)\.com$/i.test(email.trim());

/** 招待の書き方（点の有無・+・googlemail.com）が Google の返したメールと違っても、同じ受け箱なら本人の招待にする。
 *  招待の行をログインしたメールに書き換える（同じチャンネルに両方あれば、強い役割を残して 1 つに） */
export async function claimInvites(db: D1Database, email: string): Promise<number> {
  const real = email.trim().toLowerCase();
  if (!isGmail(real)) return 0;
  const key = emailKey(real);
  const rows = (await db.prepare("SELECT channel_id, email, role FROM members WHERE email != ?1 AND (email LIKE '%@gmail.com' OR email LIKE '%@googlemail.com')")
    .bind(real).all<{ channel_id: string; email: string; role: string }>()).results ?? [];
  const rank: Record<string, number> = { viewer: 0, editor: 1, owner: 2 };
  let n = 0;
  for (const r of rows) {
    if (emailKey(r.email) !== key) continue;
    const mine = await one<{ role: string }>(db, "SELECT role FROM members WHERE channel_id = ?1 AND email = ?2", r.channel_id, real);
    if (mine) {
      if ((rank[r.role] ?? 0) > (rank[mine.role] ?? 0)) await exec(db, "UPDATE members SET role = ?3 WHERE channel_id = ?1 AND email = ?2", r.channel_id, real, r.role);
      await exec(db, "DELETE FROM members WHERE channel_id = ?1 AND email = ?2", r.channel_id, r.email);
    } else {
      await exec(db, "UPDATE members SET email = ?3 WHERE channel_id = ?1 AND email = ?2", r.channel_id, r.email, real);
    }
    n++;
  }
  return n;
}

/** いまの人（cookie の印か、Bearer の鍵）。いなければ null */
export async function currentUser(req: Request, db: D1Database, now = Date.now()): Promise<Who | null> {
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (bearer?.startsWith(TOKEN_PREFIX)) {
    const h = await sha256(bearer);
    const u = await one<User>(db, "SELECT u.id, u.email, u.name, u.picture FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.hash = ?1 AND (t.expires_at IS NULL OR t.expires_at > ?2)", h, now);
    if (!u) return null;
    await exec(db, "UPDATE tokens SET last_used_at = ?2 WHERE hash = ?1", h, now);
    return { ...u, via: "token" };
  }
  const token = cookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const u = await one<User>(db,
    "SELECT u.id, u.email, u.name, u.picture FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.hash = ?1 AND s.expires_at > ?2",
    await sha256(token), now);
  return u ? { ...u, via: "cookie" } : null;
}

/** 書き換える要求が許される来かたか（鍵で来たもの、またはこの画面から来たもの） */
export function writable(req: Request, who: Who): boolean {
  if (who.via === "token") return true;
  const url = new URL(req.url);
  return req.headers.get("origin") === url.origin && req.headers.get("x-miru") === "1";
}

/** /auth/* の担当。担当でなければ null */
export async function handleAuth(req: Request, env: AuthEnv, fetcher: typeof fetch = fetch): Promise<Response | null> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (!p.startsWith("/auth/")) return null;
  const db = env.DB;
  // 手元の試し（wrangler dev の .dev.vars に DEV_LOGIN=1 と書いたときだけ）。本番には DEV_LOGIN を置かない
  if (p === "/auth/dev" && db && env.DEV_LOGIN === "1" && ["localhost", "127.0.0.1"].includes(url.hostname)) {
    const email = (url.searchParams.get("email") ?? "").toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) return json({ error: "email が要ります" }, 400);
    if (!(await mayEnter(env, db, email))) return redirect("/login?denied=1");
    await exec(db, "INSERT INTO users (id, email, name, picture, created_at) VALUES (?1, ?2, ?3, '', ?4) ON CONFLICT(id) DO NOTHING", "dev-" + email, email, email.split("@")[0], Date.now());
    await claimInvites(db, email);
    const token = random();
    await exec(db, "INSERT INTO sessions (hash, user_id, expires_at) VALUES (?1, ?2, ?3)", await sha256(token), "dev-" + email, Date.now() + 86_400_000);
    return redirect(safeNext(url.searchParams.get("next")), { "set-cookie": `__Host-miru_s=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400` });
  }
  if (!db || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return json({ error: "ログインはまだ用意されていません" }, 503);
  const redirectUri = `${url.origin}/auth/callback`;

  if (p === "/auth/google" && req.method === "GET") {
    const state = random(), verifier = random(48);
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const back = safeNext(url.searchParams.get("next"));
    const q = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: "code", scope: "openid email profile",
      state, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account",
    });
    return redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`, { "set-cookie": setCookie(FLOW_COOKIE, `${state}.${verifier}.${encodeURIComponent(back)}`, 600) });
  }

  if (p === "/auth/callback" && req.method === "GET") {
    const clear = setCookie(FLOW_COOKIE, "", 0);
    const [state, verifier, ...rest] = (cookies(req)[FLOW_COOKIE] ?? "").split(".");
    const nextEnc = rest.join(".");
    const code = url.searchParams.get("code");
    if (!state || !verifier || !code || url.searchParams.get("state") !== state) return redirect("/login?failed=1", { "set-cookie": clear });
    let claims: Record<string, unknown>;
    try {
      const res = await fetcher("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier,
        }),
      });
      if (!res.ok) return redirect("/login?failed=1", { "set-cookie": clear });
      const tok = await res.json() as { id_token?: string };
      const part = tok.id_token?.split(".")[1];
      if (!part) return redirect("/login?failed=1", { "set-cookie": clear });
      claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));
    } catch {
      return redirect("/login?failed=1", { "set-cookie": clear });
    }
    const okIss = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
    if (!okIss || claims.aud !== env.GOOGLE_CLIENT_ID || typeof claims.sub !== "string" || Number(claims.exp) * 1000 < Date.now() || claims.email_verified !== true) {
      return redirect("/login?failed=1", { "set-cookie": clear });
    }
    // 完全招待制: 招待されていないメールは、ここで断る（users にも sessions にも残さない）
    if (!(await mayEnter(env, db, String(claims.email ?? "")))) return redirect("/login?denied=1", { "set-cookie": clear });
    const user: User = { id: claims.sub, email: String(claims.email ?? "").toLowerCase(), name: String(claims.name ?? claims.email ?? ""), picture: String(claims.picture ?? "") };
    await exec(db,
      "INSERT INTO users (id, email, name, picture, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(id) DO UPDATE SET email = ?2, name = ?3, picture = ?4",
      user.id, user.email, user.name, user.picture, Date.now());
    await claimInvites(db, user.email);
    const token = random();
    await exec(db, "INSERT INTO sessions (hash, user_id, expires_at) VALUES (?1, ?2, ?3)", await sha256(token), user.id, Date.now() + SESSION_DAYS * 86_400_000);
    let next = "/";
    try { next = safeNext(decodeURIComponent(nextEnc ?? "/")); } catch { /* 既定のまま */ }
    const h = new Headers({ location: next, "cache-control": "no-store" });
    h.append("set-cookie", clear);
    h.append("set-cookie", setCookie(SESSION_COOKIE, token, SESSION_DAYS * 86_400));
    return new Response(null, { status: 302, headers: h });
  }

  if (p === "/auth/logout") {
    if (req.method !== "POST" || req.headers.get("origin") !== url.origin || req.headers.get("x-miru") !== "1") return json({ error: "この画面からだけ" }, 403);
    const token = cookies(req)[SESSION_COOKIE];
    if (token) await exec(db, "DELETE FROM sessions WHERE hash = ?1", await sha256(token));
    return json({ ok: true }, 200, { "set-cookie": setCookie(SESSION_COOKIE, "", 0) });
  }
  return json({ error: "ありません" }, 404);
}
