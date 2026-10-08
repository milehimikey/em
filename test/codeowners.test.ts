// SPDX-License-Identifier: MIT
// `em system codeowners [--check]` (MIL-234): the managed CODEOWNERS block that puts each
// model's team on its design directory and every consuming team on the producer's contract.
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeMultiModelRepo, MultiModelRepo } from "./helpers/multiModelRepo.js";
import { codeownersPatternMatches, planCodeowners, spliceCodeowners } from "../src/system/codeowners.js";
import { buildCodeownersJson, CODEOWNERS_SCHEMA_VERSION } from "../src/emit/codeownersJson.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");
function em(args: string[], cwd: string) {
  const r = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const NOTE = "# Contract files list every consuming team: a change to a model's public surface cannot merge without the teams that depend on it.";

const repos: MultiModelRepo[] = [];
const fresh = (opts: Parameters<typeof makeMultiModelRepo>[0] = {}) => {
  const r = makeMultiModelRepo(opts);
  rmSync(join(r.dir, "CODEOWNERS"), { force: true }); // the example ships its generated file
  repos.push(r);
  return r;
};
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

/** A third model whose translation consumes checkout's public event, owned by `owner`. */
const addAudit = (repo: MultiModelRepo, owner: string, consumes = "consumes checkout:event.order-submitted") => {
  mkdirSync(join(repo.dir, "models", "audit"), { recursive: true });
  const file = join(repo.dir, "models", "audit", "audit.em");
  writeFileSync(
    file,
    `model "Audit" owner "${owner}"\n\nslice "Record" {\n  translation Order Seen ${consumes} {\n    orderId: uuid\n  }\n  command Log Order\n  event Order Logged\n}\n`,
  );
  return file;
};

describe("the multi-model example", () => {
  it("the committed examples/multi-model/CODEOWNERS is exactly what `em system codeowners` generates", () => {
    const repo = fresh();
    const r = em(["system", "codeowners"], repo.dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("installed CODEOWNERS (6 entries)\n");
    expect(readFileSync(join(repo.dir, "CODEOWNERS"), "utf8")).toBe(readFileSync(join(ROOT, "examples", "multi-model", "CODEOWNERS"), "utf8"));
  });

  it("a contract edit requires both teams: the contract entry lists the producer and the consumer", () => {
    const repo = fresh();
    em(["system", "codeowners"], repo.dir);
    const text = readFileSync(join(repo.dir, "CODEOWNERS"), "utf8");
    expect(text).toContain("/models/checkout/ @example/storefront\n");
    expect(text).toContain("/models/checkout/contracts/checkout.tsp @example/storefront @example/warehouse\n");
    // fulfillment's contract is consumed by nothing: its own team only
    expect(text).toContain("/models/fulfillment/contracts/fulfillment.tsp @example/warehouse\n");
    expect(text).toContain(NOTE + "\n");
  });

  it("a second consumer adds its team; removing its consumes removes it; re-runs are idempotent", () => {
    const repo = fresh({ manifest: false }); // discovery, so the new model needs no manifest edit
    const audit = addAudit(repo, "@example/audit");
    repo.git("add", "-A"); // discovery lists tracked files only
    expect(em(["system", "codeowners"], repo.dir).status).toBe(0);
    const withAudit = readFileSync(join(repo.dir, "CODEOWNERS"), "utf8");
    expect(withAudit).toContain("/models/checkout/contracts/checkout.tsp @example/storefront @example/audit @example/warehouse\n");
    // discovery order: audit < checkout < fulfillment
    expect(withAudit.indexOf("/models/audit/ ")).toBeLessThan(withAudit.indexOf("/models/checkout/ "));

    const again = em(["system", "codeowners"], repo.dir);
    expect(again.stdout).toBe("already up to date: CODEOWNERS (9 entries)\n");
    expect(readFileSync(join(repo.dir, "CODEOWNERS"), "utf8")).toBe(withAudit);

    writeFileSync(audit, readFileSync(audit, "utf8").replace(" consumes checkout:event.order-submitted", ""));
    repo.git("add", "-A");
    expect(em(["system", "codeowners", "--check"], repo.dir).status).toBe(1);
    em(["system", "codeowners"], repo.dir);
    const without = readFileSync(join(repo.dir, "CODEOWNERS"), "utf8");
    expect(without).toContain("/models/checkout/contracts/checkout.tsp @example/storefront @example/warehouse\n");
    expect(without).not.toContain("@example/audit @example/warehouse");
  });

  it("--check: ok when current, missing / no-markers / stale otherwise, and never writes", () => {
    const repo = fresh();
    const file = join(repo.dir, "CODEOWNERS");
    const missing = em(["system", "codeowners", "--check"], repo.dir);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe("missing: CODEOWNERS does not exist — run `em system codeowners` and commit the result\n");
    expect(existsSync(file)).toBe(false);

    writeFileSync(file, "* @example/everyone\n");
    const nomark = em(["system", "codeowners", "--check"], repo.dir);
    expect(nomark.status).toBe(1);
    expect(nomark.stdout).toBe("no-markers: CODEOWNERS has no GENERATED:em-codeowners block — run `em system codeowners` and commit the result\n");
    expect(readFileSync(file, "utf8")).toBe("* @example/everyone\n");

    em(["system", "codeowners"], repo.dir);
    const ok = em(["system", "codeowners", "--check"], repo.dir);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe("ok: CODEOWNERS carries the generated block\n");

    // an owner edit makes it stale
    writeFileSync(repo.fulfillment, readFileSync(repo.fulfillment, "utf8").replace("@example/warehouse", "@example/fulfilment"));
    const before = readFileSync(file, "utf8");
    const stale = em(["system", "codeowners", "--check"], repo.dir);
    expect(stale.status).toBe(1);
    expect(stale.stdout).toBe("stale: CODEOWNERS differs from the generated block — run `em system codeowners` and commit the result\n");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("unrelated CODEOWNERS lines survive byte-for-byte, before and after the block", () => {
    const repo = fresh();
    const file = join(repo.dir, ".github", "CODEOWNERS");
    mkdirSync(dirname(file), { recursive: true });
    const head = "# our rules\n* @example/everyone\n/docs/ @example/writers   \n";
    writeFileSync(file, head);
    expect(em(["system", "codeowners"], repo.dir).stdout).toBe(`updated ${join(".", ".github", "CODEOWNERS").replace("./", "")} (6 entries)\n`);
    const spliced = readFileSync(file, "utf8");
    expect(spliced.startsWith(head + "\n# GENERATED:em-codeowners:start\n")).toBe(true);
    expect(existsSync(join(repo.dir, "CODEOWNERS"))).toBe(false);
    // add a trailer after the block, then regenerate after an owner change
    writeFileSync(file, spliced + "# tail\n/ci/ @example/platform\n");
    writeFileSync(repo.checkout, readFileSync(repo.checkout, "utf8").replace("@example/storefront", "@example/shop"));
    em(["system", "codeowners"], repo.dir);
    const final = readFileSync(file, "utf8");
    expect(final.startsWith(head + "\n# GENERATED:em-codeowners:start\n")).toBe(true);
    expect(final.endsWith("# GENERATED:em-codeowners:end\n# tail\n/ci/ @example/platform\n")).toBe(true);
    expect(final).toContain("/models/checkout/ @example/shop\n");
  });

  it("keeps an existing slices rule (the ratification convention) instead of fighting it", () => {
    const repo = fresh();
    writeFileSync(join(repo.dir, "CODEOWNERS"), "/models/checkout/slices/ @example/ratifiers\n");
    em(["system", "codeowners"], repo.dir);
    const text = readFileSync(join(repo.dir, "CODEOWNERS"), "utf8");
    // restated after the directory entry (last match wins), not replaced by the model team
    expect(text).toContain("/models/checkout/slices/** @example/ratifiers\n");
    expect(text).toContain("/models/fulfillment/slices/** @example/warehouse\n");
    const json = JSON.parse(em(["system", "codeowners", "--check", "--json"], repo.dir).stdout);
    expect(json.entries.find((e: { path: string }) => e.path === "/models/checkout/slices/**").reason).toBe("slices-existing");
    expect(json.status).toBe("ok");
  });

  it("-o picks the file and roots the paths at it; a non-handle owner is skipped with a note; no usable owner refuses", () => {
    const repo = fresh();
    writeFileSync(repo.checkout, readFileSync(repo.checkout, "utf8").replace('owner "@example/storefront"', 'owner "Storefront team", "@example/shop"'));
    const out = join(".github", "CODEOWNERS");
    const r = em(["system", "codeowners", "-o", out], repo.dir);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('note: model "checkout": skipping owner "Storefront team"');
    expect(readFileSync(join(repo.dir, out), "utf8")).toContain("/models/checkout/ @example/shop\n");

    writeFileSync(repo.checkout, readFileSync(repo.checkout, "utf8").replace('owner "Storefront team", "@example/shop"', 'owner "Storefront team"'));
    const refused = em(["system", "codeowners", "--check", "-o", out], repo.dir);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('em system codeowners: model "checkout" has no usable owner');

    writeFileSync(repo.checkout, readFileSync(repo.checkout, "utf8").replace(' owner "Storefront team"', ""));
    expect(em(["system", "codeowners", "--check", "-o", out], repo.dir).stderr).toContain("has no `owner` — add `owner \"@org/team\"`");
  });

  it("--json: the documented envelope, deterministic, no absolute paths", () => {
    const repo = fresh();
    const a = em(["system", "codeowners", "--json"], repo.dir);
    expect(a.status).toBe(0);
    const doc = JSON.parse(a.stdout);
    expect(Object.keys(doc)).toEqual(["codeownersSchemaVersion", "generator", "file", "entries", "status"]);
    expect(doc.codeownersSchemaVersion).toBe(CODEOWNERS_SCHEMA_VERSION);
    expect(doc.file).toBe("CODEOWNERS");
    expect(doc.status).toBe("created");
    expect(doc.entries[1]).toEqual({ path: "/models/checkout/contracts/checkout.tsp", owners: ["@example/storefront", "@example/warehouse"], reason: "contract" });
    expect(a.stdout).not.toContain(repo.dir);
    const b = em(["system", "codeowners", "--check", "--json"], repo.dir);
    expect(JSON.parse(b.stdout).status).toBe("ok");
    expect(b.stdout).toBe(buildCodeownersJson("CODEOWNERS", doc.entries, "ok") + "\n");
  });
});

describe("planCodeowners / splice / pattern matching (pure)", () => {
  it("codeownersPatternMatches follows gitignore anchoring", () => {
    expect(codeownersPatternMatches("slices/**", "slices/a.md")).toBe(true);
    expect(codeownersPatternMatches("slices/**", "models/x/slices/a.md")).toBe(false); // slash in the middle: anchored
    expect(codeownersPatternMatches("*.md", "models/x/slices/a.md")).toBe(true);
    expect(codeownersPatternMatches("/models/x/", "models/x/slices/a.md")).toBe(true);
    expect(codeownersPatternMatches("/models/x/slices/", "models/x/slices/a.md")).toBe(true);
    expect(codeownersPatternMatches("/models/y/", "models/x/slices/a.md")).toBe(false);
  });

  it("splice: no file -> fresh block; markers replaced in place; text without a trailing newline gets a blank-line gap", () => {
    const entries = [{ path: "/a/", owners: ["@o/a"], reason: "model-dir" as const }];
    expect(spliceCodeowners(null, entries).state).toBe("missing");
    const fresh1 = spliceCodeowners(null, entries).text;
    expect(spliceCodeowners(fresh1, entries)).toEqual({ text: fresh1, state: "ok" });
    expect(spliceCodeowners("x @o/x", entries).text.startsWith("x @o/x\n\n# GENERATED:em-codeowners:start\n")).toBe(true);
    expect(spliceCodeowners(fresh1, [{ ...entries[0], owners: ["@o/b"] }]).state).toBe("stale");
  });

  it("planCodeowners never lists the producer twice and sorts consumers", () => {
    const doc = (consumes: string[]) => ({
      schemaVersion: "1.15",
      model: { key: "x", name: "X", slices: [{ key: "s", name: "S", elements: [{ ref: "s/translation.t", kind: "translation" as const, name: "T", line: 1, public: false, consumes }] }], edges: [] },
    });
    const plan = planCodeowners([
      { key: "p", dir: "p", owner: ["@o/p"], doc: doc([]) },
      { key: "z", dir: "z", owner: ["@o/z", "@o/p"], doc: doc(["p:event.e"]) },
      { key: "b", dir: "b", owner: ["@o/b"], doc: doc(["p:event.e", "p:view.v", "nope:event.q"]) },
    ]);
    expect(plan.errors).toEqual([]);
    expect(plan.entries.find((e) => e.reason === "contract" && e.path === "/p/contracts/p.tsp")!.owners).toEqual(["@o/p", "@o/b", "@o/z"]);
  });
});
