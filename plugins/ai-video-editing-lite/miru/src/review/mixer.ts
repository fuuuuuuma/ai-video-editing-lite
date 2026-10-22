// 計画の音をその場で鳴らす（2026-10-19）。手元の review_edits.quick_mix と同じ式（音量 dB・音量の折れ線・フェード・ループ・全体の音量）を
// Web Audio で、再生位置の少し先だけ並べる。画面からは <audio> と同じ形（play・pause・currentTime・playbackRate・paused・イベント）で使う。
//
// 音のもとは 10 秒ずつに分けた FLAC（スキルの scripts/miru_sync.py publish が作る。audio/index.json）。近い所だけ読んでほどき、使い終わったら捨てる。
// 速度を変えても声の高さは変えない（2026-10-21）: 1 倍以外のときは、ほどいた塊を WSOLA で伸び縮みさせてから並べる（stretchChannels）。
// 手直しの無いときは画面が普通の <audio>（preservesPitch）を使う。
// 途中で音が止まる（2026-10-21 No.52）: 2.5 秒先しか読まず、読み込みが間に合わない塊を飛ばしていた（映像は進み、音だけ無音）。
//   いまは 15 秒先まで前もって読み、並べるのは読み終わった所まで。それでも足りないときは時計を止めて待ち（readyState 2・waiting）、
//   読めたら続きから鳴らす（playing）。画面は readyState を見て映像も一緒に待つ。

export type AudioIndex = { chunk_seconds: number; sources: Record<string, { id: string; chunks: number; duration: number }> };
type Item = { path: string; start: number; end: number; source_start_seconds?: number; gain_db?: number; fade_in_frames?: number; fade_out_frames?: number;
  keyframes?: { frame: number; gain_db?: number; interpolation?: string }[]; loop?: boolean; mute?: boolean; kind?: string };
export type MixPlan = { fps: string | number; frames: number; master_gain_db?: number; clips: Item[]; audio?: Item[] };

const fpsOf = (f: string | number) => { const s = String(f); const [a, b] = s.split("/"); return b ? Number(a) / Number(b) : Number(s); };
const LOOKAHEAD = 2.5, PREFETCH = 15, PUMP_MS = 150, KEEP = 64, STEP = 0.25;

/** 音の高さを変えずに長さだけ 1/rate にする（WSOLA: 30ms の窓を、前の窓の続きに一番似た所から取って重ねる）。 */
export function stretchChannels(chs: Float32Array[], sampleRate: number, rate: number): Float32Array[] {
  if (rate === 1 || !chs.length) return chs;
  const len = chs[0].length;
  const N = Math.max(256, Math.round(sampleRate * 0.03) & ~1), Hs = N / 2, Ha = Hs * rate, tol = Math.round(N / 4);
  const outLen = Math.ceil(len / rate);
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const mono = new Float32Array(len);
  for (const c of chs) for (let i = 0; i < len; i++) mono[i] += c[i] / chs.length;
  const out = chs.map(() => new Float32Array(outLen + N));
  const norm = new Float32Array(outLen + N);
  const at = (x: Float32Array, i: number) => (i >= 0 && i < x.length ? x[i] : 0);
  let prev = 0;
  for (let m = 0; m * Hs < outLen; m++) {
    const outPos = m * Hs;
    let pos = 0;
    if (m > 0) {
      const natural = prev + Hs, target = Math.round(m * Ha);
      let best = target, bestScore = -Infinity;
      for (let cand = Math.max(0, target - tol); cand <= target + tol; cand += 4) {
        let sc = 0;
        for (let i = 0; i < Hs; i += 4) sc += at(mono, natural + i) * at(mono, cand + i);
        if (sc > bestScore) { bestScore = sc; best = cand; }
      }
      pos = best;
    }
    for (let c = 0; c < chs.length; c++) {
      const x = chs[c], o = out[c];
      for (let i = 0; i < N; i++) o[outPos + i] += at(x, pos + i) * w[i];
    }
    for (let i = 0; i < N; i++) norm[outPos + i] += w[i];
    prev = pos;
  }
  return out.map((o) => {
    const r = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) r[i] = norm[i] > 1e-3 ? o[i] / norm[i] : o[i];
    return r;
  });
}

