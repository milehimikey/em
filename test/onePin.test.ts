// SPDX-License-Identifier: MIT
// GH #546: one em pin, in the model's repository — a command run from a code repository against
// a model elsewhere resolves the model repository's `.em-version`, and `em repos check` reports
// a code repository that fixes an em version of its own.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTemp } from "./helpers/rmTemp.js";
import { createMultiRepoProject, MultiRepoProject } from "./helpers/multiRepoProject.js";
import { findModelRepoPin, findOwnEmPins, resolveDispatch } from "../src/cli/versionPin.js";

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

describe("one em pin, in the model's repository (GH #546)", () => {
  let p: MultiRepoProject;
  const model = () => join(p.modelDir, "shop.em");

  beforeAll(() => {
    p = createMultiRepoProject(["web", "orders"], `codeMapSchemaVersion: "1.0"\ndefault: {repo: orders}\npersonas:\n  Customer: {repo: web}\n`);
    writeFileSync(join(p.modelRepo, ".em-version"), "1.24.0\n");
  });
  afterAll(() => rmTemp(p.base));

  it("a command naming the model resolves the model repository's pin, from a code repository", () => {
    const cwd = p.repoDir("orders");
    expect(findModelRepoPin(["conform", "bindings", "check", model(), "--exit-code"], cwd)).toEqual({ version: "1.24.0", source: join(p.modelRepo, ".em-version") });
    // Relative to the working directory, as a CI job would write it.
    expect(findModelRepoPin(["validate", "../model/shop/shop.em"], cwd)?.version).toBe("1.24.0");
    expect(resolveDispatch(cwd, "1.23.1", {}, ["validate", model()])).toEqual({ version: "1.24.0", source: join(p.modelRepo, ".em-version") });
    expect(resolveDispatch(cwd, "1.24.0", {}, ["validate", model()])).toBeNull();
    // A system.yaml names the model repository too.
    expect(findModelRepoPin(["system", join(p.modelRepo, "system.yaml")], cwd)?.version).toBe("1.24.0");
  });

  it("the model repository's pin wins over a pin the code repository carries", () => {
    const cwd = p.repoDir("orders");
    writeFileSync(join(cwd, ".em-version"), "1.20.0\n");
    try {
      expect(resolveDispatch(cwd, "1.23.1", {}, ["validate", model()])?.version).toBe("1.24.0");
      // With no model named, the pin above the working directory applies, as before.
      expect(resolveDispatch(cwd, "1.23.1", {}, ["repos", "check"])?.version).toBe("1.20.0");
      expect(resolveDispatch(cwd, "1.23.1", { EM_SKIP_VERSION_PIN: "1" }, ["validate", model()])).toBeNull();
      expect(resolveDispatch(cwd, "1.23.1", {}, ["upgrade", model()])).toBeNull();
    } finally {
      rmSync(join(cwd, ".em-version"));
    }
  });

  it("a model repository with no pin falls back to the working directory's, and never looks above its own repository", () => {
    rmSync(join(p.modelRepo, ".em-version"));
    writeFileSync(join(p.base, ".em-version"), "9.9.9\n"); // above every repository
    try {
      expect(findModelRepoPin(["validate", model()], p.repoDir("orders"))).toBeNull();
      // The cwd walk is unbounded, as it always was.
      expect(resolveDispatch(p.repoDir("orders"), "1.23.1", {}, ["validate", model()])?.version).toBe("9.9.9");
    } finally {
      rmSync(join(p.base, ".em-version"));
      writeFileSync(join(p.modelRepo, ".em-version"), "1.24.0\n");
    }
  });

  it("findOwnEmPins: .em-version, package.json and workflows", () => {
    const repo = p.repoDir("web");
    expect(findOwnEmPins(repo)).toEqual([]);
    writeFileSync(join(repo, ".em-version"), "1.22.0\n");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ devDependencies: { "@milehimikey/em": "^1.21.0", vitest: "1.0.0" } }));
    mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
    writeFileSync(join(repo, ".github", "workflows", "ci.yml"), "steps:\n  - run: npx -y @milehimikey/em@1.19.5 validate x.em\n  - run: npx -y @milehimikey/em@1.19.5 status x.em\n  - run: npx @milehimikey/em validate y.em\n");
    expect(findOwnEmPins(repo)).toEqual([
      { file: ".em-version", version: "1.22.0" },
      { file: "package.json", version: "^1.21.0" },
      { file: ".github/workflows/ci.yml", version: "1.19.5" },
    ]);
  });

  it("em repos check names the system's pin and each code repository that fixes its own", () => {
    const r = em(["repos", "check", "shop/shop.em"], p.modelRepo);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("em pin: 1.24.0 (.em-version, in the model's repository) — every repository runs em at this version");
    expect(r.stdout).toContain("  web: .em-version fixes em 1.22.0 itself — remove it");
    expect(r.stdout).toContain("  web: .github/workflows/ci.yml fixes em 1.19.5 itself");
    const doc = JSON.parse(em(["repos", "check", "shop/shop.em", "--json"], p.modelRepo).stdout);
    expect(doc.emPin).toEqual({ version: "1.24.0", file: ".em-version" });
    expect(doc.ownEmPins.map((x: { repo: string; file: string }) => `${x.repo}:${x.file}`)).toEqual(["web:.em-version", "web:package.json", "web:.github/workflows/ci.yml"]);
    expect(doc.summary.ownEmPins).toBe(3);
    // Every repo resolved, but a code repository pins its own: not ok, and --exit-code fails.
    expect(doc.ok).toBe(false);
    expect(em(["repos", "check", "shop/shop.em", "--exit-code"], p.modelRepo).status).toBe(1);
    for (const f of [".em-version", "package.json", ".github/workflows/ci.yml"]) rmSync(join(p.repoDir("web"), f));
    const clean = JSON.parse(em(["repos", "check", "shop/shop.em", "--json"], p.modelRepo).stdout);
    expect([clean.ok, clean.ownEmPins]).toEqual([true, []]);
  });

  it("a model repository with no pin is said to have none; a system with no code repositories says nothing about pins", () => {
    rmSync(join(p.modelRepo, ".em-version"));
    expect(em(["repos", "check", "shop/shop.em"], p.modelRepo).stdout).toContain("em pin: none — the model's repository has no .em-version");
    expect(em(["repos", "check"], p.repoDir("web")).stdout).not.toContain("em pin");
  });
});
