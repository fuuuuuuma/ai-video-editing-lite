---
name: miru-setup
description: 動画の確認サイト MIRU を、利用者自身の Cloudflare アカウントに立てる・つなぐ・新しい版にする。「MIRU を立てて」「MIRU をセットアップして」「自分の MIRU を作りたい」「MIRU を Claude Code / Codex とつないで」「MIRU を新しい版にして」で使う。Claude Code は /ai-video-editing-lite:miru-setup、Codex は $miru-setup。
---

# MIRU を自分の Cloudflare に立てる

MIRU は、AI動画編集 lite が作った動画のプレビューを見て修正指示を書く確認サイト。**利用者が自分の Cloudflare に自分専用の MIRU を立てる**（動画も指示も利用者の Cloudflare の中だけ。チャンネルを作れるのは本人だけ、見られるのは本人が招待した人だけ）。
利用者向けの詳しい手順は [../../miru/SETUP.md](../../miru/SETUP.md)。道具は `../../miru/tools/setup.mjs`（このスキルのフォルダから 2 つ上の `miru/`。以下 `SETUP=<その絶対パス>`）。

## 守ること

1. **利用者の Cloudflare に作るので、始める前に一度確かめる。** 「あなたの Cloudflare アカウントに MIRU（Workers・D1・R2）を作ります。無料の範囲で使え、R2 に 10GB を超えて置くと超えた分が Cloudflare から請求されます」と伝え、はいをもらってから start を動かす。
2. **秘密の値を受け取らない。** Google のクライアント シークレットと MIRU の鍵（miru_…）は、利用者が自分のターミナルに貼る。チャットに貼られたら使わず、「ターミナルで入れてください。貼った値は Google Cloud（鍵なら MIRU の設定）で作り直してください」と伝える。クライアント ID は公開してよい値なので受け取ってよい。
3. **ブラウザでの許可・ダッシュボードの操作は利用者がする。** Cloudflare のログイン許可、R2 の有効化、Google Cloud の設定。
4. 確かめたことと、まだのことを分けて書く（例: 公開は済み・ログインはまだ利用者が試していない）。

## 手順

0. いまの様子: `node $SETUP status`。`~/.config/miru/url` があり、`curl -s <url>/api/health` が `{"ok":true…}` なら、もう立っている → 5 へ。
1. Node.js 20 以上を確かめる（`node -v`）。無ければ https://nodejs.org から入れてもらう。
2. 利用者に、MIRU にログインする Google アカウントのメールを聞く（`--owner`）。上の 1 の確認をとる。
3. `node $SETUP start --owner <メール>` を動かす（数分。`~/MIRU` に写して npm install → Cloudflare のログイン → D1 → R2 → 表 → 公開）。
   - ブラウザが開いたら「Allow」を押してもらう。
   - 終わりのコードが **2**（「R2 がまだ使える状態になっていません」）: 利用者に Cloudflare のダッシュボードで R2 を有効にしてもらい（支払い方法の登録を求められることがある）、同じコマンドをもう一度。作ったものはそのまま続きから進む。
   - workers.dev の名前（サブドメイン）を求められて止まったら: 利用者にダッシュボードの「Workers & Pages」を一度開いて名前を登録してもらうか、利用者のターミナルで同じコマンドを動かしてもらう。
   - 最後に出る URL と、Google に入れる 2 行（JavaScript 生成元・リダイレクト URI）を利用者に見せる。
4. Google でログインできるようにする（SETUP.md の「2.」を利用者と一緒に進める）:
   - Google Cloud でプロジェクト → Google Auth Platform（対象は外部）→ クライアント（ウェブ アプリケーション）に 3 で出た 2 行を入れる → **「対象」で「アプリを公開」（本番環境）**。
   - クライアント ID をもらって `node $SETUP google --client-id <ID>`。
   - シークレットは利用者が自分のターミナルで: `cd ~/MIRU && npx wrangler secret put GOOGLE_CLIENT_SECRET`（Windows は `cd $HOME\MIRU`）。入れたら `node $SETUP status` で「シークレット: 入っています」を確かめる。
5. つなぐ: 利用者が自分の MIRU を開いて `--owner` のアカウントでログイン →「設定 → Claude Code・Codex とつなぐ」→「鍵を作る」→ 画面のコマンドを自分のターミナルに貼る。
   - Claude Code: 1 行目（`claude mcp add …`）。
   - Codex: 「Mac 用をコピー」か「Windows 用をコピー」（`~/.codex/config.toml` に `[mcp_servers.miru]` を足す）。Codex を開き直すとつながる。
   - プレビューを上げる道具: 「鍵だけコピー」→ 画面のコマンド（`~/.config/miru/token` と `~/.config/miru/url` を置く）。
   - 確かめる: MCP の list_channels が答える、または `~/.config/miru/url` が自分の MIRU を指していること。
6. 最初のチャンネルは、AI動画編集 lite が初めて上げるときに自動で作る（自分で作るなら「設定 → チャンネルを作る」）。人に見せるときは「設定 → チャンネル → 招待する」→「招待した人に送る案内をコピー」を相手に送ってもらう（MIRU はメールを送らない）。

## 新しい版にする

AI動画編集 lite を更新したら `node $SETUP update`（新しい `miru/` を `~/MIRU` に写し、表を足して公開し直す。設定とデータはそのまま）。

## 困ったとき

SETUP.md の「困ったとき」の表を見る。よくあるもの:
- 「ログインはまだ用意されていません」→ 4 がまだ（クライアント ID かシークレット）。
- Google で redirect_uri_mismatch → リダイレクト URI が `<URL>/auth/callback` と一字一句同じか。
- 「アクセスをブロック」→ Google Auth Platform の「対象」でアプリを公開していない。
- ログインできたのにチャンネルを作れない → ログインしたアカウントが `--owner` と違う。`start --owner <正しいメール>` をもう一度。

Vercel など Cloudflare 以外には立てない（動画の通信料と処理時間の上限のため。SETUP.md の最後）。
