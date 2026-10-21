# チャンネルの作風を学ぶ

学ぶとは「資料を集めて、見て、作風を style.json に書いて記憶に置き、毎回それで作る」こと。モデルを訓練するわけではない。利用者にもそう伝える。

## 材料ごとに分かること

| 材料 | 道具 | 分かること | 分からないこと |
|---|---|---|---|
| YouTube の URL | `learn.py youtube <URL> [--videos 4 --seconds 60]` | 字幕の位置・色・縁・大きさ、強調の出し方、話者の色分け、寄り引き、カットの詰め具合（間の数・長さ、画の切り替わり） | 書体の正確な名前 |
| prproj | `learn.py prproj <パス>` | 書体名（PostScript 名）・大きさ・縁の太さと色・影、その書式の回数と文例、カットの長さの中央値、使っている効果音・BGM の名前、エフェクト | 画面上の位置（モーション）、最終の見た目 |
| 完成 MP4 | `learn.py mp4 <パス> [--start 60 --seconds 90]` | YouTube と同じ | 書体の正確な名前 |

YouTube はチャンネル URL（`/@名前` でも `/channel/UC…` でも）を渡すと、新しい順に 3 分以上の動画を選ぶ。動画の URL を渡すとその 1 本だけ。取れないとき（403）は `setup.py` をもう一度実行すると yt-dlp が新しくなる。

## 見る順番

1. `sheet-NN.jpg` を全部見る。1 枚に 16 コマ（1 秒ごと、左上に時刻）。
2. 次をメモする（学んだ所の `learn/` に notes.md を書いてよい）:
   - 通常字幕: 位置（画面の下から何割）・書体の太さ（ゴシック太/細、明朝、丸）・文字色・縁（色・何重か・ぼかし）・1 行の文字数・2 行にするか
   - 強調: どんな言葉で出るか（言い切り・数字・ツッコミ・ボケ）・書体・色・大きさ・寄るか
   - 話者が 2 人のとき: 字幕の色や縁の色で分けているか
   - カット: 間をどれくらい残すか（`pauses.median_seconds`）・ジャンプカットの多さ（`scene_changes_per_minute`）
   - やっていないこと（字幕が無い区間・画面収録・BGM の有無）
3. 数字（`caption_band`）は目安。`text_top_y_1080p` は 1080p 換算の字幕の上端。コマで確かめてから使う。

## style.json の書き方

`assets/style-default.json` を写して直す。

- `caption.normal.K` / `S`: 本人（K）と相手（S）の通常字幕。`font`（lite の書体名かファイルの場所）・`font_size`（1080p の px。テロップの字の高さの目安は 70〜100）・`color`・`strokes`（`[{"width": 10, "color": "#000"}]` 縁）・`shadows`（`spread` 太らせ・`blur` ぼかし・`opacity`。縁をぼかした光彩はこちら）・`proportional_spacing`（詰め組み）。
- `caption.normal_place`: `one_line_top`（1 行のとき文字の上端の y）・`two_line_bottom`（2 行のとき下端の y）・`center_x`・`max_width`。
- `caption.max_chars_per_line`: 1 行の最大文字数（学んだ字幕の文字数から）。
- `caption.emphasis_place`: 強調の下端 `bottom`・上に伸びてよい限界 `min_top`・最大の字の大きさ `max_size`。
- `roles`: 強調の役割（いつ使う・使わない）。チャンネルに無い役割は消す。
- `designs`: 役割ごとの見た目（`style` は通常字幕と同じ書き方。`fill_gradient` でグラデーション）。学んだものは `"status": "adopt"`、案として足すものは `"open"`。利用者が MIRU か手元の確認画面で採用・不採用を決められる。
- `zoom.emphasis_scale`: 強調のときに寄る倍率（寄らないチャンネルは 1）。`cy` は寄る中心の高さ（顔の位置）。
- `cut`: `pad_frames`（声の前後に残すコマ）・`max_pause_seconds`（これより長い間は詰める。間を残すチャンネルは 0.5〜0.8）・`fillers`・`keep_backchannel`。
- `speakers`: 確認画面での呼び名（`{"K": "〇〇さん", "S": "相手"}`）。

lite の書体（すべて SIL Open Font License・初回に取得）: gothic（M PLUS 1p Black）・gothic-bold（同 ExtraBold）・dela（Dela Gothic One）・mincho（Zen Old Mincho Black）・round（M PLUS Rounded 1c Black）・brush（Yuji Syuku）・reggae（Reggae One）・pop（Mochiy Pop One）。

## 見本で確かめる

`channel_memory.py sample --out sample.jpg --frame <学んだコマの jpg>` で、通常字幕と採用デザインを 1 枚に並べる。自分で見て、学んだコマと並べて違いを直してから利用者に見せる。「完全に同じ」とは言わない（書体が違う・縁の描き方が違うことがある）。
