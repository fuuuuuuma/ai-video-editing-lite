---
name: miru-setup
description: 動画の確認サイト MIRU ライトを、利用者自身の Cloudflare アカウントに立てる・確かめる・つなぐ・新しい版にする・自分用に直す。「MIRU を立てて」「MIRU をセットアップして」「自分の MIRU を作りたい」「MIRU を確かめて」「MIRU にログインできない」「MIRU を Claude Code / Codex とつないで」「MIRU を新しい版にして」「AI動画編集 lite と MIRU を新しい版にして」「MIRU の〇〇を直して」「MIRU の容量の上限を上げて」「MIRU の控えを取って」で使う。Claude Code は /ai-video-editing-lite:miru-setup、Codex は $miru-setup。
---

# MIRU ライトを自分の Cloudflare に立てる

MIRU ライトは、AI動画編集 lite が作った動画のプレビューを見て修正指示を書く確認サイト。**利用者が自分の Cloudflare に自分専用の MIRU を立てる**（動画も指示も利用者の Cloudflare の中だけ。チャンネルを作れるのは本人だけ、入れるのは本人が招待した人だけ）。
利用者向けの手順は [../../miru/SETUP.md](../../miru/SETUP.md)、画面で見る導入ガイドは https://fuuuuuuma.github.io/ai-video-editing-lite/ 。
道具は `../../miru/tools/setup.mjs`（このスキルのフォルダーから 2 つ上の `miru/`。以下 `SETUP=<その絶対パス>`）。立てると中身が `~/MIRU`（Windows は `%USERPROFILE%\MIRU`）に写り、そこから公開される。

## 守ること

1. **利用者の Cloudflare に作るので、始める前に一度確かめる。** 「あなたの Cloudflare アカウントに MIRU（Workers・D1・R2）を作ります。無料の範囲で使え、置いた量が 9GB になると止まるので請求は来ません（上限は後で変えられます）」と伝え、はいをもらってから start を動かす。
2. **秘密の値を受け取らない。** Google のクライアント シークレット（`GOCSPX-…`）と MIRU の鍵（`miru_…`）は、利用者が自分のターミナルに貼る。チャットに貼られたら使わず、「ターミナルで入れてください。貼った値は Google Cloud（鍵なら MIRU の設定）で作り直してください」と伝える。クライアント ID は公開してよい値なので受け取ってよい。
3. **ブラウザでの許可・ダッシュボードの操作・アカウント作りは利用者がする。** Cloudflare のアカウント作成とメールの確認、ログイン許可、R2 の有効化、workers.dev の名前の登録、Google Cloud の設定。
4. **消す・上限を外すは確かめてから。** Cloudflare の MIRU を消す、容量の上限を 10GB より上にする（請求が来る）ときは、利用者のはいをもらう。
5. 確かめたことと、まだのことを分けて書く（例: 公開は済み・ログインはまだ利用者が試していない）。

## 立てる

0. いまの様子: `node $SETUP status`。立っていれば（URL があり、`node $SETUP check` が通る）→「つなぐ」へ。
1. Node.js 22.12 以上を確かめる（`node -v`。v20 では wrangler が動かない）。古ければ https://nodejs.org の LTS を入れてもらい、ターミナルを開き直す。
2. 利用者に、MIRU にログインする Google アカウントのメールを聞く（`--owner`）。上の 1 の確認をとる。
3. `node $SETUP start --owner <メール>` を動かす（数分。`~/MIRU` に写して npm install → Cloudflare のログイン → D1 → R2 → 表 → 公開）。ブラウザが開いたら「Allow」を押してもらう。
   止まったら、終わりのコードで決まった案内が出ている。利用者にしてもらい、**同じコマンドをもう一度**（作ったものはそのまま続きから進む）:
   - **2** R2 が無効 → ダッシュボードの「R2 オブジェクト ストレージ」で有効にしてもらう（支払い方法の登録を求められることがある。10GB までは請求されない）。
   - **3** workers.dev の名前が無い → 出たリンク（`…/workers/onboarding`）で英字の名前を登録してもらう。
   - **4** アカウントが複数 → 出た一覧から使うものを聞き、`--account <ID>` を付けて動かす。
   - **5** Cloudflare のメールの確認がまだ → 届いたメールのリンクを押してもらう。
   - **7** 同じ名前の D1・R2 が前からある → 前に立てた MIRU なら `--reuse`、別に立てるなら `--name 別の名前`。
   最後に出る URL と、Google に入れる 2 行（JavaScript 生成元・リダイレクト URI）を利用者に見せる。
