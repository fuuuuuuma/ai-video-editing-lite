#!/usr/bin/env node
// 自分の Cloudflare に MIRU ライトを立てる道具（2026-10-22。2026-10-23 に通し確認・自分で直した所を残す更新・控え・容量）。手順と理由は SETUP.md。
//
//   node tools/setup.mjs start --owner you@gmail.com [--name miru] [--dir ~/MIRU] [--account <アカウントID>] [--owner-quota-gb 9] [--reuse] [--no-backup] [--force-older]
//       … 置き場所（D1・R2）を作り、表を作り、画面を作って公開する。最後に Google の設定に入れる URL を出す
//   node tools/setup.mjs google --client-id <クライアントID>
//       … Google のクライアント ID を入れて公開し直す。シークレットは本人がターミナルで入れる（この道具は受け取らない）
//   node tools/setup.mjs check    … 通し確認（サイト・版・Google・シークレット・この PC とのつながり）。困ったらまずこれ
//   node tools/setup.mjs update [--force-older] [--force] [--no-backup] … 新しい版の MIRU に入れ替える（自分で直した所は残して混ぜる・控えを取ってから表を足す）
//   node tools/setup.mjs deploy [--resolved] [--no-backup] … 自分で直した ~/MIRU をそのまま公開する（型の確認をしてから。表を足すときは控えを取る）
//   node tools/setup.mjs changes  … 自分で直したファイルの一覧（入れた版との違い）
//   node tools/setup.mjs backup   … 文字のデータ（D1）の控えを backups/ に取る
//   node tools/setup.mjs quota --gb <数>  … 置ける量の上限を変える（0 で上限なし。R2 は 10GB を超えた分が請求される）
//   node tools/setup.mjs status   … いまの URL・版・Google の設定・シークレットの有無
//
// 作業する場所（--dir。無ければ、立てた MIRU の中の道具ならその MIRU、ほかは ~/MIRU）に、この道具のある MIRU の中身を写してから動く。
// 設定（wrangler.jsonc）と記録（.miru-setup.json）はその場所に残り、update でも消さない。
// 入れた版の写しを .miru-upstream/ に置き、update はそれを元に「あなたの変更」と「新しい版の変更」を混ぜる（git があれば 3 方向で）。
// 終わりのコード: 2 R2 が無効 / 3 workers.dev の名前が無い / 4 アカウントが複数 / 5 メールの確認がまだ / 6 混ぜられない所がある / 7 名前がぶつかる / 8 古い版への入れ替え
// Node.js は 22.12 以上（wrangler が 22 未満では動かず、vite が 22.12 以上を求める）

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SRC = resolve(import.meta.dirname, "..");
const STATE = ".miru-setup.json";
const BASE = ".miru-upstream";
const PREV = ".miru-upstream-prev";
const REPORT = ".miru-update.json";
// 写さない・比べないもの（設定・記録・作ったもの・控え）
const SKIP = new Set(["node_modules", "dist", ".wrangler", ".git", "wrangler.jsonc", STATE, BASE, PREV, REPORT, ".dev.vars", "backups", ".miru-tmp"]);
const WIN = process.platform === "win32";
const GB = 1024 ** 3;                  // 画面の「GB」と同じ数え方（1GB = 1024³ バイト）
const DEFAULT_QUOTA = 9 * GB;           // R2 の無料の範囲 10GB より少し下（画面では 9.0GB）

const [cmd = "help", ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith("--")) opt[rest[i].slice(2)] = rest[i + 1] === undefined || rest[i + 1].startsWith("--") ? true : rest[++i];
const expand = (p) => resolve(String(p).replace(/^~(?=$|[\\/])/, homedir()));
// 立てた MIRU の中の道具（~/MIRU/tools/setup.mjs）を動かしたときは、その MIRU が作業の場所（--dir で立てた所でも合うように）
const DIR = expand(opt.dir ?? process.env.MIRU_DIR ?? (existsSync(join(SRC, STATE)) ? SRC : join(homedir(), "MIRU")));
// npm install が書き直すので、利用者の変更として数えず、いつも新しい版のものにする（足した依存は package.json から作り直される）
const ALWAYS_THEIRS = new Set(["package-lock.json"]);
// この PC の上げる先と鍵（lite の miru_sync.py が読む ~/.config/miru）。試しに立てるときだけ MIRU_CONFIG_DIR で別の場所にできる（miru_sync.py はこれを見ない）
const CONF = process.env.MIRU_CONFIG_DIR ? expand(process.env.MIRU_CONFIG_DIR) : join(homedir(), ".config", "miru");

const say = (s = "") => console.log(s);
/** この MIRU の道具を呼ぶコマンド（どこから動かしても通るように、場所を付けて出す） */
const self = (args) => `node "${join(DIR, "tools", "setup.mjs")}" ${args}`;
/** Google のシークレットを入れるコマンド。Windows の PowerShell 5.1 は && を使えず、npx は実行の決まりで止まることがある */
const secretSteps = () => (WIN ? `cd "${DIR}"\n  npx.cmd wrangler secret put GOOGLE_CLIENT_SECRET` : `cd "${DIR}" && npx wrangler secret put GOOGLE_CLIENT_SECRET`);
const fail = (s, code = 1) => { console.error(`\n✗ ${s}`); process.exit(code); };

