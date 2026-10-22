// MCP（Claude Code とこのサイトをつなぐ。2026-10-19）。
//
//   claude mcp add --transport http miru https://<サイト>/mcp --header "Authorization: Bearer miru_…"
//
// Streamable HTTP の、状態を持たない形（POST 1 回に JSON 1 つで答える）。鍵は設定の画面で本人が作る。
// 道具は API（worker/api.ts）を同じ鍵で呼ぶだけなので、見られる範囲・できることは画面と同じ。
// 大きなファイル（プレビューの動画）は MCP ではなく、スキルの scripts/miru_sync.py publish が API へ直接上げる。

import { json } from "./auth";
import { handleApi, type Env } from "./api";

const PROTOCOL = "2025-06-18";

type Tool = { name: string; description: string; inputSchema: Record<string, unknown>; run(a: Record<string, string>, call: Caller, origin: string): Promise<unknown> };
type Caller = (method: string, path: string, body?: unknown) => Promise<unknown>;
const str = (description: string) => ({ type: "string", description });
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required });

export const TOOLS: Tool[] = [
  { name: "list_channels", description: "見られるチャンネルの一覧（動画の数・未対応の修正指示の数）", inputSchema: obj({}),
    run: (_a, call) => call("GET", "/api/channels") },
  { name: "list_videos", description: "チャンネルの動画の一覧（状態・最新の版・未対応の修正指示の数）", inputSchema: obj({ channel: str("チャンネルの名前（susume など）") }, ["channel"]),
    run: (a, call) => call("GET", `/api/channels/${enc(a.channel)}/videos`) },
  { name: "get_review", description: "動画の確認状況: 版の一覧・修正指示（全部）・画面での手直しの件数。次の版を作る前に読む", inputSchema: obj({ video: str("動画の名前") }, ["video"]),
    async run(a, call, origin) {
      const v = await call("GET", `/api/videos/${enc(a.video)}`) as Record<string, unknown>;
      const notes = await call("GET", `/api/videos/${enc(a.video)}/notes`);
      const cap = await call("GET", `/api/videos/${enc(a.video)}/edits/caption`) as { items?: unknown[] };
      const cut = await call("GET", `/api/videos/${enc(a.video)}/edits/cut`) as { items?: unknown[] };
      return { ...v, notes, edits: { caption: cap.items?.length ?? 0, cut: cut.items?.length ?? 0 }, link: `${origin}/v/${enc(a.video)}` };
    } },
  { name: "get_edits", description: "画面での手直し（字幕・カット）の中身。手元の planning/caption-edits.json・cut-edits.json と同じ形", inputSchema: obj({ video: str("動画の名前"), kind: { type: "string", enum: ["caption", "cut"] } }, ["video", "kind"]),
    run: (a, call) => call("GET", `/api/videos/${enc(a.video)}/edits/${a.kind === "cut" ? "cut" : "caption"}`) },
  { name: "reply_note", description: "修正指示に返事を書き、状態を変える（open・doing・done）", inputSchema: obj({ video: str("動画の名前"), note: str("修正指示の id"), reply: str("返事"), status: { type: "string", enum: ["open", "doing", "done"] } }, ["video", "note"]),
    run: (a, call) => call("PATCH", `/api/videos/${enc(a.video)}/notes/${enc(a.note)}`, { ...(a.reply !== undefined ? { reply: a.reply } : {}), ...(a.status ? { status: a.status } : {}) }) },
  { name: "set_video_status", description: "動画の状態を変える（editing 編集中・review 確認待ち・fixing 修正中・done 完了）", inputSchema: obj({ video: str("動画の名前"), status: { type: "string", enum: ["editing", "review", "fixing", "done"] } }, ["video", "status"]),
    run: (a, call) => call("PATCH", `/api/videos/${enc(a.video)}`, { status: a.status }) },
  { name: "preview_link", description: "動画の確認画面のリンク（版を省くと最新）", inputSchema: obj({ video: str("動画の名前"), version: str("v10 など") }, ["video"]),
    run: async (a, _call, origin) => ({ link: `${origin}/v/${enc(a.video)}${a.version ? `?ver=${enc(a.version)}` : ""}` }) },
];
const enc = (s: unknown) => encodeURIComponent(String(s ?? ""));

export async function handleMcp(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname !== "/mcp") return null;
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const auth = req.headers.get("authorization") ?? "";
  if (!/^Bearer\s+miru_/.test(auth)) return json({ error: "鍵（Authorization: Bearer miru_…）が要ります" }, 401, { "www-authenticate": "Bearer" });
  let msg: { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown> };
  try { msg = await req.json(); } catch { return rpcError(null, -32700, "JSON ではありません"); }
  if (Array.isArray(msg)) return rpcError(null, -32600, "まとめて送る形には対応していません");
  const id = msg.id ?? null;
  if (msg.method?.startsWith("notifications/")) return new Response(null, { status: 202 });

  const call: Caller = async (method, path, body) => {
    const r = await handleApi(new Request(url.origin + path, {
      method, headers: { authorization: auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    const out = r ? await r.json() as Record<string, unknown> : { error: "ありません" };
    if (!r || !r.ok) throw new Error(String(out.error ?? r?.status));
    return out;
  };
  switch (msg.method) {
    case "initialize":
      try { await call("GET", "/api/me"); } catch { return rpcError(id, -32001, "鍵が正しくありません（設定の画面で作り直してください）"); }
      return rpc(id, {
        protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "miru", version: "0.1.0" },
        instructions: "MIRU は動画の確認サイト。get_review で修正指示と手直しを読み、次の版を作ったらスキルの miru_sync.py publish で上げ、preview_link を相手に送る。",
      });
    case "ping": return rpc(id, {});
    case "tools/list": return rpc(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return rpcError(id, -32602, `道具 ${name} はありません`);
      try {
        const out = await tool.run((msg.params?.arguments ?? {}) as Record<string, string>, call, url.origin);
        return rpc(id, { content: [{ type: "text", text: JSON.stringify(out, null, 1) }], structuredContent: out });
      } catch (e) {
        return rpc(id, { content: [{ type: "text", text: `できませんでした: ${(e as Error).message}` }], isError: true });
      }
    }
    default: return rpcError(id, -32601, `${msg.method} には対応していません`);
  }
}
const rpc = (id: unknown, result: unknown) => json({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => json({ jsonrpc: "2.0", id, error: { code, message } });
