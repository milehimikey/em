// SPDX-License-Identifier: MIT
// Coverage for `em ledger`'s core logic (src/cli/ledgerCheck.ts): version/content agreement
// across two git revisions. The git runner is injected with a fake, same convention as
// test/diff-inputs.test.ts — every branch (finding codes, skip reasons, the re-ratification
// exclusion) is exercised without a subprocess or a real repo. `to` is always given a concrete
// revision in these tests (never null/working-tree) so every doc read goes through the fake git
// queue rather than real fs — the working-tree form is covered by the real-git-repo CLI tests
// instead (test/cli.test.ts).
import { describe, it, expect } from "vitest";
import { checkLedger, applyLedgerWaivers, readLedgerWaiverTrailers, LedgerCheckResult, LedgerFinding } from "../src/cli/ledgerCheck.js";
import { GitResult, GitRunner } from "../src/cli/diff-inputs.js";

// A fake git runner that replays a queue of canned results in call order — same helper shape
// diff-inputs.test.ts uses.
const fakeGit = (responses: GitResult[]): GitRunner => {
  let i = 0;
  return () => responses[i++] ?? { status: 1, stdout: "", stderr: "unexpected extra git call" };
};
const ok = (stdout: string): GitResult => ({ status: 0, stdout, stderr: "" });

/** A well-formed slice doc with every required key present. */
function doc(version: number, status: string, implementedIn: string, body: string, extra = ""): string {
  return `---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ${status}\nversion: ${version}\nimplementedIn: ${implementedIn}\n${extra}---\n${body}\n`;
}

/** The full 10-call sequence for one slice key resolvable at both `from` and `to`: two
 *  listSliceKeysAtRevision calls (rev-parse + ls-tree each), then two resolveDocAtRevision calls
 *  (rev-parse + ls-tree + show each). */
function bothRevisionsResponses(sliceKey: string, oldDocContent: string, newDocContent: string): GitResult[] {
  return [
    ok("/repo\n"), // listSliceKeysAtRevision(from): rev-parse
    ok(`slices/${sliceKey}.md\n`), // listSliceKeysAtRevision(from): ls-tree
    ok("/repo\n"), // listSliceKeysAtRevision(to): rev-parse
    ok(`slices/${sliceKey}.md\n`), // listSliceKeysAtRevision(to): ls-tree
    ok("/repo\n"), // resolveDocAtRevision(from): rev-parse
    ok(`slices/${sliceKey}.md\n`), // resolveDocAtRevision(from): ls-tree
    ok(oldDocContent), // resolveDocAtRevision(from): show
    ok("/repo\n"), // resolveDocAtRevision(to): rev-parse
    ok(`slices/${sliceKey}.md\n`), // resolveDocAtRevision(to): ls-tree
    ok(newDocContent), // resolveDocAtRevision(to): show
  ];
}

