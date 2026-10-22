// review_edits.py（すゝめ Skill の scripts/）の計画の手直し部分を TypeScript に移したもの（2026-10-19）。
// 確認ページで付けたカットの戻し・追加、強調・大きい QR の移動、字幕の時間の手直しを、render plan に当てる。
// Python と 1 コマ・1 桁まで同じ結果を出すことが前提: 直すときは review_edits.py と同時に直し、
// tools/golden_edits.py で fixtures を作り直して src/review/edits.test.ts を通す。
// 移していないもの: 字幕の打ち直しの焼き込み（apply_caption_texts は Python の画像描画が要る）、quick_mix、CLI、
// check_carried、validate、probe_duration（長さは durationOf で外から渡す。null を返してよい）。

/* eslint-disable @typescript-eslint/no-explicit-any */
export type El = Record<string, any>;
/** A render plan as parsed JSON (left untyped: callers read it with their own shapes). */
export type Plan = any;
export type Op = ['ins', number, number, string] | ['del', number, number];
export type DurationOf = (path: string) => number | null | undefined;
export interface CheckReport { ok: boolean; notes: string[]; delta_frames: number; checked_after_last_change: number }
export interface Retimed { kind: any; id: any; from: [number, number]; to: [number, number] }

export const MIN_CAP = 12;

// ---------------------------------------------------------------- Python semantics

const has = (o: any, k: string): boolean => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
/** dict.get(k, default): a key that is there with null gives null, not the default. */
const get = (o: any, k: string, d: any = null): any => (has(o, k) ? o[k] : d);

export function pyTruthy(v: any): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

const orZero = (v: any): any => (pyTruthy(v) ? v : 0);
const z = (x: number): number => x + 0;    // -0 -> 0 (Python ints have no -0)

/** Python round(x): half to even, to an int. */
export function pyRound(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return z(f + 1);
  if (d < 0.5) return z(f);
  return z(f % 2 === 0 ? f : f + 1);
}

/** Python int(x) on a float: toward zero. */
export const pyInt = (x: number): number => z(Math.trunc(x));

/** The exact value of |x| rounded half-to-even to n decimals, as digits. */
function roundDigits(x: number, n: number): { neg: boolean; text: string } {
  const neg = x < 0 || Object.is(x, -0);
  const exact = Math.abs(x).toFixed(100);          // the binary value written out exactly
  const [ip, fp] = exact.split('.');
  const keep = fp.slice(0, n);
  const rest = fp.slice(n);
  let up = false;
  if (rest[0] > '5') up = true;
  else if (rest[0] === '5') {
    if (/[1-9]/.test(rest.slice(1))) up = true;
    else up = Number((n > 0 ? keep : ip).slice(-1)) % 2 === 1;
  }
  let digits = ip + keep;
  if (up) {
    const a = digits.split('');
    let i = a.length - 1;
    while (i >= 0) {
      if (a[i] === '9') { a[i] = '0'; i--; } else { a[i] = String(Number(a[i]) + 1); break; }
    }
    digits = (i < 0 ? '1' : '') + a.join('');
  }
  const intLen = digits.length - n;
  const text = n > 0 ? `${digits.slice(0, intLen)}.${digits.slice(intLen)}` : digits;
  return { neg, text };
}

/** Python round(x, n) on a float. */
export function pyRoundN(x: number, n: number): number {
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21) return x;
  const { neg, text } = roundDigits(x, n);
  const v = Number(text);
  return neg ? -v : v;
}

/** Python f'{x:.nf}'. */
export function pyFixed(x: number, n: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? 'nan' : x > 0 ? 'inf' : '-inf';
  if (Math.abs(x) >= 1e21) return x.toFixed(n);
  const { neg, text } = roundDigits(x, n);
  return (neg ? '-' : '') + text;
}

function pyFloatRepr(v: number): string {
  if (Number.isNaN(v)) return 'nan';
  if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf';
  const [m, e] = v.toExponential().split('e');
  const exp = Number(e);
  const sign = m.startsWith('-') ? '-' : '';
  const digits = m.replace('-', '').replace('.', '');
  if (exp < -4 || exp >= 16) {
    const mant = digits[0] + (digits.length > 1 ? '.' + digits.slice(1) : '');
    return `${sign}${mant}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  if (exp < 0) return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`;
  const ip = digits.slice(0, exp + 1).padEnd(exp + 1, '0');
  const fp = digits.slice(exp + 1);
  return `${sign}${ip}.${fp || '0'}`;
}

/** Python str() of a JSON value (integral numbers are taken as ints). */
export function pyStr(v: any): string {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) < 1e16 ? String(z(v)) : pyFloatRepr(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`;
  return `{${Object.entries(v).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(', ')}}`;
}

function pyRepr(v: any): string {
  return typeof v === 'string' ? `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : pyStr(v);
}

/** Python == between JSON values (True == 1, dicts by content). */
export function pyEq(a: any, b: any): boolean {
  if (a === b) return true;
  const na = typeof a === 'boolean' ? Number(a) : a;
  const nb = typeof b === 'boolean' ? Number(b) : b;
  if (typeof na === 'number' || typeof nb === 'number') return na === nb;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => pyEq(x, b[i]));
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => has(b, k) && pyEq(a[k], b[k]));
}

/** list.index(x): the first element that is x or equal to it. */
const pyIndex = (lst: any[], x: any): number => lst.findIndex((y) => y === x || pyEq(y, x));
const pyIn = (lst: any[], x: any): boolean => pyIndex(lst, x) >= 0;
function pyRemove(lst: any[], x: any): void {
  const i = pyIndex(lst, x);
  if (i >= 0) lst.splice(i, 1);
}

/** Dict key as Python hashes it (True and 1 are one key; a missing value is None). */
const pyKey = (v: any): any => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v);

function pyStrCmp(a: string, b: string): number {
  if (a === b) return 0;
  const ca = Array.from(a), cb = Array.from(b);
  for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
    const x = ca[i].codePointAt(0)!, y = cb[i].codePointAt(0)!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return ca.length - cb.length;
}

/** min(lst, key=fn): the first smallest. */
function minBy<T>(lst: T[], fn: (x: T) => number): T {
  let best = lst[0], bk = fn(lst[0]);
  for (let i = 1; i < lst.length; i++) {
    const k = fn(lst[i]);
    if (k < bk) { best = lst[i]; bk = k; }
  }
  return best;
}

