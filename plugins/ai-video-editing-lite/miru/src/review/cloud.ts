// 確認画面（スキルの assets/review/index.html をそのまま使う）を、サイトで動かすためのつなぎ（2026-10-19）。
//
// ページは手元の review_server.py の道（/api/manifest・/api/comments・/api/caption-edits・/api/cut-edits・/media/…）を呼ぶ。
// ここでその道を受けて、サイトの API と R2 のファイルに置き換える。
//   ・カットや出入りの手直しは、手元のサーバーが Python でしていた計算（review_edits）をブラウザの中で（./edits.ts）
//   ・手直しのあとの音は、計画の音を Web Audio で並べて鳴らす（./mixer.ts）。手直しが無いときはプレビューの音をそのまま
// ページの本体（スキル側）を変えずに済むように、つなぎはこの 1 つにまとめる。

import { applyAll, remapSpans } from "./edits";
import { PlanMixer, type AudioIndex, type MixPlan } from "./mixer";
import { renderCaption, type CaptionStyle } from "./caption";
import { mark, startDiag } from "./diag";
import { mergeEdits, planNoteSync, stampOf } from "./notesync";
import { attachDrawings, startCompare } from "./compare";

declare global { interface Window { MIRU_MEDIA?: string; MIRU_CLOUD?: number; __miruStart?: () => void; Audio: typeof Audio } }

type Json = Record<string, any>;
const q = new URLSearchParams(location.search);
const vid = q.get("v") ?? "";
const enc = encodeURIComponent;
const realFetch = window.fetch.bind(window);

