// SPDX-License-Identifier: MIT
// GH #237: every `<slice-key>` argument resolves from the export key, the display name, or a
// unique prefix of either — and an unknown key lists the valid ones. The resolver itself, then the
// two verbs the issue named (`em engagement new --slices`, `em validate --slice-ready`) plus
// `em slice review` for the shared-helper wiring. Output always carries the canonical export key.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../src/pipeline.js";
import { resolveSliceKey } from "../src/model/resolveSlice.js";

vi.setConfig({ testTimeout: 20_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");
function em(args: string[], cwd: string) {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const slice = (name: string, event: string) => `slice "${name}" {\n  ui ${name} Screen @Member\n  command ${name}\n  event ${event} @Orders\n}\n`;
const SMALL = [
  slice("ORD-0001 Place Order", "Order Placed"),
  slice("ORD-0002 Cancel Order", "Order Cancelled"),
  slice("INV-0001 Issue Invoice", "Invoice Issued"),
].join("\n");

function load(src: string) {
  const { model, refs } = compile(src);
  return { model, refs };
}

describe("resolveSliceKey", () => {
  const { model, refs } = load(SMALL);
  const key = (input: string) => {
    const r = resolveSliceKey(model, refs, input);
    return r.ok ? r.key : r.message;
  };

  it("exact export key", () => expect(key("ord-0001-place-order")).toBe("ord-0001-place-order"));
  it("display name, case-insensitive and whitespace-normalized", () => {
    expect(key("ORD-0001 Place Order")).toBe("ord-0001-place-order");
    expect(key("  ord-0002   cancel ORDER ")).toBe("ord-0002-cancel-order");
  });
  it("unique prefix of the key or of the display name", () => {
    expect(key("ORD-0001")).toBe("ord-0001-place-order");
    expect(key("ord-0002 can")).toBe("ord-0002-cancel-order");
    expect(key("inv")).toBe("inv-0001-issue-invoice");
  });
  it("kebab form of the input counts as a candidate", () => expect(key("ord 0001 place")).toBe("ord-0001-place-order"));
  it("an ambiguous prefix lists the candidates", () => {
    expect(key("ORD")).toBe('slice "ORD" is ambiguous — it matches ord-0001-place-order, ord-0002-cancel-order');
  });
  it("an unknown key prints the valid keys", () => {
    expect(key("nope")).toBe(
      'no slice with export key "nope" in this model — valid keys: ord-0001-place-order, ord-0002-cancel-order, inv-0001-issue-invoice',
    );
  });
  it("a model with many slices prints the nearest few as `did you mean`", () => {
    const big = load(Array.from({ length: 25 }, (_, i) => slice(`Thing ${String.fromCharCode(97 + i)}${i}`, `Thing ${i} Done`)).join("\n"));
    const r = resolveSliceKey(big.model, big.refs, "thing-b1x");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/^no slice with export key "thing-b1x" in this model — did you mean thing-b1, /);
      expect(r.message).not.toContain("valid keys");
    }
  });
});

describe("slice-key resolution on the CLI", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-slice-key-"));
    writeFileSync(join(dir, "m.em"), SMALL);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  describe("em engagement new --slices", () => {
    const run = (slices: string, slug = "e") => em(["engagement", "new", "m.em", slug, "--slices", slices, "--force"], dir);

    it.each([
      ["exact key", "ord-0001-place-order"],
      ["display name", "ORD-0001 Place Order"],
      ["unique prefix", "ORD-0001"],
      ["kebab-form prefix", "ord 0001 pl"],
    ])("%s resolves to the canonical export key", (_label, input) => {
      const r = run(input);
      expect(r.stderr).not.toContain("no slice");
      expect(r.stdout).toBe("wrote engagements/e.md (1 slice: ord-0001-place-order)\n");
    });

    it("mixes forms in one list", () => {
      expect(run("ORD-0001, inv-0001-issue-invoice").stdout).toContain("(2 slices: ord-0001-place-order, inv-0001-issue-invoice)");
    });

    it("an ambiguous prefix is refused with the candidates", () => {
      const r = run("ORD");
      expect(r.status).toBe(1);
      expect(r.stderr).toBe('em engagement new: slice "ORD" is ambiguous — it matches ord-0001-place-order, ord-0002-cancel-order\n');
    });

    it("an unknown key is refused with the valid keys", () => {
      const r = run("nope");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('no slice with export key "nope" in this model — valid keys: ord-0001-place-order, ord-0002-cancel-order, inv-0001-issue-invoice');
    });
  });

  describe("em validate --slice-ready", () => {
    const run = (input: string) => em(["validate", "m.em", "--slice-ready", input], dir);

    it.each([
      ["exact key", "ord-0001-place-order"],
      ["display name", "ORD-0001 Place Order"],
      ["unique prefix", "ORD-0001"],
      ["kebab-form prefix", "ord 0001 pl"],
    ])("%s resolves to the canonical export key", (_label, input) => {
      const r = run(input);
      expect(r.stdout).toContain('slice "ord-0001-place-order" is NOT ready-to-implement');
      expect(r.stderr).not.toContain("no slice");
    });

    it("an ambiguous prefix errors with the candidates", () => {
      const r = run("ORD");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('slice "ORD" is ambiguous — it matches ord-0001-place-order, ord-0002-cancel-order');
    });

    it("an unknown key errors with the valid keys", () => {
      const r = run("nope");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('no slice with export key "nope" in this model — valid keys: ord-0001-place-order, ord-0002-cancel-order, inv-0001-issue-invoice');
    });
  });

  it("the other verbs share the resolver (em slice review, em export --slice)", () => {
    const review = em(["slice", "review", "m.em", "nope", "--by", "Alex"], dir);
    expect(review.status).toBe(1);
    expect(review.stderr).toContain('em slice review: no slice with export key "nope" in this model — valid keys: ');
    const exported = em(["export", "m.em", "--slice", "ORD-0002"], dir);
    expect(exported.status).toBe(0);
    expect(exported.stdout).toContain("ord-0002-cancel-order");
  });
});