describe("checkLedger: findings", () => {
  it("reports no finding when a version bump travels together with a body change", () => {
    const oldDoc = doc(1, "implemented", "PR#1", "Original body.");
    const newDoc = doc(2, "implemented", "PR#1", "Updated body.");
    const result = checkLedger("model.em", "HEAD~1", "HEAD", fakeGit(bothRevisionsResponses("checkout", oldDoc, newDoc)));
    expect(result.findings).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.checkedCount).toBe(1);
  });

  it("flags a version bump with no content change", () => {
    const body = "Same body, nothing changed.";
    const oldDoc = doc(1, "implemented", "PR#1", body);
    const newDoc = doc(2, "implemented", "PR#1", body);
    const result = checkLedger("model.em", "HEAD~1", "HEAD", fakeGit(bothRevisionsResponses("checkout", oldDoc, newDoc)));
    expect(result.findings).toEqual([
      {
        sliceKey: "checkout",
        code: "ledger-version-without-content-change",
        message: 'slice "checkout": version: bumped (v1 -> v2) but doc content is unchanged',
        oldVersion: 1,
        newVersion: 2,
        bodyChanged: false,
        lineageChanged: false,
      },
    ]);
  });

  it("flags a content change with no version bump", () => {
    const oldDoc = doc(3, "implemented", "PR#1", "Original body.");
    const newDoc = doc(3, "implemented", "PR#1", "Updated body — a real edit.");
    const result = checkLedger("model.em", "HEAD~1", "HEAD", fakeGit(bothRevisionsResponses("checkout", oldDoc, newDoc)));
    expect(result.findings).toEqual([
      {
        sliceKey: "checkout",
        code: "ledger-content-without-version-bump",
        message: 'slice "checkout": doc content changed but version: didn\'t bump (still v3)',
        oldVersion: 3,
        newVersion: 3,
        bodyChanged: true,
        lineageChanged: false,
      },
    ]);
  });

  it("flags a lineage-only change (split-from added) with no version bump", () => {
    const oldDoc = doc(1, "implemented", "PR#1", "Body unchanged.");
    const newDoc = doc(1, "implemented", "PR#1", "Body unchanged.", "split-from: checkout@v1\n");
    const result = checkLedger("model.em", "HEAD~1", "HEAD", fakeGit(bothRevisionsResponses("apply-discount", oldDoc, newDoc)));
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: "ledger-content-without-version-bump",
        bodyChanged: false,
        lineageChanged: true,
      }),
    ]);
  });

  it("flags a version regression (newVersion < oldVersion)", () => {
    const body = "Same body either way.";
    const oldDoc = doc(3, "implemented", "PR#1", body);
    const newDoc = doc(2, "implemented", "PR#1", body);
    const result = checkLedger("model.em", "HEAD~1", "HEAD", fakeGit(bothRevisionsResponses("checkout", oldDoc, newDoc)));
    expect(result.findings).toEqual([
      {
        sliceKey: "checkout",
        code: "ledger-version-regression",
        message: 'slice "checkout": version went backwards (v3 -> v2)',
        oldVersion: 3,
        newVersion: 2,
        bodyChanged: false,
        lineageChanged: false,
      },
    ]);
  });

  it("does not flag a status-only transition — the documented re-ratification convention", () => {
    // Same version, same body — only status flips (implemented -> ready-to-implement), which is
    // exactly what re-ratifying a shipped slice does (docs/slice-doc-schema.md, "status under
    // re-ratification"). If status were included in the content comparison, this would
    // false-positive as "content changed without version bump" — the check this test guards.
    const body = "Unchanged body.";
    const oldDoc = doc(2, "implemented", "PR#1", body);
    const newDoc = doc(2, "ready-to-implement", "PR#1", body);
    const result = checkLedger("model.em", "HEAD~1", "HEAD", fakeGit(bothRevisionsResponses("checkout", oldDoc, newDoc)));
    expect(result.findings).toEqual([]);
  });

  it("does not flag an implementedIn-only change (ship-time link added)", () => {
    const body = "Unchanged body.";
    const oldDoc = doc(2, "ready-to-implement", "", body);
    const newDoc = doc(2, "implemented", "PR#42", body);
    const result = checkLedger("model.em", "HEAD~1", "HEAD", fakeGit(bothRevisionsResponses("checkout", oldDoc, newDoc)));
    expect(result.findings).toEqual([]);
  });
});

describe("checkLedger: skips", () => {
  it("skips a slice absent at --from as no-prior-revision", () => {
    const git = fakeGit([
      ok("/repo\n"), // listSliceKeysAtRevision(from): rev-parse
      ok("\n"), // listSliceKeysAtRevision(from): ls-tree — empty, nothing at `from`
      ok("/repo\n"), // listSliceKeysAtRevision(to): rev-parse
      ok("slices/checkout.md\n"), // listSliceKeysAtRevision(to): ls-tree
      ok("/repo\n"), // resolveDocAtRevision(from): rev-parse
      ok("\n"), // resolveDocAtRevision(from): ls-tree — not tracked at `from` either
    ]);
    const result = checkLedger("model.em", "HEAD~1", "HEAD", git);
    expect(result.findings).toEqual([]);
    expect(result.skipped).toEqual([{ sliceKey: "checkout", reason: "no-prior-revision" }]);
    expect(result.checkedCount).toBe(1);
  });

  it("skips a slice deleted between --from and --to as deleted", () => {
    const oldDoc = doc(1, "implemented", "PR#1", "Body.");
    const git = fakeGit([
      ok("/repo\n"), // listSliceKeysAtRevision(from): rev-parse
      ok("slices/checkout.md\n"), // listSliceKeysAtRevision(from): ls-tree
      ok("/repo\n"), // listSliceKeysAtRevision(to): rev-parse
      ok("\n"), // listSliceKeysAtRevision(to): ls-tree — gone by `to`
      ok("/repo\n"), // resolveDocAtRevision(from): rev-parse
      ok("slices/checkout.md\n"), // resolveDocAtRevision(from): ls-tree
      ok(oldDoc), // resolveDocAtRevision(from): show
      ok("/repo\n"), // resolveDocAtRevision(to): rev-parse
      ok("\n"), // resolveDocAtRevision(to): ls-tree — not tracked at `to`
    ]);
    const result = checkLedger("model.em", "HEAD~1", "HEAD", git);
    expect(result.findings).toEqual([]);
    expect(result.skipped).toEqual([{ sliceKey: "checkout", reason: "deleted" }]);
  });

  it("skips a slice with unusable frontmatter (missing required key) as frontmatter-invalid", () => {
    // No `version:` line — missingRequiredFields includes "version", hasUsableFrontmatter false.
    const invalidDoc = "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: implemented\n---\nBody.\n";
    const validDoc = doc(1, "implemented", "PR#1", "Body.");
    const result = checkLedger(
      "model.em",
      "HEAD~1",
      "HEAD",
      fakeGit(bothRevisionsResponses("checkout", invalidDoc, validDoc)),
    );
    expect(result.findings).toEqual([]);
    expect(result.skipped).toEqual([{ sliceKey: "checkout", reason: "frontmatter-invalid" }]);
  });

  it("skips a slice with a present-but-unparseable version (e.g. non-numeric) as frontmatter-invalid", () => {
    // The `version:` *key* is present — hasUsableFrontmatter() alone would pass this — but its
    // value isn't a valid positive integer, so SliceDoc.version parses to null (sliceDoc.ts's
    // parseVersion()). Content also genuinely changed here: without the explicit null check,
    // this used to fall through to a non-null assertion and mis-report as
    // ledger-version-regression with a garbled "v1 -> vnull" message instead of being skipped.
    const oldDoc = doc(1, "implemented", "PR#1", "Original body.");
    const newDocWithBadVersion = "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: implemented\nversion: abc\nimplementedIn: PR#1\n---\nUpdated body.\n";
    const result = checkLedger(
      "model.em",
      "HEAD~1",
      "HEAD",
      fakeGit(bothRevisionsResponses("checkout", oldDoc, newDocWithBadVersion)),
    );
    expect(result.findings).toEqual([]);
    expect(result.skipped).toEqual([{ sliceKey: "checkout", reason: "frontmatter-invalid" }]);
  });
});

