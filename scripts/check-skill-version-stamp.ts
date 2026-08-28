#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Thin CLI shim for checkSkillVersionStamp (src/cli/skillVersionCheck.ts, MIL-92) — argv
// parsing, exit code, console output. Repo-internal dev tooling, not a shipped `em` subcommand
// (see skillVersionCheck.ts's header for why).
//
// Usage: tsx scripts/check-skill-version-stamp.ts --from <rev> [--to <rev>]
//   (npm run check:skill-version -- --from <rev>)
// `--to` defaults to the current working tree, same convention as `em ledger`/`em diff`.
//
// MIL-157: the em skill now ships as several SKILL.md files (one per event-modeling-* skill,
// see src/cli/skillDirs.ts's EM_SKILL_DIR_NAMES) rather than one, so this checks every one of
// them against the same package.json version — a release that bumps the version but forgets to
// bump even one skill's stamp is exactly the drift this gate exists to catch.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSkillVersionStamp } from "../src/cli/skillVersionCheck.js";
import { EM_SKILL_DIR_NAMES } from "../src/cli/skillDirs.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_JSON = join(ROOT, "package.json");
const SKILL_MD_PATHS = EM_SKILL_DIR_NAMES.map((name) => join(ROOT, ".claude/skills", name, "SKILL.md"));

function parseArgs(argv: string[]): { from: string; to: string | null } {
  let from: string | null = null;
  let to: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from") from = argv[++i] ?? null;
    else if (argv[i] === "--to") to = argv[++i] ?? null;
  }
  if (!from) {
    console.error("check-skill-version-stamp: --from <rev> is required");
    process.exit(1);
  }
  return { from, to };
}

const { from, to } = parseArgs(process.argv.slice(2));

let failed = false;
for (const skillMdPath of SKILL_MD_PATHS) {
  const relPath = skillMdPath.replace(ROOT + "/", "");
  const result = checkSkillVersionStamp(PKG_JSON, skillMdPath, from, to);

  if (result.skipped) {
    console.log(`${relPath}: skipped — ${result.skipped}`);
  } else if (result.finding) {
    console.error(`${relPath}: ${result.finding.message}`);
    failed = true;
  } else {
    console.log(`${relPath}: ok — package.json version and the em-version: stamp agree`);
  }
}

if (failed) process.exitCode = 1;
