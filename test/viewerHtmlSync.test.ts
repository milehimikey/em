// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VIEWER_HTML } from "../src/render/viewerHtml.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// src/render/viewer.html is the viewer's source of truth; the served constant
// is generated from it (scripts/generate-viewer-html.ts). Editing the HTML
// without re-running `npm run viewer:generate` must fail here, byte-for-byte —
// the same guarantee scaffoldTemplatesSync.test.ts gives the scaffold templates.
describe("viewer html sync", () => {
  it("VIEWER_HTML matches src/render/viewer.html byte-for-byte", () => {
    expect(VIEWER_HTML).toBe(readFileSync(join(ROOT, "src", "render", "viewer.html"), "utf8"));
  });
});