// --- MIL-185: waivers ---------------------------------------------------------------------

/** A minimal `ledger-content-without-version-bump` finding — the only waivable code. */
function contentFinding(sliceKey: string): LedgerFinding {
  return {
    sliceKey,
    code: "ledger-content-without-version-bump",
    message: `slice "${sliceKey}": doc content changed but version: didn't bump (still v1)`,
    oldVersion: 1,
    newVersion: 1,
    bodyChanged: true,
    lineageChanged: false,
  };
}

function regressionFinding(sliceKey: string): LedgerFinding {
  return {
    sliceKey,
    code: "ledger-version-regression",
    message: `slice "${sliceKey}": version went backwards (v3 -> v2)`,
    oldVersion: 3,
    newVersion: 2,
    bodyChanged: false,
    lineageChanged: false,
  };
}

function baseResult(findings: LedgerFinding[]): LedgerCheckResult {
  return { findings, waived: [], skipped: [], checkedCount: findings.length };
}

describe("applyLedgerWaivers", () => {
  it("waives a ledger-content-without-version-bump finding named by --waive", () => {
    const result = baseResult([contentFinding("checkout")]);
    const { result: out, unknownWaivers } = applyLedgerWaivers(result, ["checkout"], []);
    expect(out.findings).toEqual([]);
    expect(out.waived).toEqual([{ ...contentFinding("checkout"), waivedBy: { source: "flag" } }]);
    expect(unknownWaivers).toEqual([]);
  });

  it("waives a finding named by a trailer, carrying the commit that declared it", () => {
    const result = baseResult([contentFinding("checkout")]);
    const { result: out, unknownWaivers } = applyLedgerWaivers(result, [], [{ sliceKey: "checkout", commit: "abc1234" }]);
    expect(out.findings).toEqual([]);
    expect(out.waived).toEqual([{ ...contentFinding("checkout"), waivedBy: { source: "trailer", commit: "abc1234" } }]);
    expect(unknownWaivers).toEqual([]);
  });

  it("never waives a version-regression or version-without-content-change finding, even if named", () => {
    const result = baseResult([regressionFinding("checkout")]);
    const { result: out, unknownWaivers } = applyLedgerWaivers(result, ["checkout"], []);
    expect(out.findings).toEqual([regressionFinding("checkout")]);
    expect(out.waived).toEqual([]);
    expect(unknownWaivers).toEqual([{ sliceKey: "checkout", source: { source: "flag" } }]);
  });

  it("reports an unknown-slice waiver (typo'd or already-clean slice key) without erroring", () => {
    const result = baseResult([]);
    const { result: out, unknownWaivers } = applyLedgerWaivers(result, ["no-such-slice"], []);
    expect(out.findings).toEqual([]);
    expect(out.waived).toEqual([]);
    expect(unknownWaivers).toEqual([{ sliceKey: "no-such-slice", source: { source: "flag" } }]);
  });

  it("leaves other findings untouched when only one of several is waived", () => {
    const result = baseResult([contentFinding("checkout"), contentFinding("apply-discount")]);
    const { result: out } = applyLedgerWaivers(result, ["checkout"], []);
    expect(out.findings).toEqual([contentFinding("apply-discount")]);
    expect(out.waived.map((w) => w.sliceKey)).toEqual(["checkout"]);
  });

  it("prefers the flag source over a same-key trailer waiver, with no duplicate unknown-note", () => {
    const result = baseResult([contentFinding("checkout")]);
    const { result: out, unknownWaivers } = applyLedgerWaivers(result, ["checkout"], [{ sliceKey: "checkout", commit: "deadbee" }]);
    expect(out.waived).toEqual([{ ...contentFinding("checkout"), waivedBy: { source: "flag" } }]);
    expect(unknownWaivers).toEqual([]);
  });

  it("deduplicates a slice key repeated across multiple --waive flags", () => {
    const result = baseResult([contentFinding("checkout")]);
    const { result: out } = applyLedgerWaivers(result, ["checkout", "checkout"], []);
    expect(out.waived).toHaveLength(1);
  });

  it("sorts waived entries by slice key regardless of waiver input order", () => {
    const result = baseResult([contentFinding("zeta"), contentFinding("alpha")]);
    const { result: out } = applyLedgerWaivers(result, ["zeta", "alpha"], []);
    expect(out.waived.map((w) => w.sliceKey)).toEqual(["alpha", "zeta"]);
  });
});

