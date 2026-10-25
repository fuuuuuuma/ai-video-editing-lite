# 見てもらう・直す（MIRU と手元の確認画面）

## MIRU ライト（利用者が自分の Cloudflare に立てる確認サイト）

動画の確認サイト。0.2.0 から、**利用者が自分の Cloudflare アカウントに自分専用の MIRU を立てる**（動画も修正指示も利用者の Cloudflare の中だけ）。立て方は `../../miru/SETUP.md`（このスキルから見た場所。プラグインの中の `miru/`）。チャンネルを作れるのは立てた本人（`--owner`）だけで、本人が招待した人だけが見られる。置いた量が 9GB になると新しい版を受け付けない（R2 の無料の 10GB を超えて請求されないように。上限を変えるのは `miru-setup` の容量の節）。版が変わっても同じ映像・音は 1 回分しか置かないので、2 版目からは変わった分（数十 MB）だけ増える。古い版は動画のパネルで左にスワイプして消せる。

**初回の準備:** `~/.config/miru/url` が無ければ、まだ MIRU が無い。利用者が MIRU を使うと決めたら、`miru-setup` スキル（Claude Code は `/ai-video-editing-lite:miru-setup`、Codex は `$miru-setup`）の手順で立てる。立てたあと:
1. 利用者が自分の MIRU を開いて Google でログイン。
2. 「設定 → Claude Code・Codex とつなぐ」で鍵を作る。
3. 画面に出るコマンドを利用者がターミナルに貼る（「コマンドをコピー」が Claude Code 用、「Mac 用をコピー」「Windows 用をコピー」が Codex 用、「上げる道具用をコピー（Mac／Windows）」が miru_sync.py 用。最後のものは `~/.config/miru/token` と `~/.config/miru/url` を置く）。鍵を AI に見せてもらう必要はない。

鍵は 1 年で切れる。切れたら同じ手順で作り直す（Claude Code は先に `claude mcp remove -s user miru`。0.2.2 までの画面のコマンドでつないだフォルダーでは `claude mcp remove -s local miru` も。Codex の設定と上げる道具の鍵は、画面のコマンドで置き換わる）。
この鍵（作業用）では、消す・招待する・鍵を作ることはできず、上げ終わった版を同じ名前で上げ直すこともできない（409。直した版は `v3-2` のように別の名前で上げる）。

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
- 容量の上限を超えると「容量の上限（9.0GB）を超えます」と止まる。古い版を消してもらうか、上限を上げるか（10GB を超えた分は請求される）を利用者に聞く。
- publish の始めに「あなたの MIRU（版 N）は、入っている lite の MIRU より古いです」と出たら、上げるのは続けてよい。終わったあと `miru-setup` の「新しい版にする」を利用者に勧める。版は `PY scripts/miru_sync.py version` で比べられる。
- 出たリンクを利用者に送る。見せる人（編集を頼んだ人など）は、MIRU の「設定 → チャンネルと招待」で利用者が招待する。

**取り込む・返事する:**
```
PY scripts/miru_sync.py pull <案件> --preview vN      # 修正指示 → planning/review-comments.json、画面での手直し → planning/*-edits.json
PY scripts/miru_sync.py reply <案件> --note <id> --text "直しました" --status done
PY scripts/miru_sync.py deliver <案件> --preview vN --file <MP4>   # 承認された版に完成版を置く（相手がダウンロードする）
```

**承認と通知:** 見る人が MIRU の動画のパネルで「vN でOK（承認する）」を押すと承認になり、動画は「完了」になる（`pull` の出力の `approved`。いちばん新しい版の承認で、そのあとの未対応の指示が無いときだけ出る。前の版の承認は `stale_approvals`）。そのときは利用者に、完成版を書き出すかを聞いてから、その版の plan に画面での手直しを当てて書き出す（SKILL.md の 10）。**完成版を渡す:** 書き出したあと、利用者に聞いてから `deliver` で承認された版に置く（承認されていない版は MIRU が断る）。完成版は容量（9GB）を使う。渡し終えたら、管理者が動画のパネルの「完成版を消して … 空ける」で消せる（確認用の動画と承認は残る）。置いてある完成版は AI の鍵では置き換えられない（置き直すときは、画面で前のものを消してから）。承認を取り消すと完成版も消える。動画のパネルには期限と履歴もあり、消した修正指示は履歴の「戻す」で戻せる（管理者は「完全に消す」で中身も消せる）。
通知（新しい版・修正指示・返事・承認を Slack か Discord に送る）は、利用者が MIRU の「設定 → チャンネル → 通知」で決める。通知の URL は鍵と同じ扱い（チャットで受け取らない）。

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
