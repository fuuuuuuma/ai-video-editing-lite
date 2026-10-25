// 版の見比べと、画面への書き込み（2026-10-25。同種サービスの調査で、運用に要るとされたもの）。
// 確認画面（review.html）は手元の確認ページと同じものなので、そこには手を入れず、ページの関数と変数をそのまま使って上に重ねる。
//
// 見比べ: いまの場面を元素材の時刻に戻し、前の版の同じ場面を、前の版の軽い動画（字幕なし）で小さな窓に出して一緒に動かす。
//   前の版の字幕は、その版の manifest の文字を窓の下に出す。前の版に無い場面（新しく足した所）はそう出す。
// 書き込み: 「描く」で映像の上に赤い線を描き、次に書く修正指示に付ける。指示の場面に来ると、その線が映像の上に出る。
//   線は映像の大きさに対する 0〜1000 の整数で持つ（小さく保つ。MIRU は 1 件 4000 文字まで）。

declare const M: Json, FPS: number, audio: { currentTime: number; paused: boolean; playbackRate: number }, comments: { items: Json[] };
declare function frameNow(): number;
declare function sourceAt(f: number): { name: string; seconds: number };
declare function commentFrame(it: Json): number | null;
declare function hud(msg: string): void;
type Json = Record<string, any>;

export type Drawing = { v: 1; s: { c: string; w: number; p: number[] }[] };
export const DRAW_COLORS = ["#ff3b30", "#ffd60a", "#0a84ff", "#ffffff"];
const MAX_POINTS = 400, MAX_STROKES = 20;

const $ = (s: string) => document.querySelector(s) as HTMLElement | null;
const stageRect = () => $("#stage")!.getBoundingClientRect();

// ── 書き込み ──
// 描いた線は、描いた場面（コマと版）に結びつけ、その場面で書いた指示にだけ付ける（2026-10-25 の点検: 描いている途中に再生・移動すると、
// 別の場面の指示に付いた。「描く」を閉じても見えない線が残り、あとの指示に付いた）。
// 付けた線は指示の id で覚えておき、確認画面の「戻す → やり直す」や送り直しでも一緒に送る（覚えないと線が消えた）
let pending: { d: Drawing; frame: number; ver: string } | null = null;
const attached = new Map<string, Drawing>();
let drawMode = false, color = DRAW_COLORS[0];
let canvas: HTMLCanvasElement | null = null, bar: HTMLElement | null = null;

/** 描いた場面の指示: 同じ版で、指示のコマから終わり（無ければ 2 秒）までの間に描いたもの。画面が指示の線を出す間と同じ */
export function pickFor(post: Json[], frame: number, drawnVer: string, ver: string, fps: number): Json | null {
  return post.find((it) => (it.preview ?? ver) === drawnVer && typeof it.frame === "number"
    && frame >= it.frame - 1 && frame <= (typeof it.end_frame === "number" && it.end_frame > it.frame ? it.end_frame : it.frame + Math.round(2 * fps))) ?? null;
}

/** 新しく足す指示（cloud.ts の post）に描いた線を付ける。前に付けた線は id で、いま描いた線は描いた場面の指示にだけ */
export function attachDrawings(post: Json[], ver: string): void {
  for (const it of post) if (!it.drawing && typeof it.id === "string" && attached.has(it.id)) it.drawing = attached.get(it.id);
  if (!pending || !pending.d.s.length) return;
  const hit = pickFor(post, pending.frame, pending.ver, ver, FPS);
  if (hit) {
    hit.drawing = pending.d;
    if (typeof hit.id === "string") attached.set(hit.id, pending.d);
    pending = null;
    if (drawMode) setDrawMode(false);
  } else if (post.length) hud("描いた線は、描いた場面で書いた指示にだけ付きます（場面を動かしたので、この指示には付けていません）");
}

