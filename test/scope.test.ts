// SPDX-License-Identifier: MIT
// `em system scope` (MIL-240): the pure evaluator (src/system/scope.ts), the git change-set
// readers (src/cli/conformScope.ts), and the CLI end to end on real multi-model git repos
// (test/helpers/multiModelRepo.ts).
import { describe, it, expect, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateScope, modelForPath, parseCodeRoots, ScopeModel } from "../src/system/scope.js";
import { parseNameStatusZ, changedEntriesSince, changedEntriesStaged, changedPathsStaged } from "../src/cli/conformScope.js";
import { makeMultiModelRepo, MultiModelRepo } from "./helpers/multiModelRepo.js";

// Every CLI-spawning test here costs ~1 s locally and 5-6 s on a cold CI runner.
vi.setConfig({ testTimeout: 20_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");
function em(args: string[], cwd: string) {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: res.status, stdout: res.stdout as string, stderr: res.stderr as string };
}

// ---- pure ------------------------------------------------------------------------------

function model(key: string, dir: string, extra: Partial<ScopeModel> = {}): ScopeModel {
  return {
    key,
    file: `${dir}/${key}.em`,
    dir,
    contract: `${dir}/contracts/${key}.tsp`,
    codeRoots: [],
    surfaceChanges: null,
    headConsumes: [],
    baseConsumes: [],
    ...extra,
  };
}

describe("parseNameStatusZ / modelForPath / parseCodeRoots", () => {
  it("parses statuses, including renames with both sides", () => {
    expect(parseNameStatusZ("M\0a.txt\0R100\0old.tsp\0new.tsp\0D\0gone.md\0")).toEqual([
      { status: "M", path: "a.txt", oldPath: null },
      { status: "R", oldPath: "old.tsp", path: "new.tsp" },
      { status: "D", path: "gone.md", oldPath: null },
    ]);
    expect(parseNameStatusZ("")).toEqual([]);
  });

  it("maps a path to the model with the longest matching dir prefix", () => {
    const ms = [model("outer", "models"), model("inner", "models/inner"), model("sibling", "models/inner2")];
    expect(modelForPath(ms, "models/inner/slices/a.md")).toBe("inner");
    expect(modelForPath(ms, "models/inner2/x.em")).toBe("sibling");
    expect(modelForPath(ms, "models/readme.md")).toBe("outer");
    expect(modelForPath(ms, "docs/readme.md")).toBeNull();
    expect(modelForPath([model("root", "")], "anything/at/all.md")).toBe("root");
  });

  it("reads the `Code roots:` bullet", () => {
    expect(parseCodeRoots("- **Code roots:** src/checkout, `src/shared/`, ./lib\n")).toEqual(["src/checkout", "src/shared", "lib"]);
    expect(parseCodeRoots("- **Code roots:** none\n")).toEqual([]);
    expect(parseCodeRoots("- **Model file:** `x.em`\n")).toEqual([]);
  });
});

describe("evaluateScope", () => {
  const consumer = model("fulfillment", "m/fulfillment", { headConsumes: ["checkout:event.order-submitted"], baseConsumes: ["checkout:event.order-submitted"] });
  const breaking = [{ kind: "breaking" as const, element: "event.order-submitted", field: "placedAt", what: "removed" }];

  it("producer surface change + consumer dir change = one seam-crossing naming both", () => {
    const r = evaluateScope({
      models: [model("checkout", "m/checkout", { surfaceChanges: breaking }), consumer],
      changed: ["m/checkout/checkout.em", "m/fulfillment/slices/a.md"],
    });
    expect(r.crossings).toBe(1);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ code: "seam-crossing", severity: "error", file: "m/checkout/checkout.em", refs: ["checkout:event.order-submitted", "fulfillment"] });
    expect(r.diagnostics[0].message).toBe(
      'change set alters checkout\'s public surface (event.order-submitted field "placedAt" removed) and fulfillment, which consumes it ' +
        "(changed: m/fulfillment/slices/a.md) - land the contract change and the consumer's adaptation in separate change sets; " +
        "review on m/checkout/contracts/checkout.tsp is the only override",
    );
  });

  it("producer-only and consumer-only are clean; no multi-model warning for one model", () => {
    const p = evaluateScope({ models: [model("checkout", "m/checkout", { surfaceChanges: breaking }), consumer], changed: ["m/checkout/checkout.em"] });
    expect(p.diagnostics).toEqual([]);
    const c = evaluateScope({ models: [model("checkout", "m/checkout"), consumer], changed: ["m/fulfillment/slices/a.md"] });
    expect(c.diagnostics).toEqual([]);
  });

  it("a changed contract file with no surface change is a trigger; a rename's old path counts", () => {
    const r = evaluateScope({
      models: [model("checkout", "m/checkout", { surfaceChanges: [] }), consumer],
      changed: ["m/checkout/contracts/old.tsp", "m/fulfillment/x.md"],
    });
    expect(r.crossings).toBe(0); // a different file under contracts/ is not THE contract file
    const r2 = evaluateScope({
      models: [model("checkout", "m/checkout", { surfaceChanges: [] }), consumer],
      changed: ["m/checkout/contracts/checkout.tsp", "m/fulfillment/x.md"],
    });
    expect(r2.crossings).toBe(1);
    expect(r2.diagnostics[0].message).toContain("contract file m/checkout/contracts/checkout.tsp changed");
    expect(r2.diagnostics[0].refs).toEqual(["checkout:contract", "fulfillment"]);
  });

  it("new public surface nothing was bound to at base is greenfield: a warning, not an error", () => {
    const added = [{ kind: "additive" as const, element: "event.order-refunded", field: null, what: "added" }];
    const r = evaluateScope({
      models: [model("checkout", "m/checkout", { surfaceChanges: added }), consumer],
      changed: ["m/checkout/checkout.em", "m/checkout/contracts/checkout.tsp", "m/fulfillment/x.md"],
    });
    expect(r.crossings).toBe(0);
    expect(r.diagnostics.map((d) => d.code)).toEqual(["seam-crossing-greenfield", "multi-model-change-set"]);
    // ... but bound at base is NOT greenfield
    const bound = evaluateScope({
      models: [model("checkout", "m/checkout", { surfaceChanges: added }), { ...consumer, baseConsumes: ["checkout:event.order-refunded"] }],
      changed: ["m/checkout/checkout.em", "m/fulfillment/x.md"],
    });
    expect(bound.crossings).toBe(1);
  });

  it("two unrelated models warn only; three models list all three", () => {
    const r = evaluateScope({
      models: [model("a", "m/a"), model("b", "m/b"), model("c", "m/c")],
      changed: ["m/a/x", "m/b/y", "m/c/z", "docs/ignored.md"],
    });
    expect(r.crossings).toBe(0);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ code: "multi-model-change-set", severity: "warning", refs: ["a", "b", "c"] });
    expect(r.diagnostics[0].message).toBe("change set touches 3 models (a, b, c) but crosses no contract - consider one change set per model");
    expect(r.unmapped).toEqual(["docs/ignored.md"]);
  });

  it("code-spans-seam: changed code under two seam-joined models' code roots", () => {
    const models = [
      model("checkout", "m/checkout", { codeRoots: ["src/checkout"] }),
      model("fulfillment", "m/fulfillment", { codeRoots: ["src/fulfillment"], headConsumes: ["checkout:event.order-submitted"] }),
      model("other", "m/other", { codeRoots: ["src/other"] }),
    ];
    const r = evaluateScope({ models, changed: ["src/checkout/a.ts", "src/fulfillment/b.ts", "src/other/c.ts"] });
    expect(r.diagnostics.map((d) => d.code)).toEqual(["code-spans-seam"]);
    expect(r.diagnostics[0].message).toBe(
      "code change spans the seam between checkout (src/checkout/a.ts) and fulfillment (src/fulfillment/b.ts) - one code module per model, changed in separate change sets",
    );
    expect(evaluateScope({ models, changed: ["src/checkout/a.ts", "src/other/c.ts"] }).diagnostics).toEqual([]);
  });
});