function bisectRight(a: number[], x: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (x < a[mid]) hi = mid; else lo = mid + 1;
  }
  return lo;
}

/** Python slice bounds [lo, hi) of a sequence of length n. */
function sliceBounds(n: number, start: number, stop: number): [number, number] {
  const fix = (i: number) => (i < 0 ? Math.max(0, i + n) : Math.min(i, n));
  const lo = fix(start), hi = fix(stop);
  return [lo, Math.max(lo, hi)];
}

function replaceAll(lst: any[], items: any[]): void {
  lst.length = 0;
  for (const x of items) lst.push(x);
}

/** Path(p).name on a POSIX path. */
export function baseName(p: any): string {
  const parts = String(p).split('/').filter((s) => s !== '' && s !== '.');
  return parts.length ? parts[parts.length - 1] : '';
}

// ---------------------------------------------------------------- timeline transform

/** float(Fraction(str(plan['fps']))) */
export function fpsOf(plan: El): number {
  const s = pyStr(plan.fps).trim();
  if (s.includes('/')) {
    const [n, d] = s.split('/');
    return Number(n.trim()) / Number(d.trim());
  }
  return Number(s);
}

export const src = (el: El): number => Number(get(el, 'source_start_seconds', 0));
export const endSrc = (el: El, fps: number): number => src(el) + (el.end - el.start) / fps;
export const name = (el: El): string => baseName(el.path);
export const words = (t: any): string => pyStr(pyTruthy(t) ? t : '').replaceAll('\n', '').replaceAll(' ', '').replaceAll('　', '');
const text = (L: El): string => String(get(L, 'text', '')).replaceAll('\n', '');

type Kind = 'clip' | 'layer' | 'audio' | 'camera' | 'segment' | 'region' | 'excluded';

function srcful(kind: Kind, el: El): boolean {
  if (kind === 'clip') return true;
  if (kind === 'layer') return get(el, 'type') === 'video';
  if (kind === 'audio') return get(el, 'kind') === 'voice';
  return false;
}

function continuous(kind: Kind, el: El): boolean {
  if (kind === 'camera' || kind === 'region') return true;
  if (kind === 'layer') return get(el, 'type') === 'video' || get(el, 'role') === 'caption';
  if (kind === 'audio') return get(el, 'kind') === 'bgm';
  return false;
}

function shiftKeys(el: El, fn: (k: number) => number): void {
  if (pyTruthy(get(el, 'keyframes'))) {
    const seen = new Set<number>();
    const keys: El[] = [];
    for (const k0 of el.keyframes) {
      const k = { ...k0, frame: fn(k0.frame) };
      if (!seen.has(k.frame)) {
        seen.add(k.frame);
        keys.push(k);
      }
    }
    el.keyframes = keys;
  }
}

/** A render plan being edited; every change is recorded in ops so other timelines can follow. */
export class Edit {
  plan: El;
  fps: number;
  ops: Op[] = [];
  warnings: string[] = [];
  retimed: Retimed[] = [];
  timedEdges: number[] = [];
  placed: { id: string; box: number[] }[] = [];
  durationOf: DurationOf | null;
  voicePath: string | null;
  voiceDelta: number;
  report: CheckReport | null = null;

  constructor(plan: El, durationOf: DurationOf | null = null) {
    this.plan = structuredClone(plan);
    if (!has(this.plan, 'audio')) this.plan.audio = [];
    this.fps = fpsOf(plan);
    for (const k of ['clips', 'layers', 'audio', 'camera']) {
      (this.plan[k] ?? []).forEach((el: El, i: number) => { if (!has(el, '_o')) el._o = i; });
    }
    this.durationOf = durationOf;
    [this.voicePath, this.voiceDelta] = this.voiceTrack();
  }

  private voiceTrack(): [string | null, number] {
    const found = new Map<any, number[]>();
    const clips: El[] = this.plan.clips;
    const starts = clips.map((c) => c.start);
    for (const v of this.plan.audio as El[]) {
      if (get(v, 'kind') !== 'voice') continue;
      const i = bisectRight(starts, v.start) - 1;
      if (i < 0 || !(clips[i].start <= v.start && v.start < clips[i].end)) continue;
      const c = clips[i];
      const d = src(v) - (src(c) + (v.start - c.start) / this.fps);
      const key = pyKey(v.path);
      if (!found.has(key)) found.set(key, []);
      found.get(key)!.push(pyRoundN(d, 4));
    }
    if (!found.size) return [null, 0.0];
    let path: any = null, most = -1;
    for (const [p, ds] of found) if (ds.length > most) { path = p; most = ds.length; }
    const ds = [...found.get(path)!].sort((a, b) => a - b);
    return [path, ds[Math.floor(ds.length / 2)]];
  }

  f(seconds: number): number {
    return pyRound(seconds * this.fps);
  }

  private lists(): [Kind, El[]][] {
    const p = this.plan;
    const cp = pyTruthy(get(p, 'caption_policy')) ? p.caption_policy : {};
    return [
      ['clip', p.clips ?? []],
      ['layer', p.layers ?? []],
      ['audio', p.audio ?? []],
      ['camera', p.camera ?? []],
      ['segment', p.susume_segments ?? []],
      ['region', cp.continuous_regions ?? []],
      ['excluded', cp.excluded_regions ?? []],
    ];
  }

  /** Open n frames at output frame P (side 'A': things ending at P hold; 'B': things starting at P cover them). */
  insert(P: number, n: number, side: string, pinned: El[] = []): void {
    if (n <= 0) return;
    const pin = new Set(pinned);
    const fps = this.fps;
    for (const [kind, lst] of this.lists()) {
      const out: El[] = [];
      for (const el of lst) {
        if (pin.has(el)) { out.push(el); continue; }
        const s = el.start, e = el.end;
        const sf = srcful(kind, el), cont = continuous(kind, el);
        if (e < P) { out.push(el); continue; }
        if (e === P) {
          if (cont && side === 'A') el.end = e + n;
          out.push(el);
          continue;
        }
        if (s >= P) {
          if (s === P && side === 'B' && cont && (!sf || src(el) >= n / fps)) {
            el.end = e + n;
            if (sf) el.source_start_seconds = pyRoundN(src(el) - n / fps, 6);
            shiftKeys(el, (k) => (k > P ? k + n : k));
          } else {
            el.start = s + n;
            el.end = e + n;
            shiftKeys(el, (k) => k + n);
          }
          out.push(el);
          continue;
        }
        if (sf && kind !== 'layer') {
          const right = structuredClone(el);
          el.end = P;
          right.start = P + n;
          right.end = e + n;
          right.source_start_seconds = pyRoundN(src(el) + (P - s) / fps, 6);
          if (kind === 'audio') {
            el.fade_out_frames = Math.max(1, orZero(get(el, 'fade_out_frames', 0)));
            right.fade_in_frames = Math.max(1, orZero(get(right, 'fade_in_frames', 0)));
          }
          shiftKeys(right, (k) => (k > P ? k + n : k));
          out.push(el, right);
          continue;
        }
        el.end = e + n;
        shiftKeys(el, (k) => (k > P ? k + n : k));
        out.push(el);
      }
      replaceAll(lst, out);
    }
    this.plan.frames += n;
    this.ops.push(['ins', P, n, side]);
  }

