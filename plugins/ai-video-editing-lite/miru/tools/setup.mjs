#!/usr/bin/env node
// 自分の Cloudflare に MIRU を立てる道具（2026-10-22）。手順と理由は SETUP.md。
//
//   node tools/setup.mjs start --owner you@gmail.com [--name miru] [--dir ~/MIRU] [--account <アカウントID>]
//       … 置き場所（D1・R2）を作り、表を作り、画面を作って公開する。最後に Google の設定に入れる URL を出す
//   node tools/setup.mjs google --client-id <クライアントID>
//       … Google のクライアント ID を入れて公開し直す。シークレットは本人がターミナルで入れる（この道具は受け取らない）
//   node tools/setup.mjs update   … 新しい版の MIRU に入れ替える（表の追加・公開し直し）。設定とデータはそのまま
//   node tools/setup.mjs status   … いまの URL・Google の設定・シークレットの有無
//
// 作業する場所（--dir、既定 ~/MIRU）に、この道具のある MIRU の中身を写してから動く。
// 設定（wrangler.jsonc）と記録（.miru-setup.json）はその場所に残り、update でも消さない。

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const SRC = resolve(import.meta.dirname, "..");
const STATE = ".miru-setup.json";
const SKIP = new Set(["node_modules", "dist", ".wrangler", "wrangler.jsonc", STATE, ".dev.vars", ".git"]);
const WIN = process.platform === "win32";

const [cmd = "help", ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith("--")) opt[rest[i].slice(2)] = rest[i + 1]?.startsWith("--") ? true : rest[++i] ?? true;
const expand = (p) => resolve(String(p).replace(/^~(?=$|[\\/])/, homedir()));
const DIR = expand(opt.dir ?? process.env.MIRU_DIR ?? join(homedir(), "MIRU"));

const say = (s = "") => console.log(s);
const fail = (s, code = 1) => { console.error(`\n✗ ${s}`); process.exit(code); };

/** コマンドを動かす。capture のときは出力を返しつつ画面にも出す（確認の問いかけが見えるように） */
function run(bin, args, { capture = false, cwd = DIR, quiet = false } = {}) {
  if (!quiet) say(`$ ${bin} ${args.join(" ")}`);
  const r = spawnSync(WIN ? `${bin}.cmd` : bin, args, { cwd, shell: WIN, encoding: "utf8", stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit" });
  if (capture && !quiet) { if (r.stdout) process.stdout.write(r.stdout); if (r.stderr) process.stderr.write(r.stderr); }
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const wrangler = (args, o) => run("npx", ["--yes", "wrangler", ...args], o);

const readState = () => (existsSync(join(DIR, STATE)) ? JSON.parse(readFileSync(join(DIR, STATE), "utf8")) : null);
const writeState = (s) => writeFileSync(join(DIR, STATE), JSON.stringify(s, null, 2) + "\n");

/** この道具のある MIRU の中身を作業の場所へ写す（設定・記録・node_modules は残す） */
function copySource() {
  if (resolve(SRC) === resolve(DIR)) return;
  mkdirSync(DIR, { recursive: true });
  for (const name of readdirSync(SRC)) {
    if (SKIP.has(name)) continue;
    cpSync(join(SRC, name), join(DIR, name), { recursive: true, force: true });
  }
  say(`MIRU の中身を ${DIR} に写しました`);
}

function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) fail(`Node.js 20 以上が要ります（いまは ${process.versions.node}）。https://nodejs.org から入れてください`);
}

function npmInstall() {
  if (existsSync(join(DIR, "node_modules", "wrangler"))) return;
  if (!run("npm", ["install", "--no-audit", "--no-fund"]).ok) fail("npm install に失敗しました。通信を確かめて、もう一度動かしてください");
}

function login() {
  if (wrangler(["whoami", "--json"], { capture: true, quiet: true }).ok) return;
  say("\nCloudflare にログインします。ブラウザが開いたら「Allow（許可）」を押してください。");
  if (!wrangler(["login"]).ok || !wrangler(["whoami", "--json"], { capture: true, quiet: true }).ok) fail("Cloudflare にログインできませんでした");
}

function databaseId(name) {
  const list = wrangler(["d1", "list", "--json"], { capture: true, quiet: true });
  try { return JSON.parse(list.out.slice(list.out.indexOf("["))).find((d) => d.name === name)?.uuid ?? null; } catch { return null; }
}

function writeConfig(st) {
  const tpl = readFileSync(join(DIR, "wrangler.example.jsonc"), "utf8");
  let out = tpl.replaceAll("__NAME__", st.name).replaceAll("__OWNER__", st.owner).replaceAll("__DATABASE_ID__", st.database_id)
    .replaceAll("__GOOGLE_CLIENT_ID__", st.google_client_id ?? "");
  if (st.account) out = out.replace(`"name": "${st.name}",`, `"account_id": "${st.account}",\n  "name": "${st.name}",`);
  writeFileSync(join(DIR, "wrangler.jsonc"), `// node tools/setup.mjs が作った設定（${new Date().toISOString().slice(0, 10)}）。作り直すときは setup.mjs を使う\n` + out);
}

function deploy() {
  if (!run("npx", ["--yes", "vite", "build"]).ok) fail("画面を作れませんでした（vite build）");
  const r = wrangler(["deploy"], { capture: true });
  if (!r.ok) fail("公開できませんでした。上のエラーを読んでください（workers.dev の名前の登録を求められたら、好きな英字の名前で登録します）");
  const url = /https:\/\/[a-z0-9.-]+\.workers\.dev/i.exec(r.out)?.[0];
  return url ?? null;
}

function migrate(name) {
  if (!wrangler(["d1", "migrations", "apply", name, "--remote"]).ok) fail("表を作れませんでした（d1 migrations apply）");
}

function googleHelp(url) {
  say(`
── 次は Google でログインできるようにします（SETUP.md の「2. Google でログインできるようにする」）──
Google Cloud（https://console.cloud.google.com/）で OAuth クライアント（ウェブ アプリケーション）を作り、次を入れます。
  承認済みの JavaScript 生成元:  ${url}
  承認済みのリダイレクト URI:    ${url}/auth/callback
できたら、出たクライアント ID でこれを動かします:
  node tools/setup.mjs google --client-id <クライアントID>
シークレットは、あなたがターミナルで入れます（AI に渡さないでください）:
  cd "${DIR}" && npx wrangler secret put GOOGLE_CLIENT_SECRET`);
}

function hasSecret() {
  const r = wrangler(["secret", "list", "--format", "json"], { capture: true, quiet: true });
  return r.ok && /GOOGLE_CLIENT_SECRET/.test(r.out);
}

// ── start ──
function start() {
  checkNode();
  const owner = String(opt.owner ?? "").trim().toLowerCase();
  if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(owner)) fail("--owner に、あなたの Google アカウントのメールを入れてください（例: --owner you@gmail.com）");
  const name = String(opt.name ?? "miru").toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(name)) fail("--name は英小文字・数字・- で（例: miru）");
  const prev = readState();
  if (!prev && existsSync(join(DIR, "wrangler.jsonc"))) fail(`${DIR} の wrangler.jsonc はこの道具が作ったものではありません。別の場所（--dir）を選んでください`);
  copySource();
  npmInstall();
  login();
  say("\n① データの置き場（D1）");
  let id = prev?.database_id ?? databaseId(name);
  if (!id) {
    const r = wrangler(["d1", "create", name], { capture: true });
    id = /"?database_id"?\s*[:=]\s*"([0-9a-f-]{36})"/.exec(r.out)?.[1] ?? databaseId(name);
    if (!id) fail("D1 を作れませんでした。上のエラーを読んでください");
  }
  say("\n② 動画の置き場（R2）");
  const r2 = wrangler(["r2", "bucket", "create", `${name}-media`], { capture: true });
  if (!r2.ok && !/already exists|10004/i.test(r2.out)) {
    if (/enable R2|10042|purchase/i.test(r2.out)) fail("R2 がまだ使える状態になっていません。Cloudflare のダッシュボードで「R2」を開き、有効にしてから、もう一度同じコマンドを動かしてください（SETUP.md の「R2 を有効にする」）", 2);
    fail("R2 を作れませんでした。上のエラーを読んでください");
  }
  const st = { made_by: "miru-setup", name, owner, database_id: id, account: opt.account ?? prev?.account, google_client_id: prev?.google_client_id ?? "", url: prev?.url ?? null };
  writeConfig(st);
  writeState(st);
  say("\n③ 表を作る");
  migrate(name);
  say("\n④ 公開");
  st.url = deploy() ?? st.url;
  writeState(st);
  if (!st.url) fail("公開はできましたが、URL を読み取れませんでした。Cloudflare のダッシュボードの Workers で URL を確かめ、.miru-setup.json の url に書いてください");
  say(`\n✓ MIRU を公開しました: ${st.url}`);
  if (!st.google_client_id) googleHelp(st.url);
}