// ── コマンドを動かす ──
// capture のときも出力はその場で画面に出す（止まって見えないように）。Windows の npm・npx は .cmd なので shell を通し、空白のある引数は囲む
const winq = (a) => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
function run(bin, args, { capture = false, cwd = DIR, quiet = false } = {}) {
  if (!quiet) say(`$ ${bin} ${args.join(" ")}`);
  const shell = WIN && bin !== "git";
  const o = {
    cwd, shell, stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
    // アカウントが複数あるとき、設定（wrangler.jsonc）を書く前の D1・R2 の作成から同じアカウントを使う
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", ...(ACCOUNT() ? { CLOUDFLARE_ACCOUNT_ID: ACCOUNT() } : {}) },
  };
  // Windows の npm・npx は .cmd。引数を shell と一緒に渡すと Node 24 が毎回警告するので、囲んだ 1 本の文字にする
  const child = shell ? spawn([`${bin}.cmd`, ...args.map(winq)].join(" "), o) : spawn(bin, args, o);
  let out = "";
  if (capture) {
    child.stdout.on("data", (d) => { out += d; if (!quiet) process.stdout.write(d); });
    child.stderr.on("data", (d) => { out += d; if (!quiet) process.stderr.write(d); });
  }
  return new Promise((done) => {
    child.on("error", (e) => done({ ok: false, out: out + String(e) }));
    child.on("close", (code) => done({ ok: code === 0, out }));
  });
}
const wrangler = (args, o) => run("npx", ["--yes", "wrangler", ...args], o);

/** wrangler が止まった理由のうち、利用者がダッシュボードですることが分かっているもの。当たれば案内して終わる */
function explain(out) {
  if (/enable R2|10042|purchase.*R2|R2.*not enabled/i.test(out)) {
    fail("R2 がまだ使える状態になっていません。Cloudflare のダッシュボード（https://dash.cloudflare.com/）の左の「R2 オブジェクト ストレージ」を開き、案内に沿って有効にしてから、同じコマンドをもう一度動かしてください（支払い方法の登録を求められることがあります。10GB までは請求されません）", 2);
  }
  if (/register a workers\.dev subdomain/i.test(out)) {
    const link = /https:\/\/dash\.cloudflare\.com\/[0-9a-f]+\/workers\/onboarding/.exec(out)?.[0] ?? "https://dash.cloudflare.com/ の「Workers & Pages」";
    fail(`サイトのアドレスの一部になる名前（workers.dev のサブドメイン）がまだ決まっていません。\n  ${link}\n  を開いて、好きな英字の名前（例: taro-videos）を登録してから、同じコマンドをもう一度動かしてください（作ったものはそのまま続きから進みます）`, 3);
  }
  if (/requires at least Node\.js/i.test(out)) checkNode();
  if (/More than one account available/i.test(out)) {
    const list = out.slice(out.indexOf("Available accounts")).split("\n").slice(0, 8).join("\n");
    fail(`Cloudflare のアカウントが複数あります。使うアカウントの ID を --account で指定して、同じコマンドをもう一度動かしてください。\n${list}`, 4);
  }
  if (/verify (your )?email|email.{0,20}(not|un)verified|10034/i.test(out)) {
    fail("Cloudflare のメールアドレスの確認がまだです。Cloudflare から届いたメールの確認のリンクを押してから、同じコマンドをもう一度動かしてください", 5);
  }
  if (/Not logged in|not authenticated|token has expired|no-credentials/i.test(out)) {
    fail(`Cloudflare へのログインが切れています。${WIN ? "npx.cmd" : "npx"} wrangler login でログインし直してから、同じコマンドをもう一度動かしてください`);
  }
}

const readJson = (f, d = null) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return d; } };
const jsonOf = async (r) => { try { return await r.json(); } catch { return null; } };
const readState = () => readJson(join(DIR, STATE));
const ACCOUNT = () => (typeof opt.account === "string" ? opt.account : readState()?.account) || "";
const writeState = (s) => writeFileSync(join(DIR, STATE), JSON.stringify(s, null, 2) + "\n");
const bundled = () => readJson(join(SRC, "VERSION.json"), { build: 0, date: "", commit: "dev", feed: "" });
const verLabel = (v) => (v?.build ? `版 ${v.build}（${v.date}）` : "開発中の版");

// ── 入れた版の写しと、自分で直した所 ──
/** root の下のファイル（/ 区切りの相対パス）。SKIP と、混ぜるための一時ファイルは除く */
function listFiles(root) {
  const out = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(root, rel))) {
      if (!rel && SKIP.has(name)) continue;
      if (name === "node_modules" || name === ".DS_Store") continue;
      const r = rel ? `${rel}/${name}` : name;
      statSync(join(root, r)).isDirectory() ? walk(r) : out.push(r);
    }
  };
  if (existsSync(root)) walk("");
  return out.sort();
}
const read = (root, rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel)) : null);
const same = (a, b) => (a === null || b === null ? a === b : a.equals(b));
function put(root, rel, buf) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), buf);
}
const hasGit = () => spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

