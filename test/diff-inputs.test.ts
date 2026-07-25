// SPDX-License-Identifier: MIT
// Coverage for `em diff`'s input handling (src/cli/diff-inputs.ts): argument-form
// validation (planDiffArgs) and git-revision resolution (resolveRevision). The git
// runner is injected with a fake, so every branch — including the three failure
// modes — is exercised without a subprocess or a real repo, matching the repo's
// convention of testing logic at the module level rather than through cli.ts.
import { describe, it, expect } from "vitest";
import {
  planDiffArgs,
  resolveRevision,
  GitResult,
  GitRunner,
} from "../src/cli/diff-inputs.js";

describe("planDiffArgs", () => {
  it("plans the two-file form", () => {
    expect(planDiffArgs("old.em", "new.em", {})).toEqual({
      form: "files",
      oldFile: "old.em",
      newFile: "new.em",
    });
  });

  it("plans the git form with --from (working tree as new)", () => {
    expect(planDiffArgs("model.em", undefined, { from: "HEAD~1" })).toEqual({
      form: "git",
      file: "model.em",
      from: "HEAD~1",
      to: undefined,
    });
  });

  it("plans the git form with --from and --to", () => {
    expect(planDiffArgs("model.em", undefined, { from: "v1.0", to: "v1.1" })).toEqual({
      form: "git",
      file: "model.em",
      from: "v1.0",
      to: "v1.1",
    });
  });

  it("errors when a second file is combined with --from", () => {
    const plan = planDiffArgs("a.em", "b.em", { from: "HEAD" });
    expect(plan).toEqual({
      error: "em diff: cannot combine two file arguments with --from/--to — use one form or the other",
    });
  });

  it("errors when --to is given without --from", () => {
    expect(planDiffArgs("model.em", undefined, { to: "v1.1" })).toEqual({
      error: "em diff: --to requires --from",
    });
  });

  it("errors when no second file and no --from", () => {
    expect(planDiffArgs("model.em", undefined, {})).toEqual({
      error: "em diff: provide two files (`em diff old.em new.em`) or one file with --from <rev>",
    });
  });
});

describe("resolveRevision", () => {
  // A fake git runner that replays a queue of canned results in call order.
  const fakeGit = (responses: GitResult[]): GitRunner => {
    let i = 0;
    return () => responses[i++] ?? { status: 1, stdout: "", stderr: "unexpected extra git call" };
  };
  const ok = (stdout: string): GitResult => ({ status: 0, stdout, stderr: "" });

  it("returns file content at the revision on success", () => {
    const git = fakeGit([
      ok("/repo\n"), // rev-parse --show-toplevel
      ok("sub/model.em\n"), // ls-files --full-name
      ok('slice "S" {\n  command A\n}\n'), // show <rev>:<path>
    ]);
    const result = resolveRevision("sub/model.em", "HEAD~1", git);
    expect(result).toEqual({ ok: true, content: 'slice "S" {\n  command A\n}\n' });
  });

  it("fails when the file is not inside a git repository", () => {
    const git = fakeGit([{ status: 128, stdout: "", stderr: "not a git repository" }]);
    const result = resolveRevision("model.em", "HEAD", git);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      message: expect.stringContaining("is not inside a git repository"),
    });
  });

  it("fails when the file is not tracked by git", () => {
    const git = fakeGit([
      ok("/repo\n"), // rev-parse
      ok("\n"), // ls-files returns nothing → untracked
    ]);
    const result = resolveRevision("model.em", "HEAD", git);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ message: expect.stringContaining("is not tracked by git") });
  });

  it("fails with git's stderr when the revision is unknown", () => {
    const git = fakeGit([
      ok("/repo\n"),
      ok("model.em\n"),
      { status: 128, stdout: "", stderr: "fatal: invalid object name 'bogus'.\n" },
    ]);
    const result = resolveRevision("model.em", "bogus", git);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      message: expect.stringContaining("fatal: invalid object name 'bogus'."),
    });
  });

  it("falls back to a generic message when git gives no stderr", () => {
    const git = fakeGit([ok("/repo\n"), ok("model.em\n"), { status: 1, stdout: "", stderr: "" }]);
    const result = resolveRevision("model.em", "bogus", git);
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("unknown git error") });
  });
});
