# 見てもらう・直す（MIRU と手元の確認画面）

## MIRU（利用者が自分の Cloudflare に立てる確認サイト）

動画の確認サイト。0.2.0 から、**利用者が自分の Cloudflare アカウントに自分専用の MIRU を立てる**（動画も修正指示も利用者の Cloudflare の中だけ）。立て方は `../../miru/SETUP.md`（このスキルから見た場所。プラグインの中の `miru/`）。チャンネルを作れるのは立てた本人（`--owner`）だけで、本人が招待した人だけが見られる。本人には容量の上限も古い版の自動削除も無い（Cloudflare の無料の範囲は R2 が 10GB。超えた分は利用者の Cloudflare に請求される）。版が変わっても同じ映像・音は 1 回分しか置かないので、2 版目からは変わった分（数十 MB）だけ増える。古い版は動画のパネルで左にスワイプして消せる。

**初回の準備:** `~/.config/miru/url` が無ければ、まだ MIRU が無い。利用者が MIRU を使うと決めたら、`miru-setup` スキル（Claude Code は `/ai-video-editing-lite:miru-setup`、Codex は `$miru-setup`）の手順で立てる。立てたあと:
1. 利用者が自分の MIRU を開いて Google でログイン。
2. 「設定 → Claude Code・Codex とつなぐ」で鍵を作る。
3. 画面に出るコマンドを利用者がターミナルに貼る（Claude Code 用・Codex 用・miru_sync 用。miru_sync 用は `~/.config/miru/token` と `~/.config/miru/url` を置く）。鍵を AI に見せてもらう必要はない。

鍵は 1 年で切れる。切れたら同じ手順で作り直す。

**上げる:**
```
PY scripts/build_review_preview.py <案件> --plan <案件>/planning/render-plan-vN.json
PY scripts/build_flat_preview.py <案件> --name vN        # 軽い再生（10 分を超える動画は必ず）
PY scripts/miru_sync.py publish <案件> --preview vN
```
- **軽い再生**：カット済みの映像（寄りも込み）を 1 本の 960×540 の軽い動画にまとめる。MIRU の確認画面はそれを 1 本流すだけになり、カットのたびに頭出ししないので、ネット越しでもカクつかない。字幕と強調は今までどおり上に重ね、画面で直せる。作るのに動画の長さと同じくらいかかる（裏で動かし、その間に他の作業を進める）。画面の「軽い再生」ボタンか V キーで入り切り。
- **音の波形**：確認画面の字幕の下に「音」の段が出る（build_review_preview.py が作る）。言葉の切れ目・言い直しの間が目で見える。画面でカットを直すと波形も一緒に動く。
- 再生中に音の読み込みが追いつかないときは、映像も一緒に少し止まって「音を読み込み中…」と出る（無音のまま進まない）。
- MIRU のチャンネルは、学んだチャンネルの名前で初回に自動で作る（自分の MIRU なのでふつうはぶつからない。使われていれば後ろに印を付けて作り、記憶に残す）。動画の名前がぶつかったときも同じ（`<案件>/.akari/miru.json`）。
- 通信が切れても 5 回まで待ってやり直す。止まったら同じコマンドをもう一度実行すると、大きいファイルは続きから上げる。
- 容量が足りないと「容量が足りません」と止まる（自分の MIRU の持ち主にはふつう出ない）。古い版を消してもらうか、利用者に伝える。
- 出たリンクを利用者に送る。見せる人（編集を頼んだ人など）は、MIRU の「設定 → チャンネルと招待」で利用者が招待する。

**取り込む・返事する:**
```
PY scripts/miru_sync.py pull <案件> --preview vN      # 修正指示 → planning/review-comments.json、画面での手直し → planning/*-edits.json
PY scripts/miru_sync.py reply <案件> --note <id> --text "直しました" --status done
```

**強調デザインの採用・不採用:** MIRU の「強調デザイン」で決めたものを `miru_sync.py designs-pull` で記憶に取り込む。新しいデザインを足したら `designs-push --case <案件> --plan <plan>` で見本ごと上げる（決めた状態は上書きしない）。

## 手元の確認画面（MIRU を使わないとき）

```
PY scripts/build_review_preview.py <案件> --plan <plan>
PY scripts/build_flat_preview.py <案件> --name vN        # 軽い再生（重いときに）
PY scripts/review_server.py <案件>        # http://localhost:8765/ （この PC からだけ見られる）
```
修正指示は `planning/review-comments.json` に入る。`PY scripts/review_comments.py <案件> list` で読み、`reply <id> --text … --done` で返事。

## 直して次の版へ

1. 修正指示を全部読む。言われた所だけでなく、同じ種類の誤りが他に無いか探す（「フィラーが残っている」と言われたら全体を見直す）。
2. cuts.json / captions.json / emphasis.json を直す。画面での手直し（字幕の打ち直し・出入り・カットの戻しと追加）は、次で計画に当てる:
   ```
   PY scripts/review_edits.py <案件> apply --plan planning/render-plan-vN.json --preview vN --out planning/render-plan-vN-r1.json
   ```
   cuts / captions を直したときは `build.py plan` で新しい版を作り、前の版の手直しを当て直してから `review_edits.py <案件> carried --plan <新しい plan> --preview <新しい版> --from vN=planning/caption-edits.json,planning/cut-edits.json` で 1 件ずつ照合し、「要確認」が 0 になってから見せる。
3. 続けてほしい直しは `channel_memory.py rule` で記憶に足す。
