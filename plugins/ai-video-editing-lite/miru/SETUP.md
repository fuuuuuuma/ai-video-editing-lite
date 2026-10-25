# MIRU ライトを立てる（セットアップガイド）

MIRU ライトは、AI動画編集 lite が作った動画のプレビューを見て、修正指示を書き込むための確認サイトです。
このガイドでは、**あなた自身の Cloudflare アカウントに、あなた専用の MIRU を立てます**。
動画も修正指示も、あなたの Cloudflare の中だけに置かれます。入れるのは、あなたと、あなたが招待した人だけです。

かかる時間はおよそ 20〜30 分です。ほとんどの作業は AI（Claude Code か Codex）が進めます。
あなたがするのは、ブラウザでの「許可」と、Cloudflare・Google の画面での設定、秘密の値の貼り付けだけです。

画面で見ながら進めたいときは、導入ガイド（https://fuuuuuuma.github.io/ai-video-editing-lite/ 。同じものが AI動画編集 lite の `docs/index.html` にあります）を使ってください。スマホでも見られます。

---

## 0. 用意するもの

| もの | 用途 | 費用 |
|---|---|---|
| Cloudflare のアカウント（https://dash.cloudflare.com/sign-up） | MIRU を置く場所。作ったら、届いたメールの確認のリンクを押しておく | 無料の範囲で使えます（下の表） |
| Google アカウント | MIRU にログインする・Google Cloud の設定 | 無料 |
| Node.js 22.12 以上（https://nodejs.org の LTS。20 では途中で止まります） | セットアップの道具を動かす | 無料 |
| Claude Code か Codex（AI動画編集 lite を入れたもの） | 作業を任せる | — |

### 無料で使える範囲（2026 年 10 月時点の Cloudflare の公式の値。変わることがあります）

| 部分 | 無料の範囲 | MIRU での使い方 |
|---|---|---|
| Workers（サイト本体） | 1 日 10 万回のアクセス | 画面と API |
| D1（文字のデータ） | 5GB まで | 招待・修正指示・手直し |
| R2（動画の置き場） | 10GB まで。**見られるたびの通信料はかからない** | プレビューの動画・音・画像 |
| Workers AI | 1 日 1 万ニューロン | 修正指示を読みやすく整える（使えないときは文をそのまま残します） |

30 分の動画で、1 版目がおよそ 1GB、2 版目からは変わった分だけ（数十 MB）増えます。
**MIRU ライトは、置いた量が 9GB になると新しい版を受け付けません**（R2 の無料の 10GB を超えて請求されないように）。古い版は MIRU の画面で消せます。
超えた分を払ってよいなら、AI に「MIRU の容量の上限を 30GB にして」などと頼みます（`node ~/MIRU/tools/setup.mjs quota --gb 30`。R2 は 10GB を超えた分が 1GB あたり月数円）。
最新の値は https://developers.cloudflare.com/r2/pricing/ と https://developers.cloudflare.com/workers/platform/pricing/ で確かめてください。

---

## 1. AI に頼む

**Claude Code** なら `/ai-video-editing-lite:miru-setup`、**Codex** なら `$miru-setup` と送ってください。
AI があなたのメールアドレス（MIRU にログインする Google アカウント）を聞いてから、次のコマンドを動かします。

```bash
node <MIRU の場所>/tools/setup.mjs start --owner あなたのメール@gmail.com
```

`<MIRU の場所>` は、AI動画編集 lite のプラグインの中の `miru` フォルダーです（AI が探します）。立てた MIRU はホームの `MIRU` フォルダー（Mac は `~/MIRU`、Windows は `C:\Users\あなた\MIRU`）に作られ、このあとのコマンドはそこから動かします。
このガイドのコマンドは Mac の書き方です。Windows の PowerShell では `~/MIRU/tools/setup.mjs` を `$HOME\MIRU\tools\setup.mjs` に、`npx` を `npx.cmd` に読み替え、`&&` でつながった行は 2 行に分けて動かします。

### 途中であなたがすること

