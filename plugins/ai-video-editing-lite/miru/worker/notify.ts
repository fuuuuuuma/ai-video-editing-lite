// 通知（2026-10-24）。新しい版・修正指示・返事・承認を、チャンネルの管理者が決めた Slack か Discord の Incoming Webhook に送る。
// 同種サービスの調査で一番要るとされたもの（見に行かないと何も分からず、新しい版や指示を取りこぼす）。
// 送り先が空なら何もしない。送れなくても本来の操作は止めない（ログに残すだけ）。
import { one, type D1Database } from "./db";

/** 送ってよい送り先か。Slack・Discord の Incoming Webhook の形だけ（ほかの宛先へは送らない） */
export function hookKind(url: string): "slack" | "discord" | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  if (u.hostname === "hooks.slack.com" && /^\/services\/[\w-]+\/[\w-]+\/[\w-]+$/.test(u.pathname)) return "slack";
  if (["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"].includes(u.hostname) && /^\/api\/webhooks\/\d+\/[\w-]+$/.test(u.pathname)) return "discord";
  return null;
}

/** 送り先の形に合わせた本文。Slack は &・<・> を書き換える（2026-10-25。指示や題名に <!channel> と書くと、チャンネル全員に通知が飛んだ） */
export function hookBody(kind: "slack" | "discord", text: string): string {
  const t = text.slice(0, 1900);
  return JSON.stringify(kind === "slack" ? { text: t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") } : { content: t, allowed_mentions: { parse: [] } });
}

export type Waiter = { waitUntil(p: Promise<unknown>): void } | undefined;
/** 送った結果。送り先が無いときは sent: false。「試しに送る」が、相手に断られたことを画面に返すため */
export type Sent = { sent: boolean; ok: boolean; status?: number };

/** チャンネルの送り先へ送る（返事は待たない。ctx があれば応答の後も送り切る） */
export function notify(db: D1Database, ctx: Waiter, channelId: string, text: string, fetcher: typeof fetch = fetch): Promise<Sent> {
  const p = (async (): Promise<Sent> => {
    const r = await one<{ notify_url: string | null; name: string }>(db, "SELECT notify_url, name FROM channels WHERE id = ?1", channelId);
    const kind = r?.notify_url ? hookKind(r.notify_url) : null;
    if (!r?.notify_url || !kind) return { sent: false, ok: false };
    const res = await fetcher(r.notify_url, { method: "POST", headers: { "content-type": "application/json" }, body: hookBody(kind, `【${r.name}】${text}`),
      signal: AbortSignal.timeout(5000) });
    if (!res.ok) console.error(JSON.stringify({ at: "notify", channel: channelId, status: res.status }));
    return { sent: true, ok: res.ok, status: res.status };
  })().catch((e): Sent => { console.error(JSON.stringify({ at: "notify", channel: channelId, error: String(e) })); return { sent: true, ok: false }; });
  ctx?.waitUntil(p);
  return p;
}