4. Google でログインできるようにする（SETUP.md の「2.」を利用者と一緒に進める）:
   - Google Cloud でプロジェクト → Google Auth Platform（対象は外部）→ クライアント（ウェブ アプリケーション）に 3 で出た 2 行を入れる → **「対象」で「アプリを公開」（本番環境）**。
   - クライアント ID をもらって `node $SETUP google --client-id <ID>`。
   - シークレットは利用者が自分のターミナルで: `cd ~/MIRU && npx wrangler secret put GOOGLE_CLIENT_SECRET`（Windows の PowerShell は `cd $HOME\MIRU` のあと `npx.cmd wrangler secret put GOOGLE_CLIENT_SECRET`）。
5. **通し確認**: `node $SETUP check`。✗ の行の「→」のとおりに直し、全部 ✓（− は任意）になるまでくり返す。利用者に自分の MIRU を開いて `--owner` のアカウントでログインしてもらう。

## つなぐ

利用者が自分の MIRU を開いてログイン →「設定 → Claude Code・Codex とつなぐ」→「鍵を作る」→ 画面のコマンドを自分のターミナルに貼る。
- Claude Code: 「コマンドをコピー」（`claude mcp add -s user …`。どのフォルダーからでも使える）。前に miru をつないでいたら、先に `claude mcp remove -s user miru`。0.2.2 までの画面のコマンドでつないでいたら、そのとき開いていたフォルダーで `claude mcp remove -s local miru` も（そのフォルダーだけの古い鍵が先に使われる）。
- Codex: 「Mac 用をコピー」か「Windows 用をコピー」（`~/.codex/config.toml` の `[mcp_servers.miru]` を置き換える）。Codex を開き直すとつながる。
- 動画を上げる道具: 「上げる道具用をコピー（Mac）」か「（Windows）」（`~/.config/miru/token` と `~/.config/miru/url` を置く。鍵はコマンドに入っている）。
- この鍵（作業用）では、消す・招待する・鍵を作ることはできない（403「この鍵ではできません」）。上げ終わった版を同じ名前で上げ直すこともできない（409。別の版の名前で上げる）。頼まれたら、利用者に MIRU の画面でしてもらう。
- 確かめる: `node $SETUP check` の「鍵で入れる」が ✓、または lite の `miru_sync.py version` が `reachable: true`。

最初のチャンネルは、AI動画編集 lite が初めて上げるときに自動で作る。人に見せるときは「設定 → チャンネル → 招待する」→「招待した人に送る案内をコピー」を相手に送ってもらう（MIRU はメールを送らない）。

## 新しい版にする

「AI動画編集 lite と MIRU を新しい版にして」「MIRU を新しい版にして」と言われたら（MIRU の設定の画面や `miru_sync.py publish` が「新しい版があります」と言ったときも）:
1. lite を更新する（利用者のターミナルで動かしてもらうか、了承を得て動かす）:
   - Claude Code: `claude plugin marketplace update ai-video-editing-lite` のあと `claude plugin update ai-video-editing-lite@ai-video-editing-lite`
   - Codex: `codex plugin marketplace upgrade ai-video-editing-lite` のあと `codex plugin add ai-video-editing-lite@ai-video-editing-lite`
   （Windows の PowerShell 5.1 は `&&` を使えないので、1 行ずつ動かす）
2. **新しい** lite の `miru/tools/setup.mjs` で `node <新しい SETUP> update`（更新は次のチャットから効くので、いまのチャットでは新しいプラグインの場所を探して使う。`~/MIRU/tools/setup.mjs` からは update できない）。表を足すときは、その前に D1 の控えを `~/MIRU/backups/` に取る（取れなければ止まる。控えなしで進めるのは利用者が了承したときだけ `--no-backup`）。終わりのコード **8** は、入れようとしている MIRU が今より古い（Claude Code と Codex で lite の版が違う）。新しい方の lite から動かす。
3. 終わりのコード **6** で「入れた版の写し（.miru-upstream）が無い」と出たら、ぶつかったのではなく前の版の道具で立てた MIRU（まだ何も変えていない）。利用者に自分で直した所があるかを聞き、無ければ `--force` を付けて update をもう一度（違うファイルは `~/MIRU/backups/` に控えてから入れ替わる）。あれば、入れ替えたあとに控えを見て入れ直す。
   それ以外の **6**（ぶつかった）なら、出た各ファイルで `~/MIRU/.miru-upstream-prev/<f>`（前の版）→ `~/MIRU/.miru-upstream/<f>`（新しい版）の違いを読み、それを `~/MIRU/<f>`（利用者が直したもの）に入れる。利用者が直した所は消さない。終わったら `node $SETUP deploy --resolved`。直し終えるまで update・start・deploy は 6 で止まる（新しい版の変更が消えないように）。