function ensureCanvas() {
  if (canvas) return canvas;
  canvas = document.createElement("canvas");
  canvas.id = "miruDraw";
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:7";     // 見比べの窓（6）より上（窓が線を隠した）
  $("#stageWrap")!.appendChild(canvas);
  let cur: { c: string; w: number; p: number[] } | null = null;
  const at = (e: PointerEvent) => {
    const r = stageRect();
    return [Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * 1000), Math.round(Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) * 1000)];
  };
  const points = () => (pending?.d.s ?? []).reduce((n, s) => n + s.p.length / 2, 0);
  canvas.addEventListener("pointerdown", (e) => {
    if (!drawMode) return;
    e.preventDefault(); e.stopPropagation();
    const f = frameNow();
    if (!pending || pending.frame !== f || pending.ver !== M.name) pending = { d: { v: 1, s: [] }, frame: f, ver: M.name };   // 別の場面で描き始めたら、そこから新しく
    if (pending.d.s.length >= MAX_STROKES || points() >= MAX_POINTS) { hud("線はここまでです（消してから描き直せます）"); return; }
    cur = { c: color, w: 6, p: at(e) };
    pending.d.s.push(cur);
    canvas!.setPointerCapture(e.pointerId);
    paint();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!cur) return;
    const [x, y] = at(e), n = cur.p.length;
    if (Math.hypot(x - cur.p[n - 2], y - cur.p[n - 1]) < 6 || points() >= MAX_POINTS) return;     // 細かすぎる点は持たない
    cur.p.push(x, y); paint();
  });
  const end = () => { cur = null; };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("click", (e) => { if (drawMode) e.stopPropagation(); });     // 描いている間は、押しても再生しない
  return canvas;
}

function setDrawMode(on: boolean) {
  drawMode = on;
  const c = ensureCanvas();
  c.style.pointerEvents = on ? "auto" : "none";
  c.style.touchAction = on ? "none" : "";
  c.style.cursor = on ? "crosshair" : "";
  $("#miruDrawBtn")?.classList.toggle("on", on);
  if (bar) bar.hidden = !on;
  if (on && !audio.paused) ($("#bPlay") as HTMLButtonElement | null)?.click();      // 止めてから描く
  if (on) hud("映像に描いて、修正指示を書くと一緒に残ります");
  paint();
}

/** 線を描く（描いている途中のもの＋いまの場面の指示に付いているもの） */
function paint() {
  const c = canvas;
  if (!c) return;
  const r = c.getBoundingClientRect(), d = devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, w, h);
  const s = stageRect(), ox = (s.left - r.left) * d, oy = (s.top - r.top) * d, sw = s.width * d, sh = s.height * d;
  const stroke = (st: { c: string; w: number; p: number[] }) => {
    if (st.p.length < 2) return;
    g.strokeStyle = DRAW_COLORS.includes(st.c) ? st.c : DRAW_COLORS[0];
    g.lineWidth = Math.max(2, (st.w / 1000) * sw * 0.6); g.lineCap = "round"; g.lineJoin = "round";
    g.shadowColor = "rgba(0,0,0,.55)"; g.shadowBlur = 4 * d;
    g.beginPath();
    for (let i = 0; i < st.p.length; i += 2) {
      const x = ox + (st.p[i] / 1000) * sw, y = oy + (st.p[i + 1] / 1000) * sh;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    if (st.p.length === 2) g.lineTo(ox + (st.p[0] / 1000) * sw + 0.1, oy + (st.p[1] / 1000) * sh);
    g.stroke();
  };
  // 描いている線は、描いた場面にいる間だけ出す（動かしたら、その線はこの場面のものではない）
  if (drawMode && pending && pending.ver === M.name && Math.abs(frameNow() - pending.frame) <= 1) for (const st of pending.d.s) stroke(st);
  if (!drawMode) {
    const f = frameNow();
    for (const it of comments.items) {
      if (!it.drawing?.s || it.status === "done") continue;          // 済んだ指示の線は出さない（直ったあとも「まだ」に見えた。2026-10-25 の点検）
      const fr = commentFrame(it);
      if (fr == null) continue;
      const end = it.end_frame && it.preview === M.name ? it.end_frame : fr + Math.round(2 * FPS);
      g.globalAlpha = it.preview === M.name ? 1 : 0.45;               // 前の版に書いた指示の線は薄く
      if (f >= fr - 1 && f <= end) for (const st of it.drawing.s) stroke(st);
    }
    g.globalAlpha = 1;
  }
}

// ── 見比べ ──
type Prev = { name: string; fps: number; byName: Map<string, Json[]>; caps: Json[]; flatUrl: string | null; frames: number };
let prev: Prev | null = null, cmpOn = false, box: HTMLElement | null = null, el: HTMLVideoElement | null = null;

/** 元素材の時刻から、前の版の出力のコマ（無ければ null） */
export function frameIn(byName: Map<string, Json[]>, fps: number, src: { name: string; seconds: number }): number | null {
  for (const c of byName.get(src.name) ?? []) {
    const d = (src.seconds - c.src) * fps;
    if (d >= -0.5 && d < c.end - c.start) return Math.min(c.end - 1, Math.max(c.start, Math.round(c.start + d)));
  }
  return null;
}

