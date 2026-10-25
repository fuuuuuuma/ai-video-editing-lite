// 修正指示の保存で「この画面で変えたもの」だけを選ぶ（2026-10-24。前は画面の一覧をサイトの最新と比べた差を全部送り、
// 他の人の新しい指示を消し、他の人や AI が直した文・「済」を古い値に戻し、消された指示を生き返らせていた）。
type Json = Record<string, any>;

/** 件数と最新の更新時刻。消されたことも見張りで気づけるよう、件数を入れる */
export const stampOf = (notes: Json[]) => `${notes.length}-${Math.max(0, ...notes.map((n) => Number(n.updated_at) || 0))}`;

/**
 * items: 画面の一覧（サイトから来た指示には updated_at がある）。savedAt: 画面が一覧を受け取ったときの stampOf。
 * known: いまのサイトの指示（id → note）。
 *  足す: サイトから来ていない（updated_at の無い）指示だけ。サイトから来て今は無い指示は、誰かが消したので足さない
 *  直す: 文か「済」が違い、画面の写しがサイトと同じ版（updated_at が同じ）のときだけ。サイトの方が新しければ他の人の変更を残す
 *  消す: 画面に無く、画面が一覧を受け取った後に誰も触っていない（updated_at が savedAt の時刻以下）指示だけ
 */
export function planNoteSync(items: Json[], savedAt: string | undefined, known: Map<string, Json>) {
  const seenUntil = Number(String(savedAt ?? "").split("-").pop()) || 0;
  const ids = new Set(items.map((x) => x.id));
  const post: Json[] = [], patch: Json[] = [], del: string[] = [];
  for (const it of items) {
    const n = known.get(it.id);
    if (!n) { if (it.updated_at == null) post.push(it); continue; }
    const changed = n.text !== it.text || (n.status === "done") !== (it.status === "done");
    if (changed && (it.updated_at == null || it.updated_at === n.updated_at)) patch.push(it);
  }
  for (const [id, n] of known) if (!ids.has(id) && (Number(n.updated_at) || 0) <= seenUntil) del.push(id);
  return { post, patch, del };
}

/**
 * 字幕・カットの手直し（id のある項目の一覧）を、この画面で変えた分だけ最新に重ねる（2026-10-24。前は画面の一覧で丸ごと
 * 上書きし、直前に他の人が保存した手直しを消していた）。
 * base: この画面に最後に渡した一覧、page: 画面が送ってきた一覧、latest: いまのサイトの一覧。
 * 画面で足した（base に無い）・直した（base と中身が違う）ものは latest に入れ、画面で消した（base にあって page に無い）ものは
 * latest から抜く。他の人の分（latest にだけあるもの・latest で直されたもの）はそのまま残す。
 */
export function mergeEdits(base: Json[] | null, page: Json[], latest: Json[]): Json[] {
  const key = (x: Json) => String(x.id ?? JSON.stringify(x));
  const same = (a: Json, b: Json) => JSON.stringify(a) === JSON.stringify(b);
  const baseBy = new Map((base ?? []).map((x) => [key(x), x]));
  const pageBy = new Map(page.map((x) => [key(x), x]));
  const out = latest.filter((x) => {
    const k = key(x);
    return !(baseBy.has(k) && !pageBy.has(k));              // この画面で消した
  });
  const at = new Map(out.map((x, i) => [key(x), i]));
  for (const x of page) {
    const k = key(x), b = baseBy.get(k);
    if (b && same(b, x)) continue;                           // この画面では触っていない: サイトの方を残す
    if (at.has(k)) out[at.get(k)!] = x; else { at.set(k, out.length); out.push(x); }
  }
  return out;
}
