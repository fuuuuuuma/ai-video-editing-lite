// 打ち直した字幕を、書き出しと同じ描き方でブラウザの中で絵にする（2026-10-20）。
// スキルの scripts/caption_style.py と styled_text.make_text_image を写したもの:
//   文字の形（mask）→ 影（四角く広げる MaxFilter → ぼかす GaussianBlur → 不透明度 → 色）を後ろから重ねる
//   → 縁（文字の輪郭に沿う太線）を太い順に → 文字（単色か縦・横のグラデーション）→ 置き場所（白い字の上端・下端で合わせる）
// 字間の詰め（palt）は、ブラウザの CSS に文字の位置を測らせて同じにする。書体は配ってよい OFL のものだけがサイトに置いてある。

type Shadow = { color: string; spread?: number; blur?: number; opacity?: number; dx?: number; dy?: number; enabled?: boolean };
type Stroke = { width: number; color: string; enabled?: boolean };
export type TextItem = {
  font?: string | null; font_size?: number; color?: string; padding?: number; spacing?: number; proportional_spacing?: boolean;
  strokes?: Stroke[]; shadows?: Shadow[]; stroke_width?: number; stroke_color?: string;
  fill_gradient?: { axis?: "vertical" | "horizontal"; stops: { position: number; color: string }[] };
  text_scale_x?: number; text_scale_y?: number; background?: string;
};
export type CaptionStyle = {
  normal: Record<string, TextItem>;
  normal_place?: { one_line_top?: number; two_line_bottom?: number; center_x?: number; max_width?: number };
  emphasis: Record<string, TextItem>;
  emphasis_place?: { bottom?: number; min_top?: number; center_x?: number; max_width?: number; max_size?: number; spacing_ratio?: number; padding?: number };
};

const loaded = new Map<string, Promise<string>>();
/** 書体を読み込み、その名前を返す */
function family(fontUrl: string): Promise<string> {
  let p = loaded.get(fontUrl);
  if (!p) {
    const name = "miru-" + loaded.size;
    p = new FontFace(name, `url(${JSON.stringify(fontUrl)})`).load().then((f) => { document.fonts.add(f); return name; });
    p.catch(() => loaded.delete(fontUrl));
    loaded.set(fontUrl, p);
  }
  return p;
}

function rgba(color: string): [number, number, number, number] {
  const c = document.createElement("canvas").getContext("2d")!;
  c.fillStyle = "#000"; c.fillStyle = color;
  const v = c.fillStyle as string;               // #rrggbb か rgba(…)
  if (v.startsWith("#")) return [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16), 255];
  const m = v.match(/[\d.]+/g)!.map(Number);
  return [m[0], m[1], m[2], Math.round((m[3] ?? 1) * 255)];
}

/** 各行の文字の置き場所（行の左端から）。palt はブラウザの CSS に測らせる */
function layout(text: string, fam: string, size: number, palt: boolean) {
  const box = document.createElement("div");
  box.style.cssText = `position:absolute;left:-99999px;top:0;white-space:pre;font-family:${fam};font-size:${size}px;line-height:1;` +
    `font-feature-settings:${palt ? '"palt" 1' : "normal"};font-kerning:normal`;
  document.body.append(box);
  const lines = text.normalize("NFC").split("\n").map((line) => {
    box.textContent = line;
    const node = box.firstChild as Text | null;
    const base = box.getBoundingClientRect().left;
    const chars: { ch: string; x: number }[] = [];
    let width = 0;
    const r = document.createRange();
    for (let i = 0; node && i < line.length; ) {
      const cp = line.codePointAt(i)!; const n = cp > 0xffff ? 2 : 1;
      r.setStart(node, i); r.setEnd(node, i + n);
      const b = r.getBoundingClientRect();
      chars.push({ ch: line.slice(i, i + n), x: b.left - base });
      width = Math.max(width, b.right - base);
      i += n;
    }
    return { chars, width };
  });
  box.remove();
  return lines;
}

/** 正方形の窓での最大（PIL の MaxFilter(2r+1)） */
function dilate(a: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r <= 0) return a.slice();
  const t = new Float32Array(a.length), o = new Float32Array(a.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0; const row = y * w;
    for (let k = Math.max(0, x - r), e = Math.min(w - 1, x + r); k <= e; k++) if (a[row + k] > m) m = a[row + k];
    t[row + x] = m;
  }
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    let m = 0;
    for (let k = Math.max(0, y - r), e = Math.min(h - 1, y + r); k <= e; k++) if (t[k * w + x] > m) m = t[k * w + x];
    o[y * w + x] = m;
  }
  return o;
}

