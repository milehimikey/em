// SPDX-License-Identifier: MIT
// GH #258: `em refs` — do the commits a model's slice docs record (`ratifiedRef:`, `shippedRef:`,
// a bare `conformedAt:`) still resolve, and are they reachable from the target branch? Pure
// coverage of the waiver and classification logic with a fake GitRunner, then the real thing:
// a repository where one slice was ratified on a PR branch that was squash-merged and deleted
// (`not-ancestor`), one ratified on main (`ancestor`), a hand-edited sha (`unresolved`), a kinded
// `conformedAt` (skipped), and a shallow clone of it all (`undecidable`, never a pass).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { gitInitQuiet } from "./helpers/gitInitQuiet.js";
import { rmTemp } from "./helpers/rmTemp.js";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyRefWaivers, classifyRatificationOrder, classifyRef, OrderResult, readWaiveFile, RefsCheckResult, RefResult } from "../src/cli/refsCheck.js";
import type { GitRunner } from "../src/cli/diff-inputs.js";

vi.setConfig({ testTimeout: 30_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");
const em = (args: string[], cwd: string) => {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
};
const git = (dir: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.email=t@t.test", "-c", "user.name=t", "-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
};

const TARGET = "a".repeat(40);
const fakeGit =
  (answers: Record<string, { status: number; stdout?: string; stderr?: string }>): GitRunner =>
  (args) => {
    const key = args.slice(2).join(" ");
    const a = answers[key] ?? { status: 128 };
    return { status: a.status, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  };

describe("classifyRef (fake git)", () => {
  it("ancestor / not-ancestor / unresolved / undecidable, and shallow short-circuits before any git call", () => {
    const base = { [`cat-file -e abc^{commit}`]: { status: 0 } };
    expect(classifyRef(fakeGit({ ...base, [`merge-base --is-ancestor abc ${TARGET}`]: { status: 0 } }), "/m", "abc", TARGET, false)).toEqual({ status: "ancestor", detail: null });
    expect(classifyRef(fakeGit({ ...base, [`merge-base --is-ancestor abc ${TARGET}`]: { status: 1 } }), "/m", "abc", TARGET, false)).toMatchObject({ status: "not-ancestor" });
    expect(classifyRef(fakeGit({ [`cat-file -e abc^{commit}`]: { status: 128 } }), "/m", "abc", TARGET, false)).toMatchObject({ status: "unresolved" });
    expect(classifyRef(fakeGit({ ...base, [`merge-base --is-ancestor abc ${TARGET}`]: { status: 129, stderr: "fatal: odd" } }), "/m", "abc", TARGET, false)).toEqual({ status: "undecidable", detail: "git merge-base failed: fatal: odd" });
    let calls = 0;
    const counting: GitRunner = (args) => {
      calls++;
      return fakeGit({})(args);
    };
    expect(classifyRef(counting, "/m", "abc", TARGET, true)).toMatchObject({ status: "undecidable", detail: expect.stringContaining("shallow clone") });
    expect(calls).toBe(0);
  });
});

// GH #399: the advisory ratification-order check. Slate entry + R5 — advisory because history is
// rewritable, never a validate gate, never folded into `em refs`' own exit code.
describe("classifyRatificationOrder (fake git)", () => {
  const DOC = "slices/pay.md";

  it("shallow short-circuits before any git call", () => {
    let calls = 0;
    const counting: GitRunner = (args) => {
      calls++;
      return fakeGit({})(args);
    };
    expect(classifyRatificationOrder(counting, "/m", "abc", TARGET, DOC, true)).toEqual({
      status: "undecidable",
      commit: null,
      detail: expect.stringContaining("shallow clone"),
    });
    expect(calls).toBe(0);
  });

  it("a ratifiedRef that no longer resolves is undecidable", () => {
    const run = fakeGit({ "cat-file -e abc^{commit}": { status: 128 } });
    expect(classifyRatificationOrder(run, "/m", "abc", TARGET, DOC, false)).toMatchObject({
      status: "undecidable",
      commit: null,
      detail: expect.stringContaining("does not resolve"),
    });
  });

  it("a failed merge-base is undecidable", () => {
    const run = fakeGit({
      "cat-file -e abc^{commit}": { status: 0 },
      [`merge-base abc ${TARGET}`]: { status: 128, stderr: "fatal: bad revision" },
    });
    expect(classifyRatificationOrder(run, "/m", "abc", TARGET, DOC, false)).toMatchObject({
      status: "undecidable",
      detail: expect.stringContaining("git merge-base failed"),
    });
  });

  it("ratified directly on the target (fork point IS ratifiedRef): clean own commit reads ratified-first", () => {
    const run = fakeGit({
      "cat-file -e abc^{commit}": { status: 0 },
      [`merge-base abc ${TARGET}`]: { status: 0, stdout: "abc\n" },
      "diff-tree --no-commit-id --name-only -r abc": { status: 0, stdout: `${DOC}\n` },
    });
    expect(classifyRatificationOrder(run, "/m", "abc", TARGET, DOC, false)).toEqual({ status: "ratified-first", commit: null, detail: null });
  });

  it("a failed rev-list is undecidable", () => {
    const run = fakeGit({
      "cat-file -e abc^{commit}": { status: 0 },
      [`merge-base abc ${TARGET}`]: { status: 0, stdout: "base1\n" },
      "rev-list base1..abc": { status: 128, stderr: "fatal: bad range" },
    });
    expect(classifyRatificationOrder(run, "/m", "abc", TARGET, DOC, false)).toMatchObject({
      status: "undecidable",
      detail: expect.stringContaining("git rev-list failed"),
    });
  });

  it("an earlier commit touching code before ratifiedRef is code-before-ratification, naming the earliest offender", () => {
    const run = fakeGit({
      "cat-file -e abc^{commit}": { status: 0 },
      [`merge-base abc ${TARGET}`]: { status: 0, stdout: "base1\n" },
      "rev-list base1..abc": { status: 0, stdout: "abc\nc2\nc1\n" },
      "diff-tree --no-commit-id --name-only -r c1": { status: 0, stdout: "src/foo.ts\n" },
      // c2 and abc are never inspected: the oldest offender (c1) is reported first.
    });
    const r = classifyRatificationOrder(run, "/m", "abc", TARGET, DOC, false);
    expect(r.status).toBe("code-before-ratification");
    expect(r.commit).toBe("c1");
    expect(r.detail).toContain(`touched code other than ${DOC}`);
  });

  it("a diff-tree failure on an earlier commit is undecidable, naming the commit", () => {
    const run = fakeGit({
      "cat-file -e abc^{commit}": { status: 0 },
      [`merge-base abc ${TARGET}`]: { status: 0, stdout: "base1\n" },
      "rev-list base1..abc": { status: 0, stdout: "abc\nc1\n" },
      "diff-tree --no-commit-id --name-only -r c1": { status: 128, stderr: "fatal: bad object" },
    });
    expect(classifyRatificationOrder(run, "/m", "abc", TARGET, DOC, false)).toMatchObject({
      status: "undecidable",
      detail: expect.stringContaining("git diff-tree failed on c1"),
    });
  });

  it("earlier commits are doc-only, but the ratification commit itself bundles code: undecidable (no decidable order within one commit)", () => {
    const run = fakeGit({
      "cat-file -e abc^{commit}": { status: 0 },
      [`merge-base abc ${TARGET}`]: { status: 0, stdout: "base1\n" },
      "rev-list base1..abc": { status: 0, stdout: "abc\nc1\n" },
      "diff-tree --no-commit-id --name-only -r c1": { status: 0, stdout: `${DOC}\n` },
      "diff-tree --no-commit-id --name-only -r abc": { status: 0, stdout: `${DOC}\nsrc/foo.ts\n` },
    });
    const r = classifyRatificationOrder(run, "/m", "abc", TARGET, DOC, false);
    expect(r.status).toBe("undecidable");
    expect(r.commit).toBe(null);
    expect(r.detail).toContain("no decidable order within itself");
  });

  it("every commit up to and including ratifiedRef only touches the doc: ratified-first", () => {
    const run = fakeGit({
      "cat-file -e abc^{commit}": { status: 0 },
      [`merge-base abc ${TARGET}`]: { status: 0, stdout: "base1\n" },
      "rev-list base1..abc": { status: 0, stdout: "abc\nc1\n" },
      "diff-tree --no-commit-id --name-only -r c1": { status: 0, stdout: `${DOC}\n` },
      "diff-tree --no-commit-id --name-only -r abc": { status: 0, stdout: `${DOC}\n` },
    });
    expect(classifyRatificationOrder(run, "/m", "abc", TARGET, DOC, false)).toEqual({ status: "ratified-first", commit: null, detail: null });
  });
});

describe("applyRefWaivers / readWaiveFile (pure)", () => {
  const r = (sliceKey: string, field: RefResult["field"], status: RefResult["status"]): RefResult => ({ sliceKey, path: `slices/${sliceKey}.md`, field, ref: "deadbeef", status, detail: null });
  const base = (results: RefResult[]): RefsCheckResult => ({ reachableFrom: "main", target: TARGET, shallow: false, checkedDocs: 2, checkedRefs: results.length, results, waived: [], ok: results.every((x) => x.status === "ancestor") });

  it("a waiver excuses every non-ancestor result on its key, leaves ancestor results and other keys alone, and flips ok", () => {
    const res = base([r("pay", "ratifiedRef", "not-ancestor"), r("pay", "shippedRef", "not-ancestor"), r("pay", "conformedAt", "ancestor"), r("ship", "ratifiedRef", "unresolved")]);
    const { result, unknownWaivers } = applyRefWaivers(res, ["pay"], [], null);
    expect(result.results.map((x) => [x.sliceKey, x.field])).toEqual([["pay", "conformedAt"], ["ship", "ratifiedRef"]]);
    expect(result.waived.map((x) => [x.field, x.waivedBy])).toEqual([["ratifiedRef", { source: "flag" }], ["shippedRef", { source: "flag" }]]);
    expect(result.ok).toBe(false); // ship is still unresolved
    expect(unknownWaivers).toEqual([]);
    const all = applyRefWaivers(res, ["pay"], ["ship"], "/repo/refs-baseline.txt");
    expect(all.result.ok).toBe(true);
    expect(all.result.waived.find((x) => x.sliceKey === "ship")?.waivedBy).toEqual({ source: "file", path: "/repo/refs-baseline.txt" });
  });

  it("a waiver with nothing to excuse is reported, not swallowed; the flag wins over the file for the same key", () => {
    const res = base([r("pay", "ratifiedRef", "ancestor")]);
    const { result, unknownWaivers } = applyRefWaivers(res, ["pay", "nope"], ["pay"], "/b");
    expect(result.waived).toEqual([]);
    expect(unknownWaivers).toEqual([
      { sliceKey: "pay", source: { source: "flag" } },
      { sliceKey: "nope", source: { source: "flag" } },
    ]);
  });

  it("readWaiveFile: one key per line, comments and blanks ignored, missing file is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-refs-waive-"));
    writeFileSync(join(dir, "b.txt"), "# baseline from before em refs ran\npay   # ratified on a squashed branch\n\nship\n");
    expect(readWaiveFile(join(dir, "b.txt"))).toEqual(["pay", "ship"]);
    expect(readWaiveFile(join(dir, "missing.txt"))).toEqual([]);
    rmTemp(dir);
  });
});

