// SPDX-License-Identifier: MIT
// Coverage for `em conform-scope`'s core logic (src/cli/conformScope.ts): the implementedIn ->
// path matching rule, the full-vs-diff-scoped JSON shape, and the git layer with an injected
// fake runner (same convention as test/changelog-git.test.ts). CLI-level exit-code/process
// coverage (real git repo, real slice docs, real model, --seed-asis) lives in test/cli.test.ts.
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitResult, GitRunner } from "../src/cli/diff-inputs.js";
import {
  buildConformScope,
  changedPathsSince,
  matchImplementedInToPaths,
  seedAsisModel,
  LastConformance,
  SliceDocFacts,
} from "../src/cli/conformScope.js";

const fakeGit = (responses: GitResult[]): GitRunner => {
  let i = 0;
  return () => responses[i++] ?? { status: 1, stdout: "", stderr: "unexpected extra git call" };
};
const ok = (stdout: string): GitResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr: string): GitResult => ({ status: 128, stdout: "", stderr });

describe("matchImplementedInToPaths", () => {
  const changedPaths = ["src/checkout/CheckoutHandler.kt", "src/checkout/CheckoutHandler.test.kt", "src/billing/Invoice.kt"];

  it("matches a repo-relative directory path as a prefix", () => {
    expect(matchImplementedInToPaths("src/checkout", changedPaths)).toEqual([
      "src/checkout/CheckoutHandler.kt",
      "src/checkout/CheckoutHandler.test.kt",
    ]);
  });

  it("matches an exact file path", () => {
    expect(matchImplementedInToPaths("src/billing/Invoice.kt", changedPaths)).toEqual(["src/billing/Invoice.kt"]);
  });

  it("does not match a path that merely shares a prefix string (not a real directory boundary)", () => {
    expect(matchImplementedInToPaths("src/check", changedPaths)).toEqual([]);
  });

  it("never matches a URL — no repo-relative path information to trust", () => {
    expect(matchImplementedInToPaths("https://github.com/example/repo/pull/42", changedPaths)).toEqual([]);
  });

  it("never matches an SCP-style git remote link", () => {
    expect(matchImplementedInToPaths("git@github.com:example/repo.git", changedPaths)).toEqual([]);
  });

  it("returns [] for null implementedIn", () => {
    expect(matchImplementedInToPaths(null, changedPaths)).toEqual([]);
  });

  it("tolerates a leading ./ and trailing slash on the candidate", () => {
    expect(matchImplementedInToPaths("./src/checkout/", changedPaths)).toEqual([
      "src/checkout/CheckoutHandler.kt",
      "src/checkout/CheckoutHandler.test.kt",
    ]);
  });
});

describe("buildConformScope", () => {
  const slices: SliceDocFacts[] = [
    { key: "checkout", status: "implemented", implementedIn: "src/checkout" },
    { key: "billing", status: "implemented", implementedIn: "https://github.com/example/repo/pull/9" },
    { key: "draft-slice", status: "draft", implementedIn: null },
  ];
  const lastConformance: LastConformance = { date: "2026-08-01", revision: "abc123", report: "conformance/2026-08-01-report.md" };

  it("diff-scoped: maps a changed path via implementedIn, leaves a URL-only slice and unmatched paths as unmapped", () => {
    const changedPaths = ["src/checkout/CheckoutHandler.kt", "src/billing/Invoice.kt", "README.md"];
    const result = buildConformScope(slices, lastConformance, changedPaths, false);
    expect(result).toEqual({
      lastConformance: { date: "2026-08-01", revision: "abc123" },
      changedPaths,
      candidateSlices: [{ key: "checkout", matchedBy: "implementedIn", paths: ["src/checkout/CheckoutHandler.kt"] }],
      unmappedPaths: ["src/billing/Invoice.kt", "README.md"],
    });
  });

  it("first run (lastConformance null): every implemented slice, changedPaths/unmappedPaths empty, lastConformance echoed null", () => {
    const result = buildConformScope(slices, null, [], false);
    expect(result).toEqual({
      lastConformance: null,
      changedPaths: [],
      candidateSlices: [
        { key: "checkout", matchedBy: "full", paths: [] },
        { key: "billing", matchedBy: "full", paths: [] },
      ],
      unmappedPaths: [],
    });
  });

  it("--full overrides a set lastConformance: full candidate set, lastConformance still echoed back", () => {
    const result = buildConformScope(slices, lastConformance, [], true);
    expect(result).toEqual({
      lastConformance: { date: "2026-08-01", revision: "abc123" },
      changedPaths: [],
      candidateSlices: [
        { key: "checkout", matchedBy: "full", paths: [] },
        { key: "billing", matchedBy: "full", paths: [] },
      ],
      unmappedPaths: [],
    });
  });
});