async function loadPrev(vid: string, name: string): Promise<Prev> {
  const base = `/m/${encodeURIComponent(vid)}/${encodeURIComponent(name)}/`;
  const m = await (await fetch(base + "manifest.json", { cache: "no-cache" })).json() as Json;
  const fps = (Number(m.fps_num) || 30) / (Number(m.fps_den) || 1);
  const byName = new Map<string, Json[]>();
  for (const c of m.clips ?? []) { if (!byName.has(c.source_name)) byName.set(c.source_name, []); byName.get(c.source_name)!.push(c); }
  const caps = (m.layers ?? []).filter((L: Json) => L.role === "caption" && typeof L.text === "string").map((L: Json) => ({ start: L.start, end: L.end, text: L.text }));
  const flatUrl = m.flat?.media ? `${base}media/${m.flat.media}?v=${encodeURIComponent(`${m.name ?? name}-${m.built_at ?? ""}`)}` : null;
  return { name, fps, byName, caps, flatUrl, frames: Number(m.frames) || 0 };
}

function ensureBox() {
  if (box) return box;
  box = document.createElement("div");
  box.id = "miruCmp";
  box.style.cssText = "position:absolute;z-index:6;border-radius:12px;overflow:hidden;" +
    "background:#000;box-shadow:0 8px 28px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.25);pointer-events:none";
  box.innerHTML = `<div style="position:relative;aspect-ratio:16/9"><video muted playsinline preload="auto" style="width:100%;height:100%;display:block;object-fit:contain"></video>
    <div data-none style="position:absolute;inset:0;display:none;align-items:center;justify-content:center;color:#fff;font:600 13px/1.4 system-ui;background:rgba(0,0,0,.72);text-align:center;padding:8px">前の版に無い場面です<br>（この版で足した所）</div>
    <div data-msg style="position:absolute;inset:0;display:none;align-items:center;justify-content:center;color:#fff;font:600 12px/1.4 system-ui;background:rgba(0,0,0,.72);text-align:center;padding:8px"></div></div>
    <div data-cap style="color:#fff;font:600 12px/1.4 system-ui;padding:6px 9px;background:rgba(0,0,0,.82);min-height:1.4em"></div>
    <div data-label style="position:absolute;top:6px;left:6px;color:#fff;font:700 11px/1 system-ui;background:rgba(0,0,0,.6);padding:4px 7px;border-radius:6px"></div>`;
  $("#stageWrap")!.appendChild(box);
  el = box.querySelector("video");
  el!.addEventListener("error", () => cmpMsg("前の版の動画を読めませんでした（消されたか、通信が切れています）"));
  return box;
}

/** 窓は映像の右上の内側に置く（映像の枠は画面より小さいことがある） */
function placeBox(b: HTMLElement) {
  const w = $("#stageWrap")!.getBoundingClientRect(), s = stageRect();
  const width = Math.min(s.width * (s.width < 520 ? 0.36 : 0.46), 600);     // スマホでは小さく（映像の右上を隠しすぎた）
  b.style.width = `${Math.round(width)}px`;
  b.style.left = `${Math.round(s.right - w.left - width - 8)}px`;
  b.style.top = `${Math.round(s.top - w.top + 8)}px`;
}

function syncCmp() {
  if (!cmpOn || !prev || !box || !el) return;
  placeBox(box);
  const f = frameNow();
  const pf = frameIn(prev.byName, prev.fps, sourceAt(f));
  const none = box.querySelector("[data-none]") as HTMLElement, cap = box.querySelector("[data-cap]") as HTMLElement;
  none.style.display = pf == null ? "flex" : "none";
  if (pf == null) { if (!el.paused) el.pause(); cap.textContent = ""; return; }
  const L = prev.caps.find((x) => x.start <= pf && pf < x.end);
  cap.textContent = L ? L.text : "";
  if (!prev.flatUrl) return;
  (box.querySelector("[data-label]") as HTMLElement).textContent = `${prev.name}（前の版）${el.readyState < 2 ? "・読み込み中" : ""}`;
  const t = (pf + 0.5) / prev.fps;
  if (audio.paused) {
    if (!el.paused) el.pause();
    if (!el.seeking && Math.abs(el.currentTime - t) > 0.6 / prev.fps) el.currentTime = t;
  } else {
    el.playbackRate = audio.playbackRate;
    if (el.paused) el.play().catch(() => {});
    if (!el.seeking && Math.abs(el.currentTime - t) > 0.2) el.currentTime = t;
  }
}