// ── google ──
function google() {
  const st = readState() ?? fail(`${DIR} に MIRU がまだありません。先に start を動かしてください`);
  const cid = String(opt["client-id"] ?? "").trim();
  if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(cid)) fail("--client-id に Google のクライアント ID（…apps.googleusercontent.com）を入れてください");
  st.google_client_id = cid;
  writeConfig(st);
  writeState(st);
  st.url = deploy() ?? st.url;
  writeState(st);
  if (hasSecret()) say(`\n✓ Google でログインできます。${st.url} を開いて、${st.owner} でログインしてください`);
  else say(`\nクライアント ID を入れて公開しました。あとはシークレットだけです。ターミナルで次を動かし、Google のクライアント シークレットを貼ってください:\n  cd "${DIR}" && npx wrangler secret put GOOGLE_CLIENT_SECRET\nそのあと ${st.url} を開いてログインします`);
}

// ── update ──
function update() {
  const st = readState() ?? fail(`${DIR} に MIRU がまだありません。先に start を動かしてください`);
  checkNode();
  copySource();
  if (!run("npm", ["install", "--no-audit", "--no-fund"]).ok) fail("npm install に失敗しました");
  login();
  writeConfig(st);
  migrate(st.name);
  st.url = deploy() ?? st.url;
  writeState(st);
  say(`\n✓ 新しい版にしました: ${st.url}`);
}

// ── status ──
function status() {
  const st = readState();
  if (!st) { say(`${DIR} に MIRU はまだありません（node tools/setup.mjs start --owner <メール>）`); return; }
  say(`場所:       ${DIR}\nURL:        ${st.url ?? "（まだ）"}\n持ち主:     ${st.owner}\nGoogle ID:  ${st.google_client_id || "（まだ）"}`);
  login();
  say(`シークレット: ${hasSecret() ? "入っています" : "まだ（npx wrangler secret put GOOGLE_CLIENT_SECRET）"}`);
  if (st.url && !st.google_client_id) googleHelp(st.url);
}

const table = { start, google, update, status };
if (!table[cmd]) {
  say(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 14).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(cmd === "help" ? 0 : 1);
}
table[cmd]();