1. **Cloudflare の許可**: ブラウザが開いて Cloudflare のログインと「Allow（許可）」の画面が出ます。許可してください。
2. **R2 を有効にする**（初めて R2 を使うときだけ）: 「R2 がまだ使える状態になっていません」と出たら、
   Cloudflare のダッシュボード（https://dash.cloudflare.com/）の左の「R2 オブジェクト ストレージ」を開き、案内に沿って有効にします。
   支払い方法の登録を求められることがあります（無料の範囲の中なら請求はありません）。終わったら AI に「有効にした」と伝えると、同じコマンドを続きから動かします。
3. **workers.dev の名前**（初めて Workers を使うときだけ）: 「サイトのアドレスの一部になる名前がまだ決まっていません」と出たら、
   一緒に出るリンク（`https://dash.cloudflare.com/…/workers/onboarding`）を開き、好きな英字の名前（例 `taro-videos`）を登録します。終わったら同じコマンドを続きから動かします。

終わると、こう出ます。

```text
✓ MIRU を公開しました: https://miru.あなたの名前.workers.dev
```

この時点では、まだログインできません（「ログインはまだ用意されていません」と出ます）。次の Google の設定で使えるようになります。

---

## 2. Google でログインできるようにする

MIRU は Google アカウントでログインします。そのための「鍵」を、あなたの Google Cloud で 1 回だけ作ります。

1. https://console.cloud.google.com/ を開き、上の「プロジェクトを選択」→「新しいプロジェクト」。名前は `MIRU` などで作ります。
2. 左の「Google Auth Platform」（または「API とサービス」→「OAuth 同意画面」）を開き、「開始」。
   - アプリ名: `MIRU`（ログインの画面に出ます）
   - ユーザー サポートメール・連絡先: あなたのメール
   - 対象: **外部**
3. 「クライアント」→「クライアントを作成」。
   - アプリケーションの種類: **ウェブ アプリケーション**
   - 承認済みの JavaScript 生成元: `https://miru.あなたの名前.workers.dev`
   - 承認済みのリダイレクト URI: `https://miru.あなたの名前.workers.dev/auth/callback`

   （セットアップの道具が最後に出した 2 行を、そのまま貼れば合っています。最後に `/` を付けない）
4. 作ると「クライアント ID」と「クライアント シークレット」が出ます。
5. 「対象」の画面で「アプリを公開」を押し、**本番環境**にします。
   テストのままだと、「テストユーザー」に入れた人しかログインできません。
   MIRU はメールアドレス・名前・写真だけを使うので、Google の審査はいりません。

### クライアント ID を AI に渡す

クライアント ID（`…apps.googleusercontent.com`）を AI に伝えると、次を動かします。

```bash
node ~/MIRU/tools/setup.mjs google --client-id 123456-xxxx.apps.googleusercontent.com
```

### シークレットは自分で入れる

**クライアント シークレット（`GOCSPX-` で始まる値）は AI に渡さないでください。** 自分のターミナルで次を動かし、聞かれたらシークレットを貼って Enter を押します（画面には出ません）。

```bash
cd ~/MIRU
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Windows の PowerShell なら `cd $HOME\MIRU` のあとに `npx.cmd wrangler secret put GOOGLE_CLIENT_SECRET` です（`npx` だと「スクリプトの実行が無効」と止まることがあります）。
もしチャットに貼ってしまったら、Google Cloud のクライアントの画面でシークレットを作り直し、新しい方を入れてください。

これで完成です。`https://miru.あなたの名前.workers.dev` を開き、`--owner` に入れたメールの Google アカウントでログインしてください。

---

## 3. 確かめる（通し確認）

AI に「MIRU を確かめて」と頼むか、次を動かします。サイト・版・Google の設定・シークレット・この PC とのつながりを 1 つずつ確かめ、直す所があれば「→」で何をすればよいかを言います。

```bash
node ~/MIRU/tools/setup.mjs check
```

---

## 4. 使い始める

### Claude Code・Codex とつなぐ

「設定」→「Claude Code・Codex とつなぐ」→「鍵を作る」。出てきたコマンドを貼ります。

