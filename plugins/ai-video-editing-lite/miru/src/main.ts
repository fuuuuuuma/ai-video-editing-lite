// MIRU の画面（2026-10-19）。ログイン → ホーム（チャンネルごとの動画）→ 動画を押すと下からパネル → 確認画面
import "./style.css";
import { $, api, ago, autocomplete, esc, h, NOTE_STATUS, pullToRefresh, ROLE, sheet, skeleton, STATUS, swipeable, toast, transition } from "./ui";

type Usage = { bytes: number; quota: number; channels: number; channelLimit: number };
type Ver = { build: number; date: string; commit: string };
type Site = { can_create: boolean; invite_only: boolean; edition?: "personal" | "light"; version?: Ver; update_feed?: string | null };
type Me = { user: { id: string; email: string; name: string; picture: string }; usage: Usage; channels: Channel[]; site?: Site };
type Channel = { id: string; name: string; color: string; role: string; videos: number; open: number; mine?: number };
const gb = (n: number) => (n >= 1e15 ? "上限なし" : n < 1024 ** 3 ? `${Math.round(n / 1024 ** 2)}MB` : `${(n / 1024 ** 3).toFixed(1)}GB`);
const day = (t: number) => new Date(t).toLocaleDateString("ja-JP");
type Video = { id: string; channel_id: string; title: string; status: string; thumb: string | null; latest: string | null; open: number; updated_at: number };
type Note = { id: string; video_id: string; video_title?: string; version: string; author: string; frame: number | null; tc: string | null; text: string; status: string; category: string; reply: string | null; updated_at: number };

let me: Me | null = null;
let unPull: (() => void) | null = null;
const app = document.getElementById("app")!;

const ICON = {
  home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7v8a2 2 0 0 1-2 2h-4v-6H9v6H5a2 2 0 0 1-2-2z"/></svg>`,
  tasks: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/></svg>`,
  guide: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></svg>`,
  film: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9.5v5l4-2.5z" fill="currentColor"/></svg>`,
  google: `<svg viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`,
};

// ── 道（URL）と画面 ──
const routes: [RegExp, (m: RegExpMatchArray) => Promise<void>][] = [
  [/^\/login$/, pageLogin],
  [/^\/privacy$/, () => pageDoc("privacy")],
  [/^\/terms$/, () => pageDoc("terms")],
  [/^\/$/, () => pageHome()],
  [/^\/c\/([\w-]+)$/, (m) => pageHome(m[1])],
  [/^\/c\/([\w-]+)\/designs$/, (m) => pageDesigns(m[1])],
  [/^\/tasks$/, pageTasks],
  [/^\/guide$/, pageGuide],
  [/^\/settings$/, pageSettings],
  [/^\/v\/([\w-]+)$/, async (m) => { location.replace(`/review.html?v=${encodeURIComponent(m[1])}${location.search.replace(/^\?/, "&")}`); }],
];
export function go(path: string, replace = false) {
  if (replace) history.replaceState(null, "", path); else history.pushState(null, "", path);
  transition(render);
}
addEventListener("popstate", () => transition(render));
document.addEventListener("click", (e) => {
  const a = (e.target as Element).closest("a[data-go]") as HTMLAnchorElement | null;
  if (!a || e.metaKey || e.ctrlKey) return;
  e.preventDefault(); go(a.getAttribute("href")!);
});

async function render() {
  unPull?.(); unPull = null;
  const path = location.pathname;
  const hit = routes.find(([re]) => re.test(path));
  if (!hit) { go("/", true); return; }
  if (!["/login", "/privacy", "/terms"].includes(path) && !me) {
    try { me = await api<Me>("/api/me"); } catch { return; }    // 401 ならログインへ（api が送る）
  }
  await hit[1](path.match(hit[0])!);
}

function frame(title: string, crumbs: string, body: string, tab: string) {
  app.innerHTML = `
    <header class="top"><a class="logo" href="/" data-go><i>M</i>MIRU</a><div class="crumb">${crumbs ? `<span class="sep">/</span>${crumbs}` : ""}</div>
      ${me ? `<a href="/settings" data-go aria-label="設定">${avatar(me.user)}</a>` : ""}</header>
    <main><div class="page">${title ? `<h1>${esc(title)}</h1>` : ""}${body}</div></main>
    <nav class="tabs glass" aria-label="ページ">
      ${tabLink("/", "ホーム", ICON.home, tab === "home")}${tabLink("/tasks", "タスク", ICON.tasks, tab === "tasks", openCount())}
      ${tabLink("/guide", "使い方", ICON.guide, tab === "guide")}${tabLink("/settings", "設定", ICON.settings, tab === "settings")}
    </nav>`;
  document.title = title ? `${title} | MIRU` : "MIRU";
}
const tabLink = (href: string, label: string, icon: string, on: boolean, badge = 0) =>
  `<a href="${href}" data-go class="${on ? "on" : ""}" ${on ? 'aria-current="page"' : ""}>${icon}${badge ? `<span class="badge">${badge > 99 ? "99+" : badge}</span>` : ""}${label}</a>`;
const openCount = () => (me?.channels ?? []).reduce((s, c) => s + c.open, 0);

// ── ログイン（ボタンだけ）──
async function pageLogin() {
  const q = new URLSearchParams(location.search);
  let denied = q.has("denied");
  try {
    const r = await fetch("/api/me");
    const b = await r.json().catch(() => ({})) as Me & { denied?: boolean };
    me = r.ok ? b : null;
    denied ||= !!b.denied;
  } catch { me = null; }
  if (me) { go(q.get("next") ?? "/", true); return; }
  const site = await fetch("/api/site").then((r) => r.json()).catch(() => ({})) as { invite_only?: boolean };
  app.innerHTML = `<div class="login"><div class="box glass">
    <div class="mark">M</div><div class="name">MIRU</div>
    ${denied ? `<div class="small" style="margin:0 0 14px;color:var(--bad)"><b>このアカウントは招待されていません。</b><br>招待してくれた人に、ログインしたい Google アカウントのメールアドレスを伝えて、招待してもらってください。別のアカウントで入るときは、もう一度ログインを押して選び直します。</div>`
      : site.invite_only ? `<div class="small muted" style="margin:0 0 14px">招待されたメールアドレスの Google アカウントでログインしてください。</div>` : ""}
    <a class="gbtn" href="/auth/google?next=${encodeURIComponent(q.get("next") ?? "/")}">${ICON.google}Google でログイン</a>
    <div class="small" style="margin-top:18px"><a href="/privacy" data-go>プライバシーポリシー</a> ・ <a href="/terms" data-go>利用規約</a></div>
  </div></div>`;
  document.title = "ログイン | MIRU";
  if (q.get("failed")) toast("ログインできませんでした。もう一度お試しください", "err", 4000);
}

