// SPDX-License-Identifier: MIT
// `em refs --json` (GH #258). Versioned independently of the npm package and of every other
// command's schema, same convention as ledgerJson.ts.
//
// 1.0: initial shape — `{ refsSchemaVersion, generator, file, reachableFrom, target, shallow,
//   checked: { docs, refs }, results[], waived[], ok }`. `results[]`/`waived[]` entries are
//   `{ sliceKey, path, field, ref, status, detail }` (+ `waivedBy` on waived), `status` one of
//   `ancestor | not-ancestor | unresolved | undecidable`; `ok` is false when any active result is
//   not `ancestor` — a shallow clone therefore reads `ok: false, shallow: true`, never a pass.
//   GH #399 added an additive, opt-in `orderResults` field (present only with `--check-order`;
//   omitted, not `null`, otherwise — plain `em refs --json` stays byte-identical) — no schema
//   bump: it's a new optional key, not a change to anything 1.0 already promised. Each entry is
//   `{ sliceKey, path, ratifiedRef, commit, status, detail }`, `status` one of `ratified-first |
//   code-before-ratification | undecidable`. It carries no `ok` of its own and is never folded
//   into the document's `ok` — advisory only, never part of the exit code (R5, docs/process.md).
import { OrderResult, RefsCheckResult } from "../cli/refsCheck.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "./json.js";

export const REFS_SCHEMA_VERSION = "1.0";

/** Pretty-printed JSON, no trailing newline — the caller adds it, same convention as buildLedgerJson.
 *  `orderResults` is omitted entirely when `null` (the default, `--check-order` not passed) so a
 *  plain `em refs --json` run stays byte-identical to before GH #399. */
export function buildRefsJson(result: RefsCheckResult, file: string, orderResults: OrderResult[] | null = null): string {
  const doc = {
    refsSchemaVersion: REFS_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    file,
    reachableFrom: result.reachableFrom,
    target: result.target,
    shallow: result.shallow,
    checked: { docs: result.checkedDocs, refs: result.checkedRefs },
    results: result.results,
    waived: result.waived,
    ok: result.ok,
    ...(orderResults !== null ? { orderResults } : {}),
  };
  return JSON.stringify(doc, null, 2);
}
