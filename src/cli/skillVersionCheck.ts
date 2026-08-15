// SPDX-License-Identifier: MIT
// MIL-92's version-stamp release gate: checks that package.json's `version` and SKILL.md's
// `em-version:` frontmatter stamp move together across two revisions. Repo-internal — unlike
// `em ledger` (MIL-89, src/cli/ledgerCheck.ts), which consumer repos run against their own
// slice docs, this checks *this repo's own* package version against *this repo's own* bundled
// skill, so it's never a shipped `em` subcommand — see scripts/check-skill-version-stamp.ts for
// the thin CLI shim, and docs/ci.md's precedent framing for why a version/content-agreement
// check needs two revisions rather than being folded into `em validate`.
//
// Both sides here are version strings compared for "did it move," not ledger's version-vs-
// freeform-content comparison — the meaningful case is package.json's version changing without
// the stamp following it (`skill-version-stamp-not-bumped`). Two more are flagged as cheap extra
// coverage: a stray stamp edit with no matching package.json move (`-stray-bump`), and the
// stamp being deleted outright (`-removed`, unconditional — regardless of whether package.json
// also changed, since losing the mechanism entirely is a problem on its own; a code review on
// this very PR caught an earlier version that silently skipped the pkgChanged+deleted-stamp
// combination). The one case that stays clean rather than becoming a finding: the stamp's
// first-ever introduction (no prior value to compare against) — the normal one-time bootstrap
// of the field, not a stray edit (this check's own introducing PR, confirmed on CI, first).

import { readFileSync } from "node:fs";
import { GitRunner, realGit, resolveRevision } from "./diff-inputs.js";

export type SkillVersionFindingCode =
  | "skill-version-stamp-not-bumped"
  | "skill-version-stamp-stray-bump"
  | "skill-version-stamp-removed";

export interface SkillVersionFinding {
  code: SkillVersionFindingCode;
  message: string;
  oldPkgVersion: string;
  newPkgVersion: string;
  oldStamp: string | null;
  newStamp: string | null;
}

/** Why no finding could be produced — a state the check can't prove anything from, not a
 *  defect. `stamp-missing` covers the field not existing at EITHER revision (never adopted in
 *  this span) — distinct from it existing at `from` and being deleted by `to`, which is a
 *  `skill-version-stamp-removed` finding, not a skip. */
export type SkillVersionSkipReason = "package-json-unreadable" | "skill-md-unreadable" | "stamp-missing";

export interface SkillVersionCheckResult {
  finding: SkillVersionFinding | null;
  skipped: SkillVersionSkipReason | null;
}

type ReadResult = { ok: true; content: string } | { ok: false };

/** `to: null` reads the working tree directly (fs); a revision string resolves via git — same
 *  `to: null` = working-tree convention `em diff`/`em ledger` use. */
function readAt(path: string, rev: string | null, runGit: GitRunner): ReadResult {
  if (rev === null) {
    try {
      return { ok: true, content: readFileSync(path, "utf8") };
    } catch {
      return { ok: false };
    }
  }
  const result = resolveRevision(path, rev, runGit);
  return result.ok ? { ok: true, content: result.content } : { ok: false };
}