// ── プライバシーポリシー・利用規約（ログインしなくても見られる。Google のログイン画面からつながる）──
async function pageDoc(kind: "privacy" | "terms") {
  const site = await fetch("/api/site").then((r) => r.json()).catch(() => ({})) as { contact?: string; invite_only?: boolean; edition?: string };
  const contact = site.contact || "このサイトの管理者";
  // 招待制（SITE_OWNERS あり。個人用と MIRU ライト）では、チャンネルを作れるのは持ち主だけ。誰でも作れる形のときだけ容量の話をする
  const closed = !!site.invite_only;
  const sec = (t: string, d: string) => `<h2>${t}</h2><p class="small">${d}</p>`;
  const body = kind === "privacy" ? `
    ${sec("集める情報", "Google でログインしたときの名前・メールアドレス・プロフィール写真、修正指示と画面での手直し、チャンネルの管理者が上げた確認用の動画・画像・音、ログインを保つための cookie。")}
    ${sec("使い方", "ログインと、招待されたチャンネルの動画を見せること、修正指示と手直しを動画の制作に使うことだけに使います。広告には使いません。売ったり、第三者に渡したりしません。")}
    ${sec("置き場所", "Cloudflare（D1・R2）に置きます。ログインの印はそのままではなく SHA-256 で置きます。修正指示を読みやすく整える機能を使ったときは、その文を Cloudflare Workers AI で処理します。")}
    ${closed ? sec("見られる人", "このサイトに入れるのは、持ち主と、持ち主がチャンネルに招待した人だけです。チャンネルの動画と指示は、そのチャンネルに招待された人だけが見られます。")
    : sec("見られる人", "チャンネルを作った人と、その人が招待した人だけが、そのチャンネルの動画と指示を見られます。サイトの運営者にも、画面や道具から他の人のチャンネルを見る権限はありません（障害の調べものでデータベースに直接触れるときを除き、中身は見ません）。")}
    ${closed ? sec("残す期間", "上げ終わらなかったプレビューは 2 日で消えます。使われなくなったログインの印と、期限（1 年）の切れた鍵、招待を全部外された人の記録も消えます。")
    : sec("残す期間", "上げ終わらなかったプレビューは 2 日で、無料の容量で使っている人の古い版（各動画の新しい 2 つより前で 30 日たったもの）は自動で消えます。使われなくなったログインの印と、期限（1 年）の切れた鍵も消えます。")}
    ${sec("消す", "チャンネルは設定の画面から、動画・版ごと消せます。アカウントごと消したいときは、下の連絡先までお知らせください。")}
    ${sec("連絡先", esc(contact))}` : `
    ${closed ? sec("このサイト", `MIRU${site.edition === "light" ? " ライト" : ""} は、動画のプレビューを上げ、招待した人と一緒に見て修正指示を入れるためのサイトです。このサイトの持ち主（下の連絡先）が自分の Cloudflare で動かしています。チャンネルを作れるのは持ち主だけで、ほかの人は招待されたチャンネルだけを見られます。`)
    : sec("このサイト", "MIRU は、動画のプレビューを上げ、招待した人と一緒に見て修正指示を入れるためのサイトです。Google でログインした人は誰でも自分のチャンネルを作れます。")}
    ${closed ? sec("置くもの", "置ける量には上限があり、超えると新しい版は上げられません。上げるものは、自分で権利を持っている動画・画像・音だけにしてください。")
    : sec("容量", "無料で使える容量は 1 人あたり決まった量（いまは 2GB・チャンネル 3 つまで）です。超えると新しい版は上げられません。古い版を消して空けてください。上げるものは、自分で権利を持っている動画・画像・音だけにしてください。")}
    ${sec("使ってよい範囲", "招待されたチャンネルの動画は、制作の確認のためだけに見てください。許可なく保存・配布・公開しないでください。")}
    ${sec("止めること", closed ? "チャンネルの管理者は招待を外せます。持ち主は、費用・障害の都合などで、予告なくチャンネルやサイトを止めることがあります。"
      : "チャンネルの管理者は招待を外せます。運営者は、規約に反する使い方を見つけたときや、費用・障害の都合で、予告なくチャンネルを止めたり、サイトを止めたりすることがあります。")}
    ${sec("保証", "サイトは現状のまま提供します。消えて困るものは、別に控えを残してください。")}
    ${sec("連絡先", esc(contact))}`;
  app.innerHTML = `<header class="top"><a class="logo" href="/" data-go><i>M</i>MIRU</a></header>
    <main><div class="page"><h1>${kind === "privacy" ? "プライバシーポリシー" : "利用規約"}</h1><div class="glass card">${body}<p class="small muted">2026年10月23日</p></div></div></main>`;
  document.title = `${kind === "privacy" ? "プライバシーポリシー" : "利用規約"} | MIRU`;
}

// ── ホーム: チャンネルを切り替え、動画を状態で絞る。押すと下からパネル ──
let statusFilter = "all";
async function pageHome(channelId?: string) {
  const chs = me!.channels;
  if (!chs.length) {
    const create = me!.site?.can_create !== false;
    frame("ホーム", "", `<div class="glass card empty">${ICON.film}<div><b>まだ見られる動画がありません</b></div>
      <div class="small" style="margin-top:6px">${create ? "自分の動画を見せるなら、チャンネルを作ってください。<br>" : "このサイトは招待された人だけが使えます。<br>"}人の動画を見るなら、その人にこのメールアドレスでの招待を頼んでください<br><b>${esc(me!.user.email)}</b></div>
      ${create ? `<a class="btn primary" style="margin-top:14px" href="/settings#new" data-go>チャンネルを作る</a>` : ""}</div>`, "home");
    return;
  }
  const saved = localStore("channel");
  const cid = channelId ?? (chs.some((c) => c.id === saved) ? saved! : chs[0].id);
  localStore("channel", cid);
  const ch = chs.find((c) => c.id === cid) ?? chs[0];
  frame("", `<b>${esc(ch.name)}</b>`, `
    ${chs.length > 1 ? `<div class="seg" style="margin:4px 0 12px" id="chSeg">${chs.map((c) => `<button data-c="${esc(c.id)}" class="${c.id === ch.id ? "on" : ""}">${esc(c.name)}${c.open ? `<span class="n">${c.open}</span>` : ""}</button>`).join("")}</div>` : ""}
    <div class="hstack" style="justify-content:space-between"><h1 style="margin-right:auto">${esc(ch.name)}</h1>
      <a class="btn sm" href="/c/${encodeURIComponent(ch.id)}/designs" data-go>✦ 強調デザイン</a></div>
    <div class="seg" id="stSeg" style="margin-bottom:14px"></div>
    <div id="vids">${skeleton.videos()}</div>`, "home");
  $("#chSeg")?.addEventListener("click", (e) => { const b = (e.target as Element).closest("button"); if (b) go(`/c/${b.getAttribute("data-c")}`); });
  const load = async () => {
    const r = await api<{ videos: Video[]; role: string }>(`/api/channels/${encodeURIComponent(ch.id)}/videos`);
    drawVideos(r.videos, r.role, ch);
  };
  unPull = pullToRefresh(async () => { me = await api<Me>("/api/me"); await load(); });
  try { await load(); } catch (e) { $("#vids")!.innerHTML = `<div class="glass card empty">${esc((e as Error).message)}</div>`; }
}

