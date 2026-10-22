// 確認画面はスキルの assets/review/index.html が元（手元の確認画面と同じもの）。
// それを review.html に写し、サイトのつなぎ（src/review/cloud.ts）を差し込む。元を直したら npm run sync-review。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SRC = process.env.REVIEW_PAGE ?? "/Users/kawamurafuushin/ClaudeCode/projects/常時運用/ai-video-editing-susume/assets/review/index.html";
import { existsSync } from "node:fs";
if (!existsSync(SRC)) { console.log("確認画面の元が無いので、今の review.html を使います"); process.exit(0); }
const page = readFileSync(SRC, "utf8");
const at = page.indexOf("<script>");
if (at < 0 || page.indexOf("<script>", at + 1) >= 0) throw new Error("確認画面の <script> が 1 つではありません");
const bridge = `<!-- MIRU: ${SRC.split("/").slice(-4).join("/")} を写し、サイトのつなぎを差し込んだもの（tools/sync-review.mjs）。直接直さない -->
<script>window.MIRU_CLOUD=1;window.MIRU_READY=new Promise(function(r){window.__miruStart=r});</script>
<script type="module" src="/src/review/cloud.ts"></script>
`;
let out = page.slice(0, at) + bridge + page.slice(at);
out = out.replace("<head>", '<head>\n<meta name="robots" content="noindex">');
writeFileSync(join(import.meta.dirname, "..", "review.html"), out);
console.log("review.html を作りました", out.length);
