// SPDX-License-Identifier: MIT
// `em scaffold` (MIL-97 item 2) embeds MODEL_README_TEMPLATE /
// STATE_TEMPLATE in src/templates.ts rather than reading .claude/skills/event-modeling/templates/
// at runtime (same rationale as STARTER_EM: works identically whether em is run from a checkout
// or installed from npm). That means there are now two copies of each file — this test is the
// drift guard: it fails loudly the moment someone edits the skill's template on disk without
// updating the embedded constant to match (or vice versa).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_README_TEMPLATE, STATE_TEMPLATE } from "../src/templates.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES_DIR = join(ROOT, ".claude", "skills", "event-modeling", "templates");

describe("em scaffold's embedded templates stay in sync with the skill's templates/ directory", () => {
  it("MODEL_README_TEMPLATE matches templates/model-readme.md byte-for-byte", () => {
    expect(MODEL_README_TEMPLATE).toBe(readFileSync(join(TEMPLATES_DIR, "model-readme.md"), "utf8"));
  });

  it("STATE_TEMPLATE matches templates/state.md byte-for-byte", () => {
    expect(STATE_TEMPLATE).toBe(readFileSync(join(TEMPLATES_DIR, "state.md"), "utf8"));
  });
});
