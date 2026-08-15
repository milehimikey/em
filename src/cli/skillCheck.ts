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
import { planSkillSync } from "./skillSync.js";

export type SkillCheckFindingCode =
  | "skill-check-not-installed"
  | "skill-check-stamp-missing"
  | "skill-check-stamp-mismatch"
  | "skill-check-content-drift";

export interface SkillCheckFinding {
  code: SkillCheckFindingCode;
  message: string;
  vendoredStamp?: string | null;
  installedVersion?: string;
  driftedFiles?: string[];
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
      message: `vendored skill's em-version: stamp (${vendoredStamp}) doesn't match installed em (${installedVersion}) — run \`em skill sync\``,
      vendoredStamp,
      installedVersion,
    });
  }

  const plan = planSkillSync(packagedDir, vendoredDir);
  if (plan.changes.length > 0) {
    const driftedFiles = plan.changes.map((c) => c.relPath).sort();
    findings.push({
      code: "skill-check-content-drift",
      message: `vendored skill differs from the packaged skill in ${driftedFiles.length} file(s) — run \`em skill sync\``,
      driftedFiles,
    });
  }

  return { findings, ok: findings.length === 0 };
}
