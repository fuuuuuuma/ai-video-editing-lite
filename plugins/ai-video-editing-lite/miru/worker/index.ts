// MIRU の入口（2026-10-19）。MCP → ログイン → API・動画 → 画面（静的ファイル）の順に担当を探す。
import { handleAuth } from "./auth";
import { cleanup, handleApi, sweepDiag, type Env } from "./api";
import { handleMcp } from "./mcp";

type Full = Env & { ASSETS: { fetch(req: Request): Promise<Response> }; GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string };

const SECURITY: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "SAMEORIGIN",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

export default {
  async fetch(req: Request, env: Full, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const res = (await handleMcp(req, env, ctx)) ?? (await handleAuth(req, env)) ?? (await handleApi(req, env, ctx)) ?? (await env.ASSETS.fetch(req));
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY)) if (!out.headers.has(k)) out.headers.set(k, v);
    return out;
  },
  // 毎日の掃除（wrangler.jsonc の triggers.crons）
  async scheduled(_ev: unknown, env: Full): Promise<void> {
    try { console.log(JSON.stringify({ at: "cleanup", ...(await cleanup(env)), diag: await sweepDiag(env) })); }
    catch (e) { console.error(JSON.stringify({ at: "cleanup", error: String((e as Error)?.stack ?? e) })); }
  },
};