- **Claude Code**: 「コマンドをコピー」を押して、ターミナルに貼ります（どのフォルダーから開いても使えます）。前に miru をつないでいたら、先に `claude mcp remove -s user miru` を動かします。0.2.2 までの画面のコマンドでつないでいたら、そのとき開いていたフォルダーで `claude mcp remove -s local miru` も動かします（そのフォルダーだけの古い鍵が先に使われるため）。
- **Codex**: 「Mac 用をコピー」（Windows は「Windows 用をコピー」）を押して、ターミナル（PowerShell）に貼ります。前の miru の設定は置き換わります。Codex を開き直すとつながります。
- **動画を上げる道具（miru_sync.py）**: 「上げる道具用をコピー（Mac）」（Windows は「（Windows）」）を押して、ターミナル（PowerShell）に貼ります。
  鍵（`~/.config/miru/token`）と、あなたの MIRU の場所（`~/.config/miru/url`）が置かれます。

鍵は 1 年で切れます。切れたら同じ画面で作り直してください。
この鍵（作業用）では、消す・招待する・鍵を作ることはできません（ファイルに置く鍵が漏れても困らないように）。それらは MIRU の画面でします。
上げ終わった版は、同じ名前で上げ直せません。直した版は `v3-2` のように別の名前で上げます（前の版を消すときは MIRU の画面で）。

### チャンネルと招待

最初のチャンネルは、AI動画編集 lite が初めて動画を上げるときに自動で作ります（自分で作るなら「設定」→「チャンネルを作る」）。チャンネルを作れるのは `--owner` に入れたあなただけです。

人に見せるときは「設定」→ チャンネル → 招待するメールアドレスと役割（管理者・指示できる・見るだけ）→「招待する」。
MIRU からはメールが送られないので、「招待した人に送る案内をコピー」を押して、LINE やメールで相手に送ってください。
相手は、そのメールアドレスの Google アカウントでログインすると、チャンネルが見えます。招待していない人は、ログインしても入れません。

### 通知と承認

- **通知**: 「設定」→ チャンネル →「通知」に、Slack の Incoming Webhook（https://hooks.slack.com/services/…）か、Discord のウェブフック（チャンネルの設定 →「連携サービス」→「ウェブフック」）の URL を入れて「保存」→「試しに送る」。新しい版・修正指示・返事・承認が、そこに届きます。決められるのは管理者だけです。知らせには、チャンネル名・動画の題名・版の名前・指示と返事の文（一部）と時間の位置・書いた人や承認した人の名前・あなたの MIRU へのリンクが入ります（メールアドレスは入りません）。
  通知の URL は鍵と同じように扱ってください（知っている人は誰でもそこへ書き込めます）。人や AI のチャットに貼らないでください。`backup` の控えにも入ります。
- **承認**: 見る人が、動画のパネルで「v3 でOK（承認する）」を押すと、誰がいつ承認したかが残り、動画は「完了」になります（取り消すと「確認待ち」に戻ります）。押せるのは「指示できる」人と管理者です。AI動画編集 lite は、承認された版を見つけると、完成版を書き出すかを聞きます。

---

## 5. 自分用に直す

MIRU ライトはあなたの Cloudflare で動くあなたのものなので、好きに直せます。AI に「MIRU の〇〇を直して」と頼むと、`~/MIRU` を直して `node ~/MIRU/tools/setup.mjs deploy` で公開し直します（型の確認で止まったら公開しません）。
直したファイルは `node ~/MIRU/tools/setup.mjs changes` で見られます。**新しい版にしても、直した所は残ります**（くわしくは `~/MIRU/README.md` の「自分用に直す」）。

AI動画編集 lite（編集のスキル）を自分用に直したいときは:
- 作風（字幕・強調の見た目・カットの詰め方・続けるルール）は、AI に言えば覚え直します（「強調は 1 分に 1 個まで」など）。これは `~/.ai-video-editing-lite/` に残り、lite を更新しても消えません。
- スキルのしくみそのものを変えたいときは、GitHub で `fuuuuuuma/ai-video-editing-lite` を自分のアカウントにフォーク（Fork）して直し、そこから入れます（`claude plugin marketplace add あなた/ai-video-editing-lite`）。元の新しい版は、GitHub の「Sync fork」で取り込めます。

