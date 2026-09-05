// SPDX-License-Identifier: MIT
// Parses a seam manifest (`system.yaml`, MIL-194) into a plain, validated shape — the declared
// list of models in a system plus the seams binding one model's `public` event/view to another
// model's reaction. This is the one place the manifest's own schema is enforced; everything
// downstream (src/system/verify.ts) trusts the returned `SystemManifest`.
//
// YAML because the manifest is human-authored (and JSON is a YAML subset, so a `.json` manifest
// parses here unchanged). Pure: text in, manifest + diagnostics out — the caller (src/cli/
// systemInputs.ts) owns reading the file and resolving each model's `source` path, so this
// module never touches the filesystem. Line numbers come from the YAML parser's own
// `LineCounter`, so a shape error points at the offending entry, not just "the manifest".

import { LineCounter, parseDocument, isMap, isSeq, isScalar, Node, Pair } from "yaml";
import type { Diagnostic } from "../model/validate.js";
import { pushDiag } from "../model/rules.js";

/** The only manifest schema version accepted (`systemSchemaVersion`). Bumped, with a range
 *  check here, the day the manifest's shape changes incompatibly. */
export const SYSTEM_MANIFEST_SCHEMA_VERSION = "1.0";

export interface ManifestModel {
  /** The manifest's own key for this model — by MIL-193's rule the kebab-slug of the declared
   *  model name, and verified against the export's `model.key` by src/system/verify.ts. */
  key: string;
  /** A `.em` file or an `em export --json` document, as written (relative to the manifest). */
  source: string;
  owner: string | null;
  /** 1-based line of the model's entry in the manifest, for diagnostics. */
  line: number;
}

export interface ManifestSeam {
  /** Qualified ref of the producing `public` event/view, as written. */
  from: string;
  /** Qualified ref of the consuming reaction — or a bare `<modelKey>:<sliceKey>`, as written. */
  to: string;
  description: string | null;
  /** 1-based line of the seam's entry in the manifest, for diagnostics. */
  line: number;
}

export interface SystemManifest {
  systemSchemaVersion: string;
  name: string | null;
  /** Manifest order — the order `em system` lists models and context-map nodes. */
  models: ManifestModel[];
  /** Manifest order; empty when the manifest declares none (valid — every `public` element then
   *  reports `dangling-public-event`). */
  seams: ManifestSeam[];
}

export type ParseManifestResult =
  | { ok: true; manifest: SystemManifest; diagnostics: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[] };

const TOP_KEYS = new Set(["systemSchemaVersion", "name", "models", "seams"]);
const MODEL_KEYS = new Set(["source", "owner"]);
const SEAM_KEYS = new Set(["from", "to", "description"]);

/** Parse and shape-check manifest text. Every problem is a `system-manifest-invalid` error
 *  diagnostic (never a throw), and `ok: false` means the manifest can't be used at all — the
 *  caller refuses rather than verifying a partial system. Unknown keys are errors, not ignored:
 *  a misspelled `seam:` silently declaring zero seams would defeat the whole check. */
