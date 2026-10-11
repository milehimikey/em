// SPDX-License-Identifier: MIT
// Coverage for `em slice defer` (src/cli/defer.ts, MIL-275): pure text surgery (applyDefer,
// applyDeferStateFile, reopenDeferred), the fs orchestration, and the CLI acceptance fixture.
// MIL-281 adds `--from-issue`: removeIssueClause / applyDeferFromIssueDoc (pure) and a CLI fixture
// whose slice carries `issue "..."` clauses on its own elements and on a sibling slice's.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyDefer, applyDeferFromIssueDoc, applyDeferStateFile, removeIssueClause, reopenDeferred, DeferInput } from "../src/cli/defer.js";

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

// --- MIL-281: --from-issue ---------------------------------------------------------------------

describe("removeIssueClause (pure, MIL-281)", () => {
  const EM =
    'slice "Pay" {\n' +
    '  ui Screen @Customer\n' +
    '  command Pay Now issue "What about chargebacks?" note "slices/pay.md"\n' +
    "  event Paid {\n" +
    "    id: UUID\n" +
    '  } issue "Is Paid final?"\n' +
    '  issue "alone on its line"\n' +
    "}\n";
  it("cuts an inline clause out of the declaration line, keeping the other clauses", () => {
    const r = removeIssueClause(EM, 3, "What about chargebacks?");
    expect(r).toMatchObject({ ok: true, removedLine: 3 });
    expect(r.ok && r.content).toBe(EM.replace('  command Pay Now issue "What about chargebacks?" note "slices/pay.md"\n', '  command Pay Now note "slices/pay.md"\n'));
  });
  it("scans forward from the declaration line to a clause trailing the field block's `}`", () => {
    const r = removeIssueClause(EM, 4, "Is Paid final?");
    expect(r).toMatchObject({ ok: true, removedLine: 6 });
    expect(r.ok && r.content).toBe(EM.replace('  } issue "Is Paid final?"\n', "  }\n"));
  });
  it("drops the whole line when the clause was alone on it", () => {
    const r = removeIssueClause(EM, 4, "alone on its line");
    expect(r).toMatchObject({ ok: true, removedLine: 7 });
    expect(r.ok && r.content).toBe(EM.replace('  issue "alone on its line"\n', ""));
  });
  it("matches the decoded text, so an escaped quote in the clause is found by its decoded form", () => {
    const em = 'slice "S" {\n  command Do issue "say \\"hi\\" twice"\n}\n';
    const r = removeIssueClause(em, 2, 'say "hi" twice');
    expect(r.ok && r.content).toBe('slice "S" {\n  command Do\n}\n');
  });
  it("preserves CRLF", () => {
    const crlf = EM.replace(/\n/g, "\r\n");
    const r = removeIssueClause(crlf, 3, "What about chargebacks?");
    expect(r.ok && r.content).toBe(crlf.replace('  command Pay Now issue "What about chargebacks?" note "slices/pay.md"\r\n', '  command Pay Now note "slices/pay.md"\r\n'));
  });
  it("skips a different issue on the way and refuses when the text is never found", () => {
    expect(removeIssueClause(EM, 1, "nothing like this")).toEqual({
      ok: false,
      message: 'no `issue "nothing like this"` clause found at or after line 1',
    });
  });
});

describe("applyDeferFromIssueDoc (pure, MIL-281)", () => {
  const INPUT = { until: "v2", decision: "manual review", by: "Alex", on: "2026-10-08", currentVersion: 1 };
  const ITEM = "- [x] What about chargebacks? — v1: manual review; deferred to v2 (2026-10-08, Alex)";
  it("appends the deferred item at the end of Open Questions", () => {
    const r = applyDeferFromIssueDoc(DOC, "What about chargebacks?", INPUT);
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(r.ok && r.content).toContain(`- [x] Settled thing\n${ITEM}\n\n## Notes\n`);
  });
  it("defers an existing unchecked item in place instead of appending a duplicate", () => {
    const r = applyDeferFromIssueDoc(DOC, "retry policy", INPUT);
    expect(r.ok && r.content).toContain("- [x] What is the retry policy? — v1: manual review; deferred to v2 (2026-10-08, Alex)\n- [ ] Who owns billing?\n");
    expect(r.ok && (r.content.match(/retry policy/g) ?? []).length).toBe(1);
  });
  it("opens an Open Questions section at EOF when the doc has none", () => {
    const r = applyDeferFromIssueDoc("---\nversion: 1\n---\n# Slice\n\nbody", "What about chargebacks?", INPUT);
    expect(r.ok && r.content).toBe(`---\nversion: 1\n---\n# Slice\n\nbody\n\n## Open Questions\n\n${ITEM}\n`);
  });
  it("is idempotent once the item is there", () => {
    const first = applyDeferFromIssueDoc(DOC, "What about chargebacks?", INPUT);
    if (!first.ok) throw new Error("setup");
    expect(applyDeferFromIssueDoc(first.content, "What about chargebacks?", INPUT)).toEqual({ ok: true, content: first.content, changed: false });
  });
  it("still validates --until and --decision", () => {
    expect(applyDeferFromIssueDoc(DOC, "x", { ...INPUT, until: "v1" })).toEqual({
      ok: false,
      message: "--until v1 must be greater than the doc's current version v1",
    });
  });
});

