// SPDX-License-Identifier: MIT
// Coverage for `em changelog`'s git layer (src/cli/changelog-git.ts) at the
// module level, with an injected fake runner (same convention as
// test/diff-inputs.test.ts): the `git log --follow --name-only` parse —
// per-commit historical paths across a rename, the no-path-line fallback —
// and `readFileAtCommit`. End-to-end behavior against a real repo lives in
// test/cli.test.ts.
import { describe, it, expect } from "vitest";
import { GitResult, GitRunner } from "../src/cli/diff-inputs.js";
import { listModelCommits, readFileAtCommit, CommitInfo } from "../src/cli/changelog-git.js";

const FS = "\x01";

// A fake git runner that replays a queue of canned results in call order.
const fakeGit = (responses: GitResult[]): GitRunner => {
  let i = 0;
  return () => responses[i++] ?? { status: 1, stdout: "", stderr: "unexpected extra git call" };
};
const ok = (stdout: string): GitResult => ({ status: 0, stdout, stderr: "" });

describe("listModelCommits: --name-only parsing", () => {
  it("parses per-commit historical paths across a rename, oldest->newest", () => {
    // git log output is newest-first: rename commit at new-name.em, then two
    // pre-rename commits at old-name.em.
    const logOut = [
      `h3${FS}c3${FS}2026-01-03${FS}rename model file`,
      "",
      "new-name.em",
      `h2${FS}c2${FS}2026-01-02${FS}add shipping`,
      "",
      "old-name.em",
      `h1${FS}c1${FS}2026-01-01${FS}introduce model`,
      "",
      "old-name.em",
      "",
    ].join("\n");
    const git = fakeGit([
      ok("/repo\n"), // rev-parse --show-toplevel
      ok("new-name.em\n"), // ls-files --full-name
      ok(logOut), // log --follow --name-only
    ]);
    const result = listModelCommits("new-name.em", {}, git);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repoRoot).toBe("/repo");
    expect(result.commits.map((c) => [c.hash, c.date, c.subject, c.path])).toEqual([
      ["h1", "2026-01-01", "introduce model", "old-name.em"],
      ["h2", "2026-01-02", "add shipping", "old-name.em"],
      ["h3", "2026-01-03", "rename model file", "new-name.em"],
    ]);
  });

  it("falls back to the current path for a commit with no path line (e.g. a merge)", () => {
    const logOut = [
      `h2${FS}c2${FS}2026-01-02${FS}merge branch`,
      `h1${FS}c1${FS}2026-01-01${FS}introduce model`,
      "",
      "model.em",
      "",
    ].join("\n");
    const git = fakeGit([ok("/repo\n"), ok("model.em\n"), ok(logOut)]);
    const result = listModelCommits("model.em", {}, git);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commits.map((c) => [c.hash, c.path])).toEqual([
      ["h1", "model.em"],
      ["h2", "model.em"],
    ]);
  });

  it("reassembles a subject containing the separator character", () => {
    const logOut = [`h1${FS}c1${FS}2026-01-01${FS}odd${FS}subject`, "", "model.em", ""].join("\n");
    const git = fakeGit([ok("/repo\n"), ok("model.em\n"), ok(logOut)]);
    const result = listModelCommits("model.em", {}, git);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commits[0].subject).toBe(`odd${FS}subject`);
  });
});

describe("readFileAtCommit", () => {
  const commit: CommitInfo = {
    hash: "h1",
    shortHash: "c1",
    date: "2026-01-01",
    subject: "introduce model",
    path: "old-name.em",
  };

  it("returns the content at the commit's own (historical) path", () => {
    const git = fakeGit([ok('slice "S" {\n  command A\n}\n')]);
    const result = readFileAtCommit("/repo", commit, git);
    expect(result).toEqual({ ok: true, content: 'slice "S" {\n  command A\n}\n' });
  });

  it("fails with a note-ready message (no command prefix) carrying git's stderr", () => {
    const git = fakeGit([{ status: 128, stdout: "", stderr: "fatal: bad object h1\n" }]);
    const result = readFileAtCommit("/repo", commit, git);
    expect(result).toEqual({
      ok: false,
      message: "cannot read old-name.em at c1: fatal: bad object h1",
    });
  });
});
