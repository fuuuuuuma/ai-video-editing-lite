// tools/setup.mjs の検査（2026-10-23）。本物の Cloudflare には触れず、にせの npx・npm（wrangler・vite のふり）で通す。
//   node --test tools/setup.test.mjs      … Mac・Windows・Linux で同じに動く（GitHub Actions でも回す）
// にせの wrangler は FAKE_MODE で、R2 が無効・workers.dev の名前が無い・アカウントが複数・メールの確認がまだ、を真似る。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const MIRU = resolve(import.meta.dirname, "..");
const WIN = process.platform === "win32";
const hasGit = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

/** 試しの場所: 新しい版の MIRU（src）・作業の場所（dir）・ホーム（home）・にせのコマンド（bin） */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "miru-setup-test-"));
  const src = join(root, "plugin", "miru"), dir = join(root, "home", "MIRU"), home = join(root, "home"), bin = join(root, "bin");
  for (const d of [src, home, bin]) mkdirSync(d, { recursive: true });
  for (const f of ["tools/setup.mjs", "wrangler.example.jsonc", "package.json", "worker/version.ts", "SETUP.md"]) {
    mkdirSync(join(src, f, ".."), { recursive: true }); cpSync(join(MIRU, f), join(src, f));
  }
  writeFileSync(join(src, "VERSION.json"), JSON.stringify({ build: 10, date: "2026-10-23", commit: "aaaa", feed: "https://example.com/VERSION.json" }));
  writeFileSync(join(src, "worker", "app.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
  // にせの wrangler（と vite・npm・tsc）。呼ばれた引数を log に残す
  const fake = join(bin, "fake.mjs");
  writeFileSync(fake, `
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const [tool, ...a] = process.argv.slice(2);
const args = tool === "npx" ? a.filter((x) => x !== "--yes") : a;
appendFileSync(process.env.FAKE_LOG, JSON.stringify([tool, ...args]) + "\\n");
const mode = process.env.FAKE_MODE ?? "";
const state = process.env.FAKE_STATE, st = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : { d1: [], r2: [] };
const save = () => writeFileSync(state, JSON.stringify(st));
const out = (s) => process.stdout.write(s + "\\n"), err = (s) => { process.stderr.write(s + "\\n"); process.exit(1); };
if (tool === "npm") { mkdirSync("node_modules/wrangler", { recursive: true }); process.exit(0); }
const [cmd, sub, ...rest] = args;
if (cmd === "vite") { mkdirSync("dist", { recursive: true }); process.exit(0); }
if (cmd === "tsc") process.exit(mode === "tsc-fail" ? 2 : 0);
if (cmd !== "wrangler") err("unknown " + cmd);
const w = args.slice(1);
const multi = () => { if (mode === "multi-account" && !process.env.CLOUDFLARE_ACCOUNT_ID) err("More than one account available but unable to select one in non-interactive mode.\\nAvailable accounts are (\`<name>\`: \`<account_id>\`):\\n  \`A\`: \`aaa\`\\n  \`B\`: \`bbb\`"); };
if (w[0] === "whoami") process.exit(0);
if (w[0] === "login") process.exit(0);
if (w[0] === "d1" && w[1] === "list") { multi(); out(JSON.stringify(st.d1.map((n) => ({ name: n, uuid: "11111111-2222-3333-4444-" + n.padEnd(12, "0").slice(0, 12).replace(/[^0-9a-f]/g, "0") })))); process.exit(0); }
if (w[0] === "d1" && w[1] === "create") { multi(); if (st.d1.includes(w[2])) err("A database with that name already exists"); st.d1.push(w[2]); save(); out('"database_id": "11111111-2222-3333-4444-' + w[2].padEnd(12, "0").slice(0, 12).replace(/[^0-9a-f]/g, "0") + '"'); process.exit(0); }
if (w[0] === "r2" && w[1] === "bucket" && w[2] === "create") {
  if (mode === "r2-disabled") err("Please enable R2 through the Cloudflare Dashboard. [code: 10042]");
  if (st.r2.includes(w[3])) err("The bucket you tried to create already exists, and you own it. [code: 10004]");
  st.r2.push(w[3]); save(); process.exit(0);
}
if (w[0] === "d1" && w[1] === "migrations" && w[2] === "list") { out(process.env.FAKE_PENDING === "0" ? "No migrations to apply!" : "Migrations to be applied: 0006_x.sql"); process.exit(0); }
if (w[0] === "d1" && w[1] === "migrations") process.exit(0);
if (w[0] === "deployments" && w[1] === "list") { if ((st.workers ?? []).includes(w[w.indexOf("--name") + 1])) { out("Created: 2026"); process.exit(0); } err("This Worker does not exist on your account. [code: 10007]"); }
if (w[0] === "d1" && w[1] === "export") { const o = w[w.indexOf("--output") + 1]; writeFileSync(o, "-- dump"); process.exit(0); }
if (w[0] === "deploy") {
  if (mode === "no-subdomain") err("You need to register a workers.dev subdomain before publishing to workers.dev\\nhttps://dash.cloudflare.com/abc123/workers/onboarding");
  if (mode === "unverified") err("Your email address must be verified before you can deploy. [code: 10034]");
  st.workers = [...new Set([...(st.workers ?? []), "miru"])]; save();
  out("Uploaded miru\\nDeployed miru triggers\\n  https://miru.taro.workers.dev"); process.exit(0);
}
if (w[0] === "secret" && w[1] === "list") { out(process.env.FAKE_SECRET ? '[{"name":"GOOGLE_CLIENT_SECRET"}]' : "[]"); process.exit(0); }
err("unknown wrangler " + w.join(" "));
`);
  for (const tool of ["npx", "npm"]) {
    if (WIN) writeFileSync(join(bin, `${tool}.cmd`), `@echo off\r\n"${process.execPath}" "${fake}" ${tool} %*\r\n`);
    else { writeFileSync(join(bin, tool), `#!/bin/sh\nexec "${process.execPath}" "${fake}" ${tool} "$@"\n`, { mode: 0o755 }); }
  }
  const env = { ...process.env, PATH: `${bin}${WIN ? ";" : ":"}${process.env.PATH}`, HOME: home, USERPROFILE: home,
    FAKE_LOG: join(root, "log.jsonl"), FAKE_STATE: join(root, "cf.json"), MIRU_DIR: dir };
  const run = (args, extra = {}) => {
    const r = spawnSync(process.execPath, [join(src, "tools", "setup.mjs"), ...args], { env: { ...env, ...extra }, encoding: "utf8", timeout: 60_000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const calls = () => (existsSync(env.FAKE_LOG) ? readFileSync(env.FAKE_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { root, src, dir, home, run, calls, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("start: 置き場所を作って公開し、設定と記録を残す。上げる先も書く", () => {
  const s = sandbox();
  try {
    const r = s.run(["start", "--owner", "Taro@Gmail.com"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /MIRU を公開しました: https:\/\/miru\.taro\.workers\.dev/);
    assert.match(r.out, /承認済みのリダイレクト URI: {4}https:\/\/miru\.taro\.workers\.dev\/auth\/callback/);
    const conf = readFileSync(join(s.dir, "wrangler.jsonc"), "utf8");
    assert.match(conf, /"SITE_OWNERS": "taro@gmail.com"/);
    assert.match(conf, /"MIRU_EDITION": "light"/);
    assert.match(conf, /"OWNER_QUOTA_BYTES": "9663676416"/);
    assert.match(conf, /"UPDATE_FEED": "https:\/\/example.com\/VERSION.json"/);
    assert.doesNotMatch(conf, /__[A-Z_]+__/);
    const st = JSON.parse(readFileSync(join(s.dir, ".miru-setup.json"), "utf8"));
    assert.equal(st.installed.build, 10);
    assert.equal(readFileSync(join(s.home, ".config", "miru", "url"), "utf8").trim(), "https://miru.taro.workers.dev");
    assert.ok(existsSync(join(s.dir, ".miru-upstream", "worker", "app.ts")));
    // 同じコマンドをもう一度: 作ったものを使い直して続きから（名前のぶつかりで止めない）
    assert.equal(s.run(["start", "--owner", "taro@gmail.com"]).code, 0);
  } finally { s.done(); }
});

test("start: 止まりやすい所は、することを言って決まったコードで終わる", () => {
  for (const [mode, code, words] of [["r2-disabled", 2, /R2 オブジェクト ストレージ/], ["no-subdomain", 3, /dash\.cloudflare\.com\/abc123\/workers\/onboarding/],
    ["multi-account", 4, /--account/], ["unverified", 5, /メールアドレスの確認/]]) {
    const s = sandbox();
    try {
      const r = s.run(["start", "--owner", "taro@gmail.com"], { FAKE_MODE: mode });
      assert.equal(r.code, code, `${mode}: ${r.out}`);
      assert.match(r.out, words, mode);
      if (mode === "r2-disabled" || mode === "no-subdomain") assert.equal(s.run(["start", "--owner", "taro@gmail.com"]).code, 0, `${mode} のあと続きから`);
      if (mode === "multi-account") {   // --account を付けると、設定を書く前の D1 の作成から効く（2026-10-23 本物の Cloudflare で見つけた）
        const again = s.run(["start", "--owner", "taro@gmail.com", "--account", "aaa"], { FAKE_MODE: mode });
        assert.equal(again.code, 0, again.out);
        assert.match(readFileSync(join(s.dir, "wrangler.jsonc"), "utf8"), /"account_id": "aaa"/);
        assert.equal(s.run(["deploy"], { FAKE_MODE: mode }).code, 0, "記録したアカウントで続ける");
      }
    } finally { s.done(); }
  }
});

test("start: 前からある同じ名前の D1・R2 は、--reuse が無ければ使わない", () => {
  const s = sandbox();
  try {
    writeFileSync(join(s.root, "cf.json"), JSON.stringify({ d1: ["miru"], r2: [], workers: [] }));
    const r = s.run(["start", "--owner", "taro@gmail.com"]);
    assert.equal(r.code, 7, r.out);
    assert.match(r.out, /--reuse/);
    assert.equal(s.run(["start", "--owner", "taro@gmail.com", "--reuse"]).code, 0);
  } finally { s.done(); }
});

test("google: シークレットを渡されたら受け取らない。ID なら入れて公開し直す", () => {
  const s = sandbox();
  try {
    s.run(["start", "--owner", "taro@gmail.com"]);
    const bad = s.run(["google", "--client-id", "GOCSPX-abcdef"]);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /シークレット/);
    const ok = s.run(["google", "--client-id", "123-abc.apps.googleusercontent.com"]);
    assert.equal(ok.code, 0, ok.out);
    assert.match(readFileSync(join(s.dir, "wrangler.jsonc"), "utf8"), /"GOOGLE_CLIENT_ID": "123-abc.apps.googleusercontent.com"/);
  } finally { s.done(); }
});

test("update: 自分で直した所は残し、新しい版の変更と混ぜる。ぶつかったら公開しない", { skip: !hasGit && "git が無い" }, () => {
  const s = sandbox();
  try {
    s.run(["start", "--owner", "taro@gmail.com"]);
    writeFileSync(join(s.dir, "package-lock.json"), '{"rewritten":"by npm"}');   // npm install が書き直したもの（直した数に入れない）
    // 利用者が自分の MIRU を直す（1 行目）・自分のファイルを足す
    writeFileSync(join(s.dir, "worker", "app.ts"), "export const a = 100;\nexport const b = 2;\nexport const c = 3;\n");
    writeFileSync(join(s.dir, "worker", "mine.ts"), "export const mine = true;\n");
    const ch = s.run(["changes"]).out;
    assert.match(ch, /worker\/app\.ts[\s\S]*worker\/mine\.ts/);
    assert.doesNotMatch(ch, /package-lock/);
    // 新しい版は 3 行目を変え、ファイルを 1 つ足す
    writeFileSync(join(s.src, "worker", "app.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 300;\n");
    writeFileSync(join(s.src, "worker", "new.ts"), "export const n = 1;\n");
    writeFileSync(join(s.src, "VERSION.json"), JSON.stringify({ build: 11, date: "2026-10-24", commit: "bbbb", feed: "" }));
    const r = s.run(["update"]);
    assert.equal(r.code, 0, r.out);
    assert.equal(readFileSync(join(s.dir, "worker", "app.ts"), "utf8"), "export const a = 100;\nexport const b = 2;\nexport const c = 300;\n");
    assert.ok(existsSync(join(s.dir, "worker", "new.ts")));
    assert.ok(existsSync(join(s.dir, "worker", "mine.ts")));
    assert.ok(readdirSync(join(s.dir, "backups")).some((f) => f.endsWith(".sql")), "更新の前に控え");
    assert.equal(JSON.parse(readFileSync(join(s.dir, ".miru-setup.json"), "utf8")).installed.build, 11);
    // 同じ行を両方が変えた → 公開しないで、直す場所を言う
    writeFileSync(join(s.dir, "worker", "app.ts"), "export const a = 100;\nexport const b = 'mine';\nexport const c = 300;\n");
    writeFileSync(join(s.src, "worker", "app.ts"), "export const a = 1;\nexport const b = 'theirs';\nexport const c = 300;\n");
    writeFileSync(join(s.src, "VERSION.json"), JSON.stringify({ build: 12, date: "2026-10-25", commit: "cccc", feed: "" }));
    const before = s.calls().filter((c) => c.includes("deploy")).length;
    const c = s.run(["update"]);
    assert.equal(c.code, 6, c.out);
    assert.match(c.out, /worker\/app\.ts/);
    assert.equal(s.calls().filter((x) => x.includes("deploy")).length, before, "ぶつかったら公開しない");
    assert.equal(readFileSync(join(s.dir, "worker", "app.ts"), "utf8"), "export const a = 100;\nexport const b = 'mine';\nexport const c = 300;\n", "あなたのまま");
    assert.match(readFileSync(join(s.dir, ".miru-upstream-prev", "worker", "app.ts"), "utf8"), /a = 1;\nexport const b = 2/);
    assert.equal(s.run(["deploy"]).code, 6, "直し終えた印が無いと公開しない");
    const d = s.run(["deploy", "--resolved"]);
    assert.equal(d.code, 0, d.out);
    assert.equal(JSON.parse(readFileSync(join(s.dir, ".miru-setup.json"), "utf8")).installed.build, 12);
  } finally { s.done(); }
});

test("deploy: 型の確認で止まったら公開しない。quota で上限を変える", () => {
  const s = sandbox();
  try {
    s.run(["start", "--owner", "taro@gmail.com"]);
    const n = s.calls().filter((c) => c.includes("deploy")).length;
    const r = s.run(["deploy"], { FAKE_MODE: "tsc-fail" });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /型の確認で止まりました/);
    assert.equal(s.calls().filter((c) => c.includes("deploy")).length, n);
    assert.equal(s.run(["quota", "--gb", "0"]).code, 0);
    assert.match(readFileSync(join(s.dir, "wrangler.jsonc"), "utf8"), /"OWNER_QUOTA_BYTES": ""/);
  } finally { s.done(); }
});

test("check: サイト・Google・この PC とのつながりを確かめ、直す所を言う", async () => {
  const s = sandbox();
  let google = false;
  const server = createServer((q, res) => {
    const send = (code, body, h = {}) => { res.writeHead(code, { "content-type": "application/json", ...h }); res.end(body === null ? "" : JSON.stringify(body)); };
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (q.url === "/api/health") return send(200, { ok: true, edition: "light", version: { build: 10, date: "2026-10-23", commit: "aaaa" } });
    if (q.url === "/api/site") return send(200, { invite_only: true, edition: "light" });
    if (q.url === "/auth/google") return google
      ? send(302, null, { location: `https://accounts.google.com/o/oauth2/v2/auth?client_id=123-abc.apps.googleusercontent.com&redirect_uri=${encodeURIComponent(origin + "/auth/callback")}` })
      : send(503, { error: "ログインはまだ用意されていません" });
    if (q.url === "/api/me") return q.headers.authorization === "Bearer miru_good" ? send(200, { user: { email: "taro@gmail.com" } }) : send(401, { user: null });
    send(404, {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    s.run(["start", "--owner", "taro@gmail.com"]);
    const run = (args, extra) => new Promise((done) => {   // サーバーと同じプロセスなので、待つ間に答えられるよう非同期で動かす
      import("node:child_process").then(({ execFile }) => execFile(process.execPath, [join(s.src, "tools", "setup.mjs"), ...args],
        { env: { ...process.env, PATH: `${join(s.root, "bin")}${WIN ? ";" : ":"}${process.env.PATH}`, HOME: s.home, USERPROFILE: s.home, MIRU_DIR: s.dir,
          FAKE_LOG: join(s.root, "log.jsonl"), FAKE_STATE: join(s.root, "cf.json"), ...extra } },
        (e, out, err) => done({ code: e ? e.code : 0, out: out + err })));
    });
    let r = await run(["check", "--url", url]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /✓ サイトが動いている/);
    assert.match(r.out, /✗ Google でログインできる[\s\S]*google --client-id/);
    s.run(["google", "--client-id", "123-abc.apps.googleusercontent.com"]);
    google = true;
    mkdirSync(join(s.home, ".config", "miru"), { recursive: true });
    writeFileSync(join(s.home, ".config", "miru", "url"), url + "\n");
    writeFileSync(join(s.home, ".config", "miru", "token"), "miru_good\n");
    r = await run(["check", "--url", url], { FAKE_SECRET: "1" });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /✓ 鍵で入れる（taro@gmail.com）/);
    assert.match(r.out, /通し確認は全部通りました/);
  } finally { server.close(); s.done(); }
});

test("ぶつかったまま update・start をもう一度動かしても、新しい版の変更を消さない（2026-10-25）", { skip: !hasGit && "git が無い" }, () => {
  const s = sandbox();
  try {
    s.run(["start", "--owner", "taro@gmail.com"]);
    writeFileSync(join(s.dir, "worker", "app.ts"), "export const a = 1;\nexport const b = 'mine';\nexport const c = 3;\n");
    writeFileSync(join(s.src, "worker", "app.ts"), "export const a = 1;\nexport const b = 'theirs';\nexport const c = 3;\n");
    writeFileSync(join(s.src, "VERSION.json"), JSON.stringify({ build: 11, date: "2026-10-25", commit: "b", feed: "" }));
    assert.equal(s.run(["update"]).code, 6);
    const deploys = () => s.calls().filter((c) => c.includes("deploy")).length, n = deploys();
    for (const args of [["update"], ["start", "--owner", "taro@gmail.com"], ["deploy"]]) {
      const r = s.run(args);
      assert.equal(r.code, 6, `${args[0]}: ${r.out}`);
      assert.match(r.out, /deploy --resolved/);
    }
    assert.equal(deploys(), n, "公開しない");
    assert.match(readFileSync(join(s.dir, ".miru-upstream", "worker", "app.ts"), "utf8"), /theirs/, "新しい版の写しは残る");
    assert.match(readFileSync(join(s.dir, ".miru-upstream-prev", "worker", "app.ts"), "utf8"), /b = 2/, "前の版の写しも残る");
    assert.match(readFileSync(join(s.dir, "worker", "app.ts"), "utf8"), /mine/, "あなたの直しも残る");
  } finally { s.done(); }
});

test("古い版への入れ替えは止める（--force-older で戻せる）", () => {
  const s = sandbox();
  try {
    s.run(["start", "--owner", "taro@gmail.com"]);
    writeFileSync(join(s.src, "VERSION.json"), JSON.stringify({ build: 9, date: "2026-10-20", commit: "old", feed: "" }));
    const r = s.run(["update"]);
    assert.equal(r.code, 8, r.out);
    assert.match(r.out, /古いです/);
    const again = s.run(["start", "--owner", "taro@gmail.com"]);      // start のやり直しでも黙って戻さない（2026-10-25）
    assert.equal(again.code, 8, again.out);
    assert.equal(JSON.parse(readFileSync(join(s.dir, ".miru-setup.json"), "utf8")).installed.build, 10);
    assert.equal(s.run(["update", "--force-older"]).code, 0);
  } finally { s.done(); }
});

test("やり直しで、自分で上げた Worker・前の版の記録・選んだアカウントを取り違えない（2026-10-25）", () => {
  // Worker を上げたあとで止まった（workers.dev の名前が無い）→ 名前を登録してもう一度: 7 にしない
  const s = sandbox();
  try {
    assert.equal(s.run(["start", "--owner", "taro@gmail.com"], { FAKE_MODE: "no-subdomain" }).code, 3);
    const r = s.run(["start", "--owner", "taro@gmail.com"]);
    assert.equal(r.code, 0, r.out);
  } finally { s.done(); }
  // created を持たない前の版の記録（途中で止まったもの）: もう作ってある R2 を自分のものとして続ける
  const l = sandbox();
  try {
    l.run(["start", "--owner", "taro@gmail.com"], { FAKE_MODE: "no-subdomain" });
    const f = join(l.dir, ".miru-setup.json"), st = JSON.parse(readFileSync(f, "utf8"));
    delete st.created; writeFileSync(f, JSON.stringify(st));
    const r = l.run(["start", "--owner", "taro@gmail.com"]);
    assert.equal(r.code, 0, r.out);
  } finally { l.done(); }
  // 公開の前に --name で名前を変えても、選んだアカウントは残る
  const a = sandbox();
  try {
    mkdirSync(a.dir, { recursive: true });
    writeFileSync(join(a.dir, ".miru-setup.json"), JSON.stringify({ made_by: "miru-setup", name: "miru", owner: "taro@gmail.com", account: "aaa", database_id: "11111111-2222-3333-4444-000000000000", created: { d1: true } }));
    const r = a.run(["start", "--owner", "taro@gmail.com", "--name", "miru2"], { FAKE_MODE: "multi-account" });
    assert.equal(r.code, 0, r.out);
    assert.equal(JSON.parse(readFileSync(join(a.dir, ".miru-setup.json"), "utf8")).account, "aaa");
    assert.match(readFileSync(join(a.dir, "wrangler.jsonc"), "utf8"), /"account_id": "aaa"/);
  } finally { a.done(); }
});

test("前からある別の R2・Worker は、もう一度動かしても --reuse が無ければ使わない。公開の前なら --name で名前を変えられる", () => {
  const s = sandbox();
  try {
    writeFileSync(join(s.root, "cf.json"), JSON.stringify({ d1: [], r2: ["miru-media"], workers: [] }));
    assert.equal(s.run(["start", "--owner", "taro@gmail.com"]).code, 7);
    assert.equal(s.run(["start", "--owner", "taro@gmail.com"]).code, 7, "2 回目も使わない");
    const r = s.run(["start", "--owner", "taro@gmail.com", "--name", "miru2"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /作り直します/);
  } finally { s.done(); }
  const w = sandbox();
  try {
    writeFileSync(join(w.root, "cf.json"), JSON.stringify({ d1: [], r2: [], workers: ["miru"] }));
    const x = w.run(["start", "--owner", "taro@gmail.com"]);
    assert.equal(x.code, 7, x.out);
    assert.match(x.out, /Worker/);
    assert.equal(w.run(["start", "--owner", "taro@gmail.com", "--reuse"]).code, 0);
  } finally { w.done(); }
});

test("写しの無い場所に違うファイルがあると、update は止まる（--force で控えてから入れ替える）", () => {
  const s = sandbox();
  try {
    s.run(["start", "--owner", "taro@gmail.com"]);
    rmSync(join(s.dir, ".miru-upstream"), { recursive: true, force: true });
    writeFileSync(join(s.dir, "worker", "app.ts"), "export const mine = 1;\n");
    const r = s.run(["update"]);
    assert.equal(r.code, 6, r.out);
    assert.match(r.out, /worker\/app\.ts/);
    assert.equal(readFileSync(join(s.dir, "worker", "app.ts"), "utf8"), "export const mine = 1;\n", "まだ何も変えない");
    assert.equal(s.run(["update", "--force"]).code, 0);
    const kept = readdirSync(join(s.dir, "backups")).find((f) => f.startsWith("files-"));
    assert.ok(kept && existsSync(join(s.dir, "backups", kept, "worker", "app.ts")), "控えてから入れ替え");
  } finally { s.done(); }
});

test("表を足すときだけ控えを取る。案内のコマンドはどこからでも通る形", () => {
  const s = sandbox();
  try {
    const st = s.run(["start", "--owner", "taro@gmail.com"]);
    assert.ok(st.out.includes(`node "${join(s.dir, "tools", "setup.mjs")}" google --client-id`), st.out);
    const count = () => (existsSync(join(s.dir, "backups")) ? readdirSync(join(s.dir, "backups")).filter((f) => f.endsWith(".sql")).length : 0);
    const before = count();
    assert.equal(s.run(["deploy"], { FAKE_PENDING: "0" }).code, 0);
    assert.equal(count(), before, "足す表が無ければ控えない");
    assert.equal(s.run(["deploy"]).code, 0);
    assert.equal(count(), before + 1, "足す表があれば控える");
  } finally { s.done(); }
});
