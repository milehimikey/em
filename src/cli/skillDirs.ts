// SPDX-License-Identifier: MIT
// The set of directories under `.claude/skills/` that together make up the em-bundled
// event-modeling skill (MIL-157): five focused, SDLC-stage skills, the `event-modeling-engagement`
// lead-session skill (MIL-270), plus the thin `event-modeling`
// router skill that preserves `/event-modeling` as a single resumable entry point, and one
// non-skill directory (`event-modeling-shared`, no SKILL.md) holding reference/template material
// every skill points back to instead of duplicating. `em skill install`/`sync`/`check` treat this
// whole set as one atomic bundle — installing/syncing/checking all of it in one command, exactly
// like before the split (MIL-93) — so a consumer repo's `.claude/skills/` never needs per-skill
// awareness, and unrelated skills already living in that directory (this em bundle isn't the only
// thing that can be there) are never touched: only these named directories are ever walked, never
// `.claude/skills/` wholesale.

import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Directories with their own SKILL.md (a `name:`/`description:`/`em-version:` frontmatter and
 *  Claude Code entry point). Order is display order only, not load-bearing. */
export const EM_SKILL_DIR_NAMES: readonly string[] = [
  "event-modeling",
  "event-modeling-discover",
  "event-modeling-design",
  "event-modeling-implement",
  "event-modeling-conform",
  "event-modeling-review",
  "event-modeling-engagement",
];

/** Directories with no SKILL.md of their own — shared reference/template material every skill
 *  above points back to instead of duplicating. Still part of the sync/check bundle (content
 *  drift matters here too), just never stamp-checked for an `em-version:` frontmatter that
 *  doesn't exist. */
export const EM_SHARED_DIR_NAMES: readonly string[] = ["event-modeling-shared"];

/** Every directory `em skill install`/`sync`/`check` treat as part of the one bundle. */
export const EM_ALL_SKILL_BUNDLE_DIRS: readonly string[] = [...EM_SKILL_DIR_NAMES, ...EM_SHARED_DIR_NAMES];

/** The one directory whose presence/absence gates the bundle as a whole (used by `em skill
 *  install`'s already-installed check and `em ci init`'s generated CI gate) — the router skill,
 *  since it's the fixed entry point every consumer's `/event-modeling` resolves to regardless of
 *  which other skills in the bundle they've actually used. */
export const EM_SKILL_ANCHOR_DIR = "event-modeling";

/** MIL-269 (R32): the four Claude Code sub-agent definitions em ships under `.claude/agents/`.
 *  Unlike the skill bundle this is a FIXED FILE list, not a directory: `.claude/agents/` is
 *  shared with the consumer's own agents, so install/sync/check and the upgrade steps only ever
 *  read, write or delete exactly these names and never walk the directory. */
export const EM_AGENT_FILES: readonly string[] = [
  "em-implementer.md",
  "em-validator.md",
  "em-reviewer.md",
  "em-critic.md",
];

/** GH #412: where a consumer repo keeps the vendored bundle and the sub-agent definitions. The
 *  defaults are Claude Code's own `.claude/skills/` and `.claude/agents/`; a repo that serves
 *  several coding agents keeps skills in a neutral folder such as `.agents/skills/` (with
 *  `.claude/skills` a symlink to it) and names it with `--skills-dir`, or lets `em` detect it:
 *  when `.claude/skills/` is absent and `.agents/skills/` exists, that is the skills dir. The
 *  agents dir follows the same shape (`--agents-dir`, else `.agents/agents/` when the skills dir
 *  was detected or given under `.agents/`, else `.claude/agents/`). Paths are relative to the
 *  repo root unless absolute; the result is absolute. */
export interface VendoredDirs {
  skillsRoot: string;
  agentsRoot: string;
  /** True when `.agents/skills/` was picked up without a flag, so a command can say so. */
  detected: boolean;
}

export const GENERIC_SKILLS_DIR = ".agents/skills";
export const GENERIC_AGENTS_DIR = ".agents/agents";
export const CLAUDE_SKILLS_DIR = ".claude/skills";
export const CLAUDE_AGENTS_DIR = ".claude/agents";

export function resolveVendoredDirs(
  repoRoot: string,
  opts: { skillsDir?: string; agentsDir?: string } = {},
  exists: (p: string) => boolean = existsSync,
): VendoredDirs {
  const root = resolve(repoRoot);
  const at = (p: string) => (isAbsolute(p) ? p : join(root, p));
  let detected = false;
  let skillsDir = opts.skillsDir;
  if (skillsDir === undefined) {
    if (!exists(at(CLAUDE_SKILLS_DIR)) && exists(at(GENERIC_SKILLS_DIR))) {
      skillsDir = GENERIC_SKILLS_DIR;
      detected = true;
    } else {
      skillsDir = CLAUDE_SKILLS_DIR;
    }
  }
  const genericSkills = relative(root, at(skillsDir)).split(sep).join("/") === GENERIC_SKILLS_DIR;
  const agentsDir = opts.agentsDir ?? (genericSkills ? GENERIC_AGENTS_DIR : CLAUDE_AGENTS_DIR);
  return { skillsRoot: at(skillsDir), agentsRoot: at(agentsDir), detected };
}
