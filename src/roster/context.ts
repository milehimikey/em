// SPDX-License-Identifier: MIT
// Glue between a model file and the roster loader (GH #259): the model key and the enclosing
// system's model keys (from the nearest system.yaml, when one exists) a roster is validated against.

import { readFileSync } from "node:fs";
import type { NormalizedModel } from "../model/model.js";
import { parseManifest } from "../system/manifest.js";
import { findSystemManifestAbove } from "../cli/systemInputs.js";
import { RosterModelContext, rosterModelContext } from "./roster.js";

export function rosterContextFor(model: NormalizedModel, file: string): RosterModelContext {
  let systemModelKeys: string[] | undefined;
  try {
    const manifest = findSystemManifestAbove(file);
    if (manifest !== null) {
      const parsed = parseManifest(readFileSync(manifest, "utf8"));
      if (parsed.ok) systemModelKeys = parsed.manifest.models.map((m) => m.key);
    }
  } catch {
    // unreadable manifest: models: entries are then only shape-checked
  }
  return rosterModelContext(model, file, systemModelKeys);
}
