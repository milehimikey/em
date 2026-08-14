#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Thin CLI shim for checkSkillVersionStamp (src/cli/skillVersionCheck.ts, MIL-92) — argv
// parsing, exit code, console output. Repo-internal dev tooling, not a shipped `em` subcommand
// (see skillVersionCheck.ts's header for why).
//
// Usage: tsx scripts/check-skill-version-stamp.ts --from <rev> [--to <rev>]
//   (npm run check:skill-version -- --from <rev>)
// `--to` defaults to the current working tree, same convention as `em ledger`/`em diff`.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSkillVersionStamp } from "../src/cli/skillVersionCheck.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_JSON = join(ROOT, "package.json");
const SKILL_MD = join(ROOT, ".claude/skills/event-modeling/SKILL.md");

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
const result = checkSkillVersionStamp(PKG_JSON, SKILL_MD, from, to);

if (result.skipped) {
  console.log(`skipped — ${result.skipped}`);
} else if (result.finding) {
  console.error(result.finding.message);
  process.exitCode = 1;
} else {
  console.log("ok — package.json version and SKILL.md's em-version: stamp agree");
}