/** PIL の GaussianBlur(radius)（端の重みが小数の箱ぼかし 3 回。Pillow の _gaussian_blur_radius と同じ） */
function gaussian(a: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0) return a;
  const passes = 3, s2 = (sigma * sigma) / passes;
  const L = Math.sqrt(12 * s2 + 1), l = Math.floor((L - 1) / 2);
  const frac = ((2 * l + 1) * (l * (l + 1) - 3 * s2)) / (6 * (s2 - (l + 1) * (l + 1)));
  const norm = 2 * l + 1 + 2 * frac;
  const pass = (src: Float32Array, dst: Float32Array, n: number, count: number, at: (i: number, j: number) => number) => {
    for (let j = 0; j < count; j++) for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = -l; k <= l; k++) s += src[at(Math.min(n - 1, Math.max(0, i + k)), j)];
      s += frac * (src[at(Math.min(n - 1, Math.max(0, i - l - 1)), j)] + src[at(Math.min(n - 1, Math.max(0, i + l + 1)), j)]);
      dst[at(i, j)] = s / norm;
    }
  };
  let x = a.slice(), y = new Float32Array(a.length);
  for (let p = 0; p < passes; p++) { pass(x, y, w, h, (i, j) => j * w + i); [x, y] = [y, x]; }
  for (let p = 0; p < passes; p++) { pass(x, y, h, w, (i, j) => i * w + j); [x, y] = [y, x]; }
  return x;
}

/** 文字の絵（RGBA の Float32、0〜255）と、白い字の範囲 */
async function makeTextImage(item: TextItem, text: string, fontUrl: (key: string) => string) {
  if (!item.font) throw new Error("この書体はサイトに置けないので、仮の表示にします");
  const fam = await family(fontUrl(item.font));
  const size = item.font_size ?? 60, spacing = item.spacing ?? 8;
  const strokes = (item.strokes?.length ? item.strokes : item.stroke_width ? [{ width: item.stroke_width, color: item.stroke_color ?? "black" }] : [])
    .filter((s) => s.enabled !== false);
  const shadows = (item.shadows ?? []).filter((s) => s.enabled !== false);
  const maxStroke = Math.max(0, ...strokes.map((s) => s.width));
  const effect = Math.max(maxStroke, ...shadows.map((s) => maxStroke + (s.spread ?? 0) + 3 * (s.blur ?? 0) + Math.max(Math.abs(s.dx ?? 0), Math.abs(s.dy ?? 0))));
  const pad = Math.ceil(effect) + (item.padding ?? 8);
  const lines = layout(text, fam, size, !!item.proportional_spacing);
  const tw = Math.max(...lines.map((l) => l.width));
  const W = Math.ceil(tw) + 2 * pad + 8, H = Math.ceil(lines.length * (size + spacing) + size * 0.4) + 2 * pad;
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const g = cv.getContext("2d", { willReadFrequently: true })!;
  const ascent = size * 0.88;                  // 行の頭から基準線まで（書体の上端に近い所）
  const draw = (stroke: number) => {
    g.clearRect(0, 0, W, H);
    g.font = `${size}px ${fam}`; g.fillStyle = "#fff"; g.strokeStyle = "#fff"; g.lineJoin = "round"; g.lineWidth = stroke * 2;
    lines.forEach((ln, i) => {
      const ox = pad + 4 + (tw - ln.width) / 2, oy = pad + ascent + i * (size + spacing);
      for (const c of ln.chars) { if (stroke) g.strokeText(c.ch, ox + c.x, oy); g.fillText(c.ch, ox + c.x, oy); }
    });
    const d = g.getImageData(0, 0, W, H).data, a = new Float32Array(W * H);
    for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
    return a;
  };
  const mask = draw(0);
  const out = new Float32Array(W * H * 4);         // 色は 0〜255、不透明度も 0〜255（重ねるのは「上に置く」）
  const over = (alpha: Float32Array, color: [number, number, number, number], dx = 0, dy = 0, grad?: (x: number, y: number) => [number, number, number, number]) => {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const sx = x - dx, sy = y - dy;
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
      const c = grad ? grad(x, y) : color;
      const sa = (alpha[sy * W + sx] / 255) * (c[3] / 255);
      if (sa <= 0) continue;
      const i = (y * W + x) * 4, da = out[i + 3] / 255, oa = sa + da * (1 - sa);
      for (let k = 0; k < 3; k++) out[i + k] = (c[k] * sa + out[i + k] * da * (1 - sa)) / oa;
      out[i + 3] = oa * 255;
    }
  };
  for (const s of [...shadows].reverse()) {          // 先に書いたものが文字に近い
    let a = dilate(mask, W, H, Math.ceil(maxStroke + (s.spread ?? 0)));
    a = gaussian(a, W, H, s.blur ?? 0);
    const op = s.opacity ?? 1;
    for (let i = 0; i < a.length; i++) a[i] = Math.round(a[i] * op);
    over(a, rgba(s.color), Math.round(s.dx ?? 0), Math.round(s.dy ?? 0));
  }
  for (const s of [...strokes].sort((p, q) => q.width - p.width)) over(draw(Math.round(s.width)), rgba(s.color));
  const gr = item.fill_gradient;
  if (gr) {
    const stops = gr.stops.map((s) => ({ p: s.position, c: rgba(s.color) }));
    const vertical = (gr.axis ?? "vertical") === "vertical";
    const len = vertical ? H : W, gl = len - 2 * pad;
    const at = (x: number, y: number): [number, number, number, number] => {
      const t = Math.min(1, Math.max(0, ((vertical ? y : x) - pad) / Math.max(1, gl - 1)));
      let k = 0; while (k < stops.length - 2 && t > stops[k + 1].p) k++;
      const a = stops[k], b = stops[k + 1], u = b.p > a.p ? Math.min(1, Math.max(0, (t - a.p) / (b.p - a.p))) : 0;
      return [0, 1, 2, 3].map((i) => a.c[i] + (b.c[i] - a.c[i]) * u) as [number, number, number, number];
    };
    over(mask, [0, 0, 0, 0], 0, 0, at);
  } else over(mask, rgba(item.color ?? "white"));
  return { out, W, H };
}

