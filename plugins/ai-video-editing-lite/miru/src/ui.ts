// 画面の部品（2026-10-19）: API の呼び出し・短い知らせ・下からのパネル・横スワイプ・引っ張って更新・入力の候補・スケルトン

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export function h(html: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

export class ApiError extends Error { constructor(public status: number, msg: string) { super(msg); } }
/** API を呼ぶ（書き換えには、この画面から来た印 x-miru を付ける） */
export async function api<T = any>(path: string, opt: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opt.method ?? "GET";
  const res = await fetch(path, {
    method, credentials: "same-origin",
    headers: { ...(method !== "GET" ? { "x-miru": "1" } : {}), ...(opt.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: opt.body === undefined ? undefined : JSON.stringify(opt.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !location.pathname.startsWith("/login")) location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new ApiError(res.status, (data as { error?: string }).error ?? `うまくいきませんでした（${res.status}）`);
  }
  return data as T;
}

// ── 短い知らせ（自動で消える）──
export function toast(msg: string, kind: "ok" | "err" | "" = "ok", ms = 2400) {
  let box = $(".toasts");
  if (!box) { box = h(`<div class="toasts" role="status" aria-live="polite"></div>`); document.body.append(box); }
  const t = h(`<div class="toast ${kind}">${esc(msg)}</div>`);
  box.append(t);
  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 360); }, ms);
}

// ── 下からせり上がるパネル。つまみを下に引くか、外を押すと閉じる ──
let openSheet: (() => void) | null = null;
export function sheet(content: HTMLElement | string, opt: { onClose?: () => void } = {}): { close: () => void; body: HTMLElement } {
  openSheet?.();
  const scrim = h(`<div class="scrim"></div>`);
  const el = h(`<section class="sheet" role="dialog" aria-modal="true"><div class="grab" aria-label="閉じる"></div><div class="body"></div></section>`);
  const body = $(".body", el)!;
  if (typeof content === "string") body.innerHTML = content; else body.append(content);
  document.body.append(scrim, el);
  requestAnimationFrame(() => { scrim.classList.add("on"); el.classList.add("on"); });
  let closed = false;
  const close = () => {
    if (closed) return; closed = true; openSheet = null;
    scrim.classList.remove("on"); el.classList.remove("on"); el.style.transform = "";
    setTimeout(() => { scrim.remove(); el.remove(); }, 450);
    removeEventListener("keydown", onKey);
    opt.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  addEventListener("keydown", onKey);
  scrim.addEventListener("click", close);
  // つまみ（とパネルの一番上まで巻いた本文）を下に引く
  const grab = $(".grab", el)!;
  let y0 = 0, dy = 0, drag = false;
  const down = (e: PointerEvent) => { drag = true; y0 = e.clientY; dy = 0; el.classList.add("dragging"); (e.target as Element).setPointerCapture?.(e.pointerId); };
  const move = (e: PointerEvent) => { if (!drag) return; dy = Math.max(0, e.clientY - y0); el.style.transform = `translateY(${dy}px)`; scrim.style.opacity = String(1 - Math.min(1, dy / 400)); };
  const up = () => { if (!drag) return; drag = false; el.classList.remove("dragging"); scrim.style.opacity = ""; if (dy > 110) close(); else el.style.transform = ""; };
  grab.addEventListener("pointerdown", down); grab.addEventListener("pointermove", move); grab.addEventListener("pointerup", up); grab.addEventListener("pointercancel", up);
  grab.addEventListener("click", () => { if (dy < 4) close(); });
  openSheet = close;
  return { close, body };
}

// ── 横にスワイプすると、下に敷いたボタンが出る（右へ＝left の動き、左へ＝right の動き）──
export type SwipeSide = { label: string; cls?: string; run: () => void | Promise<void> };
export function swipeable(row: HTMLElement, sides: { left?: SwipeSide; right?: SwipeSide }): HTMLElement {
  const wrap = h(`<div class="swipe"><div class="under"><div class="l ${sides.left?.cls ?? ""}">${esc(sides.left?.label ?? "")}</div><div class="r ${sides.right?.cls ?? ""}">${esc(sides.right?.label ?? "")}</div></div></div>`);
  row.classList.add("row");
  wrap.append(row);
  if (!sides.left) ($(".l", wrap)!).style.visibility = "hidden";
  if (!sides.right) ($(".r", wrap)!).style.visibility = "hidden";
  let x0 = 0, y0 = 0, dx = 0, mode: "" | "x" | "y" = "", id = -1;
  const TH = 96;
  row.addEventListener("pointerdown", (e) => { if (e.pointerType === "mouse" && e.button !== 0) return; x0 = e.clientX; y0 = e.clientY; dx = 0; mode = ""; id = e.pointerId; });
  row.addEventListener("pointermove", (e) => {
    if (e.pointerId !== id) return;
    const mx = e.clientX - x0, my = e.clientY - y0;
    if (!mode) { if (Math.abs(mx) > 8 && Math.abs(mx) > Math.abs(my) * 1.2) { mode = "x"; row.setPointerCapture(e.pointerId); wrap.classList.add("dragging"); } else if (Math.abs(my) > 8) mode = "y"; }
    if (mode !== "x") return;
    dx = mx;
    if ((dx > 0 && !sides.left) || (dx < 0 && !sides.right)) dx = dx / 6;     // 何も無い側は少しだけ動いて戻る
    row.style.transform = `translateX(${dx}px)`;
    const l = $(".l", wrap)!, r = $(".r", wrap)!;
    l.style.opacity = String(Math.min(1, Math.max(0, dx / TH))); r.style.opacity = String(Math.min(1, Math.max(0, -dx / TH)));
    if (Math.abs(dx) > TH && !row.dataset.buzz) { row.dataset.buzz = "1"; navigator.vibrate?.(8); }
    if (Math.abs(dx) < TH) delete row.dataset.buzz;
  });
  const end = async (e: PointerEvent) => {
    if (e.pointerId !== id) return; id = -1;
    wrap.classList.remove("dragging");
    if (mode !== "x") { mode = ""; return; }
    mode = "";
    const act = dx > TH ? sides.left : dx < -TH ? sides.right : undefined;
    row.style.transform = act ? `translateX(${dx > 0 ? 120 : -120}%)` : "";
    const hide = () => { for (const u of wrap.querySelectorAll<HTMLElement>(".under>div")) u.style.opacity = "0"; };
    if (!act) hide(); else setTimeout(hide, 520);
    // スワイプの後の「押した」を捨てる
    row.addEventListener("click", (ev) => { ev.stopPropagation(); ev.preventDefault(); }, { capture: true, once: true });
    setTimeout(() => row.dispatchEvent(new Event("swipe-settled")), 0);
    if (act) { try { await act.run(); } finally { setTimeout(() => { row.style.transform = ""; }, 260); } }
  };
  row.addEventListener("pointerup", end); row.addEventListener("pointercancel", end);
  return wrap;
}

// ── 画面を下に引っ張って離すと更新 ──
export function pullToRefresh(run: () => Promise<void>) {
  const ind = $(".ptr") ?? document.body.appendChild(h(`<div class="ptr"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/></svg></div>`));
  let y0 = -1, d = 0, busy = false;
  const onStart = (e: TouchEvent) => { if (busy || scrollY > 0 || document.querySelector(".sheet")) { y0 = -1; return; } y0 = e.touches[0].clientY; d = 0; };
  const onMove = (e: TouchEvent) => {
    if (y0 < 0) return;
    d = Math.max(0, e.touches[0].clientY - y0);
    const k = Math.min(1, d / 90);
    ind.style.opacity = String(k); ind.style.transform = `translateY(${Math.min(70, d * 0.6) - 50}px) rotate(${d * 3}deg)`;
  };
  const onEnd = async () => {
    if (y0 < 0) return; y0 = -1;
    if (d < 90) { ind.style.opacity = "0"; ind.style.transform = ""; return; }
    busy = true; ind.classList.add("spin"); ind.style.transform = "translateY(20px)"; navigator.vibrate?.(10);
    try { await run(); toast("更新しました"); } catch (e) { toast((e as Error).message, "err"); }
    finally { busy = false; ind.classList.remove("spin"); ind.style.opacity = "0"; ind.style.transform = ""; }
  };
  addEventListener("touchstart", onStart, { passive: true });
  addEventListener("touchmove", onMove, { passive: true });
  addEventListener("touchend", onEnd);
  return () => { removeEventListener("touchstart", onStart); removeEventListener("touchmove", onMove); removeEventListener("touchend", onEnd); };
}

// ── 入力の途中で候補を出す（矢印で選び Enter・Tab で決める）──
export function autocomplete(input: HTMLInputElement | HTMLTextAreaElement, source: (q: string) => Promise<string[]> | string[], opt: { min?: number; delay?: number } = {}) {
  const wrap = h(`<div class="ac"></div>`);
  input.replaceWith(wrap); wrap.append(input);
  let list: HTMLUListElement | null = null, items: string[] = [], on = -1, timer = 0, seq = 0;
  const close = () => { list?.remove(); list = null; items = []; on = -1; };
  const pick = (i: number) => { if (items[i] === undefined) return; input.value = items[i]; input.dispatchEvent(new Event("input", { bubbles: true, composed: true })); close(); input.focus(); };
  const render = (q: string) => {
    close();
    if (!items.length) return;
    list = h(`<ul role="listbox"></ul>`) as HTMLUListElement;
    items.forEach((s, i) => {
      const k = s.toLowerCase().indexOf(q.toLowerCase());
      const li = h(`<li role="option">${k >= 0 ? `${esc(s.slice(0, k))}<b>${esc(s.slice(k, k + q.length))}</b>${esc(s.slice(k + q.length))}` : esc(s)}</li>`);
      li.addEventListener("pointerdown", (e) => { e.preventDefault(); pick(i); });
      list!.append(li);
    });
    wrap.append(list);
  };
  input.addEventListener("input", (e) => {
    if ((e as InputEvent).isComposing) return;
    clearTimeout(timer);
    const q = input.value;
    if (q.trim().length < (opt.min ?? 1)) { close(); return; }
    const my = ++seq;
    timer = window.setTimeout(async () => { const r = await source(q); if (my !== seq) return; items = r.filter((s) => s !== q).slice(0, 6); render(q.trim().split(/\s+/).pop() ?? q); }, opt.delay ?? 160);
  });
  input.addEventListener("keydown", (e) => {
    const k = e as KeyboardEvent;
    if (!list || k.isComposing) return;
    if (k.key === "ArrowDown" || k.key === "ArrowUp") { k.preventDefault(); on = (on + (k.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; [...list.children].forEach((c, i) => c.classList.toggle("on", i === on)); }
    else if ((k.key === "Enter" || k.key === "Tab") && on >= 0) { k.preventDefault(); pick(on); }
    else if (k.key === "Escape") close();
  });
  input.addEventListener("blur", () => setTimeout(close, 120));
  return wrap;
}

// ── スケルトン（読み込みの間、形だけ先に出す）──
export const skeleton = {
  videos: (n = 6) => `<div class="videos">${Array.from({ length: n }, () => `<div class="vcard glass"><div class="thumb sk"></div><div class="vmeta"><div class="sk sk-line" style="width:85%"></div><div class="sk sk-line" style="width:55%"></div></div></div>`).join("")}</div>`,
  rows: (n = 5) => `<div class="list">${Array.from({ length: n }, () => `<div class="glass note"><div class="sk sk-line" style="width:35%"></div><div class="sk sk-line" style="width:92%"></div><div class="sk sk-line" style="width:70%"></div></div>`).join("")}</div>`,
  title: () => `<div class="sk" style="height:30px;width:52%;margin:10px 0 18px;border-radius:10px"></div>`,
};

/** 画面の切り替えを、対応していれば View Transitions で */
export function transition(run: () => void | Promise<void>) {
  const d = document as Document & { startViewTransition?: (cb: () => void | Promise<void>) => unknown };
  if (d.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) d.startViewTransition(run); else run();
}

export const STATUS: Record<string, string> = { editing: "編集中", review: "確認待ち", fixing: "修正中", done: "完了" };
export const NOTE_STATUS: Record<string, string> = { open: "未対応", doing: "対応中", done: "済" };
export const ROLE: Record<string, string> = { owner: "管理者", editor: "指示できる", viewer: "見るだけ" };
export const ago = (t: number) => {
  const s = (Date.now() - t) / 1000;
  return s < 60 ? "いま" : s < 3600 ? `${Math.floor(s / 60)}分前` : s < 86400 ? `${Math.floor(s / 3600)}時間前` : s < 86400 * 30 ? `${Math.floor(s / 86400)}日前` : new Date(t).toLocaleDateString("ja-JP");
};
