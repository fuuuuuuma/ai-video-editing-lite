// MIRU の版と種類（2026-10-23）。
// 個人用（personal）と、視聴者が自分の Cloudflare に立てる MIRU ライト（light）は同じコードで、違いは wrangler の vars の MIRU_EDITION だけ。
// VERSION は MIRU ライトの一式を作るとき（tools/release-light.mjs）に、その写しの中だけ書き換える（ここは dev のまま）。
//   build … 個人用 MIRU のコミットの数（増えるほど新しい）・date … 最後に直した日・commit … そのコミット
export const VERSION = { build: 48, date: "2026-10-25", commit: "5f0f8b9d" };

export type Edition = "personal" | "light";
export const editionOf = (env: { MIRU_EDITION?: string }): Edition => (env.MIRU_EDITION === "light" ? "light" : "personal");