  /** Remove output frames [a, b). */
  delete(a: number, b: number): void {
    if (b <= a) return;
    const n = b - a;
    const fps = this.fps;
    const m = (f: number) => (f <= a ? f : f < b ? a : f - n);
    for (const [kind, lst] of this.lists()) {
      const out: El[] = [];
      for (const el of lst) {
        const s = el.start, e = el.end;
        if (e <= a) { out.push(el); continue; }
        if (s >= b) {
          el.start = s - n;
          el.end = e - n;
          shiftKeys(el, m);
          out.push(el);
          continue;
        }
        if (srcful(kind, el)) {
          const sv = src(el);
          if (s < a) {
            const left = structuredClone(el);
            left.end = a;
            if (kind === 'audio') left.fade_out_frames = Math.max(1, orZero(get(left, 'fade_out_frames', 0)));
            shiftKeys(left, m);
            out.push(left);
          }
          if (e > b) {
            el.source_start_seconds = pyRoundN(sv + (Math.max(s, b) - s) / fps, 6);
            el.start = s < b ? a : s - n;
            el.end = e - n;
            if (kind === 'audio' && s < b) el.fade_in_frames = Math.max(1, orZero(get(el, 'fade_in_frames', 0)));
            shiftKeys(el, m);
            out.push(el);
          }
          continue;
        }
        el.start = m(s);
        el.end = m(e);
        shiftKeys(el, m);
        if (el.end > el.start) out.push(el);
      }
      replaceAll(lst, out);
    }
    this.plan.frames -= n;
    this.ops.push(['del', a, b]);
  }

  // -- source-time edits
  private clipsOf(nm: string): El[] {
    return (this.plan.clips as El[]).filter((c) => name(c) === nm);
  }

  private voiceAt(clip: El, edge: 'start' | 'end'): El | null {
    if (!pyTruthy(this.voicePath)) return null;
    const at = edge === 'end' ? clip.end : clip.start;
    const want = (edge === 'end' ? endSrc(clip, this.fps) : src(clip)) + this.voiceDelta;
    for (const v of this.plan.audio as El[]) {
      if (get(v, 'kind') !== 'voice' || !pyEq(v.path, this.voicePath) || !pyEq(get(v, edge), at)) continue;
      const got = edge === 'end' ? endSrc(v, this.fps) : src(v);
      if (Math.abs(got - want) < 0.6 / this.fps) return v;
    }
    return null;
  }

  private newVoice(P: number, n: number, s: number): El | null {
    if (!pyTruthy(this.voicePath)) return null;
    return { id: `voice-r${this.plan.audio.length}-${pyStr(P)}`, path: this.voicePath,
      source_start_seconds: pyRoundN(s + this.voiceDelta, 6), start: P, end: P + n,
      fade_in_frames: 1, fade_out_frames: 1, kind: 'voice' };
  }

  private mergeAt(P: number): void {
    const eps = 0.6 / this.fps;
    const cl: El[] = this.plan.clips;
    for (let i = 0; i < cl.length - 1; i++) {
      const A = cl[i], B = cl[i + 1];
      if (A.end === P && P === B.start && pyEq(A.path, B.path) && pyTruthy(get(A, 'mute')) === pyTruthy(get(B, 'mute'))
          && Math.abs(endSrc(A, this.fps) - src(B)) < eps) {
        A.end = B.end;
        cl.splice(i + 1, 1);
        break;
      }
    }
    const au: El[] = this.plan.audio;
    for (const va of au) {
      if (get(va, 'kind') !== 'voice' || va.end !== P) continue;
      for (const vb of au) {
        if (vb !== va && get(vb, 'kind') === 'voice' && vb.start === P && pyEq(vb.path, va.path)
            && Math.abs(endSrc(va, this.fps) - src(vb)) < eps) {
          va.end = vb.end;
          va.fade_out_frames = get(vb, 'fade_out_frames', 0);
          pyRemove(au, vb);
          return;
        }
      }
    }
  }

