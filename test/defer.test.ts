// SPDX-License-Identifier: MIT
// Coverage for `em slice defer` (src/cli/defer.ts, MIL-275): pure text surgery (applyDefer,
// applyDeferStateFile, reopenDeferred), the fs orchestration, and the CLI acceptance fixture.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyDefer, applyDeferStateFile, reopenDeferred, DeferInput } from "../src/cli/defer.js";

vi.setConfig({ testTimeout: 20_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");
function em(args: string[], cwd: string) {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const BASE: DeferInput = {
  question: "retry policy",
  until: "v2",
  decision: "fail fast",
  by: "Alex",
  on: "2026-10-08",
  currentVersion: 1,
};
const DOC =
  "---\nversion: 1\n---\n# Slice\n\n## Open Questions\n\n- [ ] What is the retry policy?\n- [ ] Who owns billing?\n- [x] Settled thing\n\n## Notes\n\n- [ ] not a question\n";

describe("applyDefer (pure)", () => {
  it("rewrites the single matching unchecked item in place", () => {
    const r = applyDefer(DOC, BASE);
    expect(r).toMatchObject({ ok: true, changed: true });
    if (!r.ok) return;
    expect(r.content).toContain(
      "- [x] What is the retry policy? — v1: fail fast; deferred to v2 (2026-10-08, Alex)\n- [ ] Who owns billing?\n",
    );
    expect(r.content).toContain("- [ ] not a question"); // other section untouched
  });
  it("omits the by clause when --by is absent", () => {
    const r = applyDefer(DOC, { ...BASE, by: undefined });
    expect(r.ok && r.content).toContain("deferred to v2 (2026-10-08)\n");
  });
  it("preserves CRLF", () => {
    const crlf = DOC.replace(/\n/g, "\r\n");
    const r = applyDefer(crlf, BASE);
    expect(r.ok && r.content).toBe(
      crlf.replace("- [ ] What is the retry policy?", "- [x] What is the retry policy? — v1: fail fast; deferred to v2 (2026-10-08, Alex)"),
    );
  });
  it("is a no-op when already deferred to the same version", () => {
    const first = applyDefer(DOC, BASE);
    if (!first.ok) throw new Error("setup");
    const again = applyDefer(first.content, BASE);
    expect(again).toEqual({ ok: true, content: first.content, changed: false });
  });
  it("refuses: not found", () => {
    expect(applyDefer(DOC, { ...BASE, question: "nothing" })).toEqual({
      ok: false,
      message: 'no unchecked Open Question matching "nothing"',
    });
  });
  it("refuses: no Open Questions section", () => {
    expect(applyDefer("---\nversion: 1\n---\nbody\n", BASE)).toEqual({
      ok: false,
      message: 'no unchecked Open Question matching "retry policy"',
    });
  });
  it("refuses: ambiguous, naming candidates", () => {
    expect(applyDefer(DOC, { ...BASE, question: "?" })).toEqual({
      ok: false,
      message: "ambiguous — matches: What is the retry policy? | Who owns billing?",
    });
  });
  it("refuses: already checked", () => {
    expect(applyDefer(DOC, { ...BASE, question: "Settled" })).toEqual({
      ok: false,
      message: "already checked: Settled thing",
    });
  });
  it("refuses: --until not greater than current / malformed", () => {
    expect(applyDefer(DOC, { ...BASE, until: "v1" })).toEqual({
      ok: false,
      message: "--until v1 must be greater than the doc's current version v1",
    });
    expect(applyDefer(DOC, { ...BASE, until: "2" })).toEqual({
      ok: false,
      message: 'invalid --until "2" — expected v<n> (for example v2)',
    });
  });
  it("refuses control characters in --by", () => {
    expect(applyDefer(DOC, { ...BASE, by: "A\nB" })).toEqual({
      ok: false,
      message: "deferrer name must not be empty or contain control characters",
    });
  });
});

const STATE = "# State\n\n## Decisions log\n<!-- c -->\n- 2026-01-01: old — why\n\n## Open questions / parking lot\n<!-- c -->\n- [ ] x\n\n## Slice inventory\n";
const MIRROR = { question: "retry policy", sliceKey: "pay", until: 2, decision: "fail fast", by: "Alex", on: "2026-10-08", currentVersion: 1 };

describe("applyDeferStateFile (pure)", () => {
  it("appends both bullets at the end of their sections, idempotently", () => {
    const r = applyDeferStateFile(STATE, MIRROR);
    expect(r).toMatchObject({ ok: true, changed: true });
    if (!r.ok) return;
    expect(r.content).toContain(
      '- 2026-01-01: old — why\n- 2026-10-08: deferred "retry policy" on pay to v2 — v1: fail fast — by Alex\n\n## Open',
    );
    expect(r.content).toContain("- [ ] x\n- retry policy (from slice pay, deferred to v2)\n\n## Slice inventory");
    const again = applyDeferStateFile(r.content, MIRROR);
    expect(again).toEqual({ ok: true, content: r.content, changed: false });
  });
  it("preserves CRLF and appends at EOF when the section is last", () => {
    const crlf = "## Decisions log\r\n- a\r\n## Open questions / parking lot\r\n- b";
    const r = applyDeferStateFile(crlf, { ...MIRROR, by: undefined });
    expect(r.ok && r.content).toBe(
      '## Decisions log\r\n- a\r\n- 2026-10-08: deferred "retry policy" on pay to v2 — v1: fail fast\r\n' +
        "## Open questions / parking lot\r\n- b\r\n- retry policy (from slice pay, deferred to v2)\r\n",
    );
  });
  it("refuses a missing heading", () => {
    expect(applyDeferStateFile("## Decisions log\n", MIRROR)).toEqual({
      ok: false,
      message: '.event-modeling.md has no "## Open questions / parking lot" heading',
    });
    expect(applyDeferStateFile("## Open questions / parking lot\n", MIRROR)).toEqual({
      ok: false,
      message: '.event-modeling.md has no "## Decisions log" heading',
    });
  });
});

describe("reopenDeferred (pure)", () => {
  it("re-opens only items deferred to the reached version", () => {
    const a = applyDefer(DOC, BASE);
    const b = a.ok ? applyDefer(a.content, { ...BASE, question: "billing", until: "v3" }) : a;
    if (!b.ok) throw new Error("setup");
    const r = reopenDeferred(b.content, 2);
    expect(r.count).toBe(1);
    expect(r.content).toContain("- [ ] What is the retry policy?\n");
    expect(r.content).toContain("deferred to v3 (2026-10-08, Alex)");
    expect(reopenDeferred(r.content, 2).count).toBe(0);
  });
});

describe("em slice defer (CLI acceptance, MIL-275)", () => {
  let dir: string;
  const slicePath = () => join(dir, "slices", "pay.md");
  const ready = () => em(["validate", "model.em", "--slice-ready", "pay"], dir);
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-cli-defer-"));
    mkdirSync(join(dir, "slices"));
    writeFileSync(
      slicePath(),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ready-to-implement\nversion: 1\n" +
        "reviewedBy: Sam\nreviewedOn: 2026-10-01\nratifiedBy: Alex\nratifiedOn: 2026-10-02\n---\n# Slice: Pay\n\n## Open Questions\n\n- [ ] What is the retry policy?\n",
    );
    writeFileSync(
      join(dir, "model.em"),
      'slice "Pay" {\n  ui Screen @Customer\n  command Pay Now note "slices/pay.md"\n  event Paid\n}\nslice "Read Model" {\n  view Paid List from "Paid"\n  ui List Screen @Customer\n}\n',
    );
    writeFileSync(join(dir, ".event-modeling.md"), STATE);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("fails slice-ready, defers, then passes slice-ready", () => {
    expect(ready().status).toBe(1);
    const d = em(["slice", "defer", "model.em", "pay", "retry policy", "--until", "v2", "--decision", "fail fast", "--by", "Alex", "--on", "2026-10-08"], dir);
    expect(d.stderr).toBe("");
    expect(d.stdout).toBe("deferred: slices/pay.md (retry policy → v2)\n");
    expect(readFileSync(slicePath(), "utf8")).toContain(
      "- [x] What is the retry policy? — v1: fail fast; deferred to v2 (2026-10-08, Alex)",
    );
    expect(ready().status).toBe(0);
    const state = readFileSync(join(dir, ".event-modeling.md"), "utf8");
    expect(state).toContain("- retry policy (from slice pay, deferred to v2)");
    expect(state).toContain('- 2026-10-08: deferred "retry policy" on pay to v2 — v1: fail fast — by Alex');
  });
  it("a second identical run is a no-op", () => {
    const before = [readFileSync(slicePath(), "utf8"), readFileSync(join(dir, ".event-modeling.md"), "utf8")];
    const d = em(["slice", "defer", "model.em", "pay", "retry policy", "--until", "v2", "--decision", "fail fast", "--by", "Alex", "--on", "2026-10-08"], dir);
    expect(d.status).toBe(0);
    expect(d.stdout).toBe("already deferred (no-op): slices/pay.md\n");
    expect([readFileSync(slicePath(), "utf8"), readFileSync(join(dir, ".event-modeling.md"), "utf8")]).toEqual(before);
  });
  it("refuses with the exact message and exit 1 (checked item)", () => {
    const d = em(["slice", "defer", "model.em", "pay", "retry policy", "--until", "v3", "--decision", "x"], dir);
    expect(d.status).toBe(1);
    expect(d.stderr).toBe(
      "em slice defer: slices/pay.md: already checked: What is the retry policy? — v1: fail fast; deferred to v2 (2026-10-08, Alex)\n",
    );
  });
  it("refuses an invalid --on", () => {
    const a = em(["slice", "defer", "model.em", "pay", "q", "--until", "v2", "--decision", "x", "--on", "nope"], dir);
    expect(a.stderr).toBe('em slice defer: invalid --on date "nope" — expected YYYY-MM-DD\n');
    expect(a.status).toBe(1);
  });
  it("refuses when the state file is absent and writes nothing", () => {
    const d2 = mkdtempSync(join(tmpdir(), "em-cli-defer-nostate-"));
    try {
      mkdirSync(join(d2, "slices"));
      writeFileSync(join(d2, "slices", "pay.md"), "---\nversion: 1\nstatus: draft\nschemaVersion: 1\npattern: state-change\nswimlane: order\n---\n## Open Questions\n\n- [ ] q1\n");
      writeFileSync(join(d2, "model.em"), readFileSync(join(dir, "model.em"), "utf8"));
      const d = em(["slice", "defer", "model.em", "pay", "q1", "--until", "v2", "--decision", "x"], d2);
      expect(d.status).toBe(1);
      expect(d.stderr).toBe("em slice defer: no .event-modeling.md beside the model — defer mirrors into it and never creates it\n");
      expect(readFileSync(join(d2, "slices", "pay.md"), "utf8")).toContain("- [ ] q1");
    } finally {
      rmSync(d2, { recursive: true, force: true });
    }
  });
  it("reratify to v2 re-opens exactly that item and slice-ready fails again", () => {
    const r = em(["slice", "reratify", "model.em", "pay"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("re-opened 1 deferred question(s)");
    expect(readFileSync(slicePath(), "utf8")).toContain("\n- [ ] What is the retry policy?\n");
    expect(ready().status).toBe(1);
  });
});

describe("skills carry the deferral sentence (MIL-275 grep gate)", () => {
  const SENTENCE =
    'A question this version will not answer is deferred with `em slice defer <model> <key> "<question>" --until v<n> --decision "<what this version does>"` — never left `- [ ]`, never deleted, never answered by guessing.';
  for (const skill of ["event-modeling-design", "event-modeling-review"]) {
    it(`${skill} names em slice defer`, () => {
      expect(readFileSync(join(ROOT, ".claude", "skills", skill, "SKILL.md"), "utf8")).toContain(SENTENCE);
    });
  }
});