function drawVideos(videos: Video[], role: string, ch: Channel) {
  const counts: Record<string, number> = { all: videos.length };
  for (const v of videos) counts[v.status] = (counts[v.status] ?? 0) + 1;
  const seg = $("#stSeg")!;
  seg.innerHTML = ["all", "review", "fixing", "editing", "done"].map((k) => `<button data-s="${k}" class="${statusFilter === k ? "on" : ""}">${k === "all" ? "すべて" : STATUS[k]}<span class="n">${counts[k] ?? 0}</span></button>`).join("");
  seg.onclick = (e) => { const b = (e.target as Element).closest("button"); if (!b) return; statusFilter = b.getAttribute("data-s")!; drawVideos(videos, role, ch); };
  const box = $("#vids")!;
  const shown = videos.filter((v) => statusFilter === "all" || v.status === statusFilter);
  if (!shown.length) { box.innerHTML = `<div class="glass card empty">${ICON.film}<div>${statusFilter === "all" ? "まだ動画がありません。Claude Code で編集してプレビューを上げると、ここに並びます" : "この状態の動画はありません"}</div></div>`; return; }
  const grid = h(`<div class="videos"></div>`);
  shown.forEach((v, i) => {
    const card = h(`<div class="vcard glass" style="animation-delay:${Math.min(i, 8) * 0.035}s" tabindex="0" role="button" aria-label="${esc(v.title)}">
      <div class="thumb">${v.thumb ? `<img src="/api/videos/${encodeURIComponent(v.id)}/thumb" alt="" loading="lazy">` : esc(v.title.slice(0, 1))}</div>
      <div class="vmeta"><div class="vtitle">${esc(v.title)}</div>
        <div class="vsub"><span class="pill st-${v.status}">${STATUS[v.status]}</span>${v.latest ? `<span>${esc(v.latest)}</span>` : ""}<span>${ago(v.updated_at)}</span></div></div>
      ${v.open ? `<span class="count">${v.open}</span>` : ""}</div>`);
    card.addEventListener("click", () => videoSheet(v, role));
    card.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") videoSheet(v, role); });
    const canEdit = role !== "viewer";
    grid.append(innerWidth < 720 && canEdit ? swipeable(card, {
      left: v.status !== "done" ? { label: "完了にする", run: async () => { await setStatus(v, "done"); toast("完了にしました"); drawVideos(videos, role, ch); } } : { label: "確認待ちに戻す", cls: "doing", run: async () => { await setStatus(v, "review"); toast("確認待ちに戻しました"); drawVideos(videos, role, ch); } },
      right: { label: "修正中にする", cls: "back", run: async () => { await setStatus(v, "fixing"); toast("修正中にしました"); drawVideos(videos, role, ch); } },
    }) : card);
  });
  box.replaceChildren(grid);
}
async function setStatus(v: Video, status: string) { await api(`/api/videos/${encodeURIComponent(v.id)}`, { method: "PATCH", body: { status } }); v.status = status; }

/** 動画を押すと出るパネル: 版を選んで確認画面へ */
async function videoSheet(v: Video, role: string) {
  const s = sheet(`<div class="thumb" style="width:100%;margin-bottom:12px">${v.thumb ? `<img src="/api/videos/${encodeURIComponent(v.id)}/thumb" alt="">` : esc(v.title.slice(0, 1))}</div>
    <h2 style="margin:0 0 6px;font-size:19px">${esc(v.title)}</h2>
    <div class="hstack" style="margin-bottom:14px"><span class="pill st-${v.status}">${STATUS[v.status]}</span><span class="small muted">${ago(v.updated_at)}に更新</span></div>
    <div id="vs">${skeleton.rows(2)}</div>`);
  try {
    const d = await api<{ versions: { name: string; ready: number; created_at: number; bytes: number; note: string }[]; openNotes: number; role: string }>(`/api/videos/${encodeURIComponent(v.id)}`);
    const ready = d.versions.filter((x) => x.ready);
    const cutOnly = (x: { note: string }) => /カットだけ/.test(x.note ?? "");     // トンマナが無いときの仮編集（字幕と強調はまだ）
    const box = $("#vs", s.body)!;
    box.innerHTML = `
      ${ready.length ? `<a class="btn primary wide" href="/v/${encodeURIComponent(v.id)}?ver=${encodeURIComponent(ready[0].name)}">${esc(ready[0].name)} を見る</a>${cutOnly(ready[0]) ? `<div class="small muted" style="margin:8px 2px 0">カットだけの仮編集です（字幕と強調はまだ）</div>` : ""}` : `<div class="glass card small muted">まだプレビューが上がっていません</div>`}
      ${d.openNotes ? `<div class="small" style="margin:10px 2px 0">未対応の修正指示 <b>${d.openNotes}</b> 件</div>` : ""}
      ${role !== "viewer" ? `<h2>状態</h2><div class="seg" id="vst">${["editing", "review", "fixing", "done"].map((k) => `<button data-s="${k}" class="${v.status === k ? "on" : ""}">${STATUS[k]}</button>`).join("")}</div>` : ""}
      ${ready.length > 1 ? `<h2>前の版</h2><div class="list" id="vold"></div>` : ""}
      ${role === "owner" ? `<h2>管理</h2><button class="btn danger wide" id="vdel">この動画を消す</button>` : ""}`;
    const old = $("#vold", box);
    for (const x of ready.slice(1)) {
      const row = h(`<a class="glass row-item" href="/v/${encodeURIComponent(v.id)}?ver=${encodeURIComponent(x.name)}"><b>${esc(x.name)}</b><span class="grow small muted">${ago(x.created_at)}・この版だけの分 ${gb(x.bytes)}${cutOnly(x) ? "・カットだけ" : ""}</span>›</a>`);
      old?.append(role === "owner" ? swipeable(row, { right: { label: "この版を消す", run: async () => {
        await api(`/api/videos/${encodeURIComponent(v.id)}/versions/${encodeURIComponent(x.name)}`, { method: "DELETE" });
        me = await api<Me>("/api/me"); toast(`${x.name} を消しました`); row.remove();
      } } }) : row);
    }
    if (old && role === "owner") old.append(h(`<div class="small muted" style="text-align:center">左へスワイプで前の版を消して、容量を空けられます</div>`));
    $("#vst", box)?.addEventListener("click", async (e) => {
      const b = (e.target as Element).closest("button"); if (!b) return;
      await setStatus(v, b.getAttribute("data-s")!); [...b.parentElement!.children].forEach((c) => c.classList.toggle("on", c === b)); toast(`${STATUS[v.status]}にしました`);
      pageHome(v.channel_id);
    });
    $("#vdel", box)?.addEventListener("click", async (e) => {
      const b = e.currentTarget as HTMLButtonElement;
      if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "もう一度押すと、プレビューごと消します"; setTimeout(() => { delete b.dataset.armed; b.textContent = "この動画を消す"; }, 3500); return; }
      await api(`/api/videos/${encodeURIComponent(v.id)}`, { method: "DELETE" }); s.close(); toast("消しました"); pageHome(v.channel_id);
    });
  } catch (e) { $("#vs", s.body)!.innerHTML = `<div class="small" style="color:var(--bad)">${esc((e as Error).message)}</div>`; }
}