export function parseManifest(text: string): ParseManifestResult {
  const diagnostics: Diagnostic[] = [];
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false });
  const lineOf = (node: Node | Pair | null | undefined): number | undefined => {
    const range = node && "range" in node ? node.range : isPairLike(node) ? (node.key as Node | null)?.range : undefined;
    return range ? lineCounter.linePos(range[0]).line : undefined;
  };
  const invalid = (message: string, line?: number) =>
    pushDiag(diagnostics, "system-manifest-invalid", { message, line });

  if (doc.errors.length > 0) {
    for (const e of doc.errors) {
      const line = e.linePos?.[0]?.line;
      invalid(`YAML parse error: ${e.message.trim()}`, line);
    }
    return { ok: false, diagnostics };
  }
  const root = doc.contents;
  if (!isMap(root)) {
    invalid("manifest must be a YAML mapping with `systemSchemaVersion`, `models`, and optionally `name`/`seams`");
    return { ok: false, diagnostics };
  }

  for (const pair of root.items) {
    const key = scalarString(pair.key);
    if (key === undefined || !TOP_KEYS.has(key)) {
      invalid(`unknown top-level key ${describeKey(pair.key)} — expected one of: ${[...TOP_KEYS].join(", ")}`, lineOf(pair));
    }
  }

  // systemSchemaVersion — required, and exactly the one version this em understands.
  const versionNode = root.get("systemSchemaVersion", true) as Node | undefined;
  const version = scalarString(versionNode);
  if (version === undefined) {
    invalid(`missing or non-string \`systemSchemaVersion\` — set \`systemSchemaVersion: "${SYSTEM_MANIFEST_SCHEMA_VERSION}"\``, lineOf(versionNode));
  } else if (version !== SYSTEM_MANIFEST_SCHEMA_VERSION) {
    invalid(`unsupported systemSchemaVersion "${version}" — this em accepts "${SYSTEM_MANIFEST_SCHEMA_VERSION}"`, lineOf(versionNode));
  }

  // name — optional string.
  const nameNode = root.get("name", true) as Node | undefined;
  let name: string | null = null;
  if (nameNode !== undefined) {
    const n = scalarString(nameNode);
    if (n === undefined) invalid("`name` must be a string", lineOf(nameNode));
    else name = n;
  }

  // models — required mapping, ≥ 1 entry, each `{ source, owner? }`.
  const models: ManifestModel[] = [];
  const modelsNode = root.get("models", true) as Node | undefined;
  if (!isMap(modelsNode)) {
    invalid("`models` must be a mapping of model key -> { source, owner? } with at least one entry", lineOf(modelsNode ?? root));
  } else if (modelsNode.items.length === 0) {
    invalid("`models` must declare at least one model", lineOf(modelsNode));
  } else {
    for (const pair of modelsNode.items) {
      const key = scalarString(pair.key);
      const line = lineOf(pair) ?? lineOf(modelsNode);
      if (key === undefined || key.trim() === "") {
        invalid(`model key ${describeKey(pair.key)} must be a non-empty string`, line);
        continue;
      }
      const entry = pair.value as Node | null;
      if (!isMap(entry)) {
        invalid(`model "${key}" must be a mapping with a \`source\` (a .em file or an \`em export --json\` document)`, line);
        continue;
      }
      for (const p of entry.items) {
        const k = scalarString(p.key);
        if (k === undefined || !MODEL_KEYS.has(k)) invalid(`model "${key}": unknown key ${describeKey(p.key)} — expected source, owner`, lineOf(p));
      }
      const source = scalarString(entry.get("source", true) as Node | undefined);
      if (source === undefined || source.trim() === "") {
        invalid(`model "${key}": \`source\` must be a non-empty path string`, line);
        continue;
      }
      const ownerNode = entry.get("owner", true) as Node | undefined;
      let owner: string | null = null;
      if (ownerNode !== undefined) {
        const o = scalarString(ownerNode);
        if (o === undefined) invalid(`model "${key}": \`owner\` must be a string`, lineOf(ownerNode));
        else owner = o;
      }
      models.push({ key, source, owner, line: line ?? 1 });
    }
  }

  // seams — optional sequence of `{ from, to, description? }`.
  const seams: ManifestSeam[] = [];
  const seamsNode = root.get("seams", true) as Node | undefined;
  if (seamsNode !== undefined && !(isScalar(seamsNode) && seamsNode.value === null)) {
    if (!isSeq(seamsNode)) {
      invalid("`seams` must be a list of { from, to, description? } entries", lineOf(seamsNode));
    } else {
      seamsNode.items.forEach((item, i) => {
        const line = lineOf(item as Node) ?? lineOf(seamsNode);
        if (!isMap(item)) {
          invalid(`seams[${i}] must be a mapping with \`from\` and \`to\``, line);
          return;
        }
        for (const p of item.items) {
          const k = scalarString(p.key);
          if (k === undefined || !SEAM_KEYS.has(k)) invalid(`seams[${i}]: unknown key ${describeKey(p.key)} — expected from, to, description`, lineOf(p));
        }
        const from = scalarString(item.get("from", true) as Node | undefined);
        const to = scalarString(item.get("to", true) as Node | undefined);
        if (from === undefined || from.trim() === "") invalid(`seams[${i}]: \`from\` must be a qualified ref string (<modelKey>:<sliceKey>/<kind>.<slug>)`, line);
        if (to === undefined || to.trim() === "") invalid(`seams[${i}]: \`to\` must be a qualified ref string (<modelKey>:<sliceKey>/<kind>.<slug>, or <modelKey>:<sliceKey>)`, line);
        const descNode = item.get("description", true) as Node | undefined;
        let description: string | null = null;
        if (descNode !== undefined && !(isScalar(descNode) && descNode.value === null)) {
          const d = scalarString(descNode);
          if (d === undefined) invalid(`seams[${i}]: \`description\` must be a string`, lineOf(descNode));
          else description = d;
        }
        if (from !== undefined && from.trim() !== "" && to !== undefined && to.trim() !== "") {
          seams.push({ from: from.trim(), to: to.trim(), description, line: line ?? 1 });
        }
      });
    }
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return {
    ok: true,
    manifest: { systemSchemaVersion: version!, name, models, seams },
    diagnostics,
  };
}

function isPairLike(node: unknown): node is Pair {
  return typeof node === "object" && node !== null && "key" in node && "value" in node && !("range" in node);
}

/** A scalar node's value as a string — `undefined` for a missing node, a non-scalar, or a
 *  non-string scalar (numbers/booleans/null are never accepted where a string is required, so
 *  `systemSchemaVersion: 1.0` — a YAML float — is rejected, not silently coerced). */
function scalarString(node: unknown): string | undefined {
  if (!isScalar(node)) return undefined;
  return typeof node.value === "string" ? node.value : undefined;
}

function describeKey(node: unknown): string {
  if (isScalar(node)) return `"${String(node.value)}"`;
  return "(non-scalar key)";
}
