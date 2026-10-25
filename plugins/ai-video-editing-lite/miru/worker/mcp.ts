// MCP（Claude Code とこのサイトをつなぐ。2026-10-19）。
//
//   claude mcp add -s user --transport http miru https://<サイト>/mcp --header "Authorization: Bearer miru_…"
//
// Streamable HTTP の、状態を持たない形（POST 1 回に JSON 1 つで答える）。鍵は設定の画面で本人が作る。
// 道具は API（worker/api.ts）を同じ鍵で呼ぶだけなので、見られる範囲・できることは画面と同じ。
// 大きなファイル（プレビューの動画）は MCP ではなく、スキルの scripts/miru_sync.py publish が API へ直接上げる。

import { json } from "./auth";
import { handleApi, type Env } from "./api";
import type { Waiter } from "./notify";
import { editionOf, VERSION } from "./version";

const PROTOCOL = "2025-06-18";

type Tool = { name: string; description: string; inputSchema: Record<string, unknown>; run(a: Record<string, string>, call: Caller, origin: string): Promise<unknown> };
type Caller = (method: string, path: string, body?: unknown) => Promise<unknown>;
const str = (description: string) => ({ type: "string", description });
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required });

export const TOOLS: Tool[] = [
  { name: "list_channels", description: "見られるチャンネルの一覧（動画の数・未対応の修正指示の数）", inputSchema: obj({}),
    run: (_a, call) => call("GET", "/api/channels") },
  { name: "list_videos", description: "チャンネルの動画の一覧（状態・最新の版・未対応の修正指示の数）", inputSchema: obj({ channel: str("チャンネルの名前（my-channel など）") }, ["channel"]),
    run: (a, call) => call("GET", `/api/channels/${enc(a.channel)}/videos`) },
  { name: "get_review", description: "動画の確認状況: 版の一覧（いちばん新しい見られる版に approved_by・approved_at があり、そのあとの未対応の修正指示が無ければ承認済み＝完成版を作ってよい。古い版の承認は、その後に直した版があれば済んだもの）・修正指示（全部）・画面での手直しの件数。次の版を作る前に読む", inputSchema: obj({ video: str("動画の名前") }, ["video"]),
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
  { name: "get_channel_kit", description: "チャンネルのトンマナ（字幕の見た目・続けるルール）と、採用済みの強調デザイン。編集の前に読み、採用済みのデザインだけを使う。スキルでは miru_sync.py kit-pull が同じものを手元の記憶に入れる", inputSchema: obj({ channel: str("チャンネルの名前（my-channel など。list_channels の id）") }, ["channel"]),
    async run(a, call) {
      const k = await call("GET", `/api/channels/${enc(a.channel)}/kit`) as { kit: Record<string, unknown> | null; role: string; updated_at: number | null; updated_by: string | null };
      const d = await call("GET", `/api/channels/${enc(a.channel)}/designs`) as { roles: unknown[]; designs: { id: string; role: string; name: string; status: string; memo?: string }[] };
      const adopted = d.designs.filter((x) => x.status === "adopt");
      return {
        channel: a.channel, your_role: k.role, ready: !!k.kit, updated_at: k.updated_at, updated_by: k.updated_by, kit: k.kit, roles: d.roles,
        adopted_designs: adopted.map(({ id, role, name, memo }) => ({ id, role, name, memo })),
        not_adopted: d.designs.length - adopted.length,
        note: k.kit ? "このトンマナと採用済みの強調デザインだけで編集する（不採用・未決定のデザインは使わない）"
          : "このチャンネルのトンマナはまだありません。カットだけの仮編集（字幕・強調なし）なら誰でも進められる（スキルの build.py plan --cut-only）。字幕と強調は、管理者がトンマナを作って kit-push したあとに付ける",
      };
    } },
  { name: "install_editor", description: "MIRU AI動画編集（素材からカット・字幕・強調テロップ入りの動画を作り、MIRU に上げるスキル）を、この PC に入れる・新しい版にするための 10 分だけ使えるリンクと手順。スキルが無いとき・miru_sync.py が見つからないときに使う", inputSchema: obj({}),
    async run(_a, call) {
      const t = await call("POST", "/api/editor/ticket") as { version: string; sha256: string; size: number; url: string; expires_in: number };
      const z = "miru-ai-video-editing";
      return {
        version: t.version, sha256: t.sha256, size: t.size, download_url: t.url, expires_in_seconds: t.expires_in,
        install_to: { claude_code: `~/.claude/skills/${z}`, codex: `~/.agents/skills/${z}` },
        steps: [
          `いま使っているアプリに合わせて入れ先 D を決める（Claude Code は ~/.claude/skills、Codex は ~/.agents/skills。Windows は %USERPROFILE%\\.claude\\skills か %USERPROFILE%\\.agents\\skills）。D/${z} がリンク（開発元の写し）なら上書きしない`,
          `D/${z}/VERSION が ${t.version} と同じなら入れ直さない`,
          `Mac・Linux: curl -fL "${t.url}" -o /tmp/${z}.zip && echo "${t.sha256}  /tmp/${z}.zip" | shasum -a 256 -c && rm -rf "D/${z}" && mkdir -p D && unzip -q /tmp/${z}.zip -d D`,
          `Windows（PowerShell）: Invoke-WebRequest "${t.url}" -OutFile $env:TEMP\\${z}.zip; if ((Get-FileHash $env:TEMP\\${z}.zip -Algorithm SHA256).Hash -ne "${t.sha256}") { throw "壊れています" }; Remove-Item -Recurse -Force D\\${z} -ErrorAction SilentlyContinue; Expand-Archive $env:TEMP\\${z}.zip -DestinationPath D`,
          `入れたら D/${z}/SKILL.md を読み、その「最初に」（setup.py・version・channels・kit-pull）から進める。MIRU に上げる鍵はこの MCP の設定から読むので、鍵のファイルを別に置かなくてよい`,
          "新しいスキルは次のチャットから自動で使われる。いまのチャットでは SKILL.md を読んでそのとおりに進める",
        ],
      };
    } },
];
const enc = (s: unknown) => encodeURIComponent(String(s ?? ""));

// MIRU ライト（視聴者が自分の Cloudflare に立てたもの）では、編集は AI動画編集 lite が手元の記憶（作風）で行う。
// トンマナの共有と編集スキルの配布は個人用 MIRU の作りなので、ライトでは道具に出さない（API は残るが使われない）
const PERSONAL_ONLY = new Set(["get_channel_kit", "install_editor"]);
export const toolsFor = (env: { MIRU_EDITION?: string }) => (editionOf(env) === "light" ? TOOLS.filter((t) => !PERSONAL_ONLY.has(t.name)) : TOOLS);
const LITE_REPO = "fuuuuuuma/ai-video-editing-lite";
const INSTRUCTIONS = {
  personal: "MIRU は動画の確認サイト。素材の編集を頼まれたら、スキル『MIRU AI動画編集』（miru-ai-video-editing）で編集する。" +
    "スキルが無い・miru_sync.py が見つからないときは install_editor で入れる（この MCP の鍵だけで入り、上げるときも同じ鍵を使う）。" +
    "編集の前に、どのチャンネルの動画かを list_channels で決め、そのチャンネルのトンマナと採用済みの強調デザインを get_channel_kit（スキルでは miru_sync.py kit-pull）で読み、採用済みのものだけを使う。" +
    "トンマナがまだ無いチャンネルでも、カットだけの仮編集はできる。" +
    "できたら miru_sync.py publish でそのチャンネルに上げ、preview_link を送る。修正は get_review で読み、reply_note で返事する。" +
    "get_review のいちばん新しい見られる版に approved_by があり、そのあとの未対応の修正指示が無ければ承認済み。書き出しと、完成版を MIRU に置く（miru_sync.py deliver）かは利用者に聞いてから。",
  light: "MIRU ライトは、AI動画編集 lite（ai-video-editing-lite）が作った動画を見て修正指示を書く確認サイト（利用者が自分の Cloudflare に立てたもの）。" +
    "素材の編集を頼まれたら、スキル ai-video-editing-lite で編集する（Claude Code は /ai-video-editing-lite:ai-video-editing-lite、Codex は $ai-video-editing-lite）。" +
    `スキルが無いときは、利用者に自分のターミナルで入れてもらう（Claude Code: claude plugin marketplace add ${LITE_REPO} → claude plugin install ai-video-editing-lite@ai-video-editing-lite。` +
    `Codex: codex plugin marketplace add ${LITE_REPO} → codex plugin add ai-video-editing-lite@ai-video-editing-lite）。` +
    "作風（字幕・強調の見た目）は lite がこの PC に覚えている。できた動画は lite の scripts/miru_sync.py publish で上げ、preview_link を送る。" +
    "修正は get_review と get_edits で読み、次の版を作ったら reply_note で返事する。" +
    "get_review のいちばん新しい見られる版に approved_by があり、そのあとの未対応の修正指示が無ければ、その版は承認済み（見る人の OK）。完成版を書き出すかを利用者に聞いてから、lite の手順で書き出す。" +
    "書き出した完成版を相手に渡すときは、利用者に聞いてから lite の scripts/miru_sync.py deliver で、承認された版に置く（容量を使う。渡し終えたら管理者が MIRU の画面で消せる）。" +
    "MIRU そのものを立てる・つなぐ・新しい版にする・自分用に直すときは、スキル miru-setup（Claude Code は /ai-video-editing-lite:miru-setup、Codex は $miru-setup）を使う。",
};

// ctx は通知（reply_note の「返事しました」など）を応答の後も送り切るため（2026-10-25。渡していなかったので、MCP からの返事は通知が捨てられていた）
export async function handleMcp(req: Request, env: Env, ctx?: Waiter): Promise<Response | null> {
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
    }), env, ctx);
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
        serverInfo: { name: "miru", version: VERSION.build ? String(VERSION.build) : "dev" },
        instructions: INSTRUCTIONS[editionOf(env)],
      });
    case "ping": return rpc(id, {});
    case "tools/list": return rpc(id, { tools: toolsFor(env).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const tool = toolsFor(env).find((t) => t.name === name);
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