/** 3 方向で混ぜる（git merge-file）。混ぜられたら中身、ぶつかったら null */
function merge3(mine, base, theirs) {
  const tmp = join(tmpdir(), `miru-merge-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    writeFileSync(join(tmp, "mine"), mine); writeFileSync(join(tmp, "base"), base); writeFileSync(join(tmp, "theirs"), theirs);
    const r = spawnSync("git", ["merge-file", "-p", join(tmp, "mine"), join(tmp, "base"), join(tmp, "theirs")], { maxBuffer: 64 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : null;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/** この道具のある MIRU（新しい版）を作業の場所へ入れる。自分で直した所は残し、新しい版の変更と混ぜる */
function install({ strict = false } = {}) {
  if (resolve(SRC) === resolve(DIR)) return { conflicts: [], merged: [], kept: [] };
  mkdirSync(DIR, { recursive: true });
  const base = join(DIR, BASE);
  const first = !existsSync(base);
  const theirsFiles = listFiles(SRC);
  const r = { conflicts: [], merged: [], kept: [], removed: [] };
  if (first) {
    // はじめて（または写しの無い前の版）: 違うファイルは、あなたが直したものかもしれない。update なら止め、そうでなければ控えてから入れる
    const diffs = theirsFiles.filter((f) => !ALWAYS_THEIRS.has(f) && read(DIR, f) && !same(read(DIR, f), read(SRC, f)));
    if (diffs.length && strict && !opt.force) {
      fail(`入れた版の写し（${BASE}）が無いので、次のファイルがあなたの直したものか見分けられません。まだ何も変えていません:\n${diffs.map((f) => `  - ${f}`).join("\n")}
直した所が無いなら --force を付けてもう一度（違うファイルは backups/ に控えてから入れ替えます）。直した所があるなら、控えを取ってから --force で入れ替え、直しを入れ直してください`, 6);
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    for (const f of theirsFiles) {
      const m = read(DIR, f), t = read(SRC, f);
      if (m && !same(m, t)) put(join(DIR, "backups", `files-${stamp}`), f, m);
      put(DIR, f, t);
    }
    if (diffs.length) say(`※ 違っていた ${diffs.length} 個のファイルを ${join(DIR, "backups", `files-${stamp}`)} に控えてから入れ替えました: ${diffs.join("、")}`);
  } else {
    const git = hasGit();
    const files = [...new Set([...theirsFiles, ...listFiles(base)])].sort();
    for (const f of files) {
      const t = read(SRC, f), b = read(base, f), m = read(DIR, f);
      if (same(t, m)) continue;                                   // もう同じ
      if (ALWAYS_THEIRS.has(f)) { t === null ? rmSync(join(DIR, f), { force: true }) : put(DIR, f, t); continue; }
      if (same(m, b)) { t === null ? rmSync(join(DIR, f)) : put(DIR, f, t); if (t === null) r.removed.push(f); continue; }   // 直していない → 新しい版に
      if (same(t, b)) { r.kept.push(f); continue; }                // 新しい版は変えていない → あなたのまま
      const merged = git && t && b && m ? merge3(m, b, t) : null;  // 両方が変えた → 混ぜる
      if (merged) { put(DIR, f, merged); r.merged.push(f); } else r.conflicts.push(f);
    }
  }
  // 入れた版の写しを入れ替える（ぶつかった所を直すときに、前の版との違いを見られるように 1 つ前を残す）
  rmSync(join(DIR, PREV), { recursive: true, force: true });
  if (!first) renameSync(base, join(DIR, PREV));
  for (const f of theirsFiles) put(base, f, read(SRC, f));
  say(`MIRU の中身を ${DIR} に${first ? "入れました" : "入れ替えました"}（${theirsFiles.length} ファイル）`);
  if (r.merged.length) say(`  自分で直した所と新しい版を混ぜたファイル: ${r.merged.join("、")}`);
  if (r.kept.length) say(`  自分で直したまま残したファイル: ${r.kept.length} 個`);
  return r;
}

function checkNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    fail(`Node.js 22.12 以上が要ります（いまは ${process.versions.node}。Cloudflare の道具 wrangler は 22 未満では動きません）。https://nodejs.org から LTS を入れて、ターミナルを開き直してください`);
  }
}

async function npmInstall(force = false) {
  if (!force && existsSync(join(DIR, "node_modules", "wrangler"))) return;
  if (!(await run("npm", ["install", "--no-audit", "--no-fund"])).ok) fail("npm install に失敗しました。通信を確かめて、もう一度動かしてください");
}

async function login() {
  if ((await wrangler(["whoami", "--json"], { capture: true, quiet: true })).ok) return;
  say("\nCloudflare にログインします。ブラウザが開いたら「Allow（許可）」を押してください。");
  if (!(await wrangler(["login"])).ok || !(await wrangler(["whoami", "--json"], { capture: true, quiet: true })).ok) fail("Cloudflare にログインできませんでした");
}