/** render_offline.curve(item, 'gain_db', f) と同じ */
export function gainDbAt(item: Item, f: number): number {
  const keys = (item.keyframes ?? []).filter((k) => k.gain_db !== undefined);
  let v = item.gain_db ?? 0;
  for (let i = 0; i < keys.length; i++) {
    const a = keys[i];
    if (i === keys.length - 1) { if (f >= a.frame) v = a.gain_db!; break; }
    const b = keys[i + 1];
    if (f >= a.frame && f < b.frame) {
      const it = a.interpolation ?? "linear";
      if (it === "hold") return a.gain_db!;
      let u = (f - a.frame) / (b.frame - a.frame);
      if (it === "smoothstep") u = u * u * (3 - 2 * u);
      return a.gain_db! + (b.gain_db! - a.gain_db!) * u;
    }
  }
  return v;
}
/** 出力の pos 秒目（項目の頭から）での音量（倍率）。quick_mix の g と同じ */
export function amplitude(item: Item, fps: number, posSec: number): number {
  const cnt = (item.end - item.start) / fps;
  let g = 10 ** ((item.keyframes?.length ? gainDbAt(item, item.start + posSec * fps) : item.gain_db ?? 0) / 20);
  const fi = (item.fade_in_frames || 0) / fps, fo = (item.fade_out_frames || 0) / fps;
  if (fi) g *= Math.min(1, posSec / fi);
  if (fo) g *= Math.max(0, Math.min(1, (cnt - 1 / 48000 - posSec) / fo));
  return g;
}

type Listener = () => void;
export class PlanMixer {
  ctx: AudioContext;
  private master: GainNode;
  private items: Item[] = [];
  private fps = 30;
  private total = 0;
  private cache = new Map<string, Promise<AudioBuffer | null>>();
  private used: string[] = [];
  private live = new Set<AudioScheduledSourceNode>();
  private scheduledTo = 0;           // ここまで（出力の秒）は並べ終わった
  private pos0 = 0; private ctx0 = 0; private playing = false; private rate = 1; private timer = 0; private session = 0;
  private stalled = false;           // 読み込み待ちで時計を止めている
  private done = new Map<string, AudioBuffer | null>();   // 読み終わった塊（key → 音。読めなかったら null）
  private listeners = new Map<string, Set<Listener>>();
  private loaded = false;
  get readyState() { return !this.loaded ? 0 : this.stalled ? 2 : 4; }

  constructor(private index: AudioIndex, private urlOf: (sourceId: string, chunk: number) => string, ctx?: AudioContext) {
    this.ctx = ctx ?? new AudioContext({ latencyHint: "interactive" });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
  }

  setPlan(plan: MixPlan) {
    const was = this.playing, at = this.currentTime;
    if (was) this.halt();
    this.fps = fpsOf(plan.fps);
    this.total = plan.frames / this.fps;
    this.master.gain.value = 10 ** ((plan.master_gain_db ?? 0) / 20);
    this.items = [...plan.clips.filter((c) => !c.mute), ...(plan.audio ?? [])].filter((e) => e.end > e.start && this.index.sources[e.path]);
    this.loaded = true;
    this.pos0 = Math.min(at, this.total);
    if (was) this.start();
  }

  // ── <audio> と同じ形 ──
  get paused() { return !this.playing; }
  get duration() { return this.total; }
  get currentTime() { return this.playing && !this.stalled ? Math.min(this.total, this.pos0 + Math.max(0, this.ctx.currentTime - this.ctx0) * this.rate) : this.pos0; }
  set currentTime(t: number) {
    const was = this.playing;
    if (was) this.halt();
    this.pos0 = Math.max(0, Math.min(this.total, t));
    if (was) this.start();
  }
  get playbackRate() { return this.rate; }
  set playbackRate(r: number) { const was = this.playing, at = this.currentTime; if (was) this.halt(); this.rate = r; this.pos0 = at; if (was) this.start(); }
  async play() { if (this.playing) return; if (this.ctx.state !== "running") await this.ctx.resume(); this.start(); this.emit("play"); }
  pause() { if (!this.playing) return; const at = this.currentTime; this.halt(); this.pos0 = at; this.emit("pause"); }
  addEventListener(ev: string, fn: Listener, opt?: { once?: boolean }) {
    const set = this.listeners.get(ev) ?? new Set(); this.listeners.set(ev, set);
    const f = opt?.once ? () => { set.delete(f); fn(); } : fn; set.add(f);
  }
  removeEventListener(ev: string, fn: Listener) { this.listeners.get(ev)?.delete(fn); }
  emit(ev: string) { for (const f of [...(this.listeners.get(ev) ?? [])]) f(); }