/** 窓の中に、見られない理由を出す（空なら消す）。1 秒で消える知らせだけだと、黒い窓の理由が分からなかった（2026-10-25 の点検） */
function cmpMsg(text: string) {
  const m = box?.querySelector("[data-msg]") as HTMLElement | null;
  if (m) { m.textContent = text; m.style.display = text ? "flex" : "none"; }
}

async function setCompare(on: boolean, vid: string, older: string[]) {
  if (on && !prev) {
    const pick = older[0];
    if (!pick) { hud("見比べる前の版がありません"); return; }
    try { prev = await loadPrev(vid, pick); } catch { hud("前の版を読めませんでした"); return; }
  }
  cmpOn = on;
  const b = ensureBox();
  b.hidden = !on;
  $("#miruCmpBtn")?.classList.toggle("on", on);
  if (on && prev) {
    (b.querySelector("[data-label]") as HTMLElement).textContent = `${prev.name}（前の版）`;
    if (prev.flatUrl && !el!.src.endsWith(prev.flatUrl)) el!.src = prev.flatUrl;
    cmpMsg(prev.flatUrl ? "" : `${prev.name} には軽い再生の動画が無いので、字幕の文だけ比べます`);
  } else if (el && !el.paused) el.pause();
}

/** 確認画面に「見比べ」「描く」を足す（cloud.ts の起動の最後に呼ぶ） */
export function startCompare(vid: string, ver: string, readyNames: string[], canWrite: boolean) {
  const row = $("#flatBtn")?.parentElement;
  if (!row) return;
  const older = readyNames.slice(readyNames.indexOf(ver) + 1);       // 新しい順。いまの版より前
  if (older.length) {
    const b = document.createElement("button");
    b.className = "btn sm"; b.id = "miruCmpBtn"; b.textContent = "前の版と見比べ";
    b.title = `${older[0]} の同じ場面を、右上の小さな窓で一緒に流す`;
    b.addEventListener("click", () => { void setCompare(!cmpOn, vid, older); });
    row.appendChild(b);
  }
  if (canWrite) {
    const b = document.createElement("button");
    b.className = "btn sm"; b.id = "miruDrawBtn"; b.textContent = "描く";
    b.title = "映像の上に線を描いて、次に書く修正指示に付ける";
    // 閉じたら描いていた線は捨てる（「やめる」と同じ。残すと、あとで書いた別の指示に付いた）
    b.addEventListener("click", () => { if (drawMode) { pending = null; setDrawMode(false); } else setDrawMode(true); });
    row.appendChild(b);
    bar = document.createElement("div");
    bar.hidden = true;
    // 映像の左下に小さく（映像が小さい画面でも、描いた線を隠さない）。説明は描き始めに 1 回だけ出す
    bar.style.cssText = "position:absolute;left:8px;bottom:8px;z-index:8;display:flex;gap:5px;align-items:center;white-space:nowrap;" +
      "background:rgba(20,20,24,.78);color:#fff;border-radius:999px;padding:4px 6px;font:600 11px system-ui;backdrop-filter:blur(8px)";
    const pill = "color:#fff;background:rgba(255,255,255,.2);border:0;border-radius:999px;padding:3px 8px;cursor:pointer;font:inherit";
    bar.innerHTML = DRAW_COLORS.map((c) => `<button data-c="${c}" aria-label="色" style="width:24px;height:24px;border-radius:50%;border:2px solid #fff;background:${c};cursor:pointer;padding:0"></button>`).join("") +
      `<button data-a="clear" style="${pill}">消す</button><button data-a="done" style="${pill}">やめる</button>`;
    bar.addEventListener("click", (e) => {
      e.stopPropagation();
      const t = (e.target as HTMLElement).closest("button");
      if (!t) return;
      if (t.dataset.c) { color = t.dataset.c; return; }
      if (t.dataset.a === "clear") { pending = null; paint(); }
      if (t.dataset.a === "done") { pending = null; setDrawMode(false); }
    });
    $("#stageWrap")!.appendChild(bar);
  }
  ensureCanvas();
  const loop = () => { try { syncCmp(); paint(); } catch { /* ページの準備中 */ } requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}
