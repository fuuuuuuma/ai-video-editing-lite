// 修正指示に付ける線（2026-10-25。確認画面の「描く」= src/review/compare.ts）。
// 形の決まったものだけを残す（画面は線を canvas に描くだけで HTML には入れないが、色と数は決まった範囲に絞る）。
// 1 件の大きさは、線 20 本・点 400 個まで（0〜1000 の整数）。JSON で 4000 文字ほどに収まる。
export const DRAW_COLORS = ["#ff3b30", "#ffd60a", "#0a84ff", "#ffffff"];
export type Drawing = { v: 1; s: { c: string; w: number; p: number[] }[] };

/** 受け取った線を確かめて、使える形に直す。使えなければ null */
export function cleanDrawing(x: unknown): Drawing | null {
  const s = (x as { s?: unknown })?.s;
  if (!Array.isArray(s) || !s.length || s.length > 20) return null;
  let points = 0;
  const out: Drawing = { v: 1, s: [] };
  for (const st of s as { c?: unknown; w?: unknown; p?: unknown }[]) {
    const p = st?.p;
    if (!Array.isArray(p) || p.length < 2 || p.length % 2) return null;
    if (!p.every((n) => Number.isInteger(n) && n >= 0 && n <= 1000)) return null;
    points += p.length / 2;
    if (points > 400) return null;
    out.s.push({ c: DRAW_COLORS.includes(String(st.c)) ? String(st.c) : DRAW_COLORS[0], w: Math.min(20, Math.max(1, Math.round(Number(st.w) || 6))), p: p as number[] });
  }
  return out;
}

const COLOR_NAMES: Record<string, string> = { "#ff3b30": "赤", "#ffd60a": "黄", "#0a84ff": "青", "#ffffff": "白" };
/** 画面のどのあたりか（0〜100 の横・縦の中心から） */
function areaOf(cx: number, cy: number): string {
  const h = cx < 34 ? "左" : cx > 66 ? "右" : "", v = cy < 34 ? "上" : cy > 66 ? "下" : "";
  return h && v ? h + v : v ? `${v}の中央` : h ? `${h}の中ほど` : "真ん中";
}
/** 描いた線を、AI が読める言葉にする（2026-10-25 の点検: MCP では数字の並びのまま渡り、場所が伝わらなかった）。
 *  線ごとに色と場所を出す（まとめると、離れた印が「真ん中」になった）。lite の miru_sync.py の drawing_hint と同じ形 */
export function drawingHint(d: unknown): string | null {
  const s = ((d as { s?: { c?: string; p?: number[] }[] })?.s ?? []).filter((st) => Array.isArray(st?.p) && st.p.length >= 2);
  if (!s.length) return null;
  const one = (st: { c?: string; p?: number[] }) => {
    const xs = st.p!.filter((_, i) => i % 2 === 0), ys = st.p!.filter((_, i) => i % 2 === 1);
    const x0 = Math.min(...xs) / 10, x1 = Math.max(...xs) / 10, y0 = Math.min(...ys) / 10, y1 = Math.max(...ys) / 10;
    return `${COLOR_NAMES[st.c ?? ""] ?? "赤"}（画面の${areaOf((x0 + x1) / 2, (y0 + y1) / 2)}。横 ${Math.round(x0)}〜${Math.round(x1)}%・縦 ${Math.round(y0)}〜${Math.round(y1)}%）`;
  };
  const parts = s.slice(0, 6).map(one);
  return `映像に描いた線 ${s.length} 本: ${parts.join("、")}${s.length > 6 ? `、ほか ${s.length - 6} 本` : ""}`;
}
