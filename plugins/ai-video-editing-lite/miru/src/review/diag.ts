// 再生の記録（2026-10-23）。「再生中に字幕が消える・音を待つ・映像が止まる・開くのが遅い」を本番で確かめるため、ページが自分で
// 起きたことを記録し、問題が起きたら MIRU（/api/videos/<動画>/diag）に送る。直すのは記録で原因を確定してから。
//
// 記録すること:
//   字幕が出るはずのコマで出ていない（DOM が無い・非表示・画像が読み終わっていない・壊れている）と、その長さ
//   音待ち（再生中なのに音の readyState < 3）・映像の頭出し（軽い再生の動画・カメラなどの動画の seeking）・映像の待ち（waiting）
//   再生中なのにコマが進まない・描画が呼ばれていない・エラー
//   読み込みの時間（Resource Timing: 道・種類・待ち時間・全体・大きさ・プロトコル）と、ページを開いてから再生できるまでの段階
// ページの本体（review.html）の変数を読むだけで、ページの動きは変えない。

type Json = Record<string, any>;
declare const M: Json;
declare const audio: any;
declare const olayers: Json[];
declare const domLayers: Map<number, HTMLElement>;
declare const hiddenL: Set<number>;
declare const assigned: Map<string, { el: HTMLVideoElement }>;
declare const overlays: { e: Json; el: HTMLElement; on: boolean | null }[];
declare const flatEl: HTMLVideoElement | null;
declare const flatOn: boolean;
declare const clips: Json[];
declare function frameNow(): number;

const t0 = 0;      // ページを開き始めてからのミリ秒（Resource Timing と同じ物差し）
const at = () => Math.round(performance.now() - t0);
const events: Json[] = [];
const net: Json[] = [];
const marks: Record<string, number> = {};
let incidents = 0, sentIncidents = 0, sending = false, lastSend = 0, renderCalls = 0;

function add(e: Json) {
  events.push({ t: at(), ...e });
  if (events.length > 3000) events.splice(0, events.length - 3000);
}
function incident(e: Json) {
  add(e);
  incidents++;
}
// ページの変数（review.html の let / function）。まだ無いときは undefined
const page = {
  M: () => (typeof M !== "undefined" ? M : undefined),
  audio: () => (typeof audio !== "undefined" ? audio : undefined),
  olayers: () => (typeof olayers !== "undefined" ? olayers : []),
  domLayers: () => (typeof domLayers !== "undefined" ? domLayers : new Map<number, HTMLElement>()),
  hiddenL: () => (typeof hiddenL !== "undefined" ? hiddenL : new Set<number>()),
  assigned: () => (typeof assigned !== "undefined" ? assigned : new Map<string, { el: HTMLVideoElement }>()),
  overlays: () => (typeof overlays !== "undefined" ? overlays : []),
  flatEl: () => (typeof flatEl !== "undefined" ? flatEl : null),
  flatOn: () => (typeof flatOn !== "undefined" ? flatOn : null),
  clips: () => (typeof clips !== "undefined" ? clips : []),
};

/** 段階の印（開く → 計画を読んだ → 再生できる）。cloud.ts からも呼ぶ */
export function mark(name: string) { if (marks[name] == null) marks[name] = at(); }