4. `node $SETUP check` で「公開されている版」が新しい番号になったことを確かめる。

## 自分用に直す（利用者の MIRU だけが変わる）

「MIRU の〇〇を直して」と言われたら:
1. `~/MIRU` のファイルを直す（**プラグインの中の `miru/` は直さない**。lite の更新で入れ替わる）。置き場所は `~/MIRU/README.md` の表（画面 `src/main.ts`、確認画面 `review.html`・`src/review/`、サーバー `worker/`、表 `migrations/`）。
   - `wrangler.jsonc` は手で直さない（`setup.mjs` が作り直す）。設定は `setup.mjs` のオプションで。
   - 表を変えるときは `migrations/` に新しい番号のファイルを足す（前のファイルは書き換えない）。
   - 秘密の値はファイルに書かない。
2. 手元で見たいとき: `cd ~/MIRU && npx wrangler d1 migrations apply miru --local -c wrangler.dev.jsonc && npm run build && npm run worker`（表を作るのは 1 回目だけ。Windows の PowerShell は `cd $HOME\MIRU` のあと `npx.cmd …`・`npm.cmd run build`・`npm.cmd run worker` を 1 行ずつ）→ http://localhost:8790/auth/dev?email=owner@example.com で仮ログイン（`wrangler.dev.jsonc`、本番には効かない）。
3. `node $SETUP deploy`（型の確認 → 表 → 公開）。型の確認で止まったら直してからもう一度。
4. 直したファイルの一覧は `node $SETUP changes`。新しい版にしても残る（上の「新しい版にする」）。

AI動画編集 lite（編集のスキル）を直したいと言われたら: 作風・続けるルールは lite の記憶（`channel_memory.py rule`・`set-style`）で直す。スキルのしくみを変えたいときは、GitHub で `fuuuuuuma/ai-video-editing-lite` をフォークして直し、フォークから入れる方法を案内する（プラグインの中を直接直すと、更新で消える）。

## 容量・控え・やめる

- 容量: 既定は 9GB で止まる（R2 の無料の 10GB を超えないように）。「上げて」と言われたら、10GB を超えると Cloudflare から請求されること（1GB あたり月数円）を伝えてから `node $SETUP quota --gb <数>`（0 で上限なし）。古い版は MIRU の動画のパネルで左にスワイプして消せる。
- 控え: `node $SETUP backup`（D1 を `~/MIRU/backups/` に。動画は R2 にあり、元は手元の案件フォルダー）。
- やめる: SETUP.md の「やめる」を利用者と進める（消すのは利用者がダッシュボードで。消す前に控え）。

## 困ったとき

まず `node $SETUP check`。よくあるもの（SETUP.md の「困ったとき」の表に全部ある）:
- 「ログインはまだ用意されていません」→ 立てる 4 がまだ（クライアント ID かシークレット）。
- Google で redirect_uri_mismatch → リダイレクト URI が `<URL>/auth/callback` と一字一句同じか（最後に `/` が無いか）。
- 「アクセスをブロック」→ Google Auth Platform の「対象」でアプリを公開していない。
- 「招待されていません」→ ログインしたアカウントが `--owner` と違う。`start --owner <正しいメール>` をもう一度。
- PowerShell で「スクリプトの実行が無効」→ `npx` を `npx.cmd` に。
- 直らなければ、`check` の結果を添えて GitHub の Issues（https://github.com/fuuuuuuma/ai-video-editing-lite/issues）に書いてもらう（シークレットと鍵は貼らない）。

Vercel など Cloudflare 以外には立てない（動画の通信料と処理時間の上限のため。SETUP.md の最後）。
