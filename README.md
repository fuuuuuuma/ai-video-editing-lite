# AI動画編集 lite

自分の YouTube チャンネルの「編集の作風」（字幕の書体・色・位置、強調テロップの出し方、カットの詰め方）を AI に覚えさせて、撮影した素材から **カット・字幕・強調テロップ入りの MP4** を作る、Claude Code / Codex 用のスキルです。できた動画は確認サイト **MIRU** で見て、修正指示を書き込むと AI が直します。

- 最初の 1 回だけ、チャンネルの URL・Premiere のプロジェクト（.prproj）・完成した動画のどれかを渡して作風を学ばせます。2 回目からは「前に覚えた作風で編集して」だけで使えます。
- 学習データは同梱していません。まっさらな状態から、あなたのチャンネルを学びます。
- Premiere は開きません。すべてこのパソコンの中で編集します（MIRU に上げるときだけ通信します）。

## この 2 行でインストール

**Claude Code** のターミナルで:

```bash
claude plugin marketplace add fuuuuuuma/ai-video-editing-lite
claude plugin install ai-video-editing-lite@ai-video-editing-lite
```

**Codex** のターミナルで:

```bash
codex plugin marketplace add fuuuuuuma/ai-video-editing-lite
codex plugin add ai-video-editing-lite@ai-video-editing-lite
```

インストール後は新しいチャットを開いて使います（Codex は `$ai-video-editing-lite` を付けて依頼）。初回は AI が準備（Python の環境・文字起こし・書体の取得、数分）を進めます。

## 最初の 1 回：作風を学ばせる

```text
私のチャンネルの編集の作風を学んで覚えてください。
https://www.youtube.com/@あなたのチャンネル
（あれば）過去の Premiere のプロジェクト: /Users/…/第10回.prproj
```

AI が最近の動画を数本、分析用に短く取り込み、字幕や強調のコマを見て作風を書き出します。最後に「通常の字幕と強調テロップの見本」の画像を見せるので、違う所を伝えてください（「縁はもっと太く」「強調は赤じゃなくて黄色」など）。

## 2 回目から：編集を頼む

```text
前に覚えた作風で、この動画を編集してください。
/Users/…/撮影/IMG_0001.MOV
```

AI が文字起こしを全部読み、言い直し・「えー」などを切り、字幕と強調テロップを付けた確認用の動画を作って、MIRU のリンクを送ります。MIRU で気になる所に修正指示を書く（字幕の打ち直しやカットの戻しは画面で直接もできます）と、AI が取り込んで次の版を作ります。「書き出して」と言うと完成の MP4 を書き出します。YouTube への投稿は自分で行ってください。

## MIRU ライト（確認サイト）は自分の Cloudflare に立てる

MIRU ライトは、できた動画を見て修正指示を書き込むサイトです。**あなた自身の Cloudflare アカウントに、あなた専用の MIRU を立てて使います**（動画も修正指示もあなたの Cloudflare の中だけ。入れるのはあなたと、あなたが招待した人だけ）。

- **導入ガイド（画面で見ながら進める）: https://fuuuuuuma.github.io/ai-video-editing-lite/** （同じものが [docs/index.html](docs/index.html)。スマホでも見られます）
- 立て方: AI に **Claude Code は `/ai-video-editing-lite:miru-setup`、Codex は `$miru-setup`** と送ると、AI が手順を進めます。あなたがするのは、ブラウザでの許可と Cloudflare・Google Cloud の設定、秘密の値の貼り付けだけです（20〜30 分）。
- 詳しい手順・費用・困ったとき: [plugins/ai-video-editing-lite/miru/SETUP.md](plugins/ai-video-editing-lite/miru/SETUP.md)
- 確かめる: AI に「MIRU を確かめて」と頼むと、サイト・Google の設定・この PC とのつながりを 1 つずつ確かめ、直す所を言います。
- 費用: Cloudflare の無料の範囲で使えます（動画の置き場 R2 は 10GB まで無料、見られるたびの通信料はかかりません）。30 分の動画で 1 版目およそ 1GB、2 版目からは変わった分（数十 MB）だけ増えます。無料の範囲を超えないように、置いた量が 9GB になると止まります（上げることもできます）。
- Claude Code・Codex とは、MIRU の「設定 → Claude Code・Codex とつなぐ」に出るコマンドを貼るとつながります。
- MIRU を使わず、このパソコンの中だけで確認することもできます（http://localhost:8765/）。
- 0.1.x で使っていた共用の MIRU は、新しくチャンネルを作れません（今あるチャンネルはそのまま見られます）。新しい動画は自分の MIRU ライトに上げてください。

