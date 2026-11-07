#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Materializes the `helpdesk` conform eval fixture (GH #452, eval/conform/README.md) into a
// scratch directory: a copy of `model/` plus a REAL git repo built from `repo/` (baseline
// commit) with `repo-head/` overlaid as a second commit — the same "git init, commit, overlay,
// commit" shape test/cli.test.ts's "em conform-scope (CLI, real git repo)" suite uses, just
// packaged here so both the vitest smoke test (test/evalConformFixture.test.ts) and a human/
// agent running the eval by hand can build the identical fixture one way.
//
//   node eval/conform/helpdesk/setup.mjs [--dest <dir>] [--pin-last-conformance]
//
// Prints the scratch model dir, the scratch target-repo dir, and both commits' revisions as
// JSON. `--pin-last-conformance` additionally rewrites the copied model's
// `.event-modeling.md` so `Last conformance:` names the BASELINE commit (before the overlay) —
// this is what makes a subsequent `em conform-scope` run DIFF-SCOPED instead of a first-run/
// `--full` sweep; the README explains why only `escalate-ticket` and
// `tickets-awaiting-escalation` should come back as candidates when this flag is used.

import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));

function git(args, cwd) {
  const res = spawnSync("git", ["-c", "user.email=eval@example.test", "-c", "user.name=em eval", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} (cwd ${cwd}) failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

/** Byte-exact copy of `model/` into `<dest>/model`. */
export function copyModel(dest) {
  const modelDir = join(dest, "model");
  cpSync(join(HERE, "model"), modelDir, { recursive: true });
  return modelDir;
}

/**
 * Build the scratch target repo at `<dest>/repo`: `repo/` committed as the baseline revision,
 * then `repo-head/` overlaid (only the files it contains) and committed as HEAD. Returns both
 * commit SHAs. This is the ENTIRE seed surface for case (a) — nothing else changes between the
 * two commits, which is what lets `em conform-scope`'s diff-scoped mode land precisely on the
 * slices anchored at `src/support/escalation`.
 */
export function buildTargetRepo(dest) {
  const repoDir = join(dest, "repo");
  mkdirSync(repoDir, { recursive: true });
  git(["init", "-q", "-b", "main"], repoDir);
  cpSync(join(HERE, "repo"), repoDir, { recursive: true });
  git(["add", "."], repoDir);
  git(["commit", "-q", "-m", "helpdesk: baseline (open, escalate, board)"], repoDir);
  const baseRev = git(["rev-parse", "HEAD"], repoDir);

  cpSync(join(HERE, "repo-head"), repoDir, { recursive: true });
  git(["add", "."], repoDir);
  git(["commit", "-q", "-m", "helpdesk: escalate ticket records an escalationReason (case a seed)"], repoDir);
  const headRev = git(["rev-parse", "HEAD"], repoDir);

  return { repoDir, baseRev, headRev };
}

/**
 * Rewrite the copied model's `.event-modeling.md` `Last conformance:` bullet to the EXACT
 * format `stateFile.ts`'s `setConformance` writes (`YYYY-MM-DD @ <revision> — report: <path>`)
 * — hand-written here (not shelled out to `em state set-conformance`) so this script has no
 * dependency on a built/tsx-runnable CLI; the vitest smoke test cross-checks the two stay in
 * sync by also exercising the real `em state set-conformance` command.
 */
export function pinLastConformance(modelDir, revision, date = "2026-11-01", report = "conformance/2026-11-01-report.md") {
  const path = join(modelDir, ".event-modeling.md");
  const text = readFileSync(path, "utf8");
  const next = text.replace(
    /^- \*\*Last conformance:\*\*.*$/m,
    `- **Last conformance:** ${date} @ ${revision} — report: ${report}`,
  );
  if (next === text) throw new Error(`pinLastConformance: no "Last conformance:" bullet found in ${path}`);
  writeFileSync(path, next);
}

/** Build the whole fixture into a fresh temp dir (or `dest` if given) and return every path/
 *  revision a caller needs. `pin` mirrors the CLI's `--pin-last-conformance`. */
export function setupFixture({ dest, pin = false } = {}) {
  const root = dest ?? mkdtempSync(join(tmpdir(), "em-eval-conform-helpdesk-"));
  const modelDir = copyModel(root);
  const { repoDir, baseRev, headRev } = buildTargetRepo(root);
  if (pin) pinLastConformance(modelDir, baseRev);
  return { root, modelDir, repoDir, baseRev, headRev };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const argv = process.argv.slice(2);
  const di = argv.indexOf("--dest");
  const dest = di >= 0 ? argv[di + 1] : undefined;
  const pin = argv.includes("--pin-last-conformance");
  const result = setupFixture({ dest, pin });
  console.log(JSON.stringify(result, null, 2));
}