---

## 6. 新しい版にする

MIRU の「設定」→「この MIRU」に、新しい版があると出ます。AI に「AI動画編集 lite と MIRU を新しい版にして」と頼むと、lite を更新してから次を動かします。データと設定はそのままです。表（データベース）を足すときは、その前に文字のデータの控えを `~/MIRU/backups/` に取ります（取れなければ止まります）。lite が今入っている MIRU より古いときは、入れ替えずに止まります。

```bash
node <新しい MIRU の場所>/tools/setup.mjs update
```

自分で直した所と新しい版が同じ所を変えていたときだけ、公開せずに止まり、どのファイルかを言います。AI が両方の変更を入れてから `node ~/MIRU/tools/setup.mjs deploy --resolved` で続けます。

いまの様子（URL・版・Google の設定・シークレットの有無・直したファイルの数）は `node ~/MIRU/tools/setup.mjs status` で見られます。

---

## 困ったとき

まず `node ~/MIRU/tools/setup.mjs check` を動かし、出た「→」のとおりにします。よくあるもの:

| 出たこと | すること |
|---|---|
| 「R2 がまだ使える状態になっていません」 | ダッシュボードの「R2 オブジェクト ストレージ」で有効にしてから、同じコマンドをもう一度（作ったものはそのまま続きから） |
| 「サイトのアドレスの一部になる名前がまだ決まっていません」 | 出たリンク（…/workers/onboarding）で workers.dev の名前を登録してから、同じコマンドをもう一度 |
| 「Cloudflare のアカウントが複数あります」 | 出た一覧から使う ID を選び、`--account <ID>` を付けて同じコマンドをもう一度 |
| 「Cloudflare のメールアドレスの確認がまだです」 | Cloudflare から届いたメールの確認のリンクを押してから、同じコマンドをもう一度 |
| 「もう〜があります（この道具が作ったものではありません）」 | 前に立てた MIRU の D1・R2・Worker を使い直すなら `--reuse`、別に立てるなら `--name 別の名前`（公開の前なら名前を変えてやり直せます） |
| 「Node.js 22.12 以上が要ります」 | https://nodejs.org から LTS を入れ、ターミナルを開き直してから、同じコマンドをもう一度 |
| 「入れようとしている MIRU は、いま入っているものより古いです」 | AI動画編集 lite を新しくしてから update します（Claude Code と Codex で lite を別々に入れているときに起こります） |
| 「前の update でぶつかったファイルがまだあります」 | ぶつかったファイルに新しい版の変更を入れてから `deploy --resolved`（AI に頼めます）。直し終えるまで update はできません |
| 「入れた版の写し（.miru-upstream）が無いので…見分けられません」 | 前の版の道具で立てた MIRU です。自分で直した所が無ければ、`update --force` でもう一度（違うファイルは `~/MIRU/backups/` に控えてから入れ替えます）。直した所があれば、入れ替えたあとに AI に入れ直してもらいます |
| 「表を足す前の控えを取れませんでした」 | 通信を確かめて、同じコマンドをもう一度（公開はしていません）。控えなしで進めるなら `--no-backup` |
| 「〜はもう上げ終わっています」 | 上げ終わった版は同じ名前で上げ直せません。別の版の名前（`v3-2` など）で上げます |
| Codex が `config.toml` を読めないと言う | 10/25 より前の画面の Codex 用コマンドを 2 回貼ると、設定が壊れることがありました。`~/.codex/config.toml` を開き、行の途中から始まる `[`（`"gpt-5"[projects."…"]` のような所）の前で改行してから、新しいコマンドを貼り直します |
| Claude Code が前の鍵のまま（「鍵が違う」と出る） | 0.2.2 までの画面のコマンドでつないだフォルダーで `claude mcp remove -s local miru` を動かします |
| 「ログインはまだ用意されていません」 | 「2. Google でログインできるようにする」がまだです。クライアント ID とシークレットを入れてください |
| Google の画面で「redirect_uri_mismatch」 | Google Cloud のクライアントの「リダイレクト URI」が `https://…workers.dev/auth/callback` と一字一句同じか（最後に `/` が無いか）確かめます |
| Google の画面で「アクセスをブロック」・「このアプリは Google で確認されていません」 | 「対象」で「アプリを公開」して本番環境にします（テストのままだとテストユーザーしか入れません） |
| 「招待されていません」と出て入れない | `--owner` に入れたメールと、ログインしたアカウントが違います。`node ~/MIRU/tools/setup.mjs status` で持ち主を確かめ、違えば `start --owner 正しいメール` を動かし直します |
| 招待した人が入れない | 相手が、招待したメールアドレスの Google アカウントでログインしているか確かめます。Gmail は点の有無が違っても同じ人として入れます |
| 「容量の上限（9.0GB）を超えます」 | 古い版を消して空けます。超えた分を払ってよいなら `node ~/MIRU/tools/setup.mjs quota --gb 30` など |
| PowerShell で「このシステムではスクリプトの実行が無効」 | `npx` の代わりに `npx.cmd` を使います（`npx.cmd wrangler secret put GOOGLE_CLIENT_SECRET`） |
| 修正指示の「AI で整える」が働かない | Workers AI の無料の範囲を超えたか、使っている AI のモデルが有料プラン向けです。文はそのまま残るので、修正には困りません |
| 通知の URL で「Slack か Discord の Incoming Webhook の URL を…」と出る | Slack は `https://hooks.slack.com/services/…`、Discord は `https://discord.com/api/webhooks/…` の形だけを受け付けます（ほかの宛先へは送りません）。作り直した URL をそのまま貼ります |
| 「試しに送る」を押しても届かない | URL を作り直したか、Slack・Discord の側でウェブフックを消していないかを確かめ、新しい URL を「保存」し直します。届かなくても、MIRU のほかの操作は止まりません |