async function databaseId(name) {
  const list = await wrangler(["d1", "list", "--json"], { capture: true, quiet: true });
  if (!list.ok) explain(list.out);
  try { return JSON.parse(list.out.slice(list.out.indexOf("["))).find((d) => d.name === name)?.uuid ?? null; } catch { return null; }
}

function writeConfig(st) {
  const tpl = readFileSync(join(DIR, "wrangler.example.jsonc"), "utf8");
  const quota = st.owner_quota === undefined ? DEFAULT_QUOTA : st.owner_quota;
  let out = tpl.replaceAll("__NAME__", st.name).replaceAll("__OWNER__", st.owner).replaceAll("__DATABASE_ID__", st.database_id)
    .replaceAll("__GOOGLE_CLIENT_ID__", st.google_client_id ?? "").replaceAll("__OWNER_QUOTA__", quota ? String(quota) : "")
    .replaceAll("__UPDATE_FEED__", bundled().feed ?? "");
  if (st.account) out = out.replace(`"name": "${st.name}",`, `"account_id": "${st.account}",\n  "name": "${st.name}",`);
  writeFileSync(join(DIR, "wrangler.jsonc"), `// node tools/setup.mjs が作った設定（${new Date().toISOString().slice(0, 10)}）。作り直すときは setup.mjs を使う\n` + out);
}

async function deploy() {
  if (!(await run("npx", ["--yes", "vite", "build"])).ok) fail("画面を作れませんでした（vite build）。上のエラーを読んでください");
  const r = await wrangler(["deploy"], { capture: true });
  if (!r.ok) { explain(r.out); fail("公開できませんでした。上のエラーを読んでください"); }
  return /https:\/\/[a-z0-9.-]+\.workers\.dev/i.exec(r.out)?.[0] ?? null;
}

async function migrate(name) {
  const r = await wrangler(["d1", "migrations", "apply", name, "--remote"], { capture: true });
  if (!r.ok) { explain(r.out); fail("表を作れませんでした（d1 migrations apply）"); }
}

/** lite が上げる先（~/.config/miru/url）。無ければこの MIRU を書く。別の MIRU を指していたら知らせるだけ */
function linkUrl(url) {
  const f = join(CONF, "url");
  const now = existsSync(f) ? readFileSync(f, "utf8").trim() : "";
  if (!now) { mkdirSync(CONF, { recursive: true }); writeFileSync(f, url + "\n"); say(`この PC の上げる先（${f}）を ${url} にしました`); }
  else if (now.replace(/\/$/, "") !== url) say(`\n※ この PC の上げる先（${f}）は別の MIRU（${now}）です。この MIRU に上げるなら、設定の画面の「上げる道具用をコピー」で置き換えます`);
}

function googleHelp(url) {
  say(`
── 次は Google でログインできるようにします（SETUP.md の「2. Google でログインできるようにする」）──
Google Cloud（https://console.cloud.google.com/）で OAuth クライアント（ウェブ アプリケーション）を作り、次を入れます。
  承認済みの JavaScript 生成元:  ${url}
  承認済みのリダイレクト URI:    ${url}/auth/callback
「対象」の画面で「アプリを公開」を押して、本番環境にします（テストのままだと、テストユーザーに入れた人しか入れません）。
できたら、出たクライアント ID でこれを動かします:
  ${self("google --client-id <クライアントID>")}
シークレットは、あなたがターミナルで入れます（AI に渡さないでください）:
  ${secretSteps()}`);
}

async function hasSecret() {
  const r = await wrangler(["secret", "list", "--format", "json"], { capture: true, quiet: true });
  return r.ok && /GOOGLE_CLIENT_SECRET/.test(r.out);
}

const needState = () => readState() ?? fail(`${DIR} に MIRU がまだありません。先に start を動かしてください`);
/** 前の update でぶつかったまま（直し終えた印 --resolved が無い）なら止める。もう一度入れ替えると、新しい版の変更が消えてしまう */
function stopIfUnresolved() {
  const rep = readJson(join(DIR, REPORT));
  if (rep?.conflicts?.length && !opt.resolved) {
    fail(`前の update でぶつかったファイルがまだあります（${rep.conflicts.join("、")}）。${PREV}/<ファイル>（前の版）→ ${BASE}/<ファイル>（新しい版）の違いを <ファイル> に入れてから:\n  ${self("deploy --resolved")}`, 6);
  }
  return rep;
}
/** 表を足す前に控えを取る（足す表が無ければ取らない）。取れなければ止める（--no-backup で控えなしに進める） */
async function backupBeforeMigrate(st) {
  const l = await wrangler(["d1", "migrations", "list", st.name, "--remote"], { capture: true, quiet: true });
  if (l.ok && /No migrations to apply/i.test(l.out)) return;
  if (opt["no-backup"]) { say("※ --no-backup なので、控えを取らずに表を足します"); return; }
  if (!(await backup({ quiet: true }))) fail(`表を足す前の控えを取れませんでした（公開はしていません）。通信を確かめてもう一度動かすか、控えなしで進めるなら --no-backup を付けてください`);
}
const quotaOf = (gbStr) => {
  const n = Number(gbStr);
  if (!Number.isFinite(n) || n < 0) fail("--gb（--owner-quota-gb）は 0 以上の数で（0 は上限なし）");
  return Math.round(n * GB);
};