// ── タスク: 修正指示を状態ごとに。右へフリックで次の状態、左へで戻す ──
let taskTab = "open";
async function pageTasks() {
  frame("タスク", "<b>タスク</b>", `<div class="seg" id="tSeg" style="margin-bottom:14px"></div><div id="tasks">${skeleton.rows()}</div>
    <p class="small muted" style="text-align:center;margin-top:14px">右へフリックで次の状態、左へで前の状態に戻ります</p>`, "tasks");
  let notes: Note[] = [];
  const load = async () => { notes = (await api<{ notes: Note[] }>("/api/notes")).notes; draw(); };
  const draw = () => {
    const n = (k: string) => notes.filter((x) => x.status === k).length;
    const seg = $("#tSeg")!;
    seg.innerHTML = ["open", "doing", "done"].map((k) => `<button data-s="${k}" class="${taskTab === k ? "on" : ""}">${NOTE_STATUS[k]}<span class="n">${n(k)}</span></button>`).join("");
    seg.onclick = (e) => { const b = (e.target as Element).closest("button"); if (b) { taskTab = b.getAttribute("data-s")!; draw(); } };
    const box = $("#tasks")!;
    const shown = notes.filter((x) => x.status === taskTab);
    if (!shown.length) { box.innerHTML = `<div class="glass card empty">${ICON.tasks}<div>${taskTab === "done" ? "済んだ指示はまだありません" : "ここに入る指示はありません"}</div></div>`; return; }
    const list = h(`<div class="list"></div>`);
    const order = ["open", "doing", "done"];
    shown.forEach((x, i) => {
      const card = h(`<div class="glass note" style="animation:rise .45s var(--spring) ${Math.min(i, 8) * 0.03}s both">
        <div class="head"><span class="pill st-${x.status}">${NOTE_STATUS[x.status]}</span>${x.category ? `<span class="chip">${esc(x.category)}</span>` : ""}<b style="color:var(--ink)">${esc(x.video_title ?? x.video_id)}</b>${x.tc ? `<span>${esc(x.tc)}</span>` : ""}</div>
        <div class="text">${esc(x.text)}</div>${x.reply ? `<div class="reply">${esc(x.reply)}</div>` : ""}</div>`);
      card.addEventListener("click", () => noteSheet(x, load));
      const k = order.indexOf(x.status);
      const move = (to: string) => async () => {
        await api(`/api/videos/${encodeURIComponent(x.video_id)}/notes/${encodeURIComponent(x.id)}`, { method: "PATCH", body: { status: to } });
        x.status = to; toast(`${NOTE_STATUS[to]}にしました`); draw();
      };
      list.append(swipeable(card, {
        left: k < 2 ? { label: `${NOTE_STATUS[order[k + 1]]}へ`, cls: k === 0 ? "doing" : "", run: move(order[k + 1]) } : undefined,
        right: k > 0 ? { label: `${NOTE_STATUS[order[k - 1]]}へ戻す`, cls: "back", run: move(order[k - 1]) } : undefined,
      }));
    });
    box.replaceChildren(list);
  };
  unPull = pullToRefresh(load);
  try { await load(); } catch (e) { $("#tasks")!.innerHTML = `<div class="glass card empty">${esc((e as Error).message)}</div>`; }
}

function noteSheet(x: Note, reload: () => Promise<void>) {
  const s = sheet(`<div class="head hstack small muted" style="margin-bottom:8px"><span class="pill st-${x.status}">${NOTE_STATUS[x.status]}</span><b style="color:var(--ink)">${esc(x.video_title ?? "")}</b>${x.tc ? esc(x.tc) : ""}</div>
    <textarea id="nt">${esc(x.text)}</textarea>
    <div class="hstack" style="margin:10px 0"><button class="btn sm" id="tidy">✨ 読みやすく整える</button><span class="small muted" id="cat">${x.category ? `種類: ${esc(x.category)}` : ""}</span></div>
    ${x.reply ? `<div class="reply note" style="padding:0 0 0 9px;cursor:default">${esc(x.reply)}</div>` : ""}
    <div class="stack" style="margin-top:14px">
      <button class="btn primary wide" id="save">保存</button>
      ${x.frame != null ? `<a class="btn wide" href="/v/${encodeURIComponent(x.video_id)}?ver=${encodeURIComponent(x.version)}&f=${x.frame}">この場面を開く</a>` : ""}
      <button class="btn danger wide" id="del">この指示を消す</button></div>`);
  let category = x.category;
  $("#tidy", s.body)!.addEventListener("click", async (e) => {
    const b = e.currentTarget as HTMLButtonElement; b.disabled = true; b.textContent = "整えています…";
    try {
      const r = await api<{ text: string; category: string; ai: boolean }>("/api/ai/tidy", { method: "POST", body: { text: ($("#nt", s.body) as HTMLTextAreaElement).value } });
      ($("#nt", s.body) as HTMLTextAreaElement).value = r.text; category = r.category; $("#cat", s.body)!.textContent = `種類: ${r.category}`;
      toast(r.ai ? "整えました" : "種類だけ付けました");
    } catch (er) { toast((er as Error).message, "err"); } finally { b.disabled = false; b.textContent = "✨ 読みやすく整える"; }
  });
  $("#save", s.body)!.addEventListener("click", async () => {
    await api(`/api/videos/${encodeURIComponent(x.video_id)}/notes/${encodeURIComponent(x.id)}`, { method: "PATCH", body: { text: ($("#nt", s.body) as HTMLTextAreaElement).value, category } });
    s.close(); toast("保存しました"); await reload();
  });
  $("#del", s.body)!.addEventListener("click", async (e) => {
    const b = e.currentTarget as HTMLButtonElement;
    if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "もう一度押すと消します"; setTimeout(() => { delete b.dataset.armed; b.textContent = "この指示を消す"; }, 3500); return; }
    await api(`/api/videos/${encodeURIComponent(x.video_id)}/notes/${encodeURIComponent(x.id)}`, { method: "DELETE" }); s.close(); toast("消しました"); await reload();
  });
}

// ── 使い方 ──
async function pageGuide() {
  const step = (t: string, d: string) => `<div class="glass step"><b>${t}</b><span class="small muted">${d}</span></div>`;
  frame("使い方", "<b>使い方</b>", `
    <h2>見る人</h2><div class="steps">
      ${step("動画を選ぶ", "ホームでチャンネルを選び、動画を押します。下から出るパネルの「見る」で確認画面が開きます。")}
      ${step("気になる所で修正指示", "確認画面で止めて、右の「修正指示」に書きます。今の時刻と、その時の字幕が一緒に残ります。")}
      ${step("自分で直す", "字幕の文字は一覧をダブルクリック（E）、字幕の出入りは時間軸の端をドラッグ。カットは I と O で範囲を決めて「カット」。すぐに映像と音に反映されます。")}
      ${step("タスクで進み具合を見る", "タスクに修正指示が並びます。右へフリックで「対応中」→「済」、左へで戻します。")}
    </div>
    <h2>作る人（Claude Code）</h2><div class="steps">
      ${step("つなぐ", "設定の「Claude Code・Codex とつなぐ」で鍵を作り、出てきたコマンドを一度だけ実行します。")}
      ${step("プレビューを上げる", "動画を作ったら Claude Code がこのサイトへ上げ、リンクを送ります。")}
      ${step("指示を読んで次の版へ", "Claude Code は修正指示と手直しを読み、次の版を作って返事を書きます。前の版の手直しは全部引き継がれ、手直しタブで 1 件ずつ確かめられます。")}
    </div>
    <h2>操作のこつ</h2><div class="glass card small">
      <div class="kv"><b>再生・停止</b><span>Space</span><b>1 コマ</b><span>← →</span><b>拡大・縮小</b><span>ピンチ・⌘＋スクロール</span><b>時間軸を左右に</b><span>二本指で左右</span><b>取り消す</b><span>⌘Z（やり直す ⌘⇧Z）</span><b>更新</b><span>画面を下に引いて離す</span></div></div>`, "guide");
}