const MODEL = [
  'slice "Pay" {\n  ui Screen @Customer\n  command Pay Now note "slices/pay.md"\n  event Paid\n}',
  'slice "Ship" {\n  command Ship It note "slices/ship.md"\n  event Shipped\n}',
  'slice "Read Model" {\n  view Paid List from "Paid"\n  view Shipped List from "Shipped"\n  ui List Screen @Customer\n}',
].join("\n") + "\n";
const BODY = "# Slice\n\n## Intent\n\nDo the thing.\n\n## Open Questions\n\n## Notes\n\nnone\n";
const reviewed = (title: string) => `---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: reviewed\nversion: 1\nreviewedBy: Sam\nreviewedOn: 2026-10-01\n---\n${BODY.replace("# Slice", `# Slice: ${title}`)}`;

describe("em refs (CLI, real git): squash-merged ratification, main ratification, unresolved sha, kinded conformedAt, shallow clone", () => {
  let dir: string;
  let shallow: string;
  const read = (k: string) => readFileSync(join(dir, "slices", `${k}.md`), "utf8");
  const refsOf = (k: string) => /ratifiedRef: (\S+)/.exec(read(k))![1];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-gh258-"));
    mkdirSync(join(dir, "slices"));
    writeFileSync(join(dir, "slices", "pay.md"), reviewed("Pay"));
    writeFileSync(join(dir, "slices", "ship.md"), reviewed("Ship"));
    writeFileSync(join(dir, "model.em"), MODEL);
    gitInitQuiet(dir, "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "reviewed docs");
    // `ship`: ratified on main → ancestor.
    let r = em(["slice", "ratify", "model.em", "ship", "--by", "Alex", "--on", "2026-10-02"], dir);
    if (r.status !== 0) throw new Error(r.stderr);
    git(dir, "commit", "-qam", "ratify ship on main");
    // `pay`: ratified on a PR branch, then SQUASH-merged and the branch deleted → not-ancestor.
    git(dir, "checkout", "-q", "-b", "feature/pay");
    writeFileSync(join(dir, "slices", "pay.md"), read("pay").replace("Do the thing.", "Charge the customer."));
    git(dir, "commit", "-qam", "pay: body tweak on the branch");
    r = em(["slice", "ratify", "model.em", "pay", "--by", "Alex", "--on", "2026-10-03"], dir);
    if (r.status !== 0) throw new Error(r.stderr);
    git(dir, "commit", "-qam", "ratify pay on the branch");
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "--squash", "-q", "feature/pay");
    git(dir, "commit", "-qm", "pay (#1) — squash merge");
    git(dir, "branch", "-D", "feature/pay");
    // Shipped + certified against a kinded (non-git) identifier → shippedRef checked, conformedAt skipped.
    r = em(["slice", "mark-implemented", "model.em", "pay", "https://github.com/org/repo/pull/1", "--on", "2026-10-04"], dir);
    if (r.status !== 0) throw new Error(r.stderr);
    r = em(["slice", "conform", "model.em", "pay", "--at", "build:pr-1-77", "--on", "2026-10-05"], dir);
    if (r.status !== 0) throw new Error(r.stderr);
    git(dir, "commit", "-qam", "pay shipped + certified");
    shallow = mkdtempSync(join(tmpdir(), "em-gh258-shallow-"));
    rmTemp(shallow);
    const c = spawnSync("git", ["clone", "-q", "--depth", "1", `file://${dir}`, shallow], { encoding: "utf8" });
    if (c.status !== 0) throw new Error(c.stderr);
  });
  afterAll(() => {
    rmTemp(dir);
    rmTemp(shallow);
  });

  it("text report: ship ancestor; pay's ratifiedRef + shippedRef not-ancestor (squash), conformedAt build: skipped; exit 1", () => {
    const r = em(["refs", "model.em", "--reachable-from", "main"], dir);
    expect(r.status).toBe(1);
    const payRef = refsOf("pay");
    expect(r.stdout).toContain(`ancestor     ship ratifiedRef: ${refsOf("ship")}`);
    expect(r.stdout).toContain(`not-ancestor pay ratifiedRef: ${payRef} — resolves but is not an ancestor of`);
    expect(r.stdout).toContain(`not-ancestor pay shippedRef: ${payRef}`);
    expect(r.stdout).not.toContain("conformedAt");
    expect(r.stdout).toContain("2 ref(s) not reachable from main (3 checked on 2 doc(s))");
  });

  it("--json: the three outcomes are distinguishable; --waive / --waive-file excuse pay and flip ok; an unknown waiver is a note", () => {
    const doc = JSON.parse(em(["refs", "model.em", "--reachable-from", "main", "--json"], dir).stdout);
    expect(doc.refsSchemaVersion).toBe("1.0");
    expect(doc.shallow).toBe(false);
    expect(doc.checked).toEqual({ docs: 2, refs: 3 });
    expect(doc.results.map((x: RefResult) => [x.sliceKey, x.field, x.status])).toEqual([
      ["pay", "ratifiedRef", "not-ancestor"],
      ["pay", "shippedRef", "not-ancestor"],
      ["ship", "ratifiedRef", "ancestor"],
    ]);
    expect(doc.ok).toBe(false);
    const waived = em(["refs", "model.em", "--reachable-from", "main", "--waive", "pay", "--waive", "ghost", "--json"], dir);
    expect(waived.status).toBe(0);
    expect(waived.stderr).toContain('note: waiver for slice "ghost" (--waive) has nothing to excuse — ignored');
    const w = JSON.parse(waived.stdout);
    expect(w.ok).toBe(true);
    expect(w.waived.map((x: RefResult) => x.field)).toEqual(["ratifiedRef", "shippedRef"]);
    expect(w.results.map((x: RefResult) => x.status)).toEqual(["ancestor"]);
    writeFileSync(join(dir, "refs-baseline.txt"), "# known: pay was ratified on a squashed branch\npay\n");
    const file = em(["refs", "model.em", "--reachable-from", "main", "--waive-file", "refs-baseline.txt"], dir);
    expect(file.status).toBe(0);
    expect(file.stdout).toContain("waived by refs-baseline.txt");
    expect(file.stdout).toContain("ok — every recorded ref is reachable from main (3 ref(s) on 2 doc(s), 2 waived)");
  });

  it("a sha that no longer resolves is unresolved; a --reachable-from that does not resolve is a hard error", () => {
    writeFileSync(join(dir, "slices", "ship.md"), read("ship").replace(/ratifiedRef: \S+/, `ratifiedRef: ${"b".repeat(40)}`));
    const r = em(["refs", "model.em", "--reachable-from", "main", "--json"], dir);
    const ship = JSON.parse(r.stdout).results.find((x: RefResult) => x.sliceKey === "ship");
    expect(ship.status).toBe("unresolved");
    expect(ship.detail).toContain("does not resolve to a commit");
    git(dir, "checkout", "-q", "--", "slices/ship.md");
    const bad = em(["refs", "model.em", "--reachable-from", "no-such-branch"], dir);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('--reachable-from "no-such-branch" does not resolve to a commit');
  });

  it("a shallow clone reports every ref undecidable and ok:false — never a false pass", () => {
    const r = em(["refs", "model.em", "--reachable-from", "HEAD", "--json"], shallow);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("warn: shallow clone");
    const doc = JSON.parse(r.stdout);
    expect(doc.shallow).toBe(true);
    expect(doc.ok).toBe(false);
    expect(new Set(doc.results.map((x: RefResult) => x.status))).toEqual(new Set(["undecidable"]));
    expect(doc.results[0].detail).toContain("fetch-depth: 0");
  });
});