// Claude Code と Codex は lite を別々に持つ。古い方から動かすと黙って戻ってしまうので止める（update と、start のやり直し）
function noOlder(from, to) {
  if (to.build && from?.build && to.build < from.build && !opt["force-older"]) {
    fail(`入れようとしている MIRU（${verLabel(to)}）は、いま入っているもの（${verLabel(from)}）より古いです。AI動画編集 lite を新しくしてから動かしてください（わざと戻すなら --force-older）`, 8);
  }
}

// ── start ──
async function start() {
  checkNode();
  const owner = String(opt.owner ?? "").trim().toLowerCase();
  if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(owner)) fail("--owner に、あなたの Google アカウントのメールを入れてください（例: --owner you@gmail.com）");
  let prev = readState();
  if (prev?.installed) noOlder(prev.installed, bundled());
  const account = opt.account ?? prev?.account;      // 名前を変えてやり直すときも、選んだアカウントは引き継ぐ
  const name = String(opt.name ?? prev?.name ?? "miru").toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(name)) fail("--name は英小文字・数字・- で（例: miru）");
  if (!prev && existsSync(join(DIR, "wrangler.jsonc"))) fail(`${DIR} の wrangler.jsonc はこの道具が作ったものではありません。別の場所（--dir）を選んでください`);
  if (prev && prev.name !== name) {
    if (prev.url) fail(`${DIR} にはもう「${prev.name}」という MIRU があります（${prev.url}）。別に立てるなら --dir で別の場所を選んでください`);
    // まだ公開していない途中なら、名前を変えて最初からやり直せる（名前のぶつかりで --name を勧めたとき）
    say(`※ 公開の前だったので、「${prev.name}」をやめて「${name}」で作り直します。${prev.created?.d1 ? `前に作った D1「${prev.name}」` : ""}${prev.created?.r2 ? `${prev.created?.d1 ? "と" : ""}R2「${prev.name}-media」` : ""}${prev.created?.d1 || prev.created?.r2 ? "は Cloudflare に残っています（要らなければダッシュボードで消してください）" : ""}`);
    prev = null;
  }
  stopIfUnresolved();
  const r0 = install();
  if (r0.conflicts.length) fail(`自分で直した所と新しい版の変更がぶつかったので、まだ公開していません: ${r0.conflicts.join("、")}\n直してから ${self("deploy --resolved")}`, 6);
  await npmInstall();
  await login();
  // この道具が作ったもの（created）か、前に公開まで済んだ MIRU のものだけを使う。前からある別のものは --reuse が無ければ使わない。
  // created を持たない記録は前の版の setup.mjs が途中まで進めたもので、どれを作ったかを記録していないので、この道具のものとして続ける
  const legacy = !!prev && !prev.created;
  const created = { ...(prev?.created ?? {}) };
  const ours = (k) => !!(created[k] || prev?.url || legacy || opt.reuse);
  const taken = (what) => fail(`Cloudflare に、もう${what}があります（この道具が作ったものではありません）。前に立てた MIRU を使い直すなら --reuse を付けて、別に立てるなら --name 別の名前 で、もう一度動かしてください`, 7);
  const remember = (extra = {}) => writeState({ made_by: "miru-setup", ...(prev ?? {}), name, owner, account, created, ...extra });
  say("\n① データの置き場（D1）");
  let id = prev?.database_id ?? null;
  if (!id) {
    const found = await databaseId(name);
    if (found && !opt.reuse) taken(`「${name}」という名前の D1（データベース）`);
    id = found;
  }
  if (!id) {
    const r = await wrangler(["d1", "create", name], { capture: true });
    if (!r.ok) { if (/already exists/i.test(r.out)) taken(`「${name}」という名前の D1（データベース）`); explain(r.out); fail("D1 を作れませんでした。上のエラーを読んでください"); }
    id = /"?database_id"?\s*[:=]\s*"([0-9a-f-]{36})"/.exec(r.out)?.[1] ?? null;
    if (!id) fail("D1 を作れましたが、番号を読み取れませんでした。もう一度動かすときは --reuse を付けてください");
    created.d1 = true;
  }
  // ここで止まっても（R2 が無効など）、同じコマンドで続きから進めるように、作ったものを先に記録する
  remember({ database_id: id });
  say("\n② 動画の置き場（R2）");
  const r2 = await wrangler(["r2", "bucket", "create", `${name}-media`], { capture: true });
  if (!r2.ok) {
    if (/already exists|10004/i.test(r2.out)) { if (!ours("r2")) taken(`「${name}-media」という R2（動画の置き場）`); }
    else { explain(r2.out); fail("R2 を作れませんでした。上のエラーを読んでください"); }
  } else created.r2 = true;
  remember({ database_id: id });
  if (!ours("worker")) {              // はじめての公開の前に、同じ名前の Worker が無いかを確かめる（あると黙って置き換えてしまう）
    const w = await wrangler(["deployments", "list", "--name", name], { capture: true, quiet: true });
    if (w.ok) taken(`「${name}」という名前の Worker（サイト）`);
    if (!/does not exist|10007|not found/i.test(w.out)) explain(w.out);
  }
  // 公開で Worker を上げたあとに止まっても（URL を読めない・途中で止めた）、やり直しで「この道具が作ったものではありません」と言わないように、上げる前に記録する
  created.worker = true;
  const st = { made_by: "miru-setup", name, owner, database_id: id, account, created,
    google_client_id: prev?.google_client_id ?? "", url: prev?.url ?? null,
    owner_quota: opt["owner-quota-gb"] !== undefined ? quotaOf(opt["owner-quota-gb"]) : prev?.owner_quota ?? DEFAULT_QUOTA };
  writeConfig(st);
  writeState(st);
  say("\n③ 表を作る");
  if (prev?.url) await backupBeforeMigrate(st);       // 前からある MIRU に表を足すときは控えを取ってから
  await migrate(name);
  say("\n④ 公開");
  st.url = (await deploy()) ?? st.url;
  st.installed = bundled();
  writeState(st);
  if (!st.url) fail("公開はできましたが、URL を読み取れませんでした。Cloudflare のダッシュボードの Workers で URL を確かめ、.miru-setup.json の url に書いてください");
  say(`\n✓ MIRU を公開しました: ${st.url}`);
  linkUrl(st.url);
  if (!st.google_client_id) googleHelp(st.url);
  say(`\n全部終わったら、通し確認: ${self("check")}`);
}