// ── 設定: アカウント・Claude Code（MCP）・チャンネルと招待 ──
async function pageSettings() {
  const u = me!.user;
  frame("設定", "<b>設定</b>", `
    <div class="glass card row-item" style="padding:14px">${avatar(u, 44)}
      <div class="grow"><b>${esc(u.name)}</b><div class="small muted">${esc(u.email)}</div></div><button class="btn sm" id="out">ログアウト</button></div>
    <h2>Claude Code・Codex とつなぐ（MCP）</h2>
    <div class="glass card stack">
      <div class="small muted">鍵を作ると、Claude Code と Codex に貼るコマンドが出ます。鍵はこの画面で一度しか見られません。</div>
      <div class="hstack"><input id="tkLabel" placeholder="鍵の名前（例: 自分の Mac）" style="flex:1"><button class="btn primary" id="tkMake">鍵を作る</button></div>
      <div class="small muted">この鍵では、消す・招待する・鍵を作ることはできません（漏れたときに困らないように。それらはこの画面で）。</div>
      ${me!.site?.can_create && me!.site?.invite_only && !LIGHT(me!.site) ? `<label class="small hstack" style="gap:8px"><input type="checkbox" id="tkAdmin" style="width:auto">持ち主用の鍵にする（編集スキルを配る editor-publish 用。画面と同じことができるので、Claude Code・Codex には入れない）</label>` : ""}
      <div id="tkOut"></div><div id="tkList" class="list"></div></div>
    ${me!.site?.can_create !== false || me!.usage.channels ? `<h2>容量</h2><div class="glass card stack" id="usage">${usageCard(me!.usage)}</div>` : ""}
    <h2>この MIRU</h2><div class="glass card stack" id="about">${aboutCard(me!.site)}</div>
    <h2>チャンネルと招待</h2><div id="chs">${skeleton.rows(2)}</div>
    ${me!.site?.can_create !== false && me!.usage.channels < me!.usage.channelLimit ? `<div class="glass card stack" id="new"><b>チャンネルを作る</b>
      <div class="small muted">作った人が管理者になり、招待した人だけが見られます${me!.usage.channelLimit < 100 ? `（1 人 ${me!.usage.channelLimit} つまで）` : ""}。</div>
      <input id="ncName" placeholder="チャンネル名（例: 〇〇の動画）"><input id="ncId" placeholder="英小文字の名前（例: my-channel）" autocapitalize="off" spellcheck="false"><button class="btn primary" id="ncMake">作る</button></div>` : ""}`, "settings");
  $("#out")!.addEventListener("click", async () => { await api("/auth/logout", { method: "POST" }); me = null; go("/login", true); });
  checkUpdate(me!.site);
  const mcpUrl = `${location.origin}/mcp`;
  const drawTokens = async () => {
    const r = await api<{ tokens: { id: string; label: string; scope?: string; created_at: number; last_used_at: number | null; expires_at: number | null }[] }>("/api/tokens");
    const box = $("#tkList")!; box.replaceChildren();
    for (const t of r.tokens) {
      const row = h(`<div class="glass row-item"><div class="grow"><b>${esc(t.label)}</b>${t.scope === "admin" ? ` <span class="small" style="color:var(--warn)">持ち主用</span>` : ""}<div class="small muted">${ago(t.created_at)}に作成・${t.last_used_at ? `${ago(t.last_used_at)}に使用` : "まだ使われていません"}${t.expires_at ? `・${day(t.expires_at)}まで` : ""}</div></div></div>`);
      box.append(swipeable(row, { right: { label: "この鍵を消す", run: async () => { await api(`/api/tokens/${t.id}`, { method: "DELETE" }); toast("鍵を消しました"); drawTokens(); } } }));
    }
    if (r.tokens.length) box.append(h(`<div class="small muted" style="text-align:center">左へスワイプで鍵を消せます</div>`));
  };
  $("#tkMake")!.addEventListener("click", async () => {
    const admin = !!($("#tkAdmin") as HTMLInputElement | null)?.checked;
    const r = await api<{ token: string }>("/api/tokens", { method: "POST", body: { label: ($("#tkLabel") as HTMLInputElement).value || (admin ? "持ち主用" : "Claude Code"), scope: admin ? "admin" : "work" } });
    if (admin) {   // 持ち主用は editor-publish のためだけ。MCP の設定（平文で置かれる）には入れない
      $("#tkOut")!.innerHTML = `<div class="small"><b>持ち主用の鍵</b>（編集スキルを配る <span class="code" style="display:inline;padding:1px 6px">miru_sync.py editor-publish</span> だけが使います）</div>
        <div class="hstack" style="margin-top:8px"><button class="btn sm" id="tkKey">鍵をコピー</button></div>
        <div class="small muted" style="margin-top:8px">コピーしてから、ターミナルで <span class="code" style="display:inline;padding:1px 6px">mkdir -p ~/.config/miru &amp;&amp; pbpaste &gt; ~/.config/miru/admin-token &amp;&amp; chmod 600 ~/.config/miru/admin-token</span>。
        Claude Code・Codex の設定には入れないでください。使わなくなったら左へスワイプで消します。</div>`;
      $("#tkKey")!.addEventListener("click", async () => { await navigator.clipboard.writeText(r.token); toast("鍵をコピーしました"); });
      drawTokens();
      return;
    }
    // Claude Code: どのフォルダーから開いても使えるように -s user（無いと、そのとき開いていたフォルダーだけになる）
    const cmd = `claude mcp add -s user --transport http miru ${mcpUrl} --header "Authorization: Bearer ${r.token}"`;
    // Codex は設定ファイル（~/.codex/config.toml）に鍵のヘッダーを書く。前の [mcp_servers.miru]（と下の節 [mcp_servers.miru.*]）は消してから足す（鍵を作り直したときに重ならないように）。
    // 消すのは見出しの行から次の見出しの手前まで。後ろの節（Codex が足す [projects."…"] など）と、その前の行は触らない（2026-10-25。前の消し方は前の行と次の見出しをつないで、設定を読めなくしていた）。
    // Windows は [IO.File] で読み書きする（Windows PowerShell 5.1 の Set-Content・Add-Content は UTF-8 で書かず、日本語のパスが化ける）
    const codexMac = `mkdir -p ~/.codex && touch ~/.codex/config.toml && perl -0pi -e 's/^[ \\t]*\\[mcp_servers\\.miru(?:\\.[^\\]\\n]*)?\\][^\\n]*\\n?(?:(?![ \\t]*\\[).*\\n?)*//mg; s/\\n+\\z/\\n/; s/\\A\\s+\\z//' ~/.codex/config.toml && printf '\\n[mcp_servers.miru]\\nurl = "${mcpUrl}"\\nhttp_headers = { Authorization = "Bearer ${r.token}" }\\n' >> ~/.codex/config.toml`;
    const codexWin = `$p = "$HOME\\.codex\\config.toml"; New-Item -Force -ItemType Directory "$HOME\\.codex" | Out-Null; $t = if (Test-Path $p) { [IO.File]::ReadAllText($p) } else { '' }; $t = ($t -replace '(?m)^[ \\t]*\\[mcp_servers\\.miru(?:\\.[^\\]\\r\\n]*)?\\][^\\n]*(?:\\n|$)(?:(?![ \\t]*\\[)[^\\n]*(?:\\n|$))*', '') -replace '(\\r?\\n)+\\z', "\`n" -replace '\\A\\s+\\z', ''; [IO.File]::WriteAllText($p, $t + "\`n[mcp_servers.miru]\`nurl = \`"${mcpUrl}\`"\`nhttp_headers = { Authorization = \`"Bearer ${r.token}\`" }\`n")`;
    // 上げる道具（miru_sync.py）: 鍵とこのサイトの場所をファイルに置く。鍵を入れたまま 1 本のコマンドにする
    // （前は「鍵だけコピー」のあとにコマンドをコピーして貼る案内で、そのとき鍵がコマンドの文字に上書きされていた）
    const site = location.origin;
    const syncMac = `mkdir -p ~/.config/miru && printf '%s\\n' '${r.token}' > ~/.config/miru/token && chmod 600 ~/.config/miru/token && printf '%s\\n' '${site}' > ~/.config/miru/url`;
    const syncWin = `New-Item -Force -ItemType Directory "$HOME\\.config\\miru" | Out-Null; [IO.File]::WriteAllText("$HOME\\.config\\miru\\token", '${r.token}'); [IO.File]::WriteAllText("$HOME\\.config\\miru\\url", '${site}')`;
    $("#tkOut")!.innerHTML = `<div class="small"><b>Claude Code</b>（ターミナルに貼る。前に miru をつないでいたら、先に <span class="code" style="display:inline;padding:1px 6px">claude mcp remove -s user miru</span>。前の画面のコマンドでつないだフォルダーでは <span class="code" style="display:inline;padding:1px 6px">claude mcp remove -s local miru</span> も）</div><div class="code">${esc(cmd)}</div>
      <div class="hstack" style="margin-top:8px"><button class="btn sm" id="tkCopy">コマンドをコピー</button></div>
      <div class="small" style="margin-top:12px"><b>Codex</b>（Mac はターミナル、Windows は PowerShell に貼る。前の miru の設定は置き換わります。Codex を開き直すとつながります）</div>
      <div class="code">${esc(codexMac)}</div>
      <div class="hstack" style="margin-top:8px"><button class="btn sm" id="tkCodexMac">Mac 用をコピー</button><button class="btn sm" id="tkCodexWin">Windows 用をコピー</button></div>
      <div class="small" style="margin-top:12px"><b>動画を上げる道具</b>（miru_sync.py。鍵とこのサイトの場所をファイルに置きます）</div>
      <div class="hstack" style="margin-top:8px"><button class="btn sm" id="tkSyncMac">上げる道具用をコピー（Mac）</button><button class="btn sm" id="tkSyncWin">上げる道具用をコピー（Windows）</button></div>`;
    const copyOf = (id: string, text: string, done: string) => $(id)!.addEventListener("click", async () => { await navigator.clipboard.writeText(text); toast(done); });
    copyOf("#tkCopy", cmd, "コピーしました。ターミナルに貼ってください");
    copyOf("#tkCodexMac", codexMac, "Mac 用をコピーしました");
    copyOf("#tkCodexWin", codexWin, "Windows 用をコピーしました");
    copyOf("#tkSyncMac", syncMac, "コピーしました。ターミナルに貼ってください");
    copyOf("#tkSyncWin", syncWin, "コピーしました。PowerShell に貼ってください");
    drawTokens();
  });
  drawTokens().catch(() => {});
  const drawChannels = async () => {
    const box = $("#chs")!; box.replaceChildren();
    for (const c of me!.channels) {
      const card = h(`<div class="glass card stack"><div class="hstack"><b style="flex:1">${esc(c.name)}</b><span class="chip">${ROLE[c.role]}</span></div><div class="list" data-m></div></div>`);
      box.append(card);
      const self = me!.user.email.toLowerCase();
      if (c.role !== "owner") {
        const leave = h(`<button class="btn sm">このチャンネルから抜ける</button>`);
        leave.addEventListener("click", async () => {
          if (!leave.dataset.armed) { leave.dataset.armed = "1"; leave.textContent = "もう一度押すと抜けます（また招待してもらえば戻れます）"; return; }
          await api(`/api/channels/${encodeURIComponent(c.id)}/members/${encodeURIComponent(self)}`, { method: "DELETE" });
          me = await api<Me>("/api/me"); toast("抜けました"); pageSettings();
        });
        card.append(leave);
        continue;
      }
      const del = h(`<button class="btn danger sm">チャンネルを消す</button>`);
      del.addEventListener("click", async () => {
        if (!del.dataset.armed) { del.dataset.armed = "1"; del.textContent = `もう一度押すと「${c.name}」の動画・版・指示を全部消します（戻せません）`; setTimeout(() => { delete del.dataset.armed; del.textContent = "チャンネルを消す"; }, 5000); return; }
        try { await api(`/api/channels/${encodeURIComponent(c.id)}`, { method: "DELETE" }); me = await api<Me>("/api/me"); toast("消しました"); pageSettings(); }
        catch (e) { toast((e as Error).message, "err"); }
      });
      const r = await api<{ members: { email: string; role: string; name: string | null }[] }>(`/api/channels/${encodeURIComponent(c.id)}/members`);
      const list = $("[data-m]", card)!;
      for (const m of r.members) {
        const row = h(`<div class="glass row-item"><div class="grow"><b>${esc(m.name ?? m.email)}</b><div class="small muted">${esc(m.email)}</div></div>
          <select style="width:auto" aria-label="役割">${["viewer", "editor", "owner"].map((k) => `<option value="${k}" ${m.role === k ? "selected" : ""}>${ROLE[k]}</option>`).join("")}</select></div>`);
        $("select", row)!.addEventListener("change", async (e) => { await api(`/api/channels/${encodeURIComponent(c.id)}/members`, { method: "POST", body: { email: m.email, role: (e.target as HTMLSelectElement).value } }); toast("役割を変えました"); });
        list.append(swipeable(row, { right: { label: "招待を外す", run: async () => { await api(`/api/channels/${encodeURIComponent(c.id)}/members/${encodeURIComponent(m.email)}`, { method: "DELETE" }); toast("外しました"); drawChannels(); } } }));
      }
      const form = h(`<div class="stack"><input type="email" placeholder="招待するメールアドレス" autocomplete="off"><div class="hstack"><select style="flex:1">${["viewer", "editor", "owner"].map((k) => `<option value="${k}" ${k === "editor" ? "selected" : ""}>${ROLE[k]}</option>`).join("")}</select><button class="btn primary">招待する</button></div></div>`);
      const input = $("input", form) as HTMLInputElement;
      card.append(form);
      // 候補: ほかのチャンネルで招待したことのある人
      const known = new Set<string>();
      autocomplete(input, async (q) => {
        if (!known.size) for (const o of me!.channels.filter((x) => x.role === "owner" && x.id !== c.id)) for (const m of (await api<{ members: { email: string }[] }>(`/api/channels/${encodeURIComponent(o.id)}/members`)).members) known.add(m.email);
        return [...known].filter((e) => e.includes(q.toLowerCase()) && !r.members.some((m) => m.email === e));
      });
      $("button", form)!.addEventListener("click", async () => {
        try { await api(`/api/channels/${encodeURIComponent(c.id)}/members`, { method: "POST", body: { email: input.value, role: ($("select", form) as HTMLSelectElement).value } }); toast("招待しました。下のボタンで案内をコピーして送ってください", "ok", 4000); drawChannels(); }
        catch (e) { toast((e as Error).message, "err"); }
      });
      // MIRU はメールを送らないので、招待した人へ送る案内を写せるようにする
      const share = h(`<button class="btn sm">招待した人に送る案内をコピー</button>`);
      share.addEventListener("click", async () => {
        await navigator.clipboard.writeText(`動画の確認サイト MIRU の「${c.name}」に招待しました。\n${location.origin}/ を開いて、招待したメールアドレスの Google アカウントでログインしてください。`);
        toast("案内をコピーしました");
      });
      card.append(share);
      card.append(del);
    }
    if (!me!.channels.length) box.innerHTML = `<div class="glass card small muted">まだチャンネルがありません</div>`;
  };
  drawChannels().catch((e) => { $("#chs")!.innerHTML = `<div class="glass card small">${esc(e.message)}</div>`; });
  $("#ncMake")?.addEventListener("click", async () => {
    try {
      await api("/api/channels", { method: "POST", body: { id: ($("#ncId") as HTMLInputElement).value.trim().toLowerCase(), name: ($("#ncName") as HTMLInputElement).value } });
      me = await api<Me>("/api/me"); toast("チャンネルを作りました"); pageSettings();
    } catch (e) { toast((e as Error).message, "err"); }
  });
  if (location.hash === "#new") setTimeout(() => $("#new")?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
}

/** この MIRU: 種類と版。MIRU ライトの持ち主には、自分用に直す方法と、新しい版の知らせを出す */
const verLabel = (v?: Ver) => (v?.build ? `版 ${v.build}（${v.date}）` : "開発中の版");
const LIGHT = (s?: Site) => s?.edition === "light";
function aboutCard(s?: Site) {
  const own = LIGHT(s) && s?.can_create;
  return `<div class="hstack"><b style="flex:1">${LIGHT(s) ? "MIRU ライト" : "MIRU"}</b><span class="small muted">${esc(verLabel(s?.version))}</span></div>
    ${own && s?.update_feed ? `<div id="upd" class="small muted">新しい版があるか確かめています…</div>` : ""}
    ${own ? `<div class="small muted">自分用に変えたいときは、AI に「MIRU の〇〇を直して」と頼みます。変わるのはあなたの MIRU だけで、新しい版にしても直した所は残ります。</div>` : ""}`;
}
/** 新しい版の知らせ（UPDATE_FEED の VERSION.json）と今の版を比べる。読めないときは黙って消す */
async function checkUpdate(s?: Site) {
  const box = $("#upd");
  if (!box || !s?.update_feed) return;
  try {
    const f = await fetch(s.update_feed, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)) as Ver | null;
    if (!f?.build) throw new Error("no feed");
    if (f.build <= (s.version?.build ?? 0)) { box.textContent = "いまの版が最新です"; return; }
    const ask = "AI動画編集 lite と MIRU を新しい版にして";
    box.outerHTML = `<div class="stack" id="upd"><b>新しい版があります（${esc(verLabel(f))}）</b>
      <div class="small muted">AI に「${ask}」と頼むと、あなたが直した所を残したまま入れ替えます。データと設定はそのままです。</div>
      <button class="btn sm" id="updCopy">頼む文をコピー</button></div>`;
    $("#updCopy")!.addEventListener("click", async () => { await navigator.clipboard.writeText(ask); toast("コピーしました。AI に貼って送ってください"); });
  } catch { box.remove(); }
}