// ---- git readers -----------------------------------------------------------------------

describe("change-set readers", () => {
  let repo: MultiModelRepo | null = null;
  afterEach(() => repo?.cleanup());

  it("changedEntriesSince is rename-aware and uses merge-base form; staged variants read the index", () => {
    repo = makeMultiModelRepo();
    const base = repo.git("rev-parse", "HEAD").trim();
    repo.git("mv", "models/checkout/contracts/checkout.tsp", "models/checkout/contracts/renamed.tsp");
    const staged = changedEntriesStaged(repo.dir, undefined, "em system scope");
    expect(staged.ok && staged.entries).toEqual([{ status: "R", oldPath: "models/checkout/contracts/checkout.tsp", path: "models/checkout/contracts/renamed.tsp" }]);
    const paths = changedPathsStaged(repo.dir, undefined, "em system scope");
    expect(paths).toEqual({ ok: true, paths: ["models/checkout/contracts/checkout.tsp", "models/checkout/contracts/renamed.tsp"] });
    repo.git("commit", "-q", "-m", "rename");
    const since = changedEntriesSince(repo.dir, base, undefined, "em system scope");
    expect(since.ok && since.entries[0]).toMatchObject({ status: "R", oldPath: "models/checkout/contracts/checkout.tsp" });
    const bad = changedEntriesSince(repo.dir, "no-such-rev", undefined, "em system scope");
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.message).toMatch(/^em system scope: git diff failed: /);
  });
});

