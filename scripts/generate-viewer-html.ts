// SPDX-License-Identifier: MIT
// Regenerates src/render/viewerHtml.ts from src/render/viewer.html.
//
// The viewer page is authored as a real HTML file (editable, lintable, no
// TS-template-literal escaping hazards) but ships as a generated TS constant,
// because tsc copies no assets into dist/. JSON.stringify does the escaping,
// so the constant is byte-identical to the file by construction; a sync test
// (test/viewerHtmlSync.test.ts) fails if this script wasn't re-run after an
// edit.
//
//   npm run viewer:generate           # rewrite src/render/viewerHtml.ts
//   npm run viewer:generate -- --check  # verify only, exit 1 on drift

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = join(root, "src", "render", "viewer.html");
const outPath = join(root, "src", "render", "viewerHtml.ts");

const html = readFileSync(htmlPath, "utf8");
const generated =
  "// SPDX-License-Identifier: MIT\n" +
  "// GENERATED from src/render/viewer.html by scripts/generate-viewer-html.ts — do not edit.\n" +
  "// After editing viewer.html, run: npm run viewer:generate\n" +
  `export const VIEWER_HTML: string = ${JSON.stringify(html)};\n`;

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(outPath, "utf8");
  } catch {
    /* missing file is drift */
  }
  if (current !== generated) {
    console.error("viewer:check — src/render/viewerHtml.ts is stale; run `npm run viewer:generate`");
    process.exit(1);
  }
  console.log("viewer:check — ok, viewerHtml.ts matches viewer.html");
} else {
  writeFileSync(outPath, generated);
  console.log(`generated src/render/viewerHtml.ts (${html.length} bytes of HTML)`);
}