  // ── 並べる ──
  private start() {
    this.playing = true; this.session++; this.stalled = false;
    this.ctx0 = this.ctx.currentTime + 0.06;          // 最初の音を並べる余裕
    this.scheduledTo = this.pos0;
    this.pump();
    this.timer = window.setInterval(() => this.pump(), PUMP_MS);
  }
  private halt() {
    this.playing = false; this.session++; this.stalled = false;
    clearInterval(this.timer);
    for (const n of this.live) { try { n.stop(); } catch { /* 済み */ } n.disconnect(); }
    this.live.clear();
  }
  /** 出力 [a, b) 秒に要る塊の鍵（読み始める） */
  private need(a: number, b: number): string[] {
    const keys: string[] = [];
    for (const it of this.items) {
      const s = it.start / this.fps, e = it.end / this.fps;
      const x = Math.max(s, a), y = Math.min(e, b);
      if (y > x) for (const [sid, k] of this.chunks(it, x, y)) { keys.push(this.keyOf(sid, k, this.rate)); void this.buffer(sid, k, this.rate); }
    }
    return keys;
  }
  private ready(a: number, b: number) { return this.need(a, b).every((k) => this.done.has(k)); }
  private pump() {
    if (!this.playing) return;
    const now = this.currentTime;
    if (now >= this.total - 1e-3) { const s = this.session; this.halt(); this.pos0 = this.total; if (s) this.emit("ended"); this.emit("pause"); return; }
    this.need(now, Math.min(this.total, now + PREFETCH));            // 先の塊を読んでおく
    if (this.stalled) {                                              // 待っていた塊が読めたら、止めた所から続ける
      if (!this.ready(this.pos0, Math.min(this.total, this.pos0 + Math.min(LOOKAHEAD, 1)))) return;
      this.stalled = false; this.ctx0 = this.ctx.currentTime + 0.06; this.scheduledTo = this.pos0; this.emit("playing");
    }
    const to = Math.min(this.total, this.currentTime + LOOKAHEAD);
    let h = this.scheduledTo;                                        // 読み終わった所まで並べる
    while (h < to - 1e-6 && this.ready(h, Math.min(to, h + STEP))) h = Math.min(to, h + STEP);
    if (h > this.scheduledTo + 1e-6) {
      const from = this.scheduledTo; this.scheduledTo = h;
      for (const it of this.items) {
        const s = it.start / this.fps, e = it.end / this.fps;
        const a = Math.max(s, from), b = Math.min(e, h);
        if (b > a) this.place(it, a, b, this.session);
      }
    }
    if (this.scheduledTo < this.total - 1e-3 && this.currentTime >= this.scheduledTo - 0.05) {   // 並べた音が尽きる：時計を止めて待つ
      this.pos0 = this.scheduledTo; this.stalled = true;
      this.emit("waiting");
    }
  }
  /** 項目 it の出力 [a, b) 秒が使う、もとの 10 秒の塊 [音のもと, 番号] */
  private *chunks(it: Item, a: number, b: number): Generator<[string, number]> {
    const src = this.index.sources[it.path];
    const C = this.index.chunk_seconds;
    const s = it.start / this.fps;
    let t = a; let last = -1;
    while (t < b - 1e-9) {
      let srcSec = (it.source_start_seconds ?? 0) + (t - s);
      if (it.loop && src.duration > 0) srcSec = ((srcSec % src.duration) + src.duration) % src.duration;
      if (srcSec < 0) { t = Math.min(b, t - srcSec); continue; }
      if (srcSec >= src.duration) break;
      const k = Math.floor(srcSec / C);
      if (k !== last) { yield [src.id, k]; last = k; }
      const len = Math.min(b - t, C - (srcSec - k * C), (it.loop ? Infinity : src.duration - srcSec));
      if (len <= 1e-6) break;
      t += len;
    }
  }
  /** 項目 it の出力 [a, b) 秒を、もとの 10 秒の塊ごとに並べる */
  private place(it: Item, a: number, b: number, session: number) {
    const src = this.index.sources[it.path];
    const C = this.index.chunk_seconds;
    const s = it.start / this.fps;
    let t = a;
    while (t < b - 1e-9) {
      let srcSec = (it.source_start_seconds ?? 0) + (t - s);
      if (it.loop && src.duration > 0) srcSec = ((srcSec % src.duration) + src.duration) % src.duration;
      if (srcSec < 0) { t = Math.min(b, t - srcSec); continue; }             // もとの頭より前は無音
      if (srcSec >= src.duration) break;                                     // もとの終わりより後も無音
      const k = Math.floor(srcSec / C);
      const inChunk = srcSec - k * C;
      const len = Math.min(b - t, C - inChunk, (it.loop ? Infinity : src.duration - srcSec));
      if (len <= 1e-6) break;
      this.schedulePiece(it, src.id, k, inChunk, t, len, session);
      t += len;
    }
  }
  private schedulePiece(it: Item, sid: string, k: number, offset: number, outAt: number, len: number, session: number) {
    const rate = this.rate;
    const buf = this.done.get(this.keyOf(sid, k, rate));
    {
      if (!buf || session !== this.session || !this.playing) return;
      const when = this.ctx0 + (outAt - this.pos0) / this.rate;
      let late = this.ctx.currentTime + 0.005 - when;                       // 読み込みが間に合わなかったぶんは頭を詰める
      late = Math.max(0, late);
      const skip = late * this.rate;
      if (skip >= len) return;
      const node = this.ctx.createBufferSource();
      node.buffer = buf;                                                    // 1 倍以外は伸び縮み済み（高さはそのまま）
      const g = this.ctx.createGain();
      // 音量の変化を 1/30 秒ごとの点で（短い塊なので点は多くない）
      const n = Math.max(2, Math.ceil((len - skip) * 30) + 1);
      const curve = new Float32Array(n);
      const s = it.start / this.fps;
      for (let i = 0; i < n; i++) curve[i] = amplitude(it, this.fps, outAt + skip + (len - skip) * (i / (n - 1)) - s);
      const at = when + late;
      if (curve.every((v) => v === curve[0])) g.gain.setValueAtTime(curve[0], at); else g.gain.setValueCurveAtTime(curve, at, (len - skip) / this.rate);
      node.connect(g).connect(this.master);
      node.start(at, Math.min(buf.duration, (offset + skip) / rate), (len - skip) / rate);
      this.live.add(node);
      node.onended = () => { this.live.delete(node); node.disconnect(); g.disconnect(); };
    }
  }
  private keyOf(sid: string, k: number, rate: number) { return rate === 1 ? `${sid}/${k}` : `${sid}/${k}@${rate}`; }
  private buffer(sid: string, k: number, rate = 1): Promise<AudioBuffer | null> {
    const key = this.keyOf(sid, k, rate);
    let p = this.cache.get(key);
    if (!p && rate !== 1) {
      p = this.buffer(sid, k, 1).then((b) => {
        if (!b) return null;
        const chs = Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c));
        const st = stretchChannels(chs, b.sampleRate, rate);
        const out = this.ctx.createBuffer(st.length, st[0].length, b.sampleRate);
        st.forEach((d, c) => out.copyToChannel(d as Float32Array<ArrayBuffer>, c));
        return out;
      });
      this.cache.set(key, p);
    }
    if (!p) {
      p = fetch(this.urlOf(sid, k), { credentials: "same-origin" })
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
        .then((ab) => this.ctx.decodeAudioData(ab))
        .catch(() => { this.cache.delete(key); return null; });
      this.cache.set(key, p);
    }
    if (!this.done.has(key)) void p.then((b) => { if (this.cache.get(key) === p) this.done.set(key, b); else if (b === null) this.done.set(key, null); });
    this.used = [key, ...this.used.filter((x) => x !== key)];
    for (const old of this.used.splice(KEEP)) { this.cache.delete(old); this.done.delete(old); }
    return p;
  }
}
