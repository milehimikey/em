// SPDX-License-Identifier: MIT
// `em skill check` (MIL-93): checks a consuming repo's vendored skill copy for drift against
// the em package actually installed — the downstream half of the skill-drift problem (the
// in-repo half is MIL-92's skillVersionCheck.ts, which checks *this* repo's own package.json
// against *its own* bundled skill across two git revisions). This check has no git revisions
// at all: both sides are directories on disk right now, so unlike ledgerCheck.ts/
// skillVersionCheck.ts there's no GitRunner to inject.
//
// Two independent signals, both reported (never short-circuited on the first):
//  - the vendored SKILL.md's em-version: stamp vs. the installed em's own version
//  - a full content diff against the packaged skill (reusing planSkillSync's hash-walk), which
//    catches a hand-edited vendored file even when its stamp still happens to match — the
//    ticket's explicit "stamp says current, content isn't" case.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractEmVersionStamp } from "./skillVersionCheck.js";
import { planAgentSync, planSkillSync } from "./skillSync.js";

export type SkillCheckFindingCode =
  | "skill-check-not-installed"
  | "skill-check-stamp-missing"
  | "skill-check-stamp-mismatch"
  | "skill-check-content-drift"
  // MIL-269: the four vendored sub-agent definitions under .claude/agents/.
  | "agent-not-installed"
  | "agent-content-drift"
  // MIL-231: the em Claude Code plugin (src/cli/pluginPin.ts).
  | "plugin-pin-mismatch"
  | "plugin-not-enabled"
  | "plugin-registered-at-different-ref"
  | "plugin-not-installed-locally";

export interface SkillCheckFinding {
  code: SkillCheckFindingCode;
  message: string;
  vendoredStamp?: string | null;
  installedVersion?: string;
  driftedFiles?: string[];
  /** Plugin findings only (MIL-231): the marketplace name the repo's settings declare. */
  pluginName?: string;
  /** Plugin findings only: the `source.ref` the settings (or, for `plugin-registered-at-different-ref`,
   *  the machine registry) carry. */
  pluginRef?: string | null;
  /** Plugin findings only: the commands that fix it (the two-command install snippet). */
  installCommands?: string[];
}

export interface SkillCheckResult {
  findings: SkillCheckFinding[];
  ok: boolean;
}

/**
 * Pure: compares vendoredDir against packagedDir (content) and installedVersion (em --version
 * — injected, never re-derived; see src/cli.ts's PKG_VERSION) against the vendored SKILL.md's
 * em-version: stamp. No process.exit, no console.
 */
export function checkSkillSync(packagedDir: string, vendoredDir: string, installedVersion: string): SkillCheckResult {
  if (!existsSync(vendoredDir)) {
    return {
      ok: false,
      findings: [
        {
          code: "skill-check-not-installed",
          message: `no vendored skill found at ${vendoredDir} — run \`em skill sync\` first`,
        },
      ],
    };
  }

  const findings: SkillCheckFinding[] = [];

  const skillMdPath = join(vendoredDir, "SKILL.md");
  const vendoredStamp = existsSync(skillMdPath) ? extractEmVersionStamp(readFileSync(skillMdPath, "utf8")) : null;

  if (vendoredStamp === null) {
    findings.push({
      code: "skill-check-stamp-missing",
      message: `${skillMdPath} has no em-version: stamp — vendored copy predates MIL-92 or was hand-edited`,
    });
  } else if (vendoredStamp !== installedVersion) {
    findings.push({
      code: "skill-check-stamp-mismatch",
      message: `vendored skill's em-version: stamp (${vendoredStamp}) doesn't match installed em (${installedVersion}) — run \`em skill sync\` (or \`em upgrade\`)`,
      vendoredStamp,
      installedVersion,
    });
  }

  const plan = planSkillSync(packagedDir, vendoredDir);
  if (plan.changes.length > 0) {
    const driftedFiles = plan.changes.map((c) => c.relPath).sort();
    findings.push({
      code: "skill-check-content-drift",
      message: `vendored skill differs from the packaged skill in ${driftedFiles.length} file(s) — run \`em skill sync\` (or \`em upgrade\`)`,
      driftedFiles,
    });
  }

  return { findings, ok: findings.length === 0 };
}

