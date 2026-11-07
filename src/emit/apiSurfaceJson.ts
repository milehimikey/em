// SPDX-License-Identifier: MIT
// Builds the `em api surface --json` document (GH #448) — the model's public commands, events,
// views and reachable declared types, as a versioned JSON document for companion tools (contract
// bridges, augment generators) that today re-derive this from `em export --json` and risk
// drifting from em's own notion of the surface. Shared by the CLI and the MCP `api_surface` tool
// so the two are byte-identical. Own schema constant, independent of the export `SCHEMA_VERSION`
// and `API_CHECK_SCHEMA_VERSION` (apiCheckJson.ts); deterministic for the same inputs (no
// timestamps, no absolute paths — `file` is as given on the command line, same convention
// `apiCheckJson.ts` follows).

import type { ApiSurfaceReport } from "../cli/api.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "./json.js";

// 1.0 (GH #448): initial shape.
export const API_SURFACE_SCHEMA_VERSION = "1.0";

export function buildApiSurfaceJson(r: ApiSurfaceReport): string {
  const doc = {
    apiSurfaceSchemaVersion: API_SURFACE_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    file: r.file,
    modelKey: r.modelKey,
    commands: r.commands,
    events: r.events,
    views: r.views,
    types: r.types,
  };
  return JSON.stringify(doc, null, 2);
}