## 自分用に直す

- **作風**（字幕・強調の見た目、カットの詰め方、続けるルール）: AI に言えば覚え直します（「強調は 1 分に 1 個まで」「縁をもっと太く」など）。覚えた内容は `~/.ai-video-editing-lite/` に残り、更新しても消えません。
- **MIRU ライト**: あなたの Cloudflare で動くあなたのものです。AI に「MIRU の〇〇を直して」と頼むと、`~/MIRU` を直して公開し直します。**新しい版にしても、直した所は残ります**（あなたの変更と新しい版の変更を混ぜます。同じ所がぶつかったときだけ止まって知らせます）。
- **スキルのしくみそのもの**: このリポジトリを GitHub で自分のアカウントにフォーク（Fork）して直し、自分のフォークから入れます（`claude plugin marketplace add あなたの名前/ai-video-editing-lite`）。元の新しい版は、GitHub の「Sync fork」で取り込めます。直したものを元に戻してほしいときは Pull request を送ってください。

## できること・できないこと

| できる | まだできない |
|---|---|
| 言い直し・フィラー（えー・あのー）・長い間のカット | BGM・効果音・アバン・名前の札 |
| 字幕（話し手 2 人の色分け）・強調テロップ・強調のときの寄り | 画面収録の差し込み・図解・画像の挿入 |
| 音の大きさを YouTube に合わせる（-14 LUFS） | 縦長（ショート）動画 |
| MIRU / 手元の確認画面での修正 | Premiere のプロジェクトへの書き出し |

## 必要な環境

- Claude Code または Codex（プラグインが使える版）
- Python 3.10 以上（Mac は `brew install python@3.12`、Windows は python.org から）
- ffmpeg（Mac は `brew install ffmpeg`、Windows は `winget install Gyan.FFmpeg`）
- 空き容量 20GB ほど。Apple Silicon の Mac で作り、確かめています。Windows・Intel Mac は文字起こしに faster-whisper を使います。Windows は、単体の試験と MIRU ライトを立てる道具を GitHub の検査（Mac・Windows・Linux）で確かめていますが、撮影素材からの編集の通しはまだ確かめていません。

2 行はプラグインの導入コマンドです。Python・ffmpeg・Claude Code / Codex 自体のインストールは含みません。

## 覚えた内容の置き場所

`~/.ai-video-editing-lite/`（チャンネルの作風・強調デザイン・続けるルール・取り込んだ資料・書体・Python 環境）。プラグインを更新しても残ります。別のパソコンへ移すときはこのフォルダをコピーしてください。場所を変えるときは `AIVE_LITE_HOME` を設定します。

「学ぶ」とは、資料とルールを保存して毎回読み戻す仕組みのことで、AI のモデルを追加で訓練するものではありません。

## 学習に使う動画について

YouTube から取り込むのは、分析のための短い区間（低画質・1 本 1 分ほど）だけで、パソコンの外には出しません。学ばせるのは、自分のチャンネルか、使ってよいと許可を得た動画にしてください。

## 更新

```bash
claude plugin marketplace update ai-video-editing-lite && claude plugin update ai-video-editing-lite@ai-video-editing-lite
codex plugin marketplace upgrade ai-video-editing-lite && codex plugin add ai-video-editing-lite@ai-video-editing-lite
```

MIRU ライトを立てているなら、続けて AI に「MIRU を新しい版にして」と頼みます（MIRU の「設定 → この MIRU」にも、新しい版があると出ます）。何が変わったかは [CHANGELOG.md](CHANGELOG.md)。

## 困ったとき・問い合わせ

まず AI に「MIRU を確かめて」（MIRU のこと）か「doctor を動かして」（編集のこと）と頼むと、直す所を言います。
直らないときは [Issues](https://github.com/fuuuuuuma/ai-video-editing-lite/issues) に書いてください（テンプレートがあります）。**シークレットや鍵（`GOCSPX-`・`miru_` で始まる値）は貼らないでください。**

## ライセンス

MIT（このリポジトリのコード）。取得する書体は SIL Open Font License（M PLUS 1p・M PLUS Rounded 1c・Dela Gothic One・Zen Old Mincho・Yuji Syuku・Reggae One・Mochiy Pop One）。
