// SPDX-License-Identifier: MIT
// AGENTS.md managed section (MIL-129): a marker-delimited block that `em skill install`/
// `em skill sync` write/update in the consumer repo's AGENTS.md, pointing any implementing
// agent — Claude Code or otherwise — at the three pieces of agent-neutral discovery Slicewright
// story gap G5 identified as missing: the implementation contract (`em contract`), the
// slice-readiness gate (`em validate --slice-ready --json`, MIL-128), and the machine-readable
// read path (`em export --slice`, MIL-128). MIL-21 adds a fourth pointer: `em-mcp`, the MCP
// server exposing the same contract/gate/read-path (plus full validate/export) as tools for an
// MCP-native agent, instead of shell commands.
//
// Same marker discipline as `em slice index`'s README Slices table (src/cli/sliceIndex.ts,
// MIL-98): idempotent replace-between-markers via src/util/markers.ts, user content outside the
// markers untouched, repeat runs never duplicate the section. One deliberate difference from
// sliceIndex: sliceIndex refuses to create a missing README (a human has to scaffold one from
// templates/model-readme.md first) and refuses when the marker pair is absent from an existing
// one. AGENTS.md has no such "scaffold it first" step to point at — agent-neutral discovery
// *is* AGENTS.md's whole reason for existing here — so this module creates the file when it's
// missing, and appends the marker pair (with the section already inside it) when an existing
// file lacks markers, instead of refusing either way.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyMarker } from "../util/markers.js";

/** The marker name wrapping the section: `<!-- GENERATED:agent-contract:start -->` /
 *  `<!-- GENERATED:agent-contract:end -->`. */
export const AGENTS_MD_MARKER = "agent-contract";

const SECTION_BODY = `## Working with an AI agent

This repo uses [em](https://github.com/milehimikey/em) for event modeling. Any implementing
agent — Claude Code or otherwise — should follow this contract:

- **Contract**: \`em contract\` prints the full implementation contract to stdout — what
  "ready" means, treating the slice doc as the read-only spec, when to stop and hand a gap to
  a human instead of deciding it silently.
- **Gate**: before implementing a slice, verify it's ready —
  \`em validate <model>.em --slice-ready <slice-key> --json\` and read the JSON document's
  \`ready\` field (don't infer readiness from the exit code or printed text). Never make the
  gate pass yourself — that's a ratification decision.
- **Read path**: \`em export <model>.em --slice <slice-key>\` exports just that slice's
  normalized JSON (pattern, fields, doc) to implement against; \`em export <model>.em\` exports
  the whole model.
- **MCP alternative**: \`em-mcp\` starts an MCP server exposing the contract, gate, and read
  path above (plus full validate/export) as tools instead of shell commands — see
  [docs/mcp.md](https://github.com/milehimikey/em/blob/main/docs/mcp.md).`;

function markerBlock(): string {
  return `<!-- GENERATED:${AGENTS_MD_MARKER}:start -->\n${SECTION_BODY}\n<!-- GENERATED:${AGENTS_MD_MARKER}:end -->`;
}

export interface AgentsMdResult {
  path: string;
  /** True iff the file's content on disk changed (including a brand-new file). */
  wrote: boolean;
  /** True iff AGENTS.md didn't exist before this call. */
  created: boolean;
}

/**
 * Write/update the agent-contract section in `<repoRoot>/AGENTS.md`. Always idempotent: a
 * second call with nothing else having changed leaves the file byte-identical (`wrote: false`).
 */
export function syncAgentsMd(repoRoot: string): AgentsMdResult {
  const path = join(repoRoot, "AGENTS.md");

  if (!existsSync(path)) {
    writeFileSync(path, markerBlock() + "\n", "utf8");
    return { path, wrote: true, created: true };
  }

  const original = readFileSync(path, "utf8");
  const updated = applyMarker(original, AGENTS_MD_MARKER, SECTION_BODY);

  if (updated !== null) {
    if (updated === original) return { path, wrote: false, created: false };
    writeFileSync(path, updated, "utf8");
    return { path, wrote: true, created: false };
  }

  // No marker pair in the existing file: append it (with a blank-line separator, and one
  // blank line before it if the file doesn't already end in one) rather than refusing — see
  // this module's header comment for why that differs from `em slice index`'s README gate.
  const separator = original.endsWith("\n\n") ? "" : original.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(path, `${original}${separator}${markerBlock()}\n`, "utf8");
  return { path, wrote: true, created: false };
}