// GH #399 (inline ratification): `em refs --check-order`, real git, four slices on four branches
// forked from the same reviewed-docs commit — doc-first (ratified-first), code-first (a code
// commit lands on the branch before the doc-only commit that becomes ratifiedRef:
// code-before-ratification), bundled (doc + code land in the one commit that becomes
// ratifiedRef: undecidable), never-ratified (no ratifiedRef — excluded from the report
// entirely). The slate's R5 ("advisory only, never a gate"): proved by merging `bundled` for
// real and showing `ok: true` / exit 0 even though its own order reads `undecidable`.
const ORDER_MODEL = [
  'slice "Doc First" {\n  command Do Doc First note "slices/doc-first.md"\n  event Doc First Done\n}',
  'slice "Code First" {\n  command Do Code First note "slices/code-first.md"\n  event Code First Done\n}',
  'slice "Bundled" {\n  command Do Bundled note "slices/bundled.md"\n  event Bundled Done\n}',
  'slice "Never Ratified" {\n  command Do Never Ratified note "slices/never-ratified.md"\n  event Never Ratified Done\n}',
].join("\n") + "\n";

describe("em refs --check-order (CLI, real git): spec-first, retrofit, bundled-commit and never-ratified", () => {
  let dir: string;
  const read = (k: string) => readFileSync(join(dir, "slices", `${k}.md`), "utf8");
  const bodyTweak = (key: string, label: string) => writeFileSync(join(dir, "slices", `${key}.md`), read(key).replace("Do the thing.", `Do the ${label} thing.`));
  const addSrcFile = (name: string) => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", name), "// impl\n");
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-gh399-order-"));
    mkdirSync(join(dir, "slices"));
    for (const key of ["doc-first", "code-first", "bundled", "never-ratified"]) {
      writeFileSync(join(dir, "slices", `${key}.md`), reviewed(key));
    }
    writeFileSync(join(dir, "model.em"), ORDER_MODEL);
    gitInitQuiet(dir, "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "reviewed docs");

    // doc-first: doc-only commit becomes ratifiedRef; the implementation lands AFTER —
    // outside the checked range entirely, so it never factors in.
    git(dir, "checkout", "-q", "-b", "feature/doc-first");
    bodyTweak("doc-first", "doc-first");
    git(dir, "commit", "-qam", "doc-first: body tweak");
    let r = em(["slice", "ratify", "model.em", "doc-first", "--by", "Alex", "--on", "2026-11-01"], dir);
    if (r.status !== 0) throw new Error(r.stderr);
    git(dir, "commit", "-qam", "ratify doc-first on branch");
    addSrcFile("doc-first.ts");
    git(dir, "add", "-A");
    git(dir, "commit", "-qam", "implement doc-first (after ratify)");

    // code-first: a code commit lands FIRST, then a doc-only commit becomes ratifiedRef — the
    // retrofit shape the issue names (code already exists when the spec commit is made).
    git(dir, "checkout", "-q", "main");
    git(dir, "checkout", "-q", "-b", "feature/code-first");
    addSrcFile("code-first.ts");
    git(dir, "add", "-A");
    git(dir, "commit", "-qam", "code-first: add implementation before ratify");
    bodyTweak("code-first", "code-first");
    git(dir, "commit", "-qam", "code-first: doc touch (becomes ratifiedRef)");
    r = em(["slice", "ratify", "model.em", "code-first", "--by", "Alex", "--on", "2026-11-01"], dir);
    if (r.status !== 0) throw new Error(r.stderr);
    git(dir, "commit", "-qam", "ratify code-first on branch");

    // bundled: the doc edit and the code file land in the SAME commit, which becomes
    // ratifiedRef — no decidable order within one commit.
    git(dir, "checkout", "-q", "main");
    git(dir, "checkout", "-q", "-b", "feature/bundled");
    addSrcFile("bundled.ts");
    bodyTweak("bundled", "bundled");
    git(dir, "add", "-A");
    git(dir, "commit", "-qam", "bundled: doc + code together");
    r = em(["slice", "ratify", "model.em", "bundled", "--by", "Alex", "--on", "2026-11-01"], dir);
    if (r.status !== 0) throw new Error(r.stderr);
    git(dir, "commit", "-qam", "ratify bundled on branch");

    // never-ratified stays `reviewed` on main — no ratifiedRef, so it never appears in the report.
    git(dir, "checkout", "-q", "main");
  });
  afterAll(() => rmTemp(dir));

  it("doc-first: ratified-first", () => {
    git(dir, "checkout", "-q", "feature/doc-first");
    const doc = JSON.parse(em(["refs", "model.em", "--reachable-from", "main", "--check-order", "--json"], dir).stdout);
    expect(doc.orderResults).toEqual([expect.objectContaining({ sliceKey: "doc-first", status: "ratified-first", commit: null, detail: null })]);
  });

  it("code-first: code-before-ratification, naming the implementation commit", () => {
    git(dir, "checkout", "-q", "feature/code-first");
    const doc = JSON.parse(em(["refs", "model.em", "--reachable-from", "main", "--check-order", "--json"], dir).stdout);
    expect(doc.orderResults).toHaveLength(1);
    const o = doc.orderResults[0];
    expect(o.sliceKey).toBe("code-first");
    expect(o.status).toBe("code-before-ratification");
    expect(o.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(o.detail).toContain("touched code other than slices/code-first.md");
  });

  it("bundled: undecidable, and never affects the exit code even once the branch is really merged (R5)", () => {
    git(dir, "checkout", "-q", "feature/bundled");
    const unmerged = em(["refs", "model.em", "--reachable-from", "main", "--check-order", "--json"], dir);
    const docUnmerged = JSON.parse(unmerged.stdout);
    expect(docUnmerged.orderResults).toEqual([expect.objectContaining({ sliceKey: "bundled", status: "undecidable", commit: null })]);
    expect(docUnmerged.orderResults[0].detail).toContain("no decidable order within itself");

    // Real (non-squash) merge to main: ratifiedRef is now an `ancestor` (the ref check itself
    // passes), but the order result is unchanged — `undecidable` either way, and `ok`/exit stay
    // keyed on the ref check alone (R5: advisory, never a gate).
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge bundled", "feature/bundled");
    const afterMerge = em(["refs", "model.em", "--reachable-from", "main", "--check-order", "--json"], dir);
    expect(afterMerge.status).toBe(0);
    const docMerged = JSON.parse(afterMerge.stdout);
    expect(docMerged.ok).toBe(true);
    expect(docMerged.orderResults.find((o: OrderResult) => o.sliceKey === "bundled")?.status).toBe("undecidable");
  });

  it("never-ratified has no ratifiedRef, so it is excluded from the order report entirely", () => {
    git(dir, "checkout", "-q", "main");
    const doc = JSON.parse(em(["refs", "model.em", "--reachable-from", "main", "--check-order", "--json"], dir).stdout);
    expect(doc.orderResults.some((o: OrderResult) => o.sliceKey === "never-ratified")).toBe(false);
  });

  it("without --check-order, --json omits orderResults and the text report has no order section", () => {
    git(dir, "checkout", "-q", "feature/doc-first");
    const json = JSON.parse(em(["refs", "model.em", "--reachable-from", "main", "--json"], dir).stdout);
    expect(json).not.toHaveProperty("orderResults");
    const text = em(["refs", "model.em", "--reachable-from", "main"], dir);
    expect(text.stdout).not.toContain("ratification order");
    git(dir, "checkout", "-q", "main");
  });
});
