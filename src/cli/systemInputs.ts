// SPDX-License-Identifier: MIT
// The filesystem half of `em system` (MIL-194): read the manifest, resolve each model's
// `source` relative to the manifest's directory, and turn every source — a `.em` file compiled
// in-process, or an `em export --json` document read as-is — into the ONE input shape the
// verifier (src/system/verify.ts) accepts: an export document. That is how "verification reads
// export JSON only" stays true while a co-located repo still gets to point at its `.em` files
// directly: a `.em` source is compiled with the same `compile()` + `buildExportDoc()` `em export`
// itself runs, never through a second model reader, so the verifier can't tell the two apart.
//
// Shared by the CLI action (src/cli.ts) and the MCP `system` tool (src/mcp/server.ts) so the two
// surfaces load a system identically — the parity requirement. Every failure is a returned
// diagnostic, never a throw or a process exit: the CLI prints and exits, MCP returns a tool error.

import { readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join } from "node:path";
import { compile } from "../pipeline.js";
import { ParseError } from "../parser/parser.js";
import { hasErrors } from "../model/validate.js";
import { buildExportDoc } from "../emit/json.js";
import { computeModelKey } from "../model/qualifiedRef.js";
import { makeDiag } from "../model/rules.js";
import { parseManifest, SystemManifest } from "../system/manifest.js";
import { SystemDiagnostic, SystemExportDoc, SystemModelInput } from "../system/verify.js";

/** The oldest `em export` schema whose document carries what the verifier reads (`model.key`
 *  from MIL-193, `model.edges` from MIL-191 — both schema 1.10). */
export const MIN_EXPORT_SCHEMA = { major: 1, minor: 10 };

export type LoadSystemResult =
  | { ok: true; manifest: SystemManifest; manifestText: string; models: SystemModelInput[] }
  | { ok: false; diagnostics: SystemDiagnostic[] };

/** Read + parse the manifest at `manifestPath` and load every model it declares. `ok: false`
 *  means the system can't be verified at all (unreadable/invalid manifest, or a source that
 *  can't be read, parsed, or has compile errors) — the caller refuses, the same way `em export`
 *  refuses a model with errors, rather than verifying a partial system. */
export function loadSystem(manifestPath: string): LoadSystemResult {
  let manifestText: string;
  try {
    manifestText = readFileSync(manifestPath, "utf8");
  } catch {
    return { ok: false, diagnostics: [{ file: manifestPath, ...makeDiag("system-manifest-invalid", { message: `cannot read ${manifestPath}` }) }] };
  }
  const parsed = parseManifest(manifestText);
  if (!parsed.ok) {
    return { ok: false, diagnostics: parsed.diagnostics.map((d) => ({ file: manifestPath, ...d })) };
  }

  const baseDir = dirname(manifestPath);
  const diagnostics: SystemDiagnostic[] = [];
  const models: SystemModelInput[] = [];
  for (const entry of parsed.manifest.models) {
    // Joined, not resolved: diagnostics and `--json` echo this path, and a document a CI job
    // commits must not embed one machine's absolute checkout path — `em export`'s `source.path`
    // keeps the same "as given" posture.
    const file = isAbsolute(entry.source) ? entry.source : join(baseDir, entry.source);
    const loaded = loadSource(file);
    if ("error" in loaded) {
      diagnostics.push({
        file: manifestPath,
        ...makeDiag("system-manifest-invalid", { message: `model "${entry.key}": ${loaded.error}`, line: entry.line }),
      });
      continue;
    }
    models.push({ key: entry.key, source: entry.source, sourceKind: loaded.sourceKind, owner: entry.owner, file, doc: loaded.doc });
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, manifest: parsed.manifest, manifestText, models };
}

type LoadedSource = { sourceKind: "em" | "export"; doc: SystemExportDoc } | { error: string };

/** One source path to an export document. `.em` compiles (refusing on parse/validation
 *  errors, same gate as `em export`); anything else is read as an `em export --json` document
 *  and shape-checked for the fields the verifier needs. */
function loadSource(file: string): LoadedSource {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { error: `cannot read ${file}` };
  }
  if (extname(file).toLowerCase() === ".em") {
    try {
      const { model, refs, diagnostics } = compile(text);
      if (hasErrors(diagnostics)) {
        return { error: `${file} has validation errors — run \`em validate ${file}\` and fix them first` };
      }
      const { doc } = buildExportDoc(model, refs, diagnostics, text, file);
      // `model.key` is MIL-193's export field (schema 1.10); until `buildExportDoc` carries it,
      // computed here from the same helper (`computeModelKey`) so the two can never disagree.
      const key = (doc.model as { key?: string }).key ?? computeModelKey(model, file);
      return { sourceKind: "em", doc: { schemaVersion: doc.schemaVersion, model: { ...doc.model, key } } };
    } catch (e) {
      if (e instanceof ParseError) return { error: `parse error in ${file} ${e.message}` };
      throw e;
    }
  }
  return readExportDoc(text, file);
}

/** Shape-check an `em export --json` document: `schemaVersion` >= 1.10 and the `model.key`/
 *  `model.slices`/`model.edges` fields present. Deliberately shallow — this is a guard against
 *  handing the verifier a file that isn't an export at all (or one from an older em), not a
 *  full schema validation; an export em itself wrote is trusted past this point. */
export function readExportDoc(text: string, file: string): LoadedSource {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: `${file} is not valid JSON (expected an \`em export --json\` document)` };
  }
  if (typeof raw !== "object" || raw === null || typeof (raw as { schemaVersion?: unknown }).schemaVersion !== "string") {
    return { error: `${file} is not an \`em export --json\` document (no schemaVersion)` };
  }
  const doc = raw as { schemaVersion: string; model?: Record<string, unknown> };
  const [majorStr, minorStr] = doc.schemaVersion.split(".");
  const major = Number(majorStr);
  const minor = Number(minorStr);
  const tooOld = !Number.isInteger(major) || !Number.isInteger(minor) || major < MIN_EXPORT_SCHEMA.major || (major === MIN_EXPORT_SCHEMA.major && minor < MIN_EXPORT_SCHEMA.minor);
  if (tooOld) {
    return {
      error:
        `${file} has export schemaVersion "${doc.schemaVersion}" — \`em system\` needs >= ${MIN_EXPORT_SCHEMA.major}.${MIN_EXPORT_SCHEMA.minor} ` +
        `(model.key and model.edges); regenerate it with a current \`em export --json\``,
    };
  }
  const model = doc.model;
  if (typeof model !== "object" || model === null) return { error: `${file}: export document has no \`model\`` };
  if (typeof model.key !== "string") return { error: `${file}: export document has no \`model.key\` — regenerate it with a current \`em export --json\`` };
  if (!Array.isArray(model.slices)) return { error: `${file}: export document has no \`model.slices\`` };
  if (!Array.isArray(model.edges)) return { error: `${file}: export document has no \`model.edges\` — regenerate it with a current \`em export --json\`` };
  return { sourceKind: "export", doc: raw as SystemExportDoc };
}