function toCanvas(img: { out: Float32Array; W: number; H: number }, sx = 1, sy = 1) {
  const cv = document.createElement("canvas"); cv.width = img.W; cv.height = img.H;
  const g = cv.getContext("2d")!; const id = g.createImageData(img.W, img.H);
  for (let i = 0; i < img.out.length; i++) id.data[i] = Math.round(img.out[i]);
  g.putImageData(id, 0, 0);
  if (sx === 1 && sy === 1) return cv;
  const c2 = document.createElement("canvas"); c2.width = Math.round(img.W * sx); c2.height = Math.round(img.H * sy);
  const g2 = c2.getContext("2d")!; g2.imageSmoothingQuality = "high"; g2.drawImage(cv, 0, 0, c2.width, c2.height);
  return c2;
}
/** 範囲（白い字だけ、または不透明な所） */
function bbox(cv: HTMLCanvasElement, white: boolean) {
  const d = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
    const i = (y * cv.width + x) * 4;
    const ok = d[i + 3] > 200 && (!white || Math.min(d[i], d[i + 1], d[i + 2]) > 235);
    if (ok) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) throw new Error("字が見えません");
  return { x0, y0, x1, y1 };
}

/** caption_style.render と同じ: 絵（PNG の Blob）と置く場所 */
export async function renderCaption(style: CaptionStyle, kind: string, text: string, speaker: string | null, role: string | null,
  fontUrl: (key: string) => string): Promise<{ blob: Blob; x: number; y: number }> {
  const png = (cv: HTMLCanvasElement) => new Promise<Blob>((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error("絵にできません"))), "image/png"));
  if (kind !== "emphasis") {
    const item = { ...(style.normal[speaker && style.normal[speaker] ? speaker : "K"] ?? Object.values(style.normal)[0]) };
    const cv = toCanvas(await makeTextImage(item, text, fontUrl), item.text_scale_x, item.text_scale_y);
    const pl = style.normal_place ?? {};
    const b = bbox(cv, true);
    if (b.x1 - b.x0 > (pl.max_width ?? 1800)) throw new Error("1 行に入りません。2 行に分けてください");
    const x = (pl.center_x ?? 960) - Math.floor((b.x0 + b.x1) / 2);
    const y = text.includes("\n") ? (pl.two_line_bottom ?? 1026) - b.y1 : (pl.one_line_top ?? 941) - b.y0;
    return { blob: await png(cv), x, y };
  }
  const st = (role && style.emphasis[role]) || Object.values(style.emphasis)[0];
  const pl = style.emphasis_place ?? {};
  const render = async (size: number) => toCanvas(await makeTextImage({ ...st, font_size: size, padding: pl.padding ?? 6, spacing: Math.floor(size * (pl.spacing_ratio ?? 0.08)) }, text, fontUrl), st.text_scale_x, st.text_scale_y);
  let size = pl.max_size ?? 210;
  let cv = await render(size);
  let b = bbox(cv, false);
  if (b.x1 - b.x0 > (pl.max_width ?? 1800)) { size = Math.floor((size * (pl.max_width ?? 1800)) / (b.x1 - b.x0)) - 1; cv = await render(size); b = bbox(cv, false); }
  const bottom = pl.bottom ?? 1050, minTop = pl.min_top ?? 650;
  let visTop = 0;
  { const d = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data; outer: for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) if (d[(y * cv.width + x) * 4 + 3] > 0) { visTop = y; break outer; } }
  const top = bottom - b.y1 + visTop;
  if (top < minTop) {
    const k = (bottom - minTop) / (bottom - top);
    const c2 = document.createElement("canvas"); c2.width = Math.round(cv.width * k); c2.height = Math.round(cv.height * k);
    const g2 = c2.getContext("2d")!; g2.imageSmoothingQuality = "high"; g2.drawImage(cv, 0, 0, c2.width, c2.height);
    cv = c2; b = bbox(cv, false);
  }
  return { blob: await png(cv), x: (pl.center_x ?? 960) - Math.floor((b.x0 + b.x1) / 2), y: bottom - b.y1 };
}
