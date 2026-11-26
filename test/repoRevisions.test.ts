// SPDX-License-Identifier: MIT
// GH #534: one conformance revision per repository — the `<repo>=<rev>,…` form
// (src/cli/repoRevisions.ts) and every place that records or reads it: the state file's
// `Last conformance:` / `Certified:`, a slice doc's `conformedAt:`, `em refs`.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitInitQuiet } from "./helpers/gitInitQuiet.js";
import { rmTemp } from "./helpers/rmTemp.js";
import { checkRevisionArg, formatRepoRevisions, parseRevision, revisionFor } from "../src/cli/repoRevisions.js";
import { parseConformedAt } from "../src/catalog/sliceDoc.js";
import { parseState } from "../src/cli/stateFile.js";
import { validateAtRevision } from "../src/cli/sliceConform.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const em = (args: string[], cwd: string) => {
  const r = spawnSync(process.execPath, [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "src", "cli.ts"), ...args], { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const git = (args: string[], cwd: string) => spawnSync("git", ["-c", "user.email=t@t.test", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });

describe("parseRevision / formatRepoRevisions / revisionFor", () => {
  it("a plain revision is single, whatever it looks like", () => {
    for (const v of ["4f2a9c1", "origin/main", "v1.2.0", "build:1234", "HEAD~3"]) expect(parseRevision(v)).toEqual({ kind: "single", revision: v });
  });
  it("reads <repo>=<rev> pairs, and anything short of well formed stays a single revision", () => {
    expect(parseRevision("checkout-svc=4f2a9c1,storefront-web=b81d0e7")).toEqual({
      kind: "per-repo",
      revisions: [{ repo: "checkout-svc", revision: "4f2a9c1" }, { repo: "storefront-web", revision: "b81d0e7" }],
    });
    expect(parseRevision("self=abc").kind).toBe("per-repo");
    for (const v of ["web=", "=abc", "web=a,web=b", "web=a, orders=b", "web=a=b", "two words=a"]) expect(parseRevision(v).kind).toBe("single");
  });
  it("the canonical spelling sorts by repo id, so equal sets are equal strings", () => {
    const a = formatRepoRevisions([{ repo: "web", revision: "1" }, { repo: "orders", revision: "2" }, { repo: "self", revision: "3" }]);
    expect(a).toBe("orders=2,self=3,web=1");
    expect(formatRepoRevisions(parseRevision(a).kind === "per-repo" ? (parseRevision(a) as any).revisions : [])).toBe(a);
  });
  it("revisionFor: a single revision answers for any repo; a per-repo one only for the repos it names", () => {
    expect(revisionFor("abc", "web")).toBe("abc");
    expect(revisionFor("orders=2,web=1", "web")).toBe("1");
    expect(revisionFor("orders=2,web=1", "self")).toBeNull();
  });
  it("checkRevisionArg: plain passes; a per-repo value must be well formed and in id order", () => {
    expect(checkRevisionArg("abc123", "--at")).toEqual({ ok: true });
    expect(checkRevisionArg("orders=2,web=1", "--at")).toEqual({ ok: true });
    const unsorted = checkRevisionArg("web=1,orders=2", "--at");
    expect(unsorted).toEqual({ ok: false, message: "--at: write the repos in id order so every file of this run records the same string — orders=2,web=1" });
    const bad = checkRevisionArg("web=1, orders=2", "<revision>");
    expect(!bad.ok && bad.message).toContain('<revision> "web=1, orders=2" is not a per-repo revision');
  });
});

describe("conformedAt and --at", () => {
  it("parseConformedAt: git, kinded, and per-repo", () => {
    expect(parseConformedAt("4f2a9c1")).toEqual({ kind: "git", id: "4f2a9c1" });
    expect(parseConformedAt("build:1234")).toEqual({ kind: "build", id: "1234" });
    expect(parseConformedAt("orders=2,web=1")).toEqual({ kind: "repos", id: "orders=2,web=1" });
  });
  it("validateAtRevision accepts a canonical per-repo value and refuses an unsorted one", () => {
    expect(validateAtRevision("orders=2,web=1")).toEqual({ ok: true, value: "orders=2,web=1" });
    expect(validateAtRevision("web=1,orders=2").ok).toBe(false);
    expect(validateAtRevision("4f2a9c1")).toEqual({ ok: true, value: "4f2a9c1" });
    expect(validateAtRevision("build:1234")).toEqual({ ok: true, value: "build:1234" });
  });
});

describe("the state file and the CLI (real git repo)", () => {
  let repo: string;
  let modelDir: string;
  let head: string;
  const MODEL = `slice "Place Order" {\n  ui Checkout @Customer\n  command Place Order note "slices/place-order.md"\n  event Order Placed\n}\nslice "Open Orders" {\n  view Open Orders from "Order Placed"\n  ui Order List @Customer\n}\n`;
  const DOC = "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ready-to-implement\nversion: 1\n---\n## Intent\n";

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "em-repo-revs-"));
    gitInitQuiet(repo, "-b", "main");
    expect(em(["scaffold", "Checkout"], repo).status).toBe(0);
    modelDir = join(repo, "checkout");
    writeFileSync(join(modelDir, "checkout.em"), MODEL);
    mkdirSync(join(modelDir, "slices"), { recursive: true });
    writeFileSync(join(modelDir, "slices", "place-order.md"), DOC);
    expect(em(["slice", "mark-implemented", "checkout.em", "place-order", "https://github.com/acme/shop/pull/1"], modelDir).status).toBe(0);
    git(["add", "."], repo);
    git(["commit", "-qm", "model"], repo);
    head = git(["rev-parse", "--short", "HEAD"], repo).stdout.trim();
    expect(em(["model", "version", "bump", "checkout.em", "--by", "Alex Rivera"], modelDir).status).toBe(0);
  });
  afterAll(() => rmTemp(repo));

  it("a single revision: em state read prints no revisions key", () => {
    expect(em(["state", "set-conformance", head, "--report", "conformance/r.md"], modelDir).status).toBe(0);
    const state = JSON.parse(em(["state", "read"], modelDir).stdout);
    expect(state.lastConformance).toEqual({ date: expect.any(String), revision: head, report: "conformance/r.md", partial: false });
    expect(Object.keys(state.certified)).toEqual(["version", "revision", "date"]);
  });

  it("set-conformance refuses an unsorted or malformed per-repo revision, and writes nothing", () => {
    const before = readFileSync(join(modelDir, ".event-modeling.md"), "utf8");
    const r = em(["state", "set-conformance", `web=abc,self=${head}`, "--report", "conformance/r.md"], modelDir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`write the repos in id order so every file of this run records the same string — self=${head},web=abc`);
    expect(em(["state", "set-conformance", "web=abc,web=def", "--report", "conformance/r.md"], modelDir).status).toBe(1);
    expect(readFileSync(join(modelDir, ".event-modeling.md"), "utf8")).toBe(before);
  });

  it("a per-repo revision is recorded as one token and read back taken apart", () => {
    const rev = `self=${head},web=b81d0e7`;
    const r = em(["state", "set-conformance", rev, "--report", "conformance/r.md"], modelDir);
    expect(r.status).toBe(0);
    const text = readFileSync(join(modelDir, ".event-modeling.md"), "utf8");
    expect(text).toContain(`@ ${rev} — report: conformance/r.md`);
    const parsed = parseState(text);
    expect(parsed.ok && parsed.state.lastConformance).toMatchObject({
      revision: rev,
      revisions: [{ repo: "self", revision: head }, { repo: "web", revision: "b81d0e7" }],
    });
    const state = JSON.parse(em(["state", "read"], modelDir).stdout);
    expect(state.certified.revision).toBe(rev);
    expect(state.certified.revisions).toEqual([{ repo: "self", revision: head }, { repo: "web", revision: "b81d0e7" }]);
  });

  it("em slice conform --at records a per-repo conformedAt; em refs checks its self entry", () => {
    const rev = `self=${head},web=b81d0e7`;
    const r = em(["slice", "conform", "checkout.em", "place-order", "--at", rev, "--skip-findings-check"], modelDir);
    expect(r.status).toBe(0);
    expect(readFileSync(join(modelDir, "slices", "place-order.md"), "utf8")).toContain(`conformedAt: ${rev}`);
    expect(em(["slice", "conform", "checkout.em", "place-order", "--at", `web=1,self=${head}`, "--skip-findings-check"], modelDir).status).toBe(1);
    git(["add", "."], repo);
    git(["commit", "-qm", "conform"], repo);
    const refs = JSON.parse(em(["refs", "checkout.em", "--reachable-from", "HEAD", "--json"], modelDir).stdout);
    const conformed = refs.results.filter((x: { field: string }) => x.field === "conformedAt");
    expect(conformed).toHaveLength(1);
    expect(conformed[0]).toMatchObject({ ref: head, status: "ancestor" });
  });
});
