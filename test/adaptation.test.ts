// SPDX-License-Identifier: MIT
// MIL-239: the consumer-adaptation check — a consuming translation whose declared fields no
// longer match the producer's public element at HEAD raises `consumer-not-adapted`. Unit tests
// over the pure comparison, then end-to-end on a tmp git repo built from the multi-model example
// (the seeded producer rename is a TEST, not a committed broken example).
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareConsumerFields, adaptationMessage, AdaptationField } from "../src/system/adaptation.js";
import { makeMultiModelRepo, MultiModelRepo } from "./helpers/multiModelRepo.js";

vi.setConfig({ testTimeout: 20_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");
function em(args: string[], cwd: string) {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const f = (name: string, type: string | null = "string", renamedFrom: string[] | null = null): AdaptationField => ({
  name,
  type,
  typeRef: null,
  renamedFrom,
});

describe("compareConsumerFields", () => {
  it("identical fields: adapted", () => {
    expect(compareConsumerFields([f("a"), f("b", "int")], [f("a"), f("b", "int")])).toEqual([]);
  });
  it("additive producer fields are never a problem", () => {
    expect(compareConsumerFields([f("a")], [f("a"), f("extra"), f("more", "int")])).toEqual([]);
  });
  it("a removed field is reported", () => {
    expect(compareConsumerFields([f("a"), f("b")], [f("a")])).toEqual([{ field: "b", what: "removed" }]);
  });
  it("a renamed field names the new name", () => {
    expect(compareConsumerFields([f("orderId", "uuid")], [f("customerOrderId", "uuid", ["orderId"])])).toEqual([
      { field: "orderId", what: 'renamed to "customerOrderId"' },
    ]);
  });
  it("a type change on a shared field is reported; case and spacing of the type do not matter", () => {
    expect(compareConsumerFields([f("total", "decimal")], [f("total", "string")])).toEqual([
      { field: "total", what: "type changed decimal → string" },
    ]);
    expect(compareConsumerFields([f("total", "Decimal")], [f("total", "decimal")])).toEqual([]);
  });
  it("message names consumer, producer, fields and the commit (or says it is unknown)", () => {
    const problems = [{ field: "x", what: "removed" }];
    expect(adaptationMessage("C", "P", problems, "abc123")).toBe('C is not adapted to P: field "x" removed — producer last changed in abc123');
    expect(adaptationMessage("C", "P", problems, null)).toContain("(commit unknown)");
  });
});

describe("consumer-not-adapted end to end (multi-model example)", () => {
  let repo: MultiModelRepo | undefined;
  afterEach(() => repo?.cleanup());

  const renameInCheckout = (r: MultiModelRepo) => {
    const text = readFileSync(r.checkout, "utf8");
    writeFileSync(r.checkout, text.replace("    orderId: uuid assigned\n", '    customerOrderId: uuid assigned renamed from "orderId"\n'));
    r.git("commit", "-aqm", "rename orderId");
    return r.git("rev-parse", "HEAD").trim();
  };

  it("the shipped example is adapted: clean, summary checked 1 / notAdapted 0", () => {
    repo = makeMultiModelRepo();
    const out = em(["system", "system.yaml", "--json"], repo.dir);
    expect(out.status).toBe(0);
    const doc = JSON.parse(out.stdout);
    expect(doc.consumerAdaptation).toEqual({ checked: 1, notAdapted: 0 });
    expect(doc.diagnostics.map((d: { code: string }) => d.code)).not.toContain("consumer-not-adapted");
  });

  it("(a) producer rename: exit 1, names consumer, field, rename target and producer commit; (b) updating the consumer is clean", () => {
    repo = makeMultiModelRepo();
    const sha = renameInCheckout(repo);
    const out = em(["system", "system.yaml", "--json"], repo.dir);
    expect(out.status).toBe(1);
    const doc = JSON.parse(out.stdout);
    expect(doc.consumerAdaptation).toEqual({ checked: 1, notAdapted: 1 });
    const d = doc.diagnostics.find((x: { code: string }) => x.code === "consumer-not-adapted");
    expect(d.severity).toBe("error");
    expect(d.refs).toEqual(["fulfillment:receive-order/translation.order-intake", "checkout:checkout/event.order-submitted"]);
    expect(d.message).toBe(
      'translation "Order Intake" (fulfillment:receive-order/translation.order-intake) is not adapted to ' +
        'event "Order Submitted" (checkout:checkout/event.order-submitted): field "orderId" renamed to "customerOrderId" ' +
        `— producer last changed in ${sha.slice(0, 12)}`,
    );
    expect(doc.seams[0].status).toBe("error");
    expect(doc.seams[0].diagnostics).toContain("consumer-not-adapted");
    const text = em(["system", "system.yaml"], repo.dir);
    expect(text.status).toBe(1);
    expect(text.stderr).toContain("is not adapted to event");

    // (b) the consumer adapts.
    const intake = readFileSync(repo.fulfillment, "utf8");
    writeFileSync(
      repo.fulfillment,
      intake.replace(/(translation Order Intake consumes checkout:event\.order-submitted[^{\n]*\{\n {4})orderId: uuid/, "$1customerOrderId: uuid"),
    );
    const after = em(["system", "system.yaml", "--json"], repo.dir);
    expect(after.status).toBe(0);
    expect(JSON.parse(after.stdout).consumerAdaptation).toEqual({ checked: 1, notAdapted: 0 });
  });

  it("(c) an optional field added to the producer stays clean", () => {
    repo = makeMultiModelRepo();
    const text = readFileSync(repo.checkout, "utf8");
    writeFileSync(repo.checkout, text.replace("    placedAt: datetime assigned\n", "    placedAt: datetime assigned\n    couponCode?: string\n"));
    repo.git("commit", "-aqm", "add optional field");
    const out = em(["system", "system.yaml", "--json"], repo.dir);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).consumerAdaptation).toEqual({ checked: 1, notAdapted: 0 });
  });

  it("(d) a type change on a shared field is a finding", () => {
    repo = makeMultiModelRepo();
    const text = readFileSync(repo.checkout, "utf8");
    writeFileSync(repo.checkout, text.replace("    total: decimal\n    placedAt", "    total: string\n    placedAt"));
    repo.git("commit", "-aqm", "total becomes string");
    const out = em(["system", "system.yaml", "--json"], repo.dir);
    expect(out.status).toBe(1);
    const d = JSON.parse(out.stdout).diagnostics.find((x: { code: string }) => x.code === "consumer-not-adapted");
    expect(d.message).toContain('field "total" type changed decimal → string');
  });

  it("a consumer with no declared fields has nothing to compare: no finding, checked 0", () => {
    repo = makeMultiModelRepo();
    const text = readFileSync(repo.fulfillment, "utf8");
    writeFileSync(repo.fulfillment, text.replace(/(translation Order Intake consumes checkout:event\.order-submitted[^{\n]*?) \{\n {4}orderId: uuid\n {4}total: decimal\n {2}\}/, "$1"));
    const out = em(["system", "system.yaml", "--json"], repo.dir);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).consumerAdaptation).toEqual({ checked: 0, notAdapted: 0 });
  });

  it("an export-document producer has no commit: the check still runs and says (commit unknown)", () => {
    repo = makeMultiModelRepo();
    renameInCheckout(repo);
    // Export-document source: no .em path, so no commit can be named — but the finding stands.
    const exp = em(["export", repo.checkout], repo.dir);
    writeFileSync(join(repo.dir, "checkout.json"), exp.stdout);
    writeFileSync(repo.manifest, readFileSync(repo.manifest, "utf8").replace("models/checkout/checkout.em", "checkout.json"));
    const out = em(["system", "system.yaml", "--json"], repo.dir);
    expect(out.status).toBe(1);
    expect(out.stdout).toContain("(commit unknown)");
  });

  it("(e) em status: system block with a manifest above the first input, null without", () => {
    repo = makeMultiModelRepo();
    renameInCheckout(repo);
    const withManifest = em(["status", join("models", "fulfillment", "fulfillment.em"), "--json"], repo.dir);
    expect(withManifest.status).toBe(0);
    const doc = JSON.parse(withManifest.stdout);
    expect(doc.statusSchemaVersion).toBe("1.8");
    expect(doc.system).toEqual({ manifest: "system.yaml", consumerNotAdapted: 1 });
    const text = em(["status", join("models", "fulfillment", "fulfillment.em")], repo.dir);
    expect(text.stdout).toContain("consumer adaptation: 1 not adapted (system.yaml)");

    const bare = makeMultiModelRepo({ manifest: false });
    try {
      const none = em(["status", join("models", "fulfillment", "fulfillment.em"), "--json"], bare.dir);
      expect(JSON.parse(none.stdout).system).toBeNull();
      expect(none.stdout).not.toContain("consumer adaptation");
      expect(em(["status", join("models", "fulfillment", "fulfillment.em")], bare.dir).stdout).not.toContain("consumer adaptation");
    } finally {
      bare.cleanup();
    }
  });

  it("status discovery stops at the repo root: a manifest above a nested git repo is not used", () => {
    repo = makeMultiModelRepo();
    const sub = join(repo.dir, "sub");
    mkdirSync(sub);
    writeFileSync(join(sub, "m.em"), readFileSync(repo.fulfillment, "utf8"));
    spawnSync("git", ["init", "-q"], { cwd: sub });
    const out = em(["status", join("sub", "m.em"), "--json"], repo.dir);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).system).toBeNull();
  });
});