function extractPkgVersion(content: string): string | null {
  try {
    const parsed: unknown = JSON.parse(content);
    const version = (parsed as { version?: unknown })?.version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/** Pull `em-version: X` out of a `---\n...\n---` frontmatter block. Minimal and single-purpose
 *  — SKILL.md's frontmatter is two plain scalar keys plus a folded `description:` block, not
 *  the richer schema src/catalog/sliceDoc.ts parses, so this doesn't reuse that parser.
 *  Exported for reuse by src/cli/skillCheck.ts (MIL-93), which needs the same extraction to
 *  compare a vendored copy's stamp against the installed em's own version — no reason to
 *  duplicate the regex a second time. */
export function extractEmVersionStamp(content: string): string | null {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) return null;
  const line = frontmatter[1].split("\n").find((l) => /^em-version:\s*/.test(l));
  if (!line) return null;
  return line
    .replace(/^em-version:\s*/, "")
    .trim()
    .replace(/^["']|["']$/g, "");
}

/**
 * Compare `pkgJsonPath`'s version and `skillMdPath`'s `em-version:` stamp between revisions
 * `from` and `to` (`to: null` = current working tree, matching `em diff`/`em ledger`). Pure
 * aside from the injected `GitRunner` and fs reads — no process.exit, no console.
 */
export function checkSkillVersionStamp(
  pkgJsonPath: string,
  skillMdPath: string,
  from: string,
  to: string | null,
  runGit: GitRunner = realGit,
): SkillVersionCheckResult {
  const oldPkg = readAt(pkgJsonPath, from, runGit);
  const newPkg = readAt(pkgJsonPath, to, runGit);
  if (!oldPkg.ok || !newPkg.ok) return { finding: null, skipped: "package-json-unreadable" };

  const oldPkgVersion = extractPkgVersion(oldPkg.content);
  const newPkgVersion = extractPkgVersion(newPkg.content);
  if (oldPkgVersion === null || newPkgVersion === null) return { finding: null, skipped: "package-json-unreadable" };

  const oldSkill = readAt(skillMdPath, from, runGit);
  const newSkill = readAt(skillMdPath, to, runGit);
  if (!oldSkill.ok || !newSkill.ok) return { finding: null, skipped: "skill-md-unreadable" };

  const oldStamp = extractEmVersionStamp(oldSkill.content);
  const newStamp = extractEmVersionStamp(newSkill.content);

  // Never adopted anywhere in this revision span — nothing to compare. Distinct from the stamp
  // being *removed* below: that's a regression, this is simply "the field doesn't exist yet."
  if (oldStamp === null && newStamp === null) return { finding: null, skipped: "stamp-missing" };

  // The stamp's first-ever introduction (no em-version: key at `from`, one at `to`) has nothing
  // to compare against either — not a stray edit, the normal one-time bootstrap of the field
  // itself (e.g. this very check landing). Treat it as clean rather than a permanent
  // false-positive on whichever PR happens to add the key.
  if (oldStamp === null) return { finding: null, skipped: null };

  const pkgChanged = oldPkgVersion !== newPkgVersion;

  // The stamp existed and is now gone entirely — a stronger signal than merely "left stale"
  // (below), and one a naive "newStamp === null -> skip" early-out would otherwise swallow
  // silently, including the worst case: package.json bumped in the very same change that
  // deleted the stamp (caught in code review, MIL-92 PR #85 — no prior test combined
  // pkgChanged: true with a deleted stamp). Always a finding, regardless of pkgChanged: removing
  // the mechanism entirely is a problem on its own, not just when it coincides with a release.
  if (newStamp === null) {
    return {
      skipped: null,
      finding: {
        code: "skill-version-stamp-removed",
        message: pkgChanged
          ? `SKILL.md's em-version: stamp (was ${oldStamp}) was removed entirely while package.json bumped ${oldPkgVersion} -> ${newPkgVersion}`
          : `SKILL.md's em-version: stamp (was ${oldStamp}) was removed entirely`,
        oldPkgVersion,
        newPkgVersion,
        oldStamp,
        newStamp: null,
      },
    };
  }

  const stampChanged = oldStamp !== newStamp;

  if (pkgChanged && !stampChanged) {
    return {
      skipped: null,
      finding: {
        code: "skill-version-stamp-not-bumped",
        message: `package.json bumped ${oldPkgVersion} -> ${newPkgVersion} but SKILL.md's em-version: stamp stayed at ${newStamp}`,
        oldPkgVersion,
        newPkgVersion,
        oldStamp,
        newStamp,
      },
    };
  }
  if (!pkgChanged && stampChanged) {
    return {
      skipped: null,
      finding: {
        code: "skill-version-stamp-stray-bump",
        message: `SKILL.md's em-version: stamp changed (${oldStamp ?? "(none)"} -> ${newStamp}) but package.json's version didn't move (still ${newPkgVersion})`,
        oldPkgVersion,
        newPkgVersion,
        oldStamp,
        newStamp,
      },
    };
  }
  return { finding: null, skipped: null };
}
