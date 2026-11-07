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
import { compileModelFile } from "../src/pipeline.js";
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
    { key: "checkout", status: "implemented", implementedIn: "src/checkout", shipped: true, file: null },
    { key: "billing", status: "implemented", implementedIn: "https://github.com/example/repo/pull/9", shipped: true, file: "billing/billing.em" },
    { key: "draft-slice", status: "draft", implementedIn: null, shipped: false, file: null },
  ];
  const lastConformance: LastConformance = {
    date: "2026-08-01",
    revision: "abc123",
    report: "conformance/2026-08-01-report.md",
    partial: false,
  };

  it("diff-scoped: maps a changed path via implementedIn, leaves a URL-only slice and unmatched paths as unmapped", () => {
    const changedPaths = ["src/checkout/CheckoutHandler.kt", "src/billing/Invoice.kt", "README.md"];
    const result = buildConformScope(slices, lastConformance, changedPaths, false);
    expect(result).toEqual({
      lastConformance: { date: "2026-08-01", revision: "abc123", partial: false },
      changedPaths,
      candidateSlices: [{ key: "checkout", matchedBy: "implementedIn", paths: ["src/checkout/CheckoutHandler.kt"], file: null }],
      unmappedPaths: ["src/billing/Invoice.kt", "README.md"],
    });
  });

  it("first run (lastConformance null): every implemented slice, changedPaths/unmappedPaths empty, lastConformance echoed null", () => {
    const result = buildConformScope(slices, null, [], false);
    expect(result).toEqual({
      lastConformance: null,
      changedPaths: [],
      candidateSlices: [
        { key: "checkout", matchedBy: "full", paths: [], file: null },
        { key: "billing", matchedBy: "full", paths: [], file: "billing/billing.em" },
      ],
      unmappedPaths: [],
    });
  });

  it("--full overrides a set lastConformance: full candidate set, lastConformance still echoed back", () => {
    const result = buildConformScope(slices, lastConformance, [], true);
    expect(result).toEqual({
      lastConformance: { date: "2026-08-01", revision: "abc123", partial: false },
      changedPaths: [],
      candidateSlices: [
        { key: "checkout", matchedBy: "full", paths: [], file: null },
        { key: "billing", matchedBy: "full", paths: [], file: "billing/billing.em" },
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
      // GH #451: a model with no storyline files reports an empty list, not omitted.
      expect(result.storylineFiles).toEqual([]);
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

// GH #451: a root that declares a storyline without a body (GH #421) has no slice bodies of its
// own — `seedAsisModel` must also copy each storyline file to its own `-asis` sibling and point
// the copied root `in` at it, or the agent has nowhere to write an in-scope storyline slice's
// as-is picture without touching the canonical file.
describe("seedAsisModel (storyline models, GH #451)", () => {
  const ROOT_EM = 'model "Shed"\npersona Neighbor\ncontext Loans\n\nstoryline "Join the shed" {\n  slice "Register" {\n    ui Sign Up @Neighbor\n    command Register Neighbor\n    event Neighbor Registered @Loans\n  }\n}\n\nstoryline "Chase an overdue loan" after "Join the shed" in "stories/chase.em"\n';
  const CHASE_EM = 'storyline "Chase an overdue loan" source "docs/shed.md#chase"\n\nslice "Overdue Loans To Notify" {\n  view Overdue Loans To Notify from "Neighbor Registered"\n}\n';

  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "em-conform-scope-seed-storyline-"));
    writeFileSync(join(dir, "shed.em"), ROOT_EM);
    mkdirSync(join(dir, "stories"));
    writeFileSync(join(dir, "stories", "chase.em"), CHASE_EM);
    return dir;
  };

  it("copies each storyline file to its own -asis sibling and rewrites the copied root's declaration to `in` it", () => {
    const dir = setup();
    try {
      const modelPath = join(dir, "shed.em");
      const git = fakeGit([{ status: 1, stdout: "", stderr: "fatal: not a git repository" }]);
      const result = seedAsisModel(modelPath, git);

      expect(result.asisPath).toBe(join(dir, "shed-asis.em"));
      expect(result.storylineFiles).toEqual([{ file: "stories/chase.em", asisFile: "stories/chase-asis.em" }]);

      // The root's inline storyline ("Join the shed") is byte-identical; only the external
      // storyline's declaration line changes, to `in` the new asis sibling.
      const asisRoot = readFileSync(result.asisPath, "utf8");
      expect(asisRoot).toContain('storyline "Join the shed" {\n');
      expect(asisRoot).toContain('storyline "Chase an overdue loan" after "Join the shed" in "stories/chase-asis.em"');
      expect(asisRoot).not.toContain("stories/chase.em");

      // The storyline file itself is copied byte-for-byte, and the canonical one is untouched.
      const chaseAsis = readFileSync(join(dir, "stories", "chase-asis.em"), "utf8");
      expect(chaseAsis).toBe(CHASE_EM);
      expect(readFileSync(join(dir, "stories", "chase.em"), "utf8")).toBe(CHASE_EM);

      // The asis root + its rewritten sibling still compile as one model (em diff needs this).
      const { diagnostics } = compileModelFile(result.asisPath);
      expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent and re-seeds cleanly on a second run", () => {
    const dir = setup();
    try {
      const modelPath = join(dir, "shed.em");
      const git = fakeGit([ok(`${dir}\n`), ok(`${dir}\n`)]);
      seedAsisModel(modelPath, git);
      const second = seedAsisModel(modelPath, git);
      expect(second.storylineFiles).toEqual([{ file: "stories/chase.em", asisFile: "stories/chase-asis.em" }]);
      expect(second.gitignoreUpdated).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