/** 容量: 使っている量と上限。上限に近いと色を変える */
function usageCard(u: Usage) {
  const r = Math.min(1, u.bytes / Math.max(1, u.quota));
  const col = r > 0.9 ? "var(--bad)" : r > 0.7 ? "var(--warn)" : "var(--accent, #0a84ff)";
  const freeCap = LIGHT(me?.site) && me?.site?.can_create && u.quota < 1e15;
  return `<div class="hstack"><b style="flex:1">${gb(u.bytes)} / ${gb(u.quota)}</b><span class="small muted">チャンネル ${u.channels}${u.channelLimit < 100 ? ` / ${u.channelLimit}` : ""}</span></div>
    <div style="height:8px;border-radius:4px;background:rgba(127,127,127,.18);overflow:hidden"><div style="height:100%;width:${(r * 100).toFixed(1)}%;background:${col}"></div></div>
    <div class="small muted">自分が作ったチャンネルの動画の合計です（版をまたいで同じファイルは 1 回だけ数えます）。招待されたチャンネルの分は、作った人に数えます。いっぱいになったら、動画のパネルで前の版を消してください。${freeCap ? "上限は、Cloudflare の無料の範囲（R2 は 10GB）を超えて請求されないように決めた値です。" : ""}</div>`;
}

/** 顔写真。無い・読めないときは名前の頭文字の丸 */
function avatar(u: { name: string; email: string; picture: string }, size = 32) {
  const initial = esc((u.name || u.email).slice(0, 1).toUpperCase());
  const dot = `<span class="avatar" style="width:${size}px;height:${size}px;display:inline-grid;place-items:center;font-weight:800;color:#fff;font-size:${Math.round(size * 0.42)}px;background:linear-gradient(135deg,#3d9bff,#7a5cff)">${initial}</span>`;
  if (!u.picture) return dot;
  return `<img class="avatar" style="width:${size}px;height:${size}px" src="${esc(u.picture)}" alt="" referrerpolicy="no-referrer" onerror="this.outerHTML=this.dataset.f" data-f="${esc(dot)}">`;
}

