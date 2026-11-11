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
// 1.1 (GH #477, "identity scalars"): a field's `type` gains the `"scalar-alias"` kind — a
// declared `scalar Name: base` identity alias, resolved the same way `em api generate`'s
// emitter picks what to extend (`tsType` is the alias's own name, e.g. `"OrderId"`; `base` is
// the `PUBLIC_SCALAR_TYPES` key it extends, e.g. `"uuid"` — `null` on the other two kinds).
// Report gains top-level `scalars`: every identity scalar reachable from the public surface
// (same reachability `em api generate` uses to decide what to declare), `{ name, slug, base }`
// in declaration order — so a companion tool learns the OrderId -> uuid mapping without parsing
// the generated `.tsp`. Additive only.
// 1.2 (GH #478, "enums"): a field's `type` gains the `"enum"` kind (`tsType` is the enum's own
// name; `scalar`/`base` stay `null`, same convention `"scalar-alias"` already established).
// Report gains top-level `enums`: every declared enum reachable from the public surface (same
// reachability rule), `{ name, slug, members }` in declaration order — so a companion tool
// learns the member set without parsing the generated `.tsp`. Bumped on its own, same per-
// ticket cadence this file has followed since 1.0 (no "one bump per release" precedent here,
// unlike `em export`'s `SCHEMA_VERSION`). Additive only.
export const API_SURFACE_SCHEMA_VERSION = "1.2";

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
    scalars: r.scalars,
    enums: r.enums,
  };
  return JSON.stringify(doc, null, 2);
}
