// SPDX-License-Identifier: MIT
// Builds the `em api check --json` document (MIL-237) — shared by the CLI and the MCP
// `api_check` tool so the two are byte-identical. Own schema constant, independent of the
// export `SCHEMA_VERSION`; deterministic for the same inputs (no timestamps, no absolute
// paths — `file`/`contractPath` are as given on the command line).

import type { ApiCheckReport } from "../cli/api.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "./json.js";

// 1.0 (MIL-237): initial shape.
export const API_CHECK_SCHEMA_VERSION = "1.0";

export function buildApiCheckJson(r: ApiCheckReport): string {
  const doc = {
    apiCheckSchemaVersion: API_CHECK_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    file: r.file,
    contractPath: r.contractPath,
    current: r.current,
    base: r.base,
    changes: r.changes.map((c) => ({ kind: c.kind, element: c.element, field: c.field, what: c.what })),
  };
  return JSON.stringify(doc, null, 2);
}