  restore(nm: string, s0: number, s1: number, near: number): void {
    const fps = this.fps;
    const eps = 0.6 / fps;
    const clips = this.clipsOf(nm);
    const win = 20 * fps;
    const all: El[] = this.plan.clips;
    const dist = (c: El) => (c.start <= near && near <= c.end ? 0 : Math.min(Math.abs(c.start - near), Math.abs(c.end - near)));

    if (clips.some((c) => src(c) - eps <= s0 && s1 <= endSrc(c, fps) + eps && dist(c) <= win)) {
      this.warnings.push(`${nm} ${pyFixed(s0, 2)}-${pyFixed(s1, 2)}: already in the edit`);
      return;
    }
    const tails = clips.filter((c) => Math.abs(endSrc(c, fps) - s0) < eps);
    const heads = clips.filter((c) => Math.abs(src(c) - s1) < eps);
    let A = tails.length ? minBy(tails, dist) : null;
    const B = heads.length ? minBy(heads, dist) : null;
    if (A !== null && B !== null && dist(B) < dist(A)) A = null;
    if (A !== null) {                        // grow the piece before the join
      const i = pyIndex(all, A);
      const nxt = i + 1 < all.length ? all[i + 1] : null;
      if (nxt !== null && pyEq(nxt.path, A.path) && src(nxt) > s0) s1 = Math.min(s1, src(nxt));
      const n = this.f(s1 - s0);
      if (n <= 0) return;
      const P = A.end;
      const va = this.voiceAt(A, 'end');
      this.insert(P, n, 'A', va ? [A, va] : [A]);
      A.end += n;
      if (va) va.end += n;
      else {
        const v = this.newVoice(P, n, s0);
        if (v) this.plan.audio.push(v);
      }
      this.mergeAt(P + n);
      return;
    }
    if (B !== null) {                        // grow the piece after the join
      const i = pyIndex(all, B);
      const prv = i > 0 ? all[i - 1] : null;
      if (prv !== null && pyEq(prv.path, B.path) && endSrc(prv, fps) < s1) s0 = Math.max(s0, endSrc(prv, fps));
      const n = this.f(s1 - s0);
      if (n <= 0) return;
      const P = B.start;
      const vb = this.voiceAt(B, 'start');
      this.insert(P, n, 'B', vb ? [B, vb] : [B]);
      B.end += n;
      B.source_start_seconds = pyRoundN(src(B) - n / fps, 6);
      if (vb) {
        vb.end += n;
        vb.source_start_seconds = pyRoundN(src(vb) - n / fps, 6);
      } else {
        const v = this.newVoice(P, n, s0);
        if (v) this.plan.audio.push(v);
      }
      this.mergeAt(P);
      return;
    }
    const before = clips.filter((c) => endSrc(c, fps) <= s0 + eps);
    if (!before.length) {
      this.warnings.push(`${nm} ${pyFixed(s0, 2)}-${pyFixed(s1, 2)}: no place to put it back`);
      return;
    }
    let close = before.filter((c) => dist(c) <= 3 * win);
    if (!close.length) close = before;
    const A2 = minBy(close, (c) => s0 - endSrc(c, fps));
    const n = this.f(s1 - s0);
    if (n <= 0) return;
    const P = A2.end;
    const idx = pyIndex(all, A2);
    this.insert(P, n, 'A', [A2]);
    const piece: El = {};
    for (const [k, v] of Object.entries(A2)) if (k !== 'keyframes') piece[k] = v;
    piece.start = P;
    piece.end = P + n;
    piece.source_start_seconds = pyRoundN(s0, 6);
    this.plan.clips.splice(idx + 1, 0, piece);
    const v = this.newVoice(P, n, s0);
    if (v) this.plan.audio.push(v);
  }

  cut(nm: string, s0: number, s1: number, near: number): void {
    const spans: [number, number][] = [];
    for (const c of this.clipsOf(nm)) {
      const sv = src(c), end = endSrc(c, this.fps);
      const lo = Math.max(s0, sv), hi = Math.min(s1, end);
      if (hi <= lo) continue;
      const a = c.start + this.f(lo - sv);
      const b = Math.min(c.end, c.start + this.f(hi - sv));
      if (b > a) spans.push([a, b]);
    }
    if (!spans.length) {
      this.warnings.push(`${nm} ${pyFixed(s0, 2)}-${pyFixed(s1, 2)}: not in the edit`);
      return;
    }
    const far = 20 * this.fps;
    let close = spans.filter((s) => s[0] - far <= near && near <= s[1] + far);
    if (!close.length) close = [minBy(spans, (s) => Math.min(Math.abs(s[0] - near), Math.abs(s[1] - near)))];
    for (const [a, b] of [...close].sort((x, y) => y[0] - x[0] || y[1] - x[1])) this.delete(a, b);
  }

  applyItems(items: El[]): this {
    const ordered = items.map((it, i) => [pyStr(get(it, 'created', '')), i, it] as const)
      .sort((x, y) => pyStrCmp(x[0], y[0]) || x[1] - y[1]).map((x) => x[2]);
    for (const it of ordered) {
      if (it.op === 'retime' || it.op === 'place') continue;
      for (const r of it.ranges) {
        if (it.op === 'restore') this.restore(r.name, Number(r.s0), Number(r.s1), it.frame);
        else this.cut(r.name, Number(r.s0), Number(r.s1), it.frame);
      }
    }
    for (const it of ordered) if (it.op === 'retime') this.retime(it);
    for (const it of ordered) if (it.op === 'place') this.place(it);
    (this.plan.audio as El[]).sort((a, b) => a.start - b.start);
    return this;
  }

  // -- what belongs to a Point / an emphasis by name follows it when its time is changed
  private follow(L: El, a: number, b: number): void {
    const lid = pyTruthy(get(L, 'id')) ? pyStr(L.id) : '';
    const suffix = lid.includes('-') ? lid.slice(lid.indexOf('-') + 1) : lid;
    const d = a - L.start;
    for (const se of (this.plan.audio ?? []) as El[]) {
      if (get(se, 'kind') === 'se' && [`se-${lid}`, `se-${suffix}`].includes(get(se, 'id'))) {
        se.start = se.start + d;
        se.end = se.end + d;
      }
    }
    if (get(L, 'caption_kind') === 'emphasis') {
      for (const c of (this.plan.camera ?? []) as El[]) {
        if ([`cam-${lid}`, `cam-${suffix}`].includes(get(c, 'id'))) {
          c.start = a;
          c.end = b;
        }
      }
    }
  }

  private stepAside(layers: El[], s0: number, e0: number, a: number, b: number): void {
    for (const x of layers) {      // the header and the small QR step aside while the large QR shows
      if (['header', 'small_qr'].includes(get(x, 'role'))) {
        if (x.end === s0) x.end = a;
        else if (x.start === e0) x.start = b;
      }
    }
    for (const sgm of (this.plan.susume_segments ?? []) as El[]) {
      if (get(sgm, 'kind') === 'large_qr' && sgm.start === s0) {
        sgm.start = a;
        sgm.end = b;
      }
    }
  }

