// SPDX-License-Identifier: MIT
// `em contract` (MIL-129): prints the packaged implementation contract — reference/implement.md
// inside the skill directory bundled with whatever em package is actually running (see
// src/cli.ts's packagedSkillDir) — to stdout, verbatim.
//
// Why this exists: reference/implement.md opens by claiming the contract applies to "any
// implementing agent, whether or not the session started from `/event-modeling`" — but until
// this command, its only distribution channel was `em skill install` copying it into
// `.claude/skills/event-modeling/`, a path only Claude Code discovers. An agent that can run a
// shell but has no `.claude/` awareness had no route to the contract at all (Slicewright story
// gap G5). `em contract` needs no vendored skill copy, no repo scaffolding, nothing but the em
// binary itself — the file always comes from the installed package, not from any project's
// working tree.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Path to the packaged contract inside `packagedSkillDir` — the same directory `em skill
 *  install`/`sync`/`check` read from (src/cli.ts's packagedSkillDir()). */
export function contractPath(packagedSkillDir: string): string {
  return join(packagedSkillDir, "reference", "implement.md");
}

/** Pure: reads the packaged contract's exact bytes. No process.exit/console — src/cli.ts's
 *  action wraps fs errors (a corrupt/incomplete package install) the same way every other
 *  command's file reads do. */
export function readContract(packagedSkillDir: string): string {
  return readFileSync(contractPath(packagedSkillDir), "utf8");
}
