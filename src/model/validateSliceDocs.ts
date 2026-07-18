// SPDX-License-Identifier: MIT
// Diagnostics for slice docs (slices/*.md), per docs/1.0.0-spec.md §5. Mirrors
// the Diagnostic { severity, message, line? } shape from validate.ts, using
// `file` instead of `line` since these point at a Markdown doc, not the .em.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Diagnostic } from "./validate.js";
import { NormalizedModel } from "./model.js";
import { SliceDoc, SlicePattern, SliceStatus } from "./sliceDoc.js";
import { buildDocIdByElementId, deriveGeneratedFields } from "./deriveSliceFields.js";

export const CURRENT_SCHEMA_VERSION = 1;

const VALID_PATTERNS: SlicePattern[] = [
  "state-change",
  "state-view",
  "automation",
  "translation",
];

const VALID_STATUSES: SliceStatus[] = [
  "draft",
  "reviewed",
  "ready-to-implement",
  "in-progress",
  "implemented",
  "deprecated",
  "superseded",
];

const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function sameStringArray(a: unknown, b: string[]): boolean {
  if (!Array.isArray(a)) return b.length === 0;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

export function validateSliceDocs(
  model: NormalizedModel,
  modelPath: string,
  docs: SliceDoc[],
): Diagnostic[] {
  const diags: Diagnostic[] = [];

  // Which .em elements already have a doc linking back to them (note "slices/<file>.md").
  const notedPaths = new Set<string>();
  for (const el of model.elements) {
    if (el.note) notedPaths.add(resolve(dirname(modelPath), el.note));
  }

  // Every doc whose id + sliceElement look usable, so triggers/triggeredBy and
  // drift-checks can resolve cross-doc even when other fields on a doc are invalid.
  const docIdByElementId = buildDocIdByElementId(model, docs);

  const seenIds = new Map<string, string>(); // id -> first doc path that used it

  for (const doc of docs) {
    const data = doc.frontmatter;

    if (!data) {
      diags.push({
        severity: "error",
        file: doc.path,
        message: "no frontmatter block found; run `em migrate` to upgrade this model directory",
      });
      continue;
    }

    if (typeof data.schemaVersion !== "number" || !Number.isInteger(data.schemaVersion)) {
      diags.push({ severity: "error", file: doc.path, message: "missing or invalid `schemaVersion`" });
    } else if (data.schemaVersion > CURRENT_SCHEMA_VERSION) {
      diags.push({
        severity: "error",
        file: doc.path,
        message: `schemaVersion ${data.schemaVersion} is newer than this em build understands (${CURRENT_SCHEMA_VERSION}); upgrade @milehimikey/em`,
      });
    }

    if (typeof data.id !== "string" || data.id.length === 0) {
      diags.push({ severity: "error", file: doc.path, message: "missing or invalid `id`" });
    } else {
      if (!KEBAB_RE.test(data.id)) {
        diags.push({
          severity: "error",
          file: doc.path,
          message: `id "${data.id}" is not kebab-case (expected e.g. "place-order")`,
        });
      }
      const firstPath = seenIds.get(data.id);
      if (firstPath && firstPath !== doc.path) {
        diags.push({
          severity: "error",
          file: doc.path,
          message: `id "${data.id}" is also used by ${firstPath}; slice ids must be unique within a model directory`,
        });
      } else if (!firstPath) {
        seenIds.set(data.id, doc.path);
      }
    }

    if (typeof data.title !== "string" || data.title.length === 0) {
      diags.push({ severity: "error", file: doc.path, message: "missing or invalid `title`" });
    }

    if (typeof data.pattern !== "string" || !VALID_PATTERNS.includes(data.pattern as SlicePattern)) {
      diags.push({
        severity: "error",
        file: doc.path,
        message: `\`pattern\` must be one of ${VALID_PATTERNS.join(", ")}`,
      });
    }

    if (typeof data.status !== "string" || !VALID_STATUSES.includes(data.status as SliceStatus)) {
      diags.push({
        severity: "error",
        file: doc.path,
        message: `\`status\` must be one of ${VALID_STATUSES.join(", ")}`,
      });
    }

    if (typeof data.version !== "number" || !Number.isInteger(data.version) || data.version < 1) {
      diags.push({ severity: "error", file: doc.path, message: "`version` must be a positive integer" });
    }

    if (typeof data.model !== "string" || data.model.length === 0) {
      diags.push({ severity: "error", file: doc.path, message: "missing or invalid `model`" });
    } else if (!existsSync(resolve(dirname(doc.path), data.model))) {
      diags.push({
        severity: "error",
        file: doc.path,
        message: `\`model\` "${data.model}" does not resolve to an existing file`,
      });
    }

    let sliceElementId: string | undefined;
    if (typeof data.sliceElement !== "string" || data.sliceElement.length === 0) {
      diags.push({ severity: "error", file: doc.path, message: "missing or invalid `sliceElement`" });
    } else if (!model.byId.has(data.sliceElement)) {
      diags.push({
        severity: "error",
        file: doc.path,
        message: `sliceElement "${data.sliceElement}" does not match any element in ${modelPath}`,
      });
    } else {
      sliceElementId = data.sliceElement;
    }

    if (Array.isArray(data.upstreamEvents)) {
      for (const name of data.upstreamEvents) {
        const found = model.elements.some((e) => e.kind === "event" && e.name === name);
        if (!found) {
          diags.push({
            severity: "warning",
            file: doc.path,
            message: `upstreamEvents references unknown event "${name}"`,
          });
        }
      }
    }

    if (Array.isArray(data.relatedSlices)) {
      const knownIds = new Set(docs.map((d) => d.frontmatter?.id).filter(Boolean));
      for (const id of data.relatedSlices) {
        if (!knownIds.has(id)) {
          diags.push({
            severity: "warning",
            file: doc.path,
            message: `relatedSlices references unknown slice id "${id}"`,
          });
        }
      }
    }

    if (!notedPaths.has(resolve(doc.path))) {
      diags.push({
        severity: "warning",
        file: doc.path,
        message: 'no element in the .em model has `note "..."` pointing at this doc (orphan doc)',
      });
    } else if (sliceElementId) {
      const el = model.byId.get(sliceElementId)!;
      const notePath = el.note && resolve(dirname(modelPath), el.note);
      if (notePath !== resolve(doc.path)) {
        diags.push({
          severity: "warning",
          file: doc.path,
          message: `sliceElement "${sliceElementId}"'s note does not point back at this doc`,
        });
      }
    }

    if (sliceElementId) {
      const derived = deriveGeneratedFields(model, sliceElementId, docIdByElementId);
      if (derived) {
        const drifted =
          !sameStringArray(data.commands, derived.commands) ||
          !sameStringArray(data.events, derived.events) ||
          !sameStringArray(data.readModels, derived.readModels) ||
          !sameStringArray(data.contexts, derived.contexts) ||
          !sameStringArray(data.personas, derived.personas) ||
          (data.triggers ?? undefined) !== derived.triggers ||
          (data.triggeredBy ?? undefined) !== derived.triggeredBy;
        if (drifted) {
          diags.push({
            severity: "warning",
            file: doc.path,
            message: "frontmatter out of sync with .em; run `em slice sync`",
          });
        }
      }
    }
  }

  return diags;
}
