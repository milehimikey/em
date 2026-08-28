// SPDX-License-Identifier: MIT
// `em changelog`'s document builder (MIL-100), extracted out of cli.ts (MIL-167) so the MCP
// server's `changelog` tool can call the exact same function the CLI command does — same
// "one builder, two callers" pattern as buildDiffJson/buildGlossaryJson, just markdown instead
// of JSON (the CLI command itself has no `--json` flag; the document IS the markdown text).
//
// Already pure enough to share as-is: no process.exit, no console — a per-revision compile
// failure becomes that entry's `error` field, never a crash (see the docstring below). The only
// impure bit (`readFileAtCommit`, a `git show`) is injected in, same convention as
// changelog-git.ts/diff-inputs.ts's GitRunner.

import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { compile } from "../pipeline.js";
import { ParseError } from "../parser/parser.js";
import { hasErrors } from "../model/validate.js";
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { diffModels } from "../model/diff.js";
import { buildChangelog, parseDecisionsLog, ChangelogEntry, ChangelogIntro } from "../emit/changelog.js";
import { readFileAtCommit, CommitInfo } from "./changelog-git.js";
import { STATE_FILE_NAME } from "./stateFile.js";

/**
 * Build the `em changelog` markdown document for an already-resolved commit list
 * (oldest -> newest, see `listModelCommits`). Compiles every revision once; per-revision
 * warnings are deliberately never surfaced (historical revisions can be noisy) — only a compile
 * *failure* (parse error or validation error, same threshold `em diff` uses) surfaces, as that
 * entry's error note, never a crash. Diffs are computed against the previous *parseable*
 * revision, so a single bad revision in the middle of the walk doesn't break every entry after
 * it. Content is read at each commit's own path (`readFileAtCommit`), so the walk survives
 * renames.
 */
export function buildChangelogDoc(file: string, repoRoot: string, commits: CommitInfo[]): string {
  const models: (NormalizedModel | null)[] = [];
  const refsList: (RefsResult | null)[] = [];
  const errors: (string | null)[] = [];

  for (const c of commits) {
    const rev = readFileAtCommit(repoRoot, c);
    if (!rev.ok) {
      models.push(null);
      refsList.push(null);
      errors.push(rev.message);
      continue;
    }
    try {
      const { model, refs, diagnostics } = compile(rev.content);
      if (hasErrors(diagnostics)) {
        models.push(null);
        refsList.push(null);
        errors.push(`validation errors at ${c.shortHash} — fix with \`em validate\` at that revision`);
      } else {
        models.push(model);
        refsList.push(refs);
        errors.push(null);
      }
    } catch (e) {
      models.push(null);
      refsList.push(null);
      errors.push(e instanceof ParseError ? `parse error: ${e.message}` : e instanceof Error ? e.message : String(e));
    }
  }

  const entries: ChangelogEntry[] = [];
  let prevParseable = -1;
  commits.forEach((c, i) => {
    const base = { shortHash: c.shortHash, date: c.date, subject: c.subject };
    if (i === 0) {
      entries.push({ ...base, diff: null });
    } else if (!models[i]) {
      entries.push({ ...base, diff: null, error: errors[i]! });
    } else if (prevParseable === -1) {
      entries.push({ ...base, diff: null, error: `no earlier parseable revision to diff against (${commits[0].shortHash}: ${errors[0]})` });
    } else {
      entries.push({
        ...base,
        diff: diffModels(models[prevParseable]!, models[i]!, refsList[prevParseable]!, refsList[i]!),
      });
    }
    if (models[i]) prevParseable = i;
  });

  const intro: ChangelogIntro | null = models[0] ? { slices: models[0].slices.length, elements: models[0].elements.length } : null;
  const introError = models[0] ? undefined : (errors[0] ?? undefined);

  const stateFile = join(dirname(file), STATE_FILE_NAME);
  const decisions = existsSync(stateFile) ? parseDecisionsLog(readFileSync(stateFile, "utf8")) : [];

  return buildChangelog(entries, decisions, { file, intro, introError });
}