// ── google ──
async function google() {
  const st = needState();
  const cid = String(opt["client-id"] ?? "").trim();
  if (/GOCSPX-|client_secret/i.test(cid)) fail(`それはクライアント シークレットです。ここに入れず、ターミナルで次を動かして貼ってください（AI のチャットに貼ったなら、Google Cloud でシークレットを作り直してください）:\n  ${secretSteps()}`);
  if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(cid)) fail("--client-id に Google のクライアント ID（…apps.googleusercontent.com）を入れてください");
  st.google_client_id = cid;
  writeConfig(st);
  writeState(st);
  st.url = (await deploy()) ?? st.url;
  writeState(st);
  if (await hasSecret()) say(`\n✓ Google でログインできます。${st.url} を開いて、${st.owner} でログインしてください`);
  else say(`\nクライアント ID を入れて公開しました。あとはシークレットだけです。ターミナルで次を動かし、Google のクライアント シークレットを貼ってください:\n  ${secretSteps()}\nそのあと ${st.url} を開いてログインします`);
}

// ── backup ──
async function backup({ quiet = false } = {}) {
  const st = needState();
  mkdirSync(join(DIR, "backups"), { recursive: true });
  const file = `backups/${st.name}-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}.sql`;
  const r = await wrangler(["d1", "export", st.name, "--remote", "--output", file, "-y"], { capture: true, quiet });
  if (!r.ok) { if (quiet) return null; explain(r.out); fail("控えを取れませんでした"); }
  say(`控えを取りました: ${join(DIR, file)}（文字のデータ。動画は R2 にあり、この控えには入りません）`);
  return file;
}

// ── update ──
async function update() {
  const st = needState();
  if (resolve(SRC) === resolve(DIR)) fail("新しい版の MIRU の場所から動かしてください（AI動画編集 lite の plugins/ai-video-editing-lite/miru/tools/setup.mjs update）");
  checkNode();
  const from = st.installed, to = bundled();
  say(`いま: ${verLabel(from)} → 新しい版: ${verLabel(to)}`);
  noOlder(from, to);
  stopIfUnresolved();
  const r = install({ strict: true });
  writeFileSync(join(DIR, REPORT), JSON.stringify({ at: new Date().toISOString(), from, to, ...r }, null, 2) + "\n");
  if (r.conflicts.length) {
    fail(`自分で直した所と新しい版の変更が同じ所でぶつかったので、まだ公開していません:\n${r.conflicts.map((f) => `  - ${f}`).join("\n")}
それぞれ、${PREV}/<ファイル>（前の版）→ ${BASE}/<ファイル>（新しい版）の違いを、<ファイル>（あなたが直したもの）に入れてください。
終わったら: ${self("deploy --resolved")}`, 6);
  }
  await npmInstall(true);
  await login();
  writeConfig(st);
  await backupBeforeMigrate(st);
  await migrate(st.name);
  st.url = (await deploy()) ?? st.url;
  st.installed = to;
  writeState(st);
  rmSync(join(DIR, REPORT), { force: true });
  say(`\n✓ 新しい版にしました: ${st.url}（${verLabel(to)}）`);
}