// ---- CLI -------------------------------------------------------------------------------

const SLICE_DOC = join("models", "fulfillment", "slices", "receive-order.md");
const CHECKOUT_EM = join("models", "checkout", "checkout.em");

function editProducer(repo: MultiModelRepo): void {
  // Drop a field from the public event: a breaking public-surface change.
  writeFileSync(repo.checkout, readFileSync(repo.checkout, "utf8").replace("    placedAt: datetime assigned\n", ""));
}
function editConsumer(repo: MultiModelRepo): void {
  mkdirSync(join(repo.dir, "models", "fulfillment", "slices"), { recursive: true });
  writeFileSync(join(repo.dir, SLICE_DOC), "# Receive Order\n\nOrder intake notes.\n");
}
function commit(repo: MultiModelRepo, msg: string, trailer?: string): string {
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", msg, ...(trailer ? ["-m", trailer] : []));
  return repo.git("rev-parse", "HEAD").trim();
}

describe("em system scope (CLI, real git repo)", () => {
  let repo: MultiModelRepo;
  let base: string;
  const fresh = (opts?: Parameters<typeof makeMultiModelRepo>[0]) => {
    repo = makeMultiModelRepo(opts);
    base = repo.git("rev-parse", "HEAD").trim();
  };
  afterEach(() => repo?.cleanup());

  it("(a) a two-sided edit fails: producer public surface + consumer design dir -> seam-crossing, exit 1", () => {
    fresh();
    editProducer(repo);
    editConsumer(repo);
    commit(repo, "both sides");
    const r = em(["system", "scope", "--base", base], repo.dir);
    expect(r.status).toBe(1);
    expect(r.stdout.split("\n")[0]).toBe("scope since " + base + ": 2 changed paths, 2 models touched");
    expect(r.stderr).toContain("error [seam-crossing]");
    expect(r.stderr).toContain("checkout's public surface (event.order-submitted field \"placedAt\" removed)");
    expect(r.stderr).toContain("fulfillment, which consumes it (changed: " + SLICE_DOC + ")");
    expect(r.stderr).toContain("review on models/checkout/contracts/checkout.tsp is the only override");
    expect(r.stderr).not.toContain(repo.dir);
    const j = em(["system", "scope", "--base", base, "--json"], repo.dir);
    expect(j.status).toBe(1);
    const doc = JSON.parse(j.stdout);
    expect(doc.scopeSchemaVersion).toBe("1.0");
    expect(doc.crossings).toBe(1);
    expect(doc.diagnostics.map((d: { code: string }) => d.code)).toEqual(["seam-crossing"]);
    expect(doc.models.map((m: { key: string }) => m.key)).toEqual(["checkout", "fulfillment"]);
    expect(j.stdout).not.toContain(repo.dir);
    // deterministic
    expect(em(["system", "scope", "--base", base, "--json"], repo.dir).stdout).toBe(j.stdout);
  });

  it("(b) producer-only passes (exit 0, nothing to report)", () => {
    fresh();
    editProducer(repo);
    commit(repo, "producer only");
    const r = em(["system", "scope", "--base", base], repo.dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ok - no issues");
    expect(r.stderr).toBe("");
  });

  it("(c) consumer-only passes", () => {
    fresh();
    editConsumer(repo);
    commit(repo, "consumer only");
    const r = em(["system", "scope", "--base", base], repo.dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ok - no issues");
  });

  it("(d) producer internals + a consumer file touch two models but no contract: multi-model-change-set warning, exit 0", () => {
    fresh();
    // A non-public change in the producer (public surface untouched).
    writeFileSync(repo.checkout, readFileSync(repo.checkout, "utf8") + '\nslice "Audit" {\n  command Log Audit\n  event Audit Logged @Order\n}\n');
    editConsumer(repo);
    commit(repo, "internal + consumer");
    const r = em(["system", "scope", "--base", base], repo.dir);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("multi-model-change-set");
    expect(r.stderr).toContain("change set touches 2 models (checkout, fulfillment) but crosses no contract");
  });

  it("(d2) two unrelated models (no consumes between them) warn only", () => {
    fresh({ manifest: false });
    mkdirSync(join(repo.dir, "models", "billing"), { recursive: true });
    writeFileSync(join(repo.dir, "models", "billing", "billing.em"), 'model "Billing"\n\nslice "Invoice" {\n  command Send Invoice\n  event Invoice Sent public\n}\n');
    commit(repo, "add billing");
    base = repo.git("rev-parse", "HEAD").trim();
    writeFileSync(join(repo.dir, "models", "billing", "billing.em"), 'model "Billing"\n\nslice "Invoice" {\n  command Send Invoice\n  event Invoice Sent public {\n    invoiceId: uuid\n  }\n}\n');
    editConsumer(repo);
    commit(repo, "billing + fulfillment");
    const r = em(["system", "scope", "--base", base], repo.dir);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("[multi-model-change-set]");
    expect(r.stderr).toContain("(billing, fulfillment)");
    expect(r.stderr).not.toContain("seam-crossing");
  });

  it("(e) a commit carrying an Em-Upgrade trailer that touches both models is exempt (exit 0); a plain commit on the same files is not", () => {
    fresh();
    editProducer(repo);
    editConsumer(repo);
    commit(repo, "em upgrade: x", "Em-Upgrade: x");
    const r = em(["system", "scope", "--base", base, "--json"], repo.dir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.crossings).toBe(0);
    expect(doc.changedPaths).toEqual([]);
    expect(doc.exemptPaths).toEqual([CHECKOUT_EM, SLICE_DOC]);
    expect(em(["system", "scope", "--base", base], repo.dir).stdout.split("\n")[0]).toContain("2 exempt (Em-Upgrade)");

    // A later non-upgrade commit on the producer file makes that file non-exempt again.
    writeFileSync(repo.checkout, readFileSync(repo.checkout, "utf8") + "\n# touched\n");
    commit(repo, "hand edit");
    const after = JSON.parse(em(["system", "scope", "--base", base, "--json"], repo.dir).stdout);
    expect(after.changedPaths).toEqual([CHECKOUT_EM]);
    expect(after.exemptPaths).toEqual([SLICE_DOC]);
    expect(after.crossings).toBe(0);
  });

  it("(f) --staged checks the index, never exempts, and combines with --base as a union", () => {
    fresh();
    editProducer(repo);
    editConsumer(repo);
    repo.git("add", "-A");
    const r = em(["system", "scope", "--staged"], repo.dir);
    expect(r.status).toBe(1);
    expect(r.stdout.split("\n")[0]).toBe("scope staged: 2 changed paths, 2 models touched");
    expect(r.stderr).toContain("error [seam-crossing]");
    // Unstaged edits are invisible to --staged.
    repo.git("reset", "-q");
    expect(em(["system", "scope", "--staged"], repo.dir).status).toBe(0);
    // Union: producer committed, consumer staged.
    repo.git("add", CHECKOUT_EM);
    repo.git("commit", "-q", "-m", "producer");
    repo.git("add", SLICE_DOC);
    const both = em(["system", "scope", "--base", base, "--staged", "--json"], repo.dir);
    expect(both.status).toBe(1);
    expect(JSON.parse(both.stdout)).toMatchObject({ base, staged: true, crossings: 1 });
  });

  it("(g) renaming the contract file is detected (both sides of the rename), and counts as a contract change", () => {
    fresh();
    repo.git("mv", "models/checkout/contracts/checkout.tsp", "models/checkout/contracts/checkout-v2.tsp");
    editConsumer(repo);
    commit(repo, "move contract");
    const r = em(["system", "scope", "--base", base, "--json"], repo.dir);
    expect(r.status).toBe(1);
    const doc = JSON.parse(r.stdout);
    expect(doc.changedPaths).toContain("models/checkout/contracts/checkout.tsp");
    expect(doc.changedPaths).toContain("models/checkout/contracts/checkout-v2.tsp");
    expect(doc.diagnostics[0].message).toContain("contract file models/checkout/contracts/checkout.tsp changed");
  });

  it("(h) greenfield: new public surface nobody was bound to warns instead of failing", () => {
    fresh();
    writeFileSync(repo.checkout, readFileSync(repo.checkout, "utf8") + '\nslice "Refund" {\n  command Refund Order\n  event Order Refunded @Order public\n}\n');
    editConsumer(repo);
    commit(repo, "new public event + consumer touch");
    const r = em(["system", "scope", "--base", base], repo.dir);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("[seam-crossing-greenfield]");
    expect(r.stderr).toContain("checkout: event.order-refunded is new public surface with no consumer bound at the base revision");
    expect(r.stderr).not.toContain("error");
  });

  it("an existing public element changed (no longer greenfield) fails, even for an additive change", () => {
    fresh();
    writeFileSync(repo.checkout, readFileSync(repo.checkout, "utf8").replace("    placedAt: datetime assigned\n", "    placedAt: datetime assigned\n    channel: string\n"));
    editConsumer(repo);
    commit(repo, "additive field + consumer");
    expect(em(["system", "scope", "--base", base], repo.dir).status).toBe(1);
  });

  it("advisory code-roots check: `Code roots:` in the state files -> code-spans-seam warning, exit 0", () => {
    fresh();
    writeFileSync(join(repo.dir, "models", "checkout", ".event-modeling.md"), "# State\n\n- **Code roots:** src/checkout\n");
    writeFileSync(join(repo.dir, "models", "fulfillment", ".event-modeling.md"), "# State\n\n- **Code roots:** src/fulfillment\n");
    commit(repo, "declare code roots");
    base = repo.git("rev-parse", "HEAD").trim();
    mkdirSync(join(repo.dir, "src", "checkout"), { recursive: true });
    mkdirSync(join(repo.dir, "src", "fulfillment"), { recursive: true });
    writeFileSync(join(repo.dir, "src", "checkout", "a.ts"), "export {};\n");
    writeFileSync(join(repo.dir, "src", "fulfillment", "b.ts"), "export {};\n");
    commit(repo, "code on both sides");
    const r = em(["system", "scope", "--base", base], repo.dir);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("[code-spans-seam]");
    expect(r.stderr).toContain("between checkout (src/checkout/a.ts) and fulfillment (src/fulfillment/b.ts)");
  });

  it("refusals are one `em system scope:` line, never a stack trace", () => {
    fresh();
    const none = em(["system", "scope"], repo.dir);
    expect(none.status).toBe(1);
    expect(none.stderr.trim()).toBe("em system scope: pass --base <rev> (the change set since that revision), --staged (what is staged now), or both");
    const unknown = em(["system", "scope", "--base", "no-such-rev"], repo.dir);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr.trim()).toBe('em system scope: unknown revision "no-such-rev"');
    const outside = em(["system", "scope", "--base", "HEAD", join(ROOT, "examples", "multi-model", "system.yaml")], repo.dir);
    expect(outside.stderr).not.toContain("    at ");
  });

  it("`em system <manifest>` still works with the new subcommand registered", () => {
    fresh();
    const r = em(["system", "system.yaml"], repo.dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('system "Multi-model example"');
  });

  it("no override trailer or flag exists anywhere in the shipped source or docs", () => {
    const grep = spawnSync("git", ["-C", ROOT, "grep", "-l", "Em-Seam-" + "Override", "--", "src", "docs", "test", ".claude", "plugin"], { encoding: "utf8" });
    expect(grep.stdout.trim()).toBe("");
  });
});
