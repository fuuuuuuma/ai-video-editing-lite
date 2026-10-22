// AI（Workers AI）と入力の候補（2026-10-19）。
//
// tidy    … 音声入力の修正指示を、意味を変えずに読みやすい一文へ。種類（字幕・カット・演出・音・画像・その他）も付ける。
//           AI が使えないときは、言葉の手がかりで種類だけ付けて文はそのまま返す。
// suggest … 打っている途中の指示の続きの候補。これまでの指示から出す（AI を待たないので速い）。

import type { Who } from "./auth";
import { many } from "./db";
import type { Env } from "./api";

export const CATEGORIES = ["字幕", "カット", "演出", "音", "画像", "その他"] as const;
const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export function guessCategory(text: string): string {
  const t = text;
  if (/テロップ|字幕|誤字|文字|ポイント|Point|強調/.test(t)) return /強調|ポイント|Point/.test(t) ? "演出" : "字幕";
  if (/カット|切|間|詰め|言い直し|残して|戻して/.test(t)) return "カット";
  if (/BGM|SE|効果音|音量|音/.test(t)) return "音";
  if (/サムネ|画像|QR|モザイク|ぼかし/.test(t)) return "画像";
  if (/演出|ズーム|寄り|アニメ|動き/.test(t)) return "演出";
  return "その他";
}

export async function aiTidy(env: Env, body: { text?: string }): Promise<{ text: string; category: string; ai: boolean }> {
  const raw = String(body.text ?? "").trim().slice(0, 1500);
  if (!raw) return { text: "", category: "その他", ai: false };
  if (!env.AI) return { text: raw, category: guessCategory(raw), ai: false };
  try {
    const out = await env.AI.run(env.AI_MODEL ?? DEFAULT_MODEL, {
      messages: [
        { role: "system", content:
          "あなたは動画編集の修正指示を整える係です。音声入力で書かれた指示を、意味・数値・固有名詞を一切変えずに、" +
          "句読点と言いよどみ（えー、あの、なんか 等）だけ直した読みやすい日本語にします。足し算や推測はしません。" +
          `種類を次から1つ選びます: ${CATEGORIES.join("・")}。出力は JSON だけ: {"text": "...", "category": "..."}` },
        { role: "user", content: raw },
      ],
      max_tokens: 600,
      temperature: 0.1,
    }) as { response?: string | Record<string, unknown> };
    const r = out.response;
    const obj = typeof r === "string" ? JSON.parse(r.slice(r.indexOf("{"), r.lastIndexOf("}") + 1)) : r;
    const text = String(obj?.text ?? "").trim();
    const category = CATEGORIES.includes(obj?.category as never) ? String(obj?.category) : guessCategory(raw);
    // 長さが大きく変わったら、言い換えすぎたとみなして元の文を使う
    if (!text || text.length < raw.length * 0.5 || text.length > raw.length * 1.3 + 20) return { text: raw, category, ai: true };
    return { text, category, ai: true };
  } catch {
    return { text: raw, category: guessCategory(raw), ai: false };
  }
}

export async function aiSuggest(env: Env, who: Who, body: { text?: string; videoId?: string }): Promise<{ suggestions: string[] }> {
  const q = String(body.text ?? "").trim();
  if (q.length < 2) return { suggestions: [] };
  const tail = q.slice(-12);
  const like = `%${tail.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
  // 見られるチャンネルの、これまでの指示から（同じ言い回しが多い順）
  const rows = await many<{ text: string; n: number }>(env.DB,
    "SELECT n.text, count(*) AS n FROM notes n JOIN videos v ON v.id = n.video_id JOIN members m ON m.channel_id = v.channel_id AND m.email = ?2 " +
    "WHERE n.text LIKE ?1 ESCAPE '\\' GROUP BY n.text ORDER BY n DESC LIMIT 40", like, who.email.toLowerCase());
  const out: string[] = [];
  for (const r of rows) {
    const i = r.text.indexOf(tail);
    if (i < 0) continue;
    // 打った所から先（句点か改行まで）を続きとして出す
    const rest = r.text.slice(i + tail.length).split(/[。\n]/)[0];
    const s = (q + rest).slice(0, 200);
    if (rest && !out.includes(s)) out.push(s);
    if (out.length >= 5) break;
  }
  return { suggestions: out };
}