// ── deploy（自分で直したものを公開）──
async function deployOwn() {
  const st = needState();
  checkNode();
  const rep = stopIfUnresolved();
  await npmInstall(true);
  say("\n型の確認");
  const tc = await run("npx", ["--yes", "tsc", "--noEmit"]);
  const tw = tc.ok && (await run("npx", ["--yes", "tsc", "--noEmit", "-p", "worker"]));
  if (!tc.ok || !tw.ok) fail("型の確認で止まりました。上のエラーの所を直してから、もう一度動かしてください（公開はしていません）");
  await login();
  writeConfig(st);
  await backupBeforeMigrate(st);
  await migrate(st.name);
  st.url = (await deploy()) ?? st.url;
  // 公開したのは、この場所に入っている版（途中で止まった update を deploy で終えたときも合うように）
  st.installed = readJson(join(DIR, "VERSION.json")) ?? (rep?.to || st.installed);
  writeState(st);
  rmSync(join(DIR, REPORT), { force: true });
  say(`\n✓ 公開しました: ${st.url}`);
}

// ── changes ──
function changes() {
  needState();
  const base = join(DIR, BASE);
  if (!existsSync(base)) fail("入れた版の写しがありません（前の版の setup.mjs で立てたもの）。次の update から比べられます");
  const mine = new Set(listFiles(DIR).filter((f) => !ALWAYS_THEIRS.has(f))), orig = new Set(listFiles(base).filter((f) => !ALWAYS_THEIRS.has(f)));
  const changed = [...orig].filter((f) => mine.has(f) && !same(read(DIR, f), read(base, f)));
  const added = [...mine].filter((f) => !orig.has(f));
  const removed = [...orig].filter((f) => !mine.has(f));
  if (!changed.length && !added.length && !removed.length) { say("自分で直したファイルはありません（入れた版のままです）"); return; }
  for (const [label, xs] of [["直した", changed], ["足した", added], ["消した", removed]]) if (xs.length) say(`${label}（${xs.length}）:\n${xs.map((f) => `  ${f}`).join("\n")}`);
  say(`\n違いの中身は、たとえば: git diff --no-index "${BASE}/<ファイル>" "<ファイル>"（${DIR} で）`);
}

// ── quota ──
async function quota() {
  const st = needState();
  if (opt.gb === undefined) fail("--gb に上限を GB で入れてください（例: --gb 9。0 で上限なし）");
  st.owner_quota = quotaOf(opt.gb);
  await login();
  writeConfig(st);
  writeState(st);
  st.url = (await deploy()) ?? st.url;
  writeState(st);
  say(`\n✓ 置ける量の上限を ${st.owner_quota ? `${(st.owner_quota / GB).toFixed(1)}GB` : "なし"} にしました${st.owner_quota > 10 * GB || !st.owner_quota ? "（R2 は 10GB を超えた分が Cloudflare から請求されます）" : ""}`);
}

