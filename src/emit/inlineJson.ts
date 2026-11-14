// SPDX-License-Identifier: MIT
// `em inline-check --json` (GH #496). Versioned independently of the npm package and of every other
// command's schema, same convention as refsJson.ts.
//
// 1.0: initial shape -- `{ inlineSchemaVersion, generator, file, base, mergeBase, policy: { inline:
//   { value, source }, inlineViolation: { value, source } }, ratified[], codePaths[], findings[], ok }`.
//   `findings[]` entries are `{ code: "slice-ratified-inline", sliceKey, path, reason, policySource,
//   message }`, `reason` one of `public-touching | policy-never`. `ok` is false only when there are
//   findings and `inline-violation: error`.
import { InlineCheckResult } from "../cli/inlineCheck.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "./json.js";

export const INLINE_SCHEMA_VERSION = "1.0";

export function buildInlineJson(result: InlineCheckResult, file: string): string {
  return JSON.stringify(
    {
      inlineSchemaVersion: INLINE_SCHEMA_VERSION,
      generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
      file,
      base: result.base,
      mergeBase: result.mergeBase,
      policy: { inline: result.inline, inlineViolation: result.inlineViolation },
      ratified: result.ratified,
      codePaths: result.codePaths,
      findings: result.findings,
      ok: result.ok,
    },
    null,
    2,
  );
}
