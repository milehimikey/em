// SPDX-License-Identifier: MIT
// GH #475: a storyline model (a root `.em` plus storyline files, GH #421) loaded at git
// revisions — `em api check --base`, `em changelog`, scope/metrics doc reads — and the remaining
// single-file compile sites (`em system` sources, `em query`).

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitInitQuiet } from "./helpers/gitInitQuiet.js";
import { rmTemp } from "./helpers/rmTemp.js";
import { gitSourceReader, resolveRevision } from "../src/cli/diff-inputs.js";
import { runApiCheck } from "../src/cli/api.js";
import { docFromText } from "../src/cli/scopeInputs.js";
import { loadSource } from "../src/cli/systemInputs.js";
import { compileForQuery } from "../src/query/pipeline.js";
import { ModelLoadError } from "../src/model/loadModel.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");

function em(args: string[], cwd: string) {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}
function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.email=t@t.test", "-c", "user.name=t", "-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

const ROOT_EM = `model "Shop"
persona Customer
context Sales

slice "Browse" {
  ui Catalog @Customer
  command Browse { sessionId: uuid }
  event Browsed @Sales { sessionId: uuid }
}

storyline "Checkout" in "checkout/checkout.em"
`;

const CHECKOUT_V1 = `storyline "Checkout"

slice "Place Order" {
  command Place Order public { orderId: uuid, sessionId: uuid }
  event Order Placed @Sales public { orderId: uuid, sessionId: uuid }
}
slice "Order Status" {
  view Order Status public from "Order Placed" { orderId: uuid }
}
`;

// rev 2: Place Order drops sessionId (breaking), Order Placed gains a field (additive)
const CHECKOUT_V2 = `storyline "Checkout"

slice "Place Order" {
  command Place Order public { orderId: uuid }
  event Order Placed @Sales public { orderId: uuid, sessionId: uuid, total: int }
}
slice "Order Status" {
  view Order Status public from "Order Placed" { orderId: uuid }
}
`;

/** A git repo: commit 1 = ROOT_EM + CHECKOUT_V1; the working tree (and commit 2, when asked) = V2. */
function fixture(commitSecond: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "em-mfar-"));
  writeFileSync(join(dir, "shop.em"), ROOT_EM);
  mkdirSync(join(dir, "checkout"));
  writeFileSync(join(dir, "checkout", "checkout.em"), CHECKOUT_V1);
  gitInitQuiet(dir);
  git(dir, "add", "shop.em", "checkout/checkout.em");
  git(dir, "commit", "-q", "-m", "rev one");
  // root changes too (so `em changelog`, which follows the root file, sees a second commit)
  writeFileSync(join(dir, "shop.em"), ROOT_EM.replace("persona Customer\n", "persona Customer\npersona Admin\n"));
  writeFileSync(join(dir, "checkout", "checkout.em"), CHECKOUT_V2);
  if (commitSecond) {
    git(dir, "add", "shop.em", "checkout/checkout.em");
    git(dir, "commit", "-q", "-m", "rev two");
  }
  return dir;
}

describe("gitSourceReader", () => {
  it("reads a storyline file at the revision, not the working tree", () => {
    const dir = fixture(false);
    try {
      const read = gitSourceReader(join(dir, "shop.em"), "HEAD");
      expect(read("checkout/checkout.em")).toBe(CHECKOUT_V1);
      expect(() => read("checkout/missing.em")).toThrow();
      const root = resolveRevision(join(dir, "shop.em"), "HEAD");
      expect(root.ok && root.content).toBe(ROOT_EM);
    } finally {
      rmTemp(dir);
    }
  });
});