  // -- an emphasis or a large QR shown at another time, with what belongs to it
  retime(it: El): void {
    const tid = it.target.id, kind = it.target.kind;
    const L = ((this.plan.layers ?? []) as El[]).find((x) => pyEq(get(x, 'id'), tid)) ?? null;
    if (L === null) {
      this.warnings.push(`${pyStr(tid)}: not in the plan`);
      return;
    }
    const s0: number = L.start, e0: number = L.end;
    let a = this.frameOf(get(it, 'start_source'), s0);
    let b = this.frameOf(get(it, 'end_source'), e0 - 1);
    if (a === null || b === null) {
      this.warnings.push(`${pyStr(tid)}: its words are no longer in the edit`);
      return;
    }
    b += 1;
    const layers: El[] = this.plan.layers;
    const suffix = tid.includes('-') ? tid.slice(tid.indexOf('-') + 1) : tid;
    if (kind === 'screen') {
      for (const x of layers) {      // never over an emphasis: the screen stops where it starts / ends
        const sid2 = pyStr(get(x, 'id', ''));     // nor over a large QR / thumbnail
        if ((get(x, 'caption_kind') === 'emphasis' || sid2.startsWith('qr-q') || sid2.startsWith('thumb-')) && !pyTruthy(get(x, 'parked')) && x.start < b && a < x.end) {
          if (x.start < s0 || x.end <= s0) a = Math.max(a, x.end);
          else b = Math.min(b, x.start);
        }
      }
      if (b - a < MIN_CAP) {
        this.warnings.push(`${tid}: too short after the move; left as it was`);
        return;
      }
      const r = this.retimeScreen(L, a, b);
      if (r === null) return;
      [a, b] = r;
      this.retimed.push({ kind, id: tid, from: [s0, e0], to: [a, b] });
      return;
    }
    if (kind === 'emphasis') {
      const normal = layers.filter((x) => get(x, 'role') === 'caption' && !pyTruthy(get(x, 'parked')) && get(x, 'caption_kind', 'normal') !== 'emphasis');
      const prev = normal.filter((x) => x.end === s0);
      const nxt = normal.filter((x) => x.start === e0);
      for (const x of prev) a = Math.max(a, x.start + MIN_CAP);
      for (const x of nxt) b = Math.min(b, x.end - MIN_CAP);
      const others = layers.filter((x) => x !== L && get(x, 'caption_kind') === 'emphasis');
      for (const x of others) {      // never over another emphasis
        if (x.end <= s0) a = Math.max(a, x.end);
        else if (x.start >= e0) b = Math.min(b, x.start);
      }
      if (b - a < MIN_CAP) {
        this.warnings.push(`${tid}: too short after the move; left as it was`);
        return;
      }
      const aa = a, bb = b;
      const inside = normal.filter((x) => !pyIn(prev, x) && !pyIn(nxt, x) && x.start < bb && aa < x.end);
      for (const x of inside) {
        if (x.start < a) x.end = a;
        else if (x.end > b) x.start = b;
        else {
          this.warnings.push(`${tid}: would hide the caption 「${pyStr(get(x, 'text', ''))}」; left as it was`);
          return;
        }
      }
      for (const x of prev) x.end = a;
      for (const x of nxt) x.start = b;
      for (const c of (this.plan.camera ?? []) as El[]) {
        if (get(c, 'id') === `cam-${suffix}`) {
          c.start = a;
          c.end = b;
        }
      }
    } else if (this.backdropPieces(suffix).length) {
      if (b - a < MIN_CAP) {
        this.warnings.push(`${tid}: too short after the move; left as it was`);
        return;
      }
      this.cutBackdrop(suffix, a, b);
      for (const x of layers) {      // images that came and went with the QR
        if (x !== L && x.start === s0 && x.end === e0 && !['caption', 'header', 'small_qr'].includes(get(x, 'role'))) {
          x.start = a;
          x.end = b;
        }
      }
      this.stepAside(layers, s0, e0, a, b);
    } else {
      const group = layers.filter((x) => x.start === s0 && x.end === e0 && get(x, 'role') !== 'caption');
      for (const x of group) {       // the blurred background is a video: keep it inside its file
        if (get(x, 'type') === 'video') {
          const sv = src(x);
          a = Math.max(a, s0 - pyInt(sv * this.fps));
          const dur = this.durationOf ? this.durationOf(x.path) : null;
          if (pyTruthy(dur)) b = Math.min(b, a + pyInt((dur! - (sv + (a - s0) / this.fps)) * this.fps));
        }
      }
      if (b - a < MIN_CAP) {
        this.warnings.push(`${tid}: too short after the move; left as it was`);
        return;
      }
      for (const x of group) {
        if (get(x, 'type') === 'video') x.source_start_seconds = pyRoundN(src(x) + (a - s0) / this.fps, 6);
        x.start = a;
        x.end = b;
      }
      this.stepAside(layers, s0, e0, a, b);
    }
    L.start = a;
    L.end = b;
    for (const se of (this.plan.audio ?? []) as El[]) {
      if (get(se, 'kind') === 'se' && [`se-${suffix}`, `se-${tid}`].includes(get(se, 'id'))) {
        se.start = se.start + a - s0;
        se.end = se.end + a - s0;
      }
    }
    this.retimed.push({ kind, id: tid, from: [s0, e0], to: [a, b] });
  }

  // -- the blurred background of a large QR, cut from a full-length blurred copy of the camera
  private backdropPieces(qid: string): El[] {
    const bd = pyTruthy(get(this.plan, 'qr_backdrop')) ? this.plan.qr_backdrop : {};
    const backdrop = new Set(Object.values(bd).map(pyKey));
    const pieces = ((this.plan.layers ?? []) as El[]).filter((x) => pyStr(get(x, 'id', '')).startsWith(`qrbg-${qid}-`));
    return pieces.length && backdrop.size && pieces.every((x) => backdrop.has(pyKey(get(x, 'path')))) ? pieces : [];
  }

  /** a large QR / thumbnail image in another box (review_edits.Edit.place) */
  place(it: El): void {
    const tid = it.target.id;
    const L = (get(this.plan, 'layers', []) as El[]).find((x) => get(x, 'id') === tid && get(x, 'type') === 'image');
    if (!L) { this.warnings.push(`${tid}: not in the plan`); return; }
    L.x = Math.trunc(Number(it.x)); L.y = Math.trunc(Number(it.y)); L.width = Math.trunc(Number(it.width)); L.height = Math.trunc(Number(it.height));
    this.placed.push({ id: tid, box: [L.x, L.y, L.width, L.height] });
  }

