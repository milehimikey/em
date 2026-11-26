// SPDX-License-Identifier: MIT
// GH #547: examples/multi-repo/ is the worked example of a model whose code is in several
// repositories. Its four directories stand for four repositories, so this copies the example
// out, makes each one a git repository, and runs what the README says to run.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitInitQuiet } from "./helpers/gitInitQuiet.js";
import { rmTemp } from "./helpers/rmTemp.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const em = (args: string[], cwd: string) => {
  const r = spawnSync(process.execPath, [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "src", "cli.ts"), ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, EM_SKIP_VERSION_PIN: "1" },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const REPOS = ["storefront-model", "storefront-web", "checkout-svc", "payments-svc"];

describe("examples/multi-repo/", () => {
  let base: string;
  let model: string;

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "em-example-multi-repo-")));
    cpSync(join(ROOT, "examples", "multi-repo"), base, { recursive: true });
    for (const r of REPOS) gitInitQuiet(join(base, r), "-b", "main");
    model = join(base, "storefront-model");
    // The example ships with no pin, so it runs on any em; a real system has this one file.
    writeFileSync(join(model, ".em-version"), "1.24.0\n");
  });
  afterAll(() => rmTemp(base));

  it("validates in place, in this repository, and from the copy", () => {
    expect(em(["validate", "checkout/checkout.em"], join(ROOT, "examples", "multi-repo", "storefront-model")).status).toBe(0);
    expect(em(["validate", "checkout/checkout.em"], model).status).toBe(0);
  });

  it("every repo resolves as a sibling, with one em pin and no code repository fixing its own", () => {
    const doc = JSON.parse(em(["repos", "check", "checkout/checkout.em", "--json"], model).stdout);
    expect(doc.repos.map((r: { id: string; status: string; source: string }) => `${r.id}:${r.status}:${r.source}`)).toEqual([
      "self:resolved:self",
      "storefront-web:resolved:sibling",
      "checkout-svc:resolved:sibling",
      "payments-svc:resolved:sibling",
    ]);
    expect(doc.emPin).toEqual({ version: "1.24.0", file: ".em-version" });
    expect(doc.ownEmPins).toEqual([]);
    expect(doc.ok).toBe(true);
  });

  it("places: a slice in two repositories, an automation across two services, a slice in one", () => {
    const doc = JSON.parse(em(["query", "slices", "checkout/checkout.em", "--json"], model).stdout);
    const repos = Object.fromEntries(doc.results.map((s: { ref: string; places: { repo: string }[] }) => [s.ref, s.places.map((p) => p.repo)]));
    expect(repos).toEqual({
      "place-order": ["storefront-web", "checkout-svc"],
      "orders-to-charge": ["checkout-svc"],
      "take-payment": ["checkout-svc", "payments-svc"],
      "charged-orders": ["checkout-svc"],
    });
  });

  it("the bindings check finds each binding in its own repository, with no flags", () => {
    const r = em(["conform", "bindings", "check", "checkout/checkout.em", "--exit-code"], model);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[ok] ui.checkout -> storefront-web:src/checkout/CheckoutPage.tsx ("CheckoutPage")');
    expect(r.stdout).toContain('[ok] command.take-payment -> payments-svc:src/payments/TakePaymentHandler.kt ("takePayment")');
    expect(r.stdout).toContain("2 file(s) checked, 0 failed; 6 element binding(s), 0 failed");
  });

  it("a repository that is not checked out fails its bindings and no others", () => {
    rmSync(join(base, "payments-svc"), { recursive: true });
    const r = em(["conform", "bindings", "check", "checkout/checkout.em", "--exit-code"], model);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('repo "payments-svc" has no checkout here');
    expect(r.stdout).toContain("6 element binding(s), 2 failed");
  });
});
