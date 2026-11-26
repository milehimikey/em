// SPDX-License-Identifier: MIT
// `em repos check` (GH #528): the text report and the `--json` document. Unlike every other em
// document this one carries absolute paths on purpose: its whole subject is where things are on
// this machine, so it is a local report and never something to commit.

import type { RepoResolution, RepoSource } from "../system/repoResolver.js";
import { REPOS_LOCAL_FILE } from "../system/repoResolver.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "./json.js";

// 1.0 (GH #528): initial shape.
export const REPOS_CHECK_SCHEMA_VERSION = "1.0";

export interface ReposCheckReport {
  /** The governing `system.yaml`, as an absolute path; `null` when none governs the target. */
  manifest: string | null;
  /** Why the manifest's `repos:` could not be read, when it could not. */
  manifestProblem: string | null;
  modelRepoRoot: string | null;
  localFile: string | null;
  localFileProblems: string[];
  /** `true`/`false` when the per-machine file exists and git could say whether it is ignored. */
  localFileIgnored: boolean | null;
  repos: RepoResolution[];
  /** GH #546: the one em pin of the system — the model repository's `.em-version` — or `null`
   *  when it carries none. */
  emPin: { version: string; file: string } | null;
  /** GH #546: per resolved repo other than `self`, every place it fixes an em version of its
   *  own (`.em-version`, `package.json`, a workflow). A code repository should have none. */
  ownEmPins: { repo: string; file: string; version: string }[];
}

/** Every repo resolved, with a usable manifest and per-machine file, and no code repository
 *  fixing an em version of its own (GH #546). A remote that differs, or a per-machine file that
 *  is not gitignored, is a warning and does not make this false. */
export function reposCheckOk(report: ReposCheckReport): boolean {
  return (
    report.manifestProblem === null &&
    report.localFileProblems.length === 0 &&
    report.repos.every((r) => r.status === "resolved") &&
    report.ownEmPins.length === 0
  );
}

export function buildReposCheckJson(report: ReposCheckReport): string {
  return JSON.stringify(
    {
      reposCheckSchemaVersion: REPOS_CHECK_SCHEMA_VERSION,
      generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
      ok: reposCheckOk(report),
      manifest: report.manifest,
      manifestProblem: report.manifestProblem,
      modelRepoRoot: report.modelRepoRoot,
      localFile: report.localFile,
      localFileProblems: report.localFileProblems,
      localFileIgnored: report.localFileIgnored,
      emPin: report.emPin,
      ownEmPins: report.ownEmPins,
      repos: report.repos.map((r) => ({
        id: r.id,
        remote: r.remote,
        status: r.status,
        path: r.path,
        source: r.source,
        remoteMatches: r.remoteMatches,
        actualRemote: r.actualRemote,
      })),
      summary: {
        total: report.repos.length,
        resolved: report.repos.filter((r) => r.status === "resolved").length,
        missing: report.repos.filter((r) => r.status === "missing").length,
        notAGitRepo: report.repos.filter((r) => r.status === "not-a-git-repo").length,
        ownEmPins: report.ownEmPins.length,
      },
    },
    null,
    2,
  );
}

const SOURCE_TEXT: Record<RepoSource, string> = {
  self: "the model's own repository",
  flag: "--repo",
  "local-file": REPOS_LOCAL_FILE,
  sibling: "sibling directory",
};
const STATUS_TEXT = { resolved: "resolved", missing: "missing", "not-a-git-repo": "not a git repo" } as const;

export function renderReposCheckText(report: ReposCheckReport): string {
  const lines: string[] = [];
  lines.push(report.manifest === null ? "no system.yaml governs this directory — only `self` exists" : `manifest: ${report.manifest}`);
  if (report.manifestProblem !== null) lines.push(`  problem: ${report.manifestProblem}`);
  const idWidth = Math.max(...report.repos.map((r) => r.id.length));
  const statusWidth = Math.max(...report.repos.map((r) => STATUS_TEXT[r.status].length));
  for (const r of report.repos) {
    const where = r.path === null ? "no path — the model is not in a git repository, so there is no sibling directory to look in" : r.path;
    const via = r.source === null ? "" : `  (${SOURCE_TEXT[r.source]})`;
    lines.push(`  ${r.id.padEnd(idWidth)}  ${STATUS_TEXT[r.status].padEnd(statusWidth)}  ${where}${via}`);
    if (r.status === "missing" && r.path !== null) lines.push(`  ${" ".repeat(idWidth)}  no directory there — map it with --repo ${r.id}=<path> or in ${REPOS_LOCAL_FILE}; em does not clone`);
    if (r.status === "not-a-git-repo" && r.id !== "self") lines.push(`  ${" ".repeat(idWidth)}  the directory has no .git — point at the root of a checkout`);
    if (r.remoteMatches === false) lines.push(`  ${" ".repeat(idWidth)}  warning: origin is ${r.actualRemote}, the manifest records ${r.remote}`);
  }
  for (const p of report.localFileProblems) lines.push(`${REPOS_LOCAL_FILE}: ${p} — the file was not used`);
  if (report.localFile !== null && report.localFileIgnored === false) {
    lines.push(`warning: ${REPOS_LOCAL_FILE} is not gitignored — it holds this machine's paths; add \`.em/*.local.yaml\` to .gitignore`);
  }
  // GH #546: one em pin, in the model's repository.
  const codeRepos = report.repos.filter((r) => r.id !== "self");
  if (codeRepos.length > 0 || report.ownEmPins.length > 0) {
    lines.push(
      report.emPin
        ? `em pin: ${report.emPin.version} (${report.emPin.file}, in the model's repository) — every repository runs em at this version`
        : "em pin: none — the model's repository has no .em-version, so nothing fixes the em version the code repositories run",
    );
    for (const p of report.ownEmPins) {
      lines.push(`  ${p.repo}: ${p.file} fixes em ${p.version} itself — remove it; a code repository runs em at the version the model's repository pins`);
    }
  }
  const unresolved = report.repos.filter((r) => r.status !== "resolved").length;
  lines.push(unresolved === 0 ? `${report.repos.length} of ${report.repos.length} repos resolved` : `${report.repos.length - unresolved} of ${report.repos.length} repos resolved, ${unresolved} not`);
  return lines.join("\n");
}