  // -- a screen recording shown over another span (review_edits.py _retime_screen, 2026-10-21)
  private retimeScreen(L: El, a: number, b: number): [number, number] | null {
    const tid: string = L.id, sid = tid.slice('frame-'.length);
    const s0: number = L.start, e0: number = L.end;
    const layers: El[] = this.plan.layers, fps = this.fps;
    const clips: El[] = this.plan.clips ?? [];
    const camAt = (f: number): [El | null, number | null] => {
      for (const c of clips) if (c.start <= f && f < c.end) return [c, src(c) + (f - c.start) / fps];
      return [null, null];
    };
    const groups: [string, El[], number][] = [];
    for (const pre of ['scr', 'wipe']) {
      const ps = layers.filter((x) => pyStr(get(x, 'id', '')).startsWith(`${pre}-${sid}-`));
      if (!ps.length) continue;
      const offs: number[] = [];
      for (const x of ps) { const [c, cs] = camAt(x.start); if (c !== null) offs.push(src(x) - cs!); }
      offs.sort((p, q) => p - q);
      groups.push([pre, ps, offs.length ? offs[Math.floor(offs.length / 2)] : 0.0]);
    }
    if (!groups.length) {
      this.warnings.push(`${tid}: no screen pieces; left as it was`);
      return null;
    }
    let camPath: any = null;
    for (const [, ps] of groups) { const [c] = camAt(ps[0].start); camPath = camPath || (c && c.path); }
    if (this.durationOf) {      // the screen file has an end: the moved span stops there
      outer: for (const [, ps, off] of groups) {
        const dur = this.durationOf(ps[0].path);
        if (!pyTruthy(dur)) continue;
        for (const c of clips) {
          const ss = Math.max(a, c.start), ee = Math.min(b, c.end);
          if (ee <= ss || (camPath && c.path !== camPath)) continue;
          const lim = ss + Math.trunc((dur! - (src(c) + (ss - c.start) / fps + off)) * fps);
          if (lim < ee) { b = Math.max(ss, lim); continue outer; }
        }
      }
    }
    if (b - a < MIN_CAP) {
      this.warnings.push(`${tid}: too short after the move; left as it was`);
      return null;
    }
    for (const [pre, ps, off] of groups) {
      const at = pyIndex(layers, ps[0]), tpl = ps[0];
      for (const x of ps) pyRemove(layers, x);
      const add: El[] = [];
      for (const c of clips) {
        const ss = Math.max(a, c.start), ee = Math.min(b, c.end);
        if (ee <= ss || (camPath && c.path !== camPath)) continue;
        const sv = src(c) + (ss - c.start) / fps + off;
        if (sv < 0) continue;
        add.push({ ...tpl, id: `${pre}-${sid}-${pyStr(ss)}`, start: ss, end: ee, source_start_seconds: pyRoundN(sv, 6) });
      }
      layers.splice(at, 0, ...add);
    }
    L.start = a; L.end = b;
    const pol: El | null = pyTruthy(get(this.plan, 'caption_policy')) ? this.plan.caption_policy : null;
    if (pol) {
      for (const r of (get(pol, 'excluded_regions', []) ?? []) as El[]) if (r.start === s0 && r.end === e0) { r.start = a; r.end = b; }
      const ex = ((get(pol, 'excluded_regions', []) ?? []) as El[]).map((r) => [r.start, r.end] as [number, number]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
      const cr = (get(pol, 'continuous_regions', []) ?? []) as El[];
      const starts = [...cr.map((r) => r.start), ...ex.map((x) => x[0])], ends = [...cr.map((r) => r.end), ...ex.map((x) => x[1])];
      const lo = starts.length ? Math.min(...starts) : 0, hi = ends.length ? Math.max(...ends) : this.plan.frames;
      const cont: El[] = [];
      let f = lo;
      for (const [xs, xe] of ex) { if (xs > f) cont.push({ start: f, end: xs }); f = Math.max(f, xe); }
      if (f < hi) cont.push({ start: f, end: hi });
      pol.continuous_regions = cont;
    }
    const normal = (x: El) => get(x, 'role') === 'caption' && get(x, 'caption_kind', 'normal') === 'normal';
    for (const x of layers) {
      if (normal(x) && !pyTruthy(get(x, 'parked')) && x.start < b && a < x.end) {
        if (x.start < a) x.end = a;
        else if (x.end > b) x.start = b;
        else x.parked = true;
      }
    }
    for (const [rs, re] of [[s0, Math.min(a, e0)], [Math.max(b, s0), e0]]) {
      if (re <= rs) continue;
      for (const x of layers) {
        if (normal(x) && pyTruthy(get(x, 'parked')) && x.start < re && rs < x.end) {
          delete x.parked;
          x.start = Math.max(x.start, rs); x.end = Math.min(x.end, re);
        }
      }
    }
    const w0 = Math.min(s0, a) - 1, w1 = Math.max(e0, b) + 1;
    const ex2 = pol ? ((get(pol, 'excluded_regions', []) ?? []) as El[]).map((r) => [r.start, r.end] as [number, number]) : [];
    const open = (f0: number, f1: number) => !ex2.some(([xs, xe]) => xs < f1 && f0 < xe);
    const live = layers.filter((x) => normal(x) && !pyTruthy(get(x, 'parked'))).sort((p, q) => p.start - q.start);
    const others = layers.filter((x) => get(x, 'role') === 'caption' && get(x, 'caption_kind', 'normal') !== 'normal' && !pyTruthy(get(x, 'parked')))
      .map((x) => [x.start, x.end] as [number, number]);
    for (let i = 0; i < live.length - 1; i++) {
      const x = live[i], nxt = live[i + 1];
      if (x.end < nxt.start && x.end <= w1 && nxt.start >= w0 && open(x.end, nxt.start)) {
        const inside = others.filter(([os, oe]) => os < nxt.start && x.end < oe);
        if (inside.length) {      // an emphasis / Point in the gap: the caption after it starts where it ends
          const e = Math.max(...inside.map(([, oe]) => oe));
          if (x.end >= Math.min(...inside.map(([os]) => os)) && e < nxt.start) nxt.start = e;
        } else x.end = nxt.start;
      }
    }
    for (const r of (pol ? pol.continuous_regions : []) as El[]) {
      if (!(w0 <= r.start && r.start <= w1)) continue;
      const first = live.find((x) => x.end > r.start);
      if (first && first.start > r.start && first.start < r.end && open(r.start, first.start)) first.start = r.start;
    }
    for (const x of layers) {
      if (get(x, 'caption_kind') === 'point' && (x.start < a || x.end > b) && x.start < e0 && s0 < x.end) {
        this.warnings.push(`${tid}: Point 「${pyStr(get(x, 'text', ''))}」 is outside the moved screen recording`);
      }
    }
    return [a, b];
  }

  private cutBackdrop(qid: string, a: number, b: number): void {
    const layers: El[] = this.plan.layers, backdrop: El = this.plan.qr_backdrop;
    const pieces = this.backdropPieces(qid);
    const at = pyIndex(layers, pieces[0]), tpl = pieces[0];
    for (const x of pieces) pyRemove(layers, x);
    const add: El[] = [];
    for (const c of (this.plan.clips ?? []) as El[]) {
      const ss = Math.max(a, c.start), ee = Math.min(b, c.end);
      if (ee <= ss) continue;
      const path = get(backdrop, c.path);
      if (!pyTruthy(path)) {
        this.warnings.push(`qr-${qid}: no blurred copy of ${name(c)}; that part shows unblurred`);
        continue;
      }
      add.push({ ...tpl, id: `qrbg-${qid}-${pyStr(ss)}`, path, start: ss, end: ee,
        source_start_seconds: pyRoundN(src(c) + (ss - c.start) / this.fps, 6) });
    }
    layers.splice(at, 0, ...add);
  }

  // -- checks shown on the page after every change
  check(base: El): CheckReport {
    const notes: string[] = [];
    const p = this.plan;
    const clips: El[] = p.clips ?? [];
    if (clips.length && clips[clips.length - 1].end !== p.frames) {
      notes.push(`映像の最後（${pyStr(clips[clips.length - 1].end)}）と動画の長さ（${pyStr(p.frames)}）が合いません`);
    }
    for (const x of [...(p.layers ?? []), ...(p.audio ?? [])] as El[]) {
      if (x.end > p.frames) notes.push(`${pyStr(get(x, 'id', ''))} が動画の終わりより後まで続きます`);
    }
    // caption track: no gap inside the regions that keep captions
    const cov = new Uint8Array(p.frames + 1);
    for (const x of (p.layers ?? []) as El[]) {
      if (get(x, 'role') === 'caption' && !pyTruthy(get(x, 'parked'))) {
        const [lo, hi] = sliceBounds(cov.length, Math.max(0, x.start), Math.min(p.frames, x.end));
        cov.fill(1, lo, hi);
      }
    }
    const cp = pyTruthy(get(p, 'caption_policy')) ? p.caption_policy : {};
    for (const r of (get(cp, 'continuous_regions', []) ?? []) as El[]) {
      const [lo, hi] = sliceBounds(cov.length, r.start, r.end);
      let count = 0, first = -1;
      for (let i = lo; i < hi; i++) if (!cov[i]) { if (first < 0) first = i - lo; count++; }
      if (count) notes.push(`字幕の空白 ${count}コマ（${pyStr(r.start + first)} から）`);
    }
    // BGM long enough
    for (const x of (p.audio ?? []) as El[]) {
      if (get(x, 'kind') !== 'bgm' || pyTruthy(get(x, 'loop')) || !this.durationOf) continue;
      const dur = this.durationOf(x.path);
      const need = src(x) + (x.end - x.start) / this.fps;
      if (pyTruthy(dur) && need > dur! + 1 / this.fps) {
        notes.push(`BGM「${baseName(x.path)}」が ${pyStr(pyRound((need - dur!) * this.fps))}コマ足りません`);
      }
    }
    // everything after the last change moved by the same amount
    const delta = p.frames - base.frames;
    const last = this.lastBasePoint();
    let moved = 0, bad = 0;
    if (last !== null) {
      for (const k of ['clips', 'layers', 'audio', 'camera']) {
        const now = new Map<any, El[]>();
        for (const x of (p[k] ?? []) as El[]) {
          const key = pyKey(get(x, '_o'));
          if (!now.has(key)) now.set(key, []);
          now.get(key)!.push(x);
        }
        ((base[k] ?? []) as El[]).forEach((x, i) => {
          if (x.start <= last) return;
          const got = now.get(i) ?? [];
          moved += 1;
          if (got.length !== 1 || got[0].start !== x.start + delta || got[0].end !== x.end + delta) bad += 1;
        });
      }
    }
    if (bad) notes.push(`最後の直しより後の ${bad}個が、同じだけずれていません`);
    return { ok: !notes.length, notes, delta_frames: delta, checked_after_last_change: moved };
  }

  /** The latest frame of the original plan that any change touched. */
  private lastBasePoint(): number | null {
    const toBase = (y: number, upto: number): number => {
      for (let j = upto - 1; j >= 0; j--) {      // back to the original plan's frames
        const prev = this.ops[j];
        if (prev[0] === 'ins') {
          const [, P, n] = prev;
          y = y >= P + n ? y - n : y >= P ? P : y;
        } else {
          const [, a, b] = prev;
          y = y >= a ? y + (b - a) : y;
        }
      }
      return y;
    };
    const pts = this.ops.map((op, j) => toBase(op[0] === 'ins' ? op[1] : op[2], j));
    for (const r of this.retimed) pts.push(toBase(Math.max(r.from[1], r.to[1]), this.ops.length));
    for (const e of this.timedEdges) pts.push(toBase(e, this.ops.length));
    return pts.length ? pts.reduce((m, x) => (x > m ? x : m)) : null;
  }

  // -- captions moved on the page
  frameOf(s: any, near: number): number | null {
    if (!pyTruthy(s)) return null;
    let best: number | null = null;
    for (const c of this.plan.clips as El[]) {
      if (name(c) !== get(s, 'name')) continue;
      const d = Number(s.seconds) - src(c);
      if (-0.5 / this.fps <= d && d < (c.end - c.start) / this.fps) {
        let f = c.start + Math.max(0, pyRound(d * this.fps));
        f = Math.min(f, c.end - 1);
        if (best === null || Math.abs(f - near) < Math.abs(best - near)) best = f;
      }
    }
    return best;
  }

  /** frameOf, or when that source frame was cut later, the nearest kept frame inward (step +1 / -1, up to 1 s). */
  frameKept(s: any, near: number, step: number): number | null {
    let f = this.frameOf(s, near);
    if (f !== null || !pyTruthy(s)) return f;
    for (let k = 1; k < pyInt(this.fps) + 1; k++) {
      f = this.frameOf({ ...s, seconds: Number(s.seconds) + step * k / this.fps }, near);
      if (f !== null) return f;
    }
    return null;
  }

  applyCaptionTimes(items: El[]): this {
    const caps = new Map<any, El>();
    const setdefault = (k: any, v: El) => { const kk = pyKey(k); if (!caps.has(kk)) caps.set(kk, v); };
    for (const L of (this.plan.layers ?? []) as El[]) {
      if (get(L, 'role') === 'caption' && !pyTruthy(get(L, 'parked'))) {     // a caption parked under a screen recording is not on screen
        setdefault(get(L, 'id'), L);
        setdefault(pyTruthy(get(L, 'caption_id')) ? L.caption_id : get(L, 'id'), L);
      }
    }
    const moved: El[] = [];
    for (const it of items) {
      if (get(it, 'op') !== 'time') continue;
      // the words of the caption: before the reviewer retyped it, or after (a rebuilt plan already has the new words)
      const ws = new Set<string>();
      for (const t of [get(it, 'old_text'), get(it, 'text_now')]) if (pyTruthy(t)) ws.add(pyStr(t).replaceAll('\n', ''));
      let L: El | null = caps.get(pyKey(get(it, 'layer_id'))) ?? caps.get(pyKey(get(it, 'caption_id'))) ?? null;
      if (L !== null && ws.size && !ws.has(text(L))) L = null;
      if (L === null) {      // the plan was rebuilt and the ids moved: the same words at the same place in the source
        const f = this.frameKept(pyTruthy(get(it, 'source')) ? it.source : get(it, 'start_source'),
          get(it, 'old_frame', get(it, 'frame', 0)), 1);
        if (f !== null && ws.size) {
          L = ((this.plan.layers ?? []) as El[]).find((x) => get(x, 'role') === 'caption' && !pyTruthy(get(x, 'parked')) && x.start - 20 <= f && f < x.end + 20
            && ws.has(text(x))) ?? null;
        }
      }
      if (L === null) {
        this.warnings.push(`caption ${pyStr(get(it, 'caption_id'))}: not in the plan`);
        continue;
      }
      let a = this.frameKept(get(it, 'start_source'), L.start, 1);
      let b = this.frameKept(get(it, 'end_source'), L.end - 1, -1);
      if (a === null || b === null || b + 1 <= a) {
        this.warnings.push(`caption ${pyStr(get(it, 'caption_id'))}: its words are no longer in the edit`);
        continue;
      }
      if (get(L, 'caption_kind', 'normal') === 'normal') {     // never into a stretch the reviewer said has no caption
        const cp = pyTruthy(get(this.plan, 'caption_policy')) ? this.plan.caption_policy : {};
        for (const r of (get(cp, 'excluded_regions', []) ?? []) as El[]) {
          if (r.start <= a && a < r.end && r.end <= b) a = r.end as number;
          if (r.start <= b && b < r.end && a < r.start) b = r.start - 1;
        }
      }
      a = a as number;
      b = b as number;
      if (['point', 'emphasis'].includes(get(L, 'caption_kind')) && !(L.start === a && L.end === b + 1)) {
        this.retimed.push({ kind: L.caption_kind, id: get(L, 'id'), from: [L.start, L.end], to: [a, b + 1] });
        this.follow(L, a, b + 1);
      }
      this.timedEdges.push(Math.max(L.end, b + 1) + 1);     // its neighbour moves with it
      L.start = a;
      L.end = b + 1;
      L.timed_by_reviewer = true;
      moved.push(L);
    }
    if (moved.length) {   // keep normal captions from overlapping after the moves
      const mv = new Set(moved);
      const normal = ((this.plan.layers as El[]).filter((L) => get(L, 'role') === 'caption' && !pyTruthy(get(L, 'parked')) && get(L, 'caption_kind', 'normal') !== 'emphasis'))
        .map((L, i) => [L, i] as const)
        .sort((x, y) => x[0].start - y[0].start || x[0].end - y[0].end || x[1] - y[1]).map((x) => x[0]);
      for (let i = 0; i + 1 < normal.length; i++) {
        const p = normal[i], q = normal[i + 1];
        if (p.end > q.start) {
          if (mv.has(q) && !mv.has(p)) p.end = q.start;
          else q.start = p.end;
        } else if (0 < q.start - p.end && q.start - p.end <= 2 && (mv.has(p) || mv.has(q))) {
          // source seconds rounded on the page: one boundary, not a 1-frame hole
          if (mv.has(p) && !mv.has(q)) q.start = p.end;
          else p.end = q.start;
        }
      }
      this.plan.layers = (this.plan.layers as El[]).filter((L) => L.end > L.start);
    }
    return this;
  }

  result(keepOrigin = false): Plan {
    const p = structuredClone(this.plan);
    if (!keepOrigin) {
      for (const k of ['clips', 'layers', 'audio', 'camera']) for (const el of (p[k] ?? []) as El[]) delete el._o;
    }
    return p;
  }
}

/** Follow plain [start, end) spans (the preview's marks) through recorded ops. */
export function remapSpans<T extends { start: number; end: number }>(spans: T[], ops: Op[]): T[] {
  let out = spans.map((s) => ({ ...s }));
  for (const op of ops) {
    const nxt: T[] = [];
    if (op[0] === 'ins') {
      const [, P, n] = op;
      for (const s of out) {
        if (s.start >= P) {
          s.start += n;
          s.end += n;
        } else if (s.end > P) s.end += n;
        nxt.push(s);
      }
    } else {
      const [, a, b] = op;
      for (const s of out) {
        s.start = s.start <= a ? s.start : s.start < b ? a : s.start - (b - a);
        s.end = s.end <= a ? s.end : s.end < b ? a : s.end - (b - a);
        if (s.end > s.start) nxt.push(s);
      }
    }
    out = nxt;
  }
  return out;
}

/** cuts -> emphasis / large QR moves -> caption times (retyped captions are not baked here). Returns [plan, edit] like Python. */
export function applyAll(plan: El, cutItems: El[], timeItems: El[] = [], keepOrigin = false,
  durationOf: DurationOf | null = null, check = false): [Plan, Edit] {
  const ed = new Edit(plan, durationOf).applyItems(cutItems);
  ed.applyCaptionTimes([...timeItems]);
  ed.report = check ? ed.check(plan) : null;
  return [ed.result(keepOrigin), ed];
}

/** What review_edits.py hands back besides the plan, with its JSON keys. */
export function editSummary(ed: Edit) {
  return { ops: ed.ops, warnings: ed.warnings, retimed: ed.retimed, timed_edges: ed.timedEdges, placed: ed.placed, report: ed.report, baked: 0 };
}

/** The Python names, for code written against review_edits.py. */
export const reviewEdits = {
  fps_of: fpsOf,
  remap_spans: remapSpans,
  apply_all(plan: El, cut_items: El[], time_items: El[] = [], keep_origin = false, duration_of: DurationOf | null = null, check = false) {
    const [p, ed] = applyAll(plan, cut_items, time_items, keep_origin, duration_of, check);
    return [p, editSummary(ed)] as const;
  },
};