async function api(path: string, opt: RequestInit & { json?: unknown } = {}): Promise<any> {
  const method = opt.method ?? "GET";
  const r = await realFetch(path, { ...opt, credentials: "same-origin", headers: { ...(method !== "GET" ? { "x-miru": "1" } : {}), ...(opt.json !== undefined ? { "content-type": "application/json" } : {}) },
    body: opt.json !== undefined ? JSON.stringify(opt.json) : opt.body });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401) { location.href = `/login?next=${enc(location.pathname + location.search)}`; throw new Error("ログインしてください"); }
  if (!r.ok) throw new Error(d.error ?? String(r.status));
  return d;
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function boot() {
  if (!vid) { location.replace("/"); return; }
  mark("boot");
  const video = await api(`/api/videos/${enc(vid)}`);
  mark("video_info");
  const ready: { name: string }[] = video.versions.filter((x: Json) => x.ready);
  if (!ready.length) throw new Error("この動画にはまだプレビューがありません");
  const ver = ready.some((x) => x.name === q.get("ver")) ? q.get("ver")! : ready[0].name;
  const base = `/m/${enc(vid)}/${enc(ver)}/`;
  window.MIRU_MEDIA = `${base}media/`;
  const role: string = video.role;

  // 手直しの一覧も、ほかのファイルと同時に取りに行く（前は読み終わってから順に取りに行き、開くのが 1 往復分遅かった。2026-10-24）
  const editsAhead = Promise.all([api(`/api/videos/${enc(vid)}/edits/cut`), api(`/api/videos/${enc(vid)}/edits/caption`)]);
  const [manifest, plan, audioIndex, durations, carried, capStyle] = await Promise.all([
    realFetch(base + "manifest.json", { cache: "no-cache" }).then((r) => r.json()),
    realFetch(base + "plan.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)),
    realFetch(base + "audio/index.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)) as Promise<AudioIndex | null>,
    realFetch(base + "durations.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : {})) as Promise<Record<string, number>>,
    realFetch(base + "carried.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : { items: [] })),
    realFetch(base + "caption-style.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)) as Promise<CaptionStyle | null>,
  ]);
  mark("files");
  document.title = `${video.video.title} ${ver} | MIRU`;

  // ── 手直しを当てた時間軸（手元のサーバーの edited_manifest と同じ形）──
  let cuts: Json = { items: [] }, caps: Json = { items: [] };
  let capsShown: Json[] | null = null;      // ページがいま持っている字幕の手直し（保存のとき、この画面で変えた分を見分ける相手）
  const plans = new Map<string, MixPlan>();          // 'mix:<rev>' → その時間軸の計画（音を鳴らすのに使う）
  let edited: { key: string; out: Json } | null = null;
  const digest = async (x: unknown) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(x))))].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
  async function editedManifest(): Promise<Json> {
    const items = (cuts.items as Json[]).filter((x) => x.preview === ver);
    const follow = (caps.items as Json[]).filter((x) => x.op === "time" && x.preview === ver && (x.caption_kind === "point" || x.caption_kind === "emphasis"));
    const baseOut = { ...manifest, cut_rev: "", follow_rev: "", cut_warnings: [], cut_check: null, retimed: [], caption_style: !!capStyle };
    if (!plan || (!items.length && !follow.length)) return plan || !items.length ? baseOut : { ...baseOut, cut_error: "この版には計画が上がっていないので、カットの手直しは使えません" };
    const rev = items.length ? await digest(items) : "", frev = follow.length ? await digest(follow) : "";
    if (edited?.key === rev + "|" + frev) return edited.out;
    const t0 = performance.now();
    const [p, ed] = applyAll(plan, items, follow, true, (path: string) => durations[path] ?? null, true);
    const m = manifest;
    const clips = p.clips.map((c: Json, i: number) => ({ ...m.clips[c._o], i, src: Number(c.source_start_seconds ?? 0), start: c.start, end: c.end }));
    const layers = p.layers.map((L: Json, i: number) => ({ ...m.layers[L._o], i, start: L.start, end: L.end, ...(L.keyframes ? { keyframes: L.keyframes } : {}),
      ...Object.fromEntries(["x", "y", "width", "height"].filter((k) => k in L).map((k) => [k, L[k]])),       // 画面で置き直した画像
      ...(L.type === "video" ? { src: Number(L.source_start_seconds ?? 0) } : {}) }));
    const camera = (p.camera ?? []).map(({ _o, ...c }: Json) => c);
    // the name card and the title band follow other moves (a title piece steps aside for a moved emphasis): their marks
    // are read again from the moved layers instead of remapped
    const marks: Json[] = remapSpans((m.marks ?? []).filter((x: Json) => x.kind !== "name" && x.kind !== "title"), ed.ops) as Json[];
    for (const L of layers as Json[]) {
      const id = String(L.id ?? "");
      if (id.startsWith("namecard-")) marks.push({ kind: "name", start: L.start, end: L.end, label: "名札" });
      else if (id.startsWith("hdr-l") && L.role === "header") marks.push({ kind: "title", start: L.start, end: L.end, label: "タイトル" });
    }
    marks.sort((x: Json, y: Json) => x.start - y.start || x.end - y.end);
    for (const r of ed.retimed) {
      const kind = r.kind === "large_qr" ? "qr" : r.kind;
      const mk = marks.find((x: Json) => x.kind === kind && x.start === r.from[0]);
      if (mk) [mk.start, mk.end] = r.to;
    }
    const key = `mix:${rev || "0"}-${frev || "0"}`;
    plans.set(key, p);
    const out = { ...baseOut, frames: p.frames, clips, layers, camera, marks, audio: key, cut_rev: rev, follow_rev: frev, cut_warnings: ed.warnings,
      cut_ops: ed.ops, cut_check: ed.report, retimed: ed.retimed, cut_seconds: Math.round(performance.now() - t0) / 1000,
      ...(audioIndex ? {} : { cut_warnings: [...ed.warnings, "この版には音のもとが上がっていないので、手直しのあとの音は鳴りません"] }) };
    edited = { key: rev + "|" + frev, out };
    return out;
  }

  // ── 修正指示: ページの形（comments.items）とサイトの notes を行き来する ──
  // 2026-10-24 の点検で見つかったデータの消失を直した: ページが持っている一覧を「サイトの最新」と比べて差を送っていたため、
  // ページに無い他の人の新しい指示を DELETE し、他の人や AI が直した文・「済」を古い値に PATCH で戻し、消された指示を POST で
  // 生き返らせていた。いまは「この画面で変えたもの」だけを送る:
  //   ・足す（POST）: サイトから来ていない（updated_at の無い）指示だけ
  //   ・直す（PATCH）: ページの写しがサイトと同じ版（updated_at が同じ）のときだけ。サイトの方が新しければ、他の人の変更を残す
  //   ・消す（DELETE）: ページが一覧を受け取った後に誰も触っていない（updated_at がページの saved_at 以下）指示だけ
  // saved_at は「件数＋最新の時刻」にして、消されたことも見張りで気づけるようにする。
  const toItem = (n: Json) => ({ ...n, preview: n.version, status: n.status === "done" ? "done" : "open", ...(n.reply ? { reply: n.reply } : {}) });
  let known = new Map<string, Json>();
  async function loadComments() {
    const d = await api(`/api/videos/${enc(vid)}/notes`);
    known = new Map(d.notes.map((n: Json) => [n.id, n]));
    return { items: d.notes.map(toItem), saved_at: stampOf(d.notes) };
  }
  async function saveComments(doc: Json) {
    await loadComments();                                   // 比べる相手はいまのサイト
    const { post, patch, del } = planNoteSync(doc.items ?? [], doc.saved_at, known);
    // 描いた線は、描いた場面で書いた指示にだけ付ける。前に付けた線は id で覚えていて、やり直しや送り直しでも付く（compare.ts）
    attachDrawings(post, ver);
    for (const it of post) await api(`/api/videos/${enc(vid)}/notes`, { method: "POST", json: { ...it, version: it.preview ?? ver } });
    for (const it of patch) {
      const n = known.get(it.id)!;
      await api(`/api/videos/${enc(vid)}/notes/${enc(it.id)}`, { method: "PATCH", json: { text: it.text, status: it.status === "done" ? "done" : n.status === "done" ? "open" : n.status } });
    }
    for (const id of del) await api(`/api/videos/${enc(vid)}/notes/${enc(id)}`, { method: "DELETE" });
    return loadComments();
  }

  // ── ページの道を受ける ──
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    const p = url.pathname, method = (init?.method ?? "GET").toUpperCase();
    const body = () => JSON.parse(String(init?.body ?? "{}"));
    try {
      if (p === "/api/manifest") return reply({ ...(await editedManifest()), previews: ready.map((x) => x.name).reverse(), name: ver, comments_file: "MIRU", caption_edits_file: "MIRU", cut_edits_file: "MIRU" });
      if (p === "/api/comments") {
        if (method !== "POST" && bootNotes) { const d = await bootNotes; bootNotes = null; if (d) return reply(d); }
        return reply(method === "POST" ? await saveComments(body()) : await loadComments());
      }
      if (p === "/api/caption-edits") {
        if (method !== "POST" && bootCaps) { const d = bootCaps; bootCaps = null; capsShown = d.items ?? []; return reply(d); }   // 起動で読んだばかり
        if (method === "POST") {
          if (role === "viewer") return reply({ error: "見るだけの権限です" }, 403);
          // この画面で変えた分だけ、いまのサイトの一覧に重ねる（他の人が直前に保存した手直しを消さない）
          // ページは保存の返事の一覧を受け取らず自分の一覧を持ち続けるので、次に比べる相手はページが送ったもの
          const b = body(), latest = await api(`/api/videos/${enc(vid)}/edits/caption`);
          caps = await api(`/api/videos/${enc(vid)}/edits/caption`, { method: "PUT", json: { ...b, items: mergeEdits(capsShown, b.items ?? [], latest.items ?? []) } });
          capsShown = b.items ?? [];
          return reply({ ...caps, manifest: await editedManifest() });
        }
        caps = await api(`/api/videos/${enc(vid)}/edits/caption`);
        capsShown = caps.items ?? [];
        return reply(caps);
      }
      if (p === "/api/cut-edits") {
        if (method !== "POST" && bootCuts) { const d = bootCuts; bootCuts = null; return reply(d); }
        if (method === "POST") {
          if (role === "viewer") return reply({ error: "見るだけの権限です" }, 403);
          const b = body(), latest = await api(`/api/videos/${enc(vid)}/edits/cut`);
          cuts = await api(`/api/videos/${enc(vid)}/edits/cut`, { method: "PUT", json: { ...b, items: mergeEdits(cuts.items ?? null, b.items ?? [], latest.items ?? []) } });
          return reply({ ...cuts, manifest: await editedManifest() });
        }
        cuts = await api(`/api/videos/${enc(vid)}/edits/cut`);
        return reply(cuts);
      }
      if (p === "/api/carried") return reply({ ...carried, preview: ver });
      if (p === "/api/previews") {
        const v2 = await api(`/api/videos/${enc(vid)}`);
        return reply({ current: ver, previews: v2.versions.filter((x: Json) => x.ready).map((x: Json) => x.name).reverse() });
      }
      if (p === "/api/preview" && method === "POST") { const u = new URL(location.href); u.searchParams.set("ver", body().name); u.searchParams.delete("f"); history.replaceState(null, "", u); return reply({ ok: true }); }
      if (p === "/api/caption-image" && method === "POST" && capStyle) {    // 打ち直した字幕を書き出しと同じ描き方で（./caption.ts）
        const b = body();
        const r = await renderCaption(capStyle, b.kind, String(b.text ?? ""), b.speaker ?? null, b.role ?? null, (key) => base + key);
        return reply({ url: URL.createObjectURL(r.blob), x: r.x, y: r.y });
      }
      if (p.startsWith("/api/caption-image") || p.startsWith("/api/style")) return reply({ error: "サイトでは使えません" }, 404);
    } catch (e) { return reply({ error: (e as Error).message }, 400); }
    return realFetch(input, init);
  };

  // ── 音: 'mix:…' のときは計画の音を並べて鳴らし、それ以外は普通の <audio> ──
  const RealAudio = window.Audio;
  let mixer: PlanMixer | null = null;
  const pageEvents: [string, () => void][] = [];
  const getMixer = () => {
    if (!mixer) {
      mixer = new PlanMixer(audioIndex!, (sid, k) => `${base}audio/${sid}/${k}.flac`);
      for (const [ev, fn] of pageEvents) mixer.addEventListener(ev, fn);      // ページが付けた再生・停止・終わりの知らせ
    }
    return mixer;
  };
  class HybridAudio {
    el = new RealAudio();
    mode: "el" | "mix" = "el";
    private _rate = 1;          // この音の速度。切り替えた先（<audio> と計画の音）にも同じ値を渡す（前の値に戻らないように）
    constructor(src?: string) { (this.el as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true; if (src) this.src = src; }
    private get t(): HTMLAudioElement | PlanMixer { return this.mode === "mix" ? getMixer() : this.el; }
    get src() { return this.mode === "mix" ? this._mixSrc : this.el.src; }
    private _mixSrc = "";
    set src(u: string) {
      const key = decodeURIComponent(u.split("/media/").pop()!.split("?")[0]);
      const at = this.currentTime, rate = this._rate, playing = !this.paused;
      if (playing) this.t.pause();
      if (key.startsWith("mix:") && plans.has(key) && audioIndex) {
        this.mode = "mix"; this._mixSrc = new URL(u, location.href).href;
        getMixer().setPlan(plans.get(key)!);
        setTimeout(() => getMixer().emit("loadedmetadata"), 0);
      } else {
        this.mode = "el"; this.el.src = u;
      }
      this.t.currentTime = at; this.t.playbackRate = rate;
      if (playing) void this.t.play();
    }
    load() { if (this.mode === "el") this.el.load(); else setTimeout(() => getMixer().emit("loadedmetadata"), 0); }
    play() { return this.t.play(); }
    pause() { this.t.pause(); }
    get paused() { return this.t.paused; }
    get currentTime() { return this.t.currentTime; }
    set currentTime(v: number) { this.t.currentTime = v; }
    get playbackRate() { return this._rate; }
    set playbackRate(v: number) { this._rate = v; this.el.playbackRate = v; if (mixer) mixer.playbackRate = v; }
    get readyState() { return this.mode === "mix" ? getMixer().readyState : this.el.readyState; }   // 2 = 読み込み待ち（画面は映像も止める）
    get duration() { return this.t.duration; }
    set preload(v: string) { this.el.preload = v as "" | "none" | "metadata" | "auto"; }
    addEventListener(ev: string, fn: () => void, o?: AddEventListenerOptions) {
      this.el.addEventListener(ev, fn, o);
      if (o?.once) { if (audioIndex) getMixer().addEventListener(ev, fn, { once: true }); return; }     // src を替える前に付けられることがある
      pageEvents.push([ev, fn]);
      if (mixer) mixer.addEventListener(ev, fn);
    }
  }
  window.Audio = HybridAudio as unknown as typeof Audio;
  // 確かめるための入口（音の照合・不具合の調べ）。画面の動きには使わない
  (window as unknown as { __miru: unknown }).__miru = { PlanMixer, plans, audioIndex, base, editedManifest };

  // ── サイトの印: 左上にホームへ戻る道。「強調デザイン」はこのチャンネルの一覧（サイトの /c/<チャンネル>/designs）を上に重ねて開く ──
  (window as unknown as { MIRU_STYLES: string }).MIRU_STYLES = `/c/${enc(video.video.channel_id)}/designs?embed=1`;
  const st = document.createElement("style");
  st.textContent = `.miru-home{display:inline-flex;align-items:center;gap:6px;margin-right:8px;font-weight:800;letter-spacing:.12em;font-size:13px;color:inherit;text-decoration:none}
    .miru-home i{width:22px;height:22px;border-radius:7px;display:grid;place-items:center;color:#fff;font-style:normal;letter-spacing:0;background:linear-gradient(135deg,#3d9bff,#7a5cff)}`;
  document.head.append(st);
  const home = document.createElement("a");
  home.href = "/"; home.className = "miru-home"; home.title = "ホームへ"; home.innerHTML = "<i>M</i>MIRU";
  const header = document.querySelector("header") ?? document.body;
  header.prepend(home);

  // 先に今の手直しを読んでおく（最初の /api/manifest で使い、ページが続けて取りに来る分にもそのまま返す）
  [cuts, caps] = await editsAhead;
  bootNotes = loadComments().catch(() => null);      // ページがすぐ取りに来る修正指示も先に
  bootCuts = cuts; bootCaps = caps;
  mark("edits");
  window.__miruStart?.();
  startDiag(vid);
  prefetchImages(manifest, base, ver);
  startCompare(vid, ver, ready.map((x) => x.name), role !== "viewer");
}
let bootCuts: Json | null = null, bootCaps: Json | null = null;
let bootNotes: Promise<Json | null> | null = null;

/** 字幕・強調などの画像を、再生位置の少し先（1 分）だけ、優先度を低くして裏で読んでおく。
 *  2026-10-23 の再生の記録で確定: 前の先読み（優先度の高い fetch を 4 本ずつ、全部の画像 600 本以上を 55 秒続けて）が、
 *  画面に今出す字幕画像（<img>・優先度が低い）の読み込みを Chrome に 15〜18 秒後回しにさせ、字幕が出なくなっていた。
 *  いまは: 優先度「低」・同時に 2 本まで・再生位置から 1 分先までに出る画像だけ。画面の字幕画像はページ側で優先度「高」。
 *  画像を開いたまま持たない（数百枚を展開するとメモリが足りない）。ページと同じ URL で取り、ブラウザのキャッシュに入れるだけ。 */
function prefetchImages(manifest: Json, base: string, ver: string) {
  const v = encodeURIComponent(`${ver}-${manifest.built_at ?? ""}`);
  const flat = !!manifest.flat;
  const live = (L: Json) => L.role === "caption" || L.role === "header" || L.role === "small_qr" || /^(qr-q|qrbg-|thumb)/.test(String(L.id ?? ""));
  const firstAt = new Map<string, number>();
  for (const L of manifest.layers as Json[]) {
    if (L.type !== "image" || !L.media || (flat && !live(L))) continue;
    if (!firstAt.has(L.media) || L.start < firstAt.get(L.media)!) firstAt.set(L.media, L.start);
  }
  const order = [...firstAt.entries()].sort((a, b) => a[1] - b[1]);
  const fps = (Number(manifest.fps_num) || 30) / (Number(manifest.fps_den) || 1);
  const AHEAD = 60 * fps, PARALLEL = 2;
  const done = new Set<string>();
  let running = 0;
  const now = (): number => { try { return frameNow(); } catch { return 0; } };
  const pump = () => {
    const f = now();
    for (const [k, at] of order) {
      if (running >= PARALLEL) return;
      if (done.has(k) || at < f - 30 || at > f + AHEAD) continue;
      done.add(k); running++;
      realFetch(`${base}media/${k}?v=${v}`, { credentials: "same-origin", priority: "low" } as RequestInit)
        .then((r) => r.arrayBuffer()).catch(() => { done.delete(k); }).finally(() => { running--; pump(); });
    }
  };
  setTimeout(() => { pump(); setInterval(pump, 1000); }, 1500);   // 最初の映像と音を先に。再生位置が動けば 1 秒以内に追う
}
declare function frameNow(): number;

window.MIRU_CLOUD = 1;
boot().catch((e) => {
  const box = document.getElementById("skErr");
  if (box) { box.hidden = false; box.textContent = "読み込めませんでした：" + (e as Error).message; }
  console.error(e);
});