describe("em slice defer --from-issue (CLI acceptance, MIL-281)", () => {
  let dir: string;
  const modelPath = () => join(dir, "model.em");
  const slicePath = () => join(dir, "slices", "pay.md");
  const ready = () => em(["validate", "model.em", "--slice-ready", "pay"], dir);
  const issues = () => em(["validate", "model.em", "--list-issues"], dir).stdout;
  const defer = (...args: string[]) => em(["slice", "defer", "model.em", "pay", ...args, "--until", "v2", "--decision", "manual review", "--by", "Alex", "--on", "2026-10-08"], dir);
  const EM =
    'slice "Pay" {\n' +
    "  ui Screen @Customer\n" +
    '  command Pay Now issue "What about chargebacks?" note "slices/pay.md"\n' +
    '  event Paid issue "Is Paid final?"\n' +
    "}\n" +
    'slice "Read Model" {\n' +
    '  view Paid List from "Paid" issue "Are chargebacks shown?"\n' +
    "  ui List Screen @Customer\n" +
    "}\n";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-cli-defer-issue-"));
    mkdirSync(join(dir, "slices"));
    writeFileSync(
      slicePath(),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ready-to-implement\nversion: 1\n" +
        "reviewedBy: Sam\nreviewedOn: 2026-10-01\nratifiedBy: Alex\nratifiedOn: 2026-10-02\n---\n# Slice: Pay\n\n## Open Questions\n\n## Notes\n",
    );
    writeFileSync(modelPath(), EM);
    writeFileSync(join(dir, ".event-modeling.md"), STATE);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("refuses both or neither of <question> and --from-issue", () => {
    const both = em(["slice", "defer", "model.em", "pay", "q", "--from-issue", "x", "--until", "v2", "--decision", "d"], dir);
    expect(both.status).toBe(1);
    expect(both.stderr).toBe('em slice defer: pass either "<question>" or --from-issue <text>, not both and not neither\n');
    const neither = em(["slice", "defer", "model.em", "pay", "--until", "v2", "--decision", "d"], dir);
    expect(neither.status).toBe(1);
    expect(neither.stderr).toBe(both.stderr);
  });
  it("refuses an ambiguous text, naming each candidate with its .em line; nothing written", () => {
    const d = defer("--from-issue", "?");
    expect(d.status).toBe(1);
    // The open-issue warnings themselves precede the refusal on stderr (printDiagnostics, like every command).
    expect(d.stderr.endsWith('em slice defer: ambiguous — matches: command "Pay Now" :3 issue "What about chargebacks?" | event "Paid" :4 issue "Is Paid final?"\n')).toBe(true);
    expect(readFileSync(modelPath(), "utf8")).toBe(EM);
  });
  it("refuses a text that matches no issue on THIS slice (a sibling slice's issue is not a candidate)", () => {
    const d = defer("--from-issue", "shown");
    expect(d.status).toBe(1);
    expect(d.stderr.endsWith('em slice defer: no open issue matching "shown" on slice "pay" (see `em validate --list-issues`)\n')).toBe(true);
  });
  it("promotes the issue: doc item appended, state mirrored, clause removed from the .em, --list-issues shrinks", () => {
    expect(issues()).toContain('issue :3 slice "Pay" command "Pay Now": What about chargebacks?');
    expect(ready().status).toBe(1); // open issues count against readiness
    const d = defer("--from-issue", "chargebacks");
    expect(d.stderr).not.toContain("em slice defer:"); // only the model's own open-issue warnings
    expect(d.status).toBe(0);
    expect(d.stdout).toBe('deferred: slices/pay.md (issue "What about chargebacks?" → v2; issue clause removed from model.em:3)\n');
    expect(readFileSync(modelPath(), "utf8")).toBe(EM.replace('  command Pay Now issue "What about chargebacks?" note "slices/pay.md"\n', '  command Pay Now note "slices/pay.md"\n'));
    expect(readFileSync(slicePath(), "utf8")).toContain(
      "## Open Questions\n\n- [x] What about chargebacks? — v1: manual review; deferred to v2 (2026-10-08, Alex)\n\n## Notes\n",
    );
    const state = readFileSync(join(dir, ".event-modeling.md"), "utf8");
    expect(state).toContain("- What about chargebacks? (from slice pay, deferred to v2)");
    expect(state).toContain('- 2026-10-08: deferred "What about chargebacks?" on pay to v2 — v1: manual review — by Alex');
    const after = issues();
    expect(after).not.toContain("What about chargebacks?");
    expect(after).toContain("Are chargebacks shown?"); // the sibling slice's issue is untouched
  });
  it("a second identical run is a no-op on all three files", () => {
    const before = [modelPath(), slicePath(), join(dir, ".event-modeling.md")].map((p) => readFileSync(p, "utf8"));
    const d = defer("--from-issue", "chargebacks");
    expect(d.status).toBe(0);
    expect(d.stdout).toBe("already deferred (no-op): slices/pay.md\n");
    expect([modelPath(), slicePath(), join(dir, ".event-modeling.md")].map((p) => readFileSync(p, "utf8"))).toEqual(before);
  });
  it("deferring the slice's last open issue makes --slice-ready pass; reratify re-opens both", () => {
    expect(defer("--from-issue", "final").status).toBe(0);
    expect(readFileSync(modelPath(), "utf8")).toContain("  event Paid\n");
    expect(ready().status).toBe(0);
    const r = em(["slice", "reratify", "model.em", "pay"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("re-opened 2 deferred question(s)");
    expect(readFileSync(slicePath(), "utf8")).toContain("- [ ] What about chargebacks?\n- [ ] Is Paid final?\n");
  });
  it("points at the positional form when the text matches a hand-written `- [ ]` item but no issue clause", () => {
    // After reratify the doc is at v2, both questions are back on it unchecked, and the .em
    // carries no clause.
    const d = em(["slice", "defer", "model.em", "pay", "--from-issue", "chargebacks", "--until", "v3", "--decision", "later"], dir);
    expect(d.status).toBe(1);
    expect(d.stderr.endsWith(
      'em slice defer: no open issue matching "chargebacks" on slice "pay" — but slices/pay.md has an unchecked Open Question containing it; ' +
        'defer that with the positional form: em slice defer <model> pay "chargebacks" --until v3 --decision "..."\n',
    )).toBe(true);
  });
});

describe("skills carry the deferral sentence (MIL-275 grep gate)", () => {
  const SENTENCE =
    'A question this version will not answer is deferred with `em slice defer <model> <key> "<question>" --until v<n> --decision "<what this version does>"` — never left `- [ ]`, never deleted, never answered by guessing.';
  const FROM_ISSUE = '`em slice defer <model> <key> --from-issue "<text>" --until v<n> --decision "<what this version does>"`';
  for (const skill of ["event-modeling-design", "event-modeling-review"]) {
    it(`${skill} names em slice defer, both forms (MIL-275 + MIL-282)`, () => {
      const text = readFileSync(join(ROOT, ".claude", "skills", skill, "SKILL.md"), "utf8");
      expect(text).toContain(SENTENCE);
      expect(text).toContain(FROM_ISSUE);
      expect(text.replace(/\s+/g, " ")).toMatch(/never a deferral|Defer is never used to record an answer/);
    });
  }
  it("the review skill gives each question one of three endings before `em slice review`", () => {
    const review = readFileSync(join(ROOT, ".claude", "skills", "event-modeling-review", "SKILL.md"), "utf8").replace(/\s+/g, " ");
    for (const s of ["**Answered in the room**", "**Raised in the room, not for this version**", "**Already on the doc, not for this version**", "nothing left `- [ ]` and no open `issue`"]) {
      expect(review, s).toContain(s);
    }
  });
});