describe("readLedgerWaiverTrailers", () => {
  it("reads Em-Ledger-Waive trailers from the from..to range, resolving `to: null` to HEAD", () => {
    const calls: string[][] = [];
    const git: GitRunner = (args) => {
      calls.push(args);
      if (args.includes("rev-parse")) return ok("/repo\n");
      return ok("abc1234full\x00checkout\x01\n");
    };
    const waivers = readLedgerWaiverTrailers("model.em", "HEAD~3", null, git);
    expect(waivers).toEqual([{ sliceKey: "checkout", commit: "abc1234full" }]);
    const logCall = calls.find((c) => c.includes("log"));
    expect(logCall).toBeDefined();
    expect(logCall).toContain("HEAD~3..HEAD");
  });

  it("uses the from..to range verbatim when --to is given", () => {
    const calls: string[][] = [];
    const git: GitRunner = (args) => {
      calls.push(args);
      if (args.includes("rev-parse")) return ok("/repo\n");
      return ok("\x00\x01\n");
    };
    readLedgerWaiverTrailers("model.em", "v1.0", "v1.1", git);
    const logCall = calls.find((c) => c.includes("log"));
    expect(logCall).toContain("v1.0..v1.1");
  });

  it("parses multiple trailer values on one commit into separate waivers", () => {
    const git: GitRunner = (args) => (args.includes("rev-parse") ? ok("/repo\n") : ok("commitA\x00beta\ngamma\x01\n"));
    const waivers = readLedgerWaiverTrailers("model.em", "HEAD~1", "HEAD", git);
    expect(waivers).toEqual([
      { sliceKey: "beta", commit: "commitA" },
      { sliceKey: "gamma", commit: "commitA" },
    ]);
  });

  it("attributes a slice key repeated across commits to the first (earliest, --reverse) commit", () => {
    // --reverse means the git log stream is already oldest-first; "earliest" is simply "first
    // record seen" — this fake replays two commits both carrying "checkout", oldest first.
    const git: GitRunner = (args) =>
      args.includes("rev-parse") ? ok("/repo\n") : ok("oldest\x00checkout\x01\nnewest\x00checkout\x01\n");
    const waivers = readLedgerWaiverTrailers("model.em", "HEAD~2", "HEAD", git);
    expect(waivers).toEqual([{ sliceKey: "checkout", commit: "oldest" }]);
  });

  it("returns no waivers (not a crash) when the range can't be resolved", () => {
    const git: GitRunner = () => ({ status: 1, stdout: "", stderr: "fatal: bad revision" });
    expect(readLedgerWaiverTrailers("model.em", "not-a-rev", "HEAD", git)).toEqual([]);
  });

  it("returns no waivers when anchorFile isn't inside a git repository", () => {
    const git: GitRunner = (args) => (args.includes("rev-parse") ? { status: 128, stdout: "", stderr: "fatal: not a git repository" } : ok(""));
    expect(readLedgerWaiverTrailers("model.em", "HEAD~1", "HEAD", git)).toEqual([]);
  });
});