// ---- Bundle variant (MIL-157) — the em skill ships as several sibling directories under
// `.claude/skills/` (see src/cli/skillDirs.ts): the stamp-checked skill directories (each with
// its own SKILL.md) and the shared, non-skill directories (reference/template material with no
// SKILL.md, so no stamp to check — content drift only). Findings from every directory are
// prefixed with `[<dirName>]` and their `driftedFiles` with `<dirName>/`, so a single aggregated
// report still tells you exactly which directory each finding concerns.

function prefixFinding(dirName: string, f: SkillCheckFinding): SkillCheckFinding {
  return {
    ...f,
    message: `[${dirName}] ${f.message}`,
    driftedFiles: f.driftedFiles?.map((p) => `${dirName}/${p}`),
  };
}

/**
 * Pure: checkSkillSync for every stamp-checked skill directory, plus content-drift-only
 * (planSkillSync) for every shared directory. Same `SkillCheckResult` shape as checkSkillSync
 * itself — a bundle check is just several single-directory checks with prefixed findings.
 */
export function checkSkillSyncBundle(
  packagedRoot: string,
  vendoredRoot: string,
  installedVersion: string,
  skillDirNames: readonly string[],
  sharedDirNames: readonly string[],
): SkillCheckResult {
  const findings: SkillCheckFinding[] = [];

  for (const name of skillDirNames) {
    const result = checkSkillSync(join(packagedRoot, name), join(vendoredRoot, name), installedVersion);
    for (const f of result.findings) findings.push(prefixFinding(name, f));
  }

  for (const name of sharedDirNames) {
    const vendoredDir = join(vendoredRoot, name);
    if (!existsSync(vendoredDir)) {
      findings.push(
        prefixFinding(name, {
          code: "skill-check-not-installed",
          message: `no vendored skill found at ${vendoredDir} — run \`em skill sync\` first`,
        }),
      );
      continue;
    }
    const plan = planSkillSync(join(packagedRoot, name), vendoredDir);
    if (plan.changes.length > 0) {
      const driftedFiles = plan.changes.map((c) => c.relPath).sort();
      findings.push(
        prefixFinding(name, {
          code: "skill-check-content-drift",
          message: `vendored skill differs from the packaged skill in ${driftedFiles.length} file(s) — run \`em skill sync\``,
          driftedFiles,
        }),
      );
    }
  }

  return { findings, ok: findings.length === 0 };
}

/**
 * Pure (MIL-269, R32): checks exactly the listed agent files under `.claude/agents/` and nothing
 * else in that shared directory. A missing file is `agent-not-installed`, an edited/stale one
 * `agent-content-drift`; messages carry the `[agents]` prefix and the file name. No stamp (the
 * files have no `em-version:` line - the frontmatter is Claude Code's).
 */
export function checkAgentFiles(packagedDir: string, vendoredDir: string, fileNames: readonly string[]): SkillCheckResult {
  const plan = planAgentSync(packagedDir, vendoredDir, fileNames);
  const findings: SkillCheckFinding[] = plan.changes.map((c) =>
    c.kind === "added"
      ? {
          code: "agent-not-installed" as const,
          message: `[agents] ${c.relPath}: not installed at ${join(vendoredDir, c.relPath)} - run \`em skill sync\` (or \`em upgrade\`)`,
          driftedFiles: [`agents/${c.relPath}`],
        }
      : {
          code: "agent-content-drift" as const,
          message: `[agents] ${c.relPath}: content drift - differs from the packaged agent definition - run \`em skill sync\` (or \`em upgrade\`)`,
          driftedFiles: [`agents/${c.relPath}`],
        },
  );
  return { findings, ok: findings.length === 0 };
}