// ── 読み込み ──
try { performance.setResourceTimingBufferSize(5000); } catch { /* 古いブラウザ */ }
try {
  new PerformanceObserver((list) => {
    for (const r of list.getEntries() as PerformanceResourceTiming[]) {
      const u = new URL(r.name, location.href);
      net.push({ t: Math.round(r.startTime), path: u.pathname.replace(/^\/m\/[^/]+\/[^/]+\//, ""), kind: r.initiatorType,
        wait: Math.round((r.responseStart || r.startTime) - r.startTime), ms: Math.round(r.duration), bytes: r.transferSize || r.encodedBodySize || 0,
        proto: r.nextHopProtocol || "" });
      if (net.length > 2500) net.splice(0, net.length - 2500);
      if (r.duration > 3000) incident({ kind: "slow_request", path: u.pathname, ms: Math.round(r.duration) });
    }
    try { performance.clearResourceTimings(); } catch { /* */ }
  }).observe({ type: "resource", buffered: true });
} catch { /* */ }

// ── 動画・音の要素の出来事 ──
const watched = new WeakSet<HTMLMediaElement>();
function watch(el: HTMLMediaElement | null | undefined, name: string) {
  if (!el || watched.has(el)) return;
  watched.add(el);
  let seekAt = 0, waitAt = 0;
  el.addEventListener("seeking", () => { seekAt = performance.now(); });
  el.addEventListener("seeked", () => {
    if (!seekAt) return;
    const ms = Math.round(performance.now() - seekAt); seekAt = 0;
    (ms > 1500 ? incident : add)({ kind: "seek", what: name, ms, to: Math.round(el.currentTime * 100) / 100 });
  });
  el.addEventListener("waiting", () => { waitAt = performance.now(); });
  el.addEventListener("playing", () => {
    if (!waitAt) return;
    const ms = Math.round(performance.now() - waitAt); waitAt = 0;
    (ms > 1500 ? incident : add)({ kind: "waiting", what: name, ms });
  });
  el.addEventListener("stalled", () => add({ kind: "stalled", what: name }));
  el.addEventListener("error", () => incident({ kind: "media_error", what: name, code: el.error?.code }));
}

// ── タブが隠れた・戻った（隠れている間はブラウザが描画を止める） ──
document.addEventListener("visibilitychange", () => add({ kind: "visibility", state: document.visibilityState }));

// ── エラー ──
addEventListener("error", (e) => incident({ kind: "error", message: String((e as ErrorEvent).message ?? e).slice(0, 300) }));
addEventListener("unhandledrejection", (e) => add({ kind: "rejection", message: String((e as PromiseRejectionEvent).reason ?? "").slice(0, 300) }));

// ── 様子を 0.1 秒ごとに見る ──
type Open = { since: number; e: Json };
const open = new Map<string, Open>();
function hold(key: string, on: boolean, e: () => Json, threshold: number) {
  const o = open.get(key);
  if (on && !o) open.set(key, { since: performance.now(), e: e() });
  if (!on && o) {
    open.delete(key);
    const ms = Math.round(performance.now() - o.since);
    if (ms >= 100) (ms >= threshold ? incident : add)({ ...o.e, ms, until: at() });
  }
}

let lastF = -1, lastMove = performance.now();
function sample() {
  if (!page.M()) return;
  const a = page.audio();
  if (!a) return;
  mark("page_ready");
  if (a.readyState >= 3) mark("audio_ready");
  const fl0 = page.flatEl();
  if (!page.M()!.flat || (fl0 && fl0.readyState >= 2)) mark("video_ready");
  if (marks.audio_ready != null && marks.video_ready != null && marks.opened == null) {
    mark("opened");
    if (marks.opened > 4000) incident({ kind: "slow_open", ms: marks.opened, marks: { ...marks } });
  }
  const f: number = frameNow();
  const playing = !a.paused;
  // 音待ち
  hold("audio", playing && a.readyState < 3, () => ({ kind: "audio_wait", f, mode: a.mode ?? "el", rs: a.readyState }), 1500);
  // コマが進まない
  if (f !== lastF) { lastF = f; lastMove = performance.now(); }
  hold("stall", playing && performance.now() - lastMove > 700, () => ({ kind: "stall", f, audio_rs: a.readyState, flat_rs: page.flatEl()?.readyState ?? null,
    flat_seeking: !!page.flatEl()?.seeking }), 1500);
  // 描画が呼ばれていない
  hold("render", playing && renderCalls === 0, () => ({ kind: "render_stopped", f }), 1000);
  renderCalls = 0;
  // 動画の要素
  watch(page.flatEl(), "flat");
  for (const [uid, s] of page.assigned()) watch(s.el, "live:" + String(uid).split("-")[0]);
  watch(a.el ?? a, "audio");
  // 字幕: 出るはずのコマで出ていない
  const showing = new Set<string>();
  const ol: Json[] = page.olayers();
  const dom: Map<number, HTMLElement> = page.domLayers();
  const hid: Set<number> = page.hiddenL();
  for (const L of ol) {
    if (L.role !== "caption" || !(L.start <= f && f < L.end) || hid.has(L.i)) continue;
    const el = dom.get(L.i) as HTMLImageElement | undefined;
    const why = !el ? "no_element" : el.style.display !== "block" ? "hidden" : !el.complete ? "loading" : !el.naturalWidth ? "broken" : "";
    const key = "cap:" + L.i;
    showing.add(key);
    hold(key, !!why, () => ({ kind: "caption_missing", f, id: L.id, caption_kind: L.caption_kind, text: String(L.text ?? "").slice(0, 30), why,
      src: el instanceof HTMLImageElement ? new URL(el.src).pathname.split("/").pop() : null, playing }), 500);
  }
  for (const o of page.overlays()) {      // 打ち直した字幕（ページで描いたもの）
    if (!o.on) continue;
    const img = o.el.querySelector("img") as HTMLImageElement | null;
    const why = o.el.style.visibility === "hidden" ? "drawing" : img && !img.complete ? "loading" : "";
    const key = "ov:" + (o.e.key ?? o.e.caption_id);
    showing.add(key);
    hold(key, !!why, () => ({ kind: "caption_missing", f, id: o.e.caption_id, caption_kind: "edited", text: String(o.e.text ?? "").slice(0, 30), why, playing }), 500);
  }
  for (const k of [...open.keys()]) if ((k.startsWith("cap:") || k.startsWith("ov:")) && !showing.has(k)) hold(k, false, () => ({}), 500);
  // 送る
  if (incidents > sentIncidents && !sending && performance.now() - lastSend > 20000) void send("auto");
}

function context(): Json {
  const a = page.audio(), m = page.M() ?? {}, fl = page.flatEl();
  const cl: Json[] = page.clips();
  return { url: location.pathname + location.search, version: m.name, frames: m.frames, ua: navigator.userAgent,
    connection: (navigator as any).connection ? { type: (navigator as any).connection.effectiveType, rtt: (navigator as any).connection.rtt, down: (navigator as any).connection.downlink } : null,
    audio_mode: a?.mode ?? "el", flat: !!m.flat, flat_on: page.flatOn(), flat_rs: fl?.readyState ?? null,
    live_clips: cl.filter((c) => c.flatT == null).length, clips: cl.length, cut_rev: m.cut_rev ?? "", marks, colo, visible: document.visibilityState,
    open_now: [...open.values()].map((o) => ({ ...o.e, for_ms: Math.round(performance.now() - o.since) })) };
}

let colo = "";
fetch("/cdn-cgi/trace").then((r) => r.text()).then((t) => { colo = /colo=(\w+)/.exec(t)?.[1] ?? ""; }).catch(() => {});

let videoId = "";
export async function send(why: string, keepalive = false): Promise<string | null> {
  if (!videoId) return null;
  sending = true; lastSend = performance.now();
  const body = JSON.stringify({ why, at: new Date().toISOString(), context: context(), events: events.slice(keepalive ? -150 : -1500),
    net: net.slice(keepalive ? -100 : -1500) });
  try {
    const r = await fetch(`/api/videos/${encodeURIComponent(videoId)}/diag`, { method: "POST", credentials: "same-origin", keepalive,
      headers: { "content-type": "application/json", "x-miru": "1" }, body });
    sentIncidents = incidents;
    return r.ok ? ((await r.json()).name as string) : null;
  } catch { return null; } finally { sending = false; }
}

/** 記録を始める（cloud.ts の起動の最後に呼ぶ） */
export function startDiag(vid: string) {
  videoId = vid;
  const w = window as unknown as Json;
  const orig = w.render;          // 描画が呼ばれているか（ページの render を包むだけ）
  if (typeof orig === "function") w.render = function (this: unknown, ...args: unknown[]) { renderCalls++; return orig.apply(this, args); };
  setInterval(() => { try { sample(); } catch (e) { add({ kind: "diag_error", message: String(e).slice(0, 200) }); } }, 100);
  addEventListener("pagehide", () => { if (incidents > sentIncidents) void send("leave", true); });
  w.__miruDiag = { send: () => send("manual"), events, net, context };
}