describe("changedPathsSince", () => {
  it("parses git diff --name-only output into a path list", () => {
    const git = fakeGit([ok("/repo\n"), ok("src/checkout/CheckoutHandler.kt\nsrc/billing/Invoice.kt\n")]);
    const result = changedPathsSince("/repo", "abc123", git);
    expect(result).toEqual({ ok: true, paths: ["src/checkout/CheckoutHandler.kt", "src/billing/Invoice.kt"] });
  });

  it("fails clearly when the path isn't a git repository", () => {
    const git = fakeGit([fail("fatal: not a git repository")]);
    const result = changedPathsSince("/not-a-repo", "abc123", git);
    expect(result).toEqual({ ok: false, message: "em conform-scope: /not-a-repo is not a git repository" });
  });

  it("fails clearly on an unknown revision", () => {
    const git = fakeGit([ok("/repo\n"), fail("fatal: ambiguous argument 'not-a-rev..HEAD': unknown revision or path not in the working tree.")]);
    const result = changedPathsSince("/repo", "not-a-rev", git);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("git diff failed");
    expect(result.message).toContain("unknown revision");
  });
});

describe("seedAsisModel", () => {
  let dir: string;

  const setup = () => mkdtempSync(join(tmpdir(), "em-conform-scope-seed-"));

  it("writes a byte-identical copy and creates the gitignore when missing", () => {
    dir = setup();
    try {
      const modelPath = join(dir, "model.em");
      writeFileSync(modelPath, 'slice "Place" {\n  command Place Order\n}\n');
      const git = fakeGit([{ status: 1, stdout: "", stderr: "fatal: not a git repository" }]);
      const result = seedAsisModel(modelPath, git);
      expect(result.asisPath).toBe(join(dir, "model-asis.em"));
      expect(readFileSync(result.asisPath, "utf8")).toBe(readFileSync(modelPath, "utf8"));
      expect(result.gitignoreUpdated).toBe(true);
      expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("*-asis.em\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends to an existing gitignore that lacks the line, keeping other lines intact", () => {
    dir = setup();
    try {
      const modelPath = join(dir, "model.em");
      writeFileSync(modelPath, "slice \"Place\" {}\n");
      writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
      const git = fakeGit([ok(`${dir}\n`)]);
      const result = seedAsisModel(modelPath, git);
      expect(result.gitignoreUpdated).toBe(true);
      expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("node_modules/\n*-asis.em\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent: does not duplicate the line when already present", () => {
    dir = setup();
    try {
      const modelPath = join(dir, "model.em");
      writeFileSync(modelPath, "slice \"Place\" {}\n");
      writeFileSync(join(dir, ".gitignore"), "node_modules/\n*-asis.em\n");
      const git = fakeGit([ok(`${dir}\n`)]);
      const result = seedAsisModel(modelPath, git);
      expect(result.gitignoreUpdated).toBe(false);
      expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("node_modules/\n*-asis.em\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the gitignore at the resolved repo root, not the model's own directory", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "em-conform-scope-seed-root-"));
    try {
      const modelDir = join(repoRoot, "models", "checkout");
      mkdirSync(modelDir, { recursive: true });
      const modelPath = join(modelDir, "model.em");
      writeFileSync(modelPath, "slice \"Place\" {}\n");
      const git = fakeGit([ok(`${repoRoot}\n`)]);
      const result = seedAsisModel(modelPath, git);
      expect(result.asisPath).toBe(join(modelDir, "model-asis.em"));
      expect(readFileSync(join(repoRoot, ".gitignore"), "utf8")).toBe("*-asis.em\n");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