// ── 強調デザインの一覧（チャンネルごと。採用・不採用はここが正。不採用は次に開いたときには出ない）──
type Design = { id: string; role: string; name: string; status: string; memo: string; has_image: number; decided_at: number | null };
type Role = { role: string; label: string; when: string; avoid: string };
let designTab = "adopt";
async function pageDesigns(cid: string) {
  const embed = new URLSearchParams(location.search).has("embed");
  const ch = me!.channels.find((c) => c.id === cid);
  const body = `${embed ? `<div class="hstack" style="justify-content:space-between;margin:4px 0 6px"><h1 style="margin:0">強調デザイン</h1><button class="btn" id="dClose">閉じる</button></div>` : ""}
    <div class="seg" id="dSeg" style="margin:6px 0 14px"></div><div id="dList">${skeleton.videos(6)}</div>
    <p class="small muted" style="text-align:center;margin-top:14px">右へフリックで採用、左へで不採用。不採用は次に開いたときには出ません。新しいデザインは Claude に頼むと足されます</p>`;
  if (embed) {
    app.innerHTML = `<main style="padding-bottom:24px"><div class="page">${body}</div></main>`;
    document.title = "強調デザイン | MIRU";
    $("#dClose")!.addEventListener("click", () => { try { parent.postMessage({ type: "styles:close" }, location.origin); } catch { /* 単独で開いたとき */ } });
  } else frame("強調デザイン", `<span>${esc(ch?.name ?? cid)}</span><span class="sep">/</span><b>強調デザイン</b>`, body, "home");
  let roles: Role[] = [], designs: Design[] = [], role = "viewer";
  const firstSeen = new Set<string>();       // 開いた時点で不採用だったもの（ここで不採用にしたものは、閉じるまで見えたまま）
  const load = async () => {
    const r = await api<{ roles: Role[]; designs: Design[]; role: string }>(`/api/channels/${encodeURIComponent(cid)}/designs`);
    roles = r.roles; designs = r.designs; role = r.role;
    if (!firstSeen.size) for (const d of designs) if (d.status === "reject") firstSeen.add(d.id);
    draw();
  };
  const img = (d: Design) => d.has_image ? `<img src="/api/channels/${encodeURIComponent(cid)}/designs/${encodeURIComponent(d.id)}/image?u=${d.decided_at ?? 0}" alt="" loading="lazy">` : esc(d.id);
  const set = async (d: Design, status: string, memo?: string) => {
    const r = await api<{ designs: Design[] }>(`/api/channels/${encodeURIComponent(cid)}/designs/${encodeURIComponent(d.id)}`, { method: "PATCH", body: { status, ...(memo !== undefined ? { memo } : {}) } });
    designs = r.designs; toast(status === "adopt" ? "採用にしました" : status === "reject" ? "不採用にしました" : "未判断に戻しました"); draw();
    try { parent !== window && parent.postMessage({ type: "styles:saved" }, location.origin); } catch { /* なし */ }
  };
  const draw = () => {
    const shown = designs.filter((d) => !firstSeen.has(d.id) || d.status !== "reject");
    const n = (k: string) => shown.filter((d) => k === "all" || d.status === k).length;
    const seg = $("#dSeg")!;
    seg.innerHTML = [["adopt", "採用"], ["open", "未判断"], ["all", "すべて"]].map(([k, l]) => `<button data-s="${k}" class="${designTab === k ? "on" : ""}">${l}<span class="n">${n(k)}</span></button>`).join("");
    seg.onclick = (e) => { const b = (e.target as Element).closest("button"); if (b) { designTab = b.getAttribute("data-s")!; draw(); } };
    const box = $("#dList")!; box.replaceChildren();
    let any = false;
    for (const r of roles) {
      const ds = shown.filter((d) => d.role === r.role && (designTab === "all" || d.status === designTab));
      if (!ds.length) continue;
      any = true;
      box.append(h(`<div><h2 style="margin-bottom:2px">${esc(r.label)}</h2><div class="small muted" style="margin-bottom:10px">使う: ${esc(r.when)}${r.avoid ? `<br>使わない: ${esc(r.avoid)}` : ""}</div></div>`));
      const grid = h(`<div class="videos"></div>`);
      ds.forEach((d, i) => {
        const card = h(`<div class="vcard glass" style="animation-delay:${Math.min(i, 8) * 0.03}s" role="button" tabindex="0">
          <div class="thumb">${img(d)}</div><div class="vmeta"><div class="vtitle">${esc(d.id)}　${esc(d.name)}</div>
          <div class="vsub"><span class="pill ${d.status === "adopt" ? "st-done" : d.status === "reject" ? "st-open" : "st-editing"}">${d.status === "adopt" ? "採用" : d.status === "reject" ? "不採用" : "未判断"}</span>${d.memo ? `<span>${esc(d.memo.slice(0, 30))}</span>` : ""}</div></div></div>`);
        card.addEventListener("click", () => designSheet(d, r));
        grid.append(role === "owner" && innerWidth < 720 ? swipeable(card, {
          left: d.status !== "adopt" ? { label: "採用", run: () => set(d, "adopt") } : undefined,
          right: d.status !== "reject" ? { label: "不採用", run: () => set(d, "reject") } : undefined,
        }) : card);
      });
      box.append(grid);
    }
    if (!any) box.innerHTML = `<div class="glass card empty">${designs.length ? "ここに入るデザインはありません" : "まだデザインがありません。Claude Code で動画を作ると、見本が上がります"}</div>`;
  };
  const designSheet = (d: Design, r: Role) => {
    const sh = sheet(`<div class="thumb" style="width:100%;margin-bottom:12px">${img(d)}</div>
      <h2 style="margin:0 0 4px;font-size:19px">${esc(d.id)}　${esc(d.name)}</h2><div class="small muted" style="margin-bottom:12px">${esc(r.label)}：${esc(r.when)}</div>
      ${role === "owner" ? `<textarea id="dm" placeholder="メモ（どういう時に使うか・気になる所）" style="min-height:70px">${esc(d.memo)}</textarea>
      <div class="stack" style="margin-top:12px"><button class="btn primary wide" data-s="adopt">採用する</button>
        <div class="hstack"><button class="btn" style="flex:1" data-s="open">未判断に戻す</button><button class="btn danger" style="flex:1" data-s="reject">不採用にする</button></div></div>`
        : `<div class="glass card small">${d.memo ? esc(d.memo) : "メモはありません"}</div><div class="small muted">採用・不採用を決めるのは管理者です</div>`}`);
    sh.body.addEventListener("click", async (e) => {
      const b = (e.target as Element).closest("[data-s]"); if (!b) return;
      await set(d, b.getAttribute("data-s")!, ($("#dm", sh.body) as HTMLTextAreaElement | null)?.value); sh.close();
    });
  };
  if (!embed) unPull = pullToRefresh(load);
  try { await load(); } catch (e) { $("#dList")!.innerHTML = `<div class="glass card empty">${esc((e as Error).message)}</div>`; }
}

function localStore(k: string, v?: string): string | null {
  try { if (v === undefined) return localStorage.getItem("miru." + k); localStorage.setItem("miru." + k, v); } catch { /* 使えない環境では覚えない */ }
  return v ?? null;
}

render();
