# MIRU ライト

AI動画編集 lite が作った動画を見て、修正指示を書き込む確認サイトです。**あなた自身の Cloudflare に、あなた専用の MIRU を立てて使います**。

- 立て方: [SETUP.md](SETUP.md)（AI に Claude Code は `/ai-video-editing-lite:miru-setup`、Codex は `$miru-setup` と送ると進めます）
- 困ったら: `node tools/setup.mjs check`（通し確認。直す所を 1 つずつ言います）

このフォルダーは「配られた元」です。立てると、中身が `~/MIRU`（Windows は `C:\Users\あなた\MIRU`）に写され、そこから公開されます。

## 自分用に直す

MIRU はあなたの Cloudflare で動くあなたのものなので、好きに直せます。

1. AI に頼みます。例: 「MIRU のホームの並びを新しい順にして」「確認画面の字幕を大きくして」。
2. AI は `~/MIRU` のファイルを直し、`node tools/setup.mjs deploy` で公開し直します（型の確認で止まったら公開しません）。
3. 直したファイルの一覧は `node tools/setup.mjs changes` で見られます。

**新しい版が出ても、直した所は残ります。** `update` は、入れた版の写し（`~/MIRU/.miru-upstream/`）を元に、あなたの変更と新しい版の変更を混ぜます。同じ所を両方が変えていたときだけ、公開せずに止まり、どのファイルかを言います（AI が両方を入れて `deploy --resolved` で続けます）。

直すときの決まり:
- 直すのは `~/MIRU` の中だけ。このフォルダー（配られた元）は、AI動画編集 lite を更新すると入れ替わります。
- `wrangler.jsonc` は手で直さず、`setup.mjs` のオプションで変えます（作り直すたびに上書きされるため）。
- 表（データベース）を変えるときは、`migrations/` に新しい番号のファイルを足します（前のファイルは書き換えない）。
- 秘密の値（Google のシークレット・MIRU の鍵）はファイルに書きません。

## 新しい版にする

設定の画面の「この MIRU」に、新しい版があると出ます。AI に「AI動画編集 lite と MIRU を新しい版にして」と頼むと、lite を更新してから `update` を動かします。更新の前に、文字のデータの控えを `~/MIRU/backups/` に取ります。

## 置き場所

| 場所 | 中身 |
|---|---|
| `index.html`・`src/main.ts`・`src/ui.ts`・`src/style.css` | ホーム・タスク・設定などの画面 |
| `review.html`・`src/review/` | 確認画面（動画・字幕・修正指示・手直し） |
| `worker/` | サーバー（`index.ts` 入口・`auth.ts` Google ログイン・`api.ts` API・`mcp.ts` Claude Code / Codex とのつなぎ） |
| `migrations/` | 表（D1） |
| `public/_headers` | 画面に付ける守りのヘッダー |
| `tools/setup.mjs` | 立てる・直したものを公開する・新しい版にする・確かめる道具（`tools/setup.test.mjs` がその検査） |
| `wrangler.example.jsonc` | 設定のひな形（`setup.mjs` がこれから `wrangler.jsonc` を作る） |
| `VERSION.json` | この MIRU の版 |

手元で試す: `npm install` → `npm run build` → `npm run worker`（http://localhost:8790。`/auth/dev?email=you@example.com` で仮ログイン。`wrangler.dev.jsonc` のときだけ）。

## やめる

1. 控えを取る: `node tools/setup.mjs backup`
2. Cloudflare のダッシュボード（https://dash.cloudflare.com/）で、Workers & Pages の MIRU（既定の名前は `miru`）、D1 の `miru`、R2 の `miru-media` を消します（R2 は中を空にしてから消せます）。
3. Google Cloud の MIRU のプロジェクトを消し、`~/MIRU` と `~/.config/miru` を消します。

ライセンスは MIT です。