describe("em api check --base on a storyline model (GH #475)", () => {
  it("diffs the public surface across revisions, storyline files included", () => {
    const dir = fixture(false);
    try {
      const r = runApiCheck(join(dir, "shop.em"), "HEAD");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const lines = r.report.changes.map((c) => `${c.kind}: ${c.element}${c.field !== null ? ` ${c.field}` : ""} ${c.what}`);
      expect(lines.some((l) => l.startsWith("breaking:") && l.includes("sessionId"))).toBe(true);
      expect(lines.some((l) => l.startsWith("additive:") && l.includes("total"))).toBe(true);
      // Place Order / Order Placed live only in the storyline file: the base surface was whole,
      // so neither is reported as a brand-new element.
      expect(r.report.changes.some((c) => c.what.includes("new") && c.element.includes("Place Order") && c.field === null)).toBe(false);
    } finally {
      rmTemp(dir);
    }
  });

  it("CLI: no refusal; against an identical base there are no changes", () => {
    const dir = fixture(true);
    try {
      const same = em(["api", "check", "shop.em", "--base", "HEAD"], dir);
      expect(same.stderr).not.toContain("does not yet support storyline models");
      expect(same.stdout).toContain("no public-surface changes since HEAD");
      const diff = em(["api", "check", "shop.em", "--base", "HEAD~1"], dir);
      expect(diff.stdout).toMatch(/breaking: .*sessionId/);
      expect(diff.stdout).toMatch(/additive: .*total/);
    } finally {
      rmTemp(dir);
    }
  });

  it("a base revision whose storyline file is missing reports the load error, not a partial diff", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-mfar-"));
    try {
      writeFileSync(join(dir, "shop.em"), ROOT_EM);
      gitInitQuiet(dir);
      git(dir, "add", "shop.em");
      git(dir, "commit", "-q", "-m", "root only");
      mkdirSync(join(dir, "checkout"));
      writeFileSync(join(dir, "checkout", "checkout.em"), CHECKOUT_V1);
      const r = runApiCheck(join(dir, "shop.em"), "HEAD");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain("cannot be read");
    } finally {
      rmTemp(dir);
    }
  });
});

describe("em changelog on a storyline model (GH #475)", () => {
  it("diffs revisions with the storyline files read at each commit", () => {
    const dir = fixture(true);
    try {
      const r = em(["changelog", "shop.em"], dir);
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain("cannot be read");
      // The storyline-file field change shows up in the second entry's diff.
      expect(r.stdout).toContain("total");
    } finally {
      rmTemp(dir);
    }
  });
});

describe("scope/metrics doc reads (GH #475)", () => {
  it("docFromText with a repo-file reader carries the storyline slices; without one it does not", () => {
    const dir = fixture(false);
    try {
      const readRepoFile = (rel: string): string | null => {
        const s = spawnSync("git", ["-C", dir, "show", `HEAD:${rel}`], { encoding: "utf8" });
        return s.status === 0 ? s.stdout : null;
      };
      const withFiles = docFromText(ROOT_EM, "shop.em", readRepoFile);
      expect(withFiles?.model.slices.map((s) => s.name)).toEqual(["Browse", "Place Order", "Order Status"]);
      expect(docFromText(ROOT_EM, "shop.em", () => null)).toBeNull();
    } finally {
      rmTemp(dir);
    }
  });
});

describe("single-file compile sweep (GH #475)", () => {
  it("em system's source loader compiles a storyline root with its files", () => {
    const dir = fixture(false);
    try {
      const r = loadSource(join(dir, "shop.em"));
      expect("error" in r).toBe(false);
      if (!("error" in r)) expect(r.doc.model.slices.map((s) => s.name)).toContain("Place Order");
    } finally {
      rmTemp(dir);
    }
  });

  it("loadSource names an unreadable storyline file instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-mfar-"));
    try {
      writeFileSync(join(dir, "shop.em"), ROOT_EM);
      const r = loadSource(join(dir, "shop.em"));
      expect("error" in r && r.error).toContain("cannot be read");
    } finally {
      rmTemp(dir);
    }
  });

  it("compileForQuery loads storyline files (and throws ModelLoadError when one is missing)", () => {
    const dir = fixture(false);
    try {
      const c = compileForQuery(ROOT_EM, dir);
      expect(c.model.slices.map((s) => s.name)).toContain("Place Order");
      expect(() => compileForQuery(ROOT_EM, join(dir, "nowhere"))).toThrow(ModelLoadError);
    } finally {
      rmTemp(dir);
    }
  });

  it("CLI: em query sees an element declared in a storyline file", () => {
    const dir = fixture(false);
    try {
      const r = em(["query", "producers", "shop.em", "--event", "Order Placed", "--json"], dir);
      expect(r.stderr).not.toContain("cannot be read");
      expect(r.stdout).toContain("Place Order");
    } finally {
      rmTemp(dir);
    }
  });
});