直らないときは、GitHub の Issues（https://github.com/fuuuuuuma/ai-video-editing-lite/issues）に、`node ~/MIRU/tools/setup.mjs check` の結果と、何をしたら何が出たかを書いてください。**シークレットや鍵（`GOCSPX-`・`miru_` で始まる値）と、通知の URL（`hooks.slack.com/services/…`・`discord.com/api/webhooks/…`）は貼らないでください。**

## やめる

1. 控えを取る: `node ~/MIRU/tools/setup.mjs backup`（文字のデータ。動画は手元の案件フォルダーに元があります）
2. Cloudflare のダッシュボードで、Workers & Pages の `miru`、D1 の `miru`、R2 の `miru-media` を消します。
   R2 は中が空でないと消せません。ファイルが多いときは、バケットの「設定」→「オブジェクトのライフサイクル ルール」で 1 日で消すルールを足し、翌日に消します。
3. Google Cloud の MIRU のプロジェクトを消し、`~/MIRU` と `~/.config/miru` を消します。

## Vercel などでは立てられますか

MIRU は Cloudflare の Workers・D1・R2 の上で作っています。Vercel でも同じことはできますが、
動画を見られるたびに通信料がかかること（R2 はかかりません）と、1 回の処理の時間に上限があり大きな動画を上げにくいことから、
**Cloudflare をおすすめしています**。いまは Cloudflare のための道具だけを用意しています。

## しくみ（気になる人へ）

- サイト本体は Cloudflare Workers、文字のデータは D1、動画は R2 に置きます。ログインは Google（OAuth 2.0 の認可コード＋PKCE）です。
- ログインの印と鍵は、そのままではなく SHA-256 にして置きます。Google のシークレットは Cloudflare の中だけにあり、このパソコンのファイルには残りません。
- 毎日 1 回（日本時間 4:17）、期限切れのログインと鍵、上げ終わらなかった版、招待を全部外された人の記録を掃除します。
- 「指示できる」人が書いた文字は、画面に出すときに文字として扱います（スクリプトとして動かない）。手直しの形もサーバーで確かめます。
