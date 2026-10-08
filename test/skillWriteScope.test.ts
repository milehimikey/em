// SPDX-License-Identifier: MIT
// MIL-236 (+ GH #193): the design-session write-scope rule, the out-of-scope-during-design list,
// the evidence rule, the pre-release version rule, the seam change request convention and the
// ratify-flag guidance must stay present in every skill entry point that runs a design session
// (router, design skill, shared operating principles), with the implement contract's mirror
// image. Skill behaviour is prose an agent follows, so the gate is (a) the required text exists
// in each file, (b) the pre-release signal the skill reads (ruling R20) behaves as documented on
// real `em status --json` output, and (c) the seam change request shape the skill writes is a
// Decisions-log entry `em changelog` actually picks up.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDecisionsLog } from "../src/emit/changelog.js";
import { scaffoldStateFile } from "../src/templates.js";
import { meaningConfirmationRequiredMessage } from "../src/cli/ratify.js";

// Scenario (b) spawns the real CLI; a cold CI runner takes ~5 s per spawn (briefing §5).
vi.setConfig({ testTimeout: 20_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");
const SKILLS = join(ROOT, ".claude", "skills");

const ROUTER = join(SKILLS, "event-modeling", "SKILL.md");
const DESIGN = join(SKILLS, "event-modeling-design", "SKILL.md");
const PRINCIPLES = join(SKILLS, "event-modeling-shared", "reference", "operating-principles.md");
const IMPLEMENT = join(SKILLS, "event-modeling-implement", "reference", "implement.md");
const STATE_TEMPLATE = join(SKILLS, "event-modeling-shared", "templates", "state.md");

/** Collapse line wrapping so a required phrase matches however the prose is wrapped. */
function flat(path: string): string {
  return readFileSync(path, "utf8").replace(/\s+/g, " ");
}

const SEAM_REQUEST_SHAPE = "- YYYY-MM-DD: seam change request → <producerKey>:<kind>.<slug> — <what> — <why>";

// The out-of-scope-during-design list, item by item (MIL-236 Additional Do).
const OUT_OF_SCOPE_ITEMS = ["`contracts/*.tsp`", "OpenAPI", "`specs/`", "`.specify/`", "`src/`", "`plugin/`", "`version:`"];

describe("MIL-236 (a): required write-scope text in each design entry point", () => {
  const entryPoints = { router: ROUTER, design: DESIGN, principles: PRINCIPLES };

  for (const [name, path] of Object.entries(entryPoints)) {
    describe(name, () => {
      const text = flat(path);

      it("binds the session to the model directory it started in", () => {
        expect(text).toContain("bound to the model directory it started in");
        expect(text).toMatch(/Never write under another model's directory/);
      });

      it("states the out-of-scope-during-design list", () => {
        expect(text).toContain("Out of scope during design");
        for (const item of OUT_OF_SCOPE_ITEMS) expect(text).toContain(item);
      });

      it("states the evidence rule (code only in extract and conform)", () => {
        expect(text).toContain("Evidence rule.");
        expect(text).toMatch(/The `\.em` model and the slice docs are the evidence/);
        expect(text).toMatch(/`extract`.*`conform`/);
      });

      it("routes a cross-model need to a seam change request", () => {
        expect(text).toContain("seam change request");
      });
    });
  }

  it("the design skill and operating principles document the seam change request shape exactly", () => {
    expect(readFileSync(DESIGN, "utf8")).toContain(SEAM_REQUEST_SHAPE);
    expect(readFileSync(PRINCIPLES, "utf8")).toContain(SEAM_REQUEST_SHAPE);
    expect(readFileSync(STATE_TEMPLATE, "utf8")).toContain(SEAM_REQUEST_SHAPE);
  });

  it("the design skill and operating principles state the R20 pre-release version rule", () => {
    for (const path of [DESIGN, PRINCIPLES]) {
      const text = flat(path);
      expect(text).toContain("em status <model>.em --json");
      expect(text).toContain("`design: null`");
      expect(text).toContain("`slices.byStatus.implemented === 0`");
      expect(text).toMatch(/never run `(em slice )?reratify`/);
      expect(text).toMatch(/[Nn]ever bump a draft's `version:` on edit/);
    }
  });

  it("the design skill no longer tells the agent to read implementation sources as evidence", () => {
    const text = flat(DESIGN);
    expect(text).not.toContain("Grep/Read adjacent real sources");
    expect(text).toContain("Never Grep or Read implementation source");
  });

  it("the design skill, router and principles run em system scope --staged before committing", () => {
    for (const path of [ROUTER, DESIGN, PRINCIPLES]) {
      const text = flat(path);
      expect(text).toContain("em system scope --staged");
      expect(text).toContain("git diff --cached --name-only");
      expect(text).toContain("STOP");
    }
    expect(flat(PRINCIPLES)).toContain("`seam-crossing`");
  });

  it("the design skill says when em api generate IS run (marking an element public)", () => {
    for (const path of [DESIGN, PRINCIPLES]) {
      const text = flat(path);
      expect(text).toContain("em api generate <model>.em");
      expect(text).toMatch(/marking an element `public`|marks an element `public`|mark an element `public`/);
    }
  });

  it("the design skill teaches the MIL-238 ratify flags and keeps ratification a human gate", () => {
    const text = flat(DESIGN);
    expect(text).toContain(
      "`em slice ratify --by <name>` and `em slice reratify` refuse without one of two flags: pass `--meaning-unchanged` when this version does not change what the public contract means, or `--contract-change \"<why>\"` when a consumer must read the change differently.",
    );
    // The quoted refusal is the CLI's own message (src/cli/ratify.ts), so the skill cannot drift from it.
    expect(text).toContain(meaningConfirmationRequiredMessage("<key>"));
    expect(text).toContain("Run `em api generate <model>.em` first, so `em validate --slice-ready` sees a current contract");
    expect(text).toContain("`slice-ready-contract-stale`");
    expect(text).toContain("a review session never ratifies");
    // MIL-201's human-gate wording in the review skill is untouched.
    expect(flat(join(SKILLS, "event-modeling-review", "SKILL.md"))).toContain(
      "The facilitator never ratifies, never offers to ratify, and never suggests ratification in a review session.",
    );
  });

  it("the router recommends focused skills and steers late work to event-modeling-review", () => {
    const text = flat(ROUTER);
    expect(text).toContain("Steer late work to `event-modeling-review`");
    expect(text).toContain("`slices.byStatus.draft === 0`");
    expect(text).toContain("Never do the phase work here.");
    // The routing table is kept.
    expect(text).toContain("| `model`, `slice` | `event-modeling-design`");
  });

  it("implement.md carries the mirror image and stay-on-your-side rule", () => {
    const text = flat(IMPLEMENT);
    expect(text).toContain("implement reads them; design never writes them");
    expect(text).toContain("Stay on your side of the seam");
    expect(text).toContain("Never hand-edit a generated contract (`contracts/*.tsp`)");
    expect(text).toContain("`--meaning-unchanged` or `--contract-change \"<why>\"`");
  });
});

describe("MIL-236 (c): a seam change request in the documented shape is a Decisions-log entry", () => {
  it("em changelog's parser picks it up from a scaffolded state file; the template comment is not an entry", () => {
    const scaffolded = scaffoldStateFile("Fulfillment", "fulfillment", "2026-10-07", "1.14.0");
    // The template's guidance comment alone yields no entry.
    expect(parseDecisionsLog(scaffolded)).toEqual([]);

    const bullet = SEAM_REQUEST_SHAPE.replace("YYYY-MM-DD", "2026-10-07")
      .replace("<producerKey>:<kind>.<slug>", "checkout:event.order-submitted")
      .replace("<what>", "add `currency: string`")
      .replace("<why>", "the receiving slice must record the order's currency");
    const withRequest = scaffolded.replace(/(## Decisions log\n<!--[\s\S]*?-->\n)/, `$1${bullet}\n`);
    expect(withRequest).not.toBe(scaffolded);

    expect(parseDecisionsLog(withRequest)).toEqual([
      {
        date: "2026-10-07",
        text: "seam change request → checkout:event.order-submitted — add `currency: string` — the receiving slice must record the order's currency",
      },
    ]);
  });
});

function em(args: string[], cwd: string) {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** R20: pre-release iff the model's modelVersion entry has design === null and nothing is implemented. */
function isPreRelease(statusJson: string): boolean {
  const doc = JSON.parse(statusJson) as {
    modelVersion: { file: string; design: number | null }[];
    slices: { byStatus: { implemented: number } };
  };
  expect(doc.modelVersion).toHaveLength(1);
  return doc.modelVersion[0].design === null && doc.slices.byStatus.implemented === 0;
}

function frontmatterVersion(doc: string): string | undefined {
  return /^version:\s*(\S+)/m.exec(doc)?.[1];
}

describe("MIL-236 (b): the R20 pre-release signal on real em status --json output", () => {
  let cwd: string;
  const model = () => join(cwd, "fulfillment", "fulfillment.em");
  const slicesDoc = () => join(cwd, "fulfillment", "slices", "browse-catalog.md");

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "em-skill-write-scope-"));
    expect(em(["scaffold", "Fulfillment"], cwd).status).toBe(0);
    const wired = em(
      ["slice", "new", "Browse Catalog", "--pattern", "state-change", "--swimlane", "Customer → Order", "--wire", "fulfillment.em"],
      join(cwd, "fulfillment"),
    );
    expect(wired.status, wired.stderr).toBe(0);
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it("a fresh model with a draft doc is pre-release; editing the draft leaves version: alone", () => {
    const r = em(["status", model(), "--json"], cwd);
    expect(r.status, r.stderr).toBe(0);
    expect(isPreRelease(r.stdout)).toBe(true);

    // The pre-release design edit the skill makes: body text only, frontmatter untouched.
    const before = readFileSync(slicesDoc(), "utf8");
    writeFileSync(slicesDoc(), before + "\n## Open questions\n- Does a guest checkout exist?\n");
    expect(frontmatterVersion(readFileSync(slicesDoc(), "utf8"))).toBe("1");
    const after = em(["status", model(), "--json"], cwd);
    expect(isPreRelease(after.stdout)).toBe(true);
  });

  it("a bumped model version makes the model released", () => {
    const bump = em(["model", "version", "bump", model(), "--by", "Release Owner"], cwd);
    expect(bump.status, bump.stderr).toBe(0);
    const r = em(["status", model(), "--json"], cwd);
    expect(isPreRelease(r.stdout)).toBe(false);
  });

  it("an implemented slice makes the model released, and re-ratification then bumps version:", { timeout: 60_000 }, () => {
    const dir = join(cwd, "fulfillment");
    for (const args of [
      ["slice", "review", "fulfillment.em", "browse-catalog", "--by", "Reviewer"],
      ["slice", "ratify", "fulfillment.em", "browse-catalog", "--by", "Ratifier", "--on", "2026-10-07"],
      ["slice", "mark-implemented", "fulfillment.em", "browse-catalog", "https://example.com/pr/1"],
    ]) {
      const step = em(args, dir);
      expect(step.status, `${args.join(" ")}: ${step.stderr}`).toBe(0);
    }
    const r = em(["status", model(), "--json"], cwd);
    expect(isPreRelease(r.stdout)).toBe(false);

    // Released → the existing re-ratification path bumps version: as today.
    const rr = em(["slice", "reratify", "fulfillment.em", "browse-catalog"], dir);
    expect(rr.status, rr.stderr).toBe(0);
    expect(frontmatterVersion(readFileSync(slicesDoc(), "utf8"))).toBe("2");
  });
});