// ── check（通し確認）──
async function check() {
  const st = needState();
  const url = (opt.url ?? st.url ?? "").replace(/\/$/, "");
  let bad = 0;
  const line = (ok, label, fix = "") => { if (ok === false) bad++; say(`${ok === true ? "✓" : ok === false ? "✗" : "−"} ${label}${fix ? `\n    → ${fix}` : ""}`); };
  const get = async (path, init = {}) => { try { return await fetch(url + path, { redirect: "manual", ...init, headers: { "user-agent": "miru-setup/1.0", ...(init.headers ?? {}) } }); } catch (e) { return { ok: false, status: 0, error: String(e) }; } };
  if (!url) { line(false, "サイトの URL がわかりません", `${self("start --owner <メール>")} を最後まで動かしてください`); process.exit(1); }
  say(`MIRU: ${url}\n`);
  const h = await get("/api/health");
  const hj = h.status ? await jsonOf(h) : null;
  line(!!hj?.ok, "サイトが動いている（/api/health）", h.status ? (hj?.ok ? "" : `データベースに届いていません。${self("deploy")} で表を作り直します`) : `つながりません（${h.error ?? h.status}）。URL を確かめてください`);
  if (hj) {
    const want = st.installed?.build ?? 0, have = hj.version?.build ?? 0, pkg = bundled().build ?? 0;
    line(have >= want ? true : false, `公開されている版: ${verLabel(hj.version)}`, have < want ? `公開がまだ古い版です。${self("deploy")}` : "");
    if (pkg > have) line(null, `入っている lite には新しい版（${verLabel(bundled())}）があります`, "node <新しい MIRU の場所>/tools/setup.mjs update");
    line(hj.edition === "light", "MIRU ライトとして動いている", hj.edition === "light" ? "" : `wrangler.jsonc の MIRU_EDITION が light ではありません。${self("deploy")} で作り直します`);
  }
  const site = await jsonOf(await get("/api/site"));
  line(!!site?.invite_only, "招待された人だけが入れる（持ち主の設定あり）", site?.invite_only ? "" : `SITE_OWNERS が空です。${self("start --owner <メール>")} をもう一度`);
  const g = await get("/auth/google");
  const loc = g.headers?.get?.("location") ?? "";
  if (g.status === 503) line(false, "Google でログインできる", st.google_client_id ? `シークレットがまだです:\n      ${secretSteps().replace(/\n  /g, "\n      ")}` : `クライアント ID がまだです: ${self("google --client-id <ID>")}`);
  else if (g.status === 302 && loc.startsWith("https://accounts.google.com/")) {
    const q = new URL(loc).searchParams;
    const okId = q.get("client_id") === st.google_client_id, okBack = q.get("redirect_uri") === `${url}/auth/callback`;
    line(okId && okBack, "Google でログインできる（ログインの入口）", okId ? (okBack ? "" : `Google Cloud のリダイレクト URI を ${url}/auth/callback にしてください`) : `公開されているクライアント ID が記録と違います。${self("google --client-id <ID>")}`);
    say("    （Google の画面で「redirect_uri_mismatch」「アクセスをブロック」が出たら、SETUP.md の「困ったとき」）");
  } else line(false, "Google でログインできる", `ログインの入口が思わぬ答え（${g.status}）でした`);
  const tokenFile = join(CONF, "token"), urlFile = join(CONF, "url");
  const linked = existsSync(urlFile) && readFileSync(urlFile, "utf8").trim().replace(/\/$/, "") === url;
  line(linked ? true : null, "この PC の上げる先がこの MIRU（~/.config/miru/url）", linked ? "" : "設定の画面の「Claude Code・Codex とつなぐ」→「上げる道具用をコピー」を押してターミナルに貼ります");
  if (existsSync(tokenFile)) {
    const token = readFileSync(tokenFile, "utf8").trim();
    const me = linked ? await get("/api/me", { headers: { authorization: `Bearer ${token}` } }) : null;
    const mj = me?.status === 200 ? await jsonOf(me) : null;
    if (linked) line(!!mj?.user, `鍵で入れる${mj?.user ? `（${mj.user.email}）` : ""}`, mj?.user ? "" : "鍵が違うか期限切れです。設定の画面で鍵を作り直し、「上げる道具用をコピー」を押して貼ります");
  } else line(null, "鍵（~/.config/miru/token）", "まだ置いていません。ログインしたあと、設定の画面の「上げる道具用をコピー」を押して貼ります");
  const codex = readTextSafe(join(homedir(), ".codex", "config.toml"));
  if (codex !== null) line(codex.includes(`${url}/mcp`) ? true : null, "Codex とつながっている（~/.codex/config.toml）", codex.includes(`${url}/mcp`) ? "" : "設定の画面の「Mac 用をコピー」か「Windows 用をコピー」を貼り、Codex を開き直します");
  const claude = readJson(join(homedir(), ".claude.json"));
  if (claude) {
    const urls = [claude.mcpServers?.miru?.url, ...Object.values(claude.projects ?? {}).map((p) => p?.mcpServers?.miru?.url)].filter(Boolean);
    line(urls.includes(`${url}/mcp`) ? true : null, "Claude Code とつながっている", urls.includes(`${url}/mcp`) ? "" : "設定の画面の「コマンドをコピー」（claude mcp add …）を押してターミナルに貼ります");
  }
  if (await hasSecret().catch(() => false)) line(true, "Google のシークレットが入っている");
  say(bad ? `\n✗ 直す所が ${bad} つあります（上の → のとおり）` : "\n✓ 通し確認は全部通りました");
  process.exit(bad ? 1 : 0);
}
function readTextSafe(f) { try { return readFileSync(f, "utf8"); } catch { return null; } }

// ── status ──
async function status() {
  const st = readState();
  if (!st) { say(`${DIR} に MIRU はまだありません（${self("start --owner <メール>")}）`); return; }
  const pkg = bundled();
  say(`場所:       ${DIR}\nURL:        ${st.url ?? "（まだ）"}\n持ち主:     ${st.owner}\n入れた版:   ${verLabel(st.installed)}${pkg.build > (st.installed?.build ?? 0) ? `（新しい版 ${verLabel(pkg)} があります: update）` : ""}\nGoogle ID:  ${st.google_client_id || "（まだ）"}\n容量の上限: ${st.owner_quota === 0 ? "なし" : `${((st.owner_quota ?? DEFAULT_QUOTA) / GB).toFixed(1)}GB`}`);
  const base = join(DIR, BASE);
  if (existsSync(base)) {
    const n = listFiles(base).filter((f) => !ALWAYS_THEIRS.has(f) && !same(read(DIR, f), read(base, f))).length;
    say(`自分で直したファイル: ${n} 個${n ? `（${self("changes")}）` : ""}`);
  }
  await login();
  say(`シークレット: ${(await hasSecret()) ? "入っています" : `まだ:\n  ${secretSteps()}`}`);
  if (st.url && !st.google_client_id) googleHelp(st.url);
}

const table = { start, google, update, deploy: deployOwn, changes, backup, quota, check, status };
if (!table[cmd]) {
  const lines = readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1);
  say(lines.slice(0, lines.findIndex((l) => !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(cmd === "help" ? 0 : 1);
}
if (cmd !== "changes") checkNode();
await table[cmd]();
