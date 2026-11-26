// SPDX-License-Identifier: MIT
// GH #527: `em validate`'s code-map rules. An fs-aware sibling of model/validate.ts (same shape
// as catalog/orphanedSliceDocValidate.ts and friends): it reads `code-map.yaml` beside the model
// and the system manifest above it, and checks the map against the model. A model with no
// `code-map.yaml` gets no diagnostic and no filesystem walk beyond one `existsSync`, so a project
// whose model and code share one repository sees no change.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { Diagnostic } from "../model/validate.js";
import { pushDiag } from "../model/rules.js";
import { SELF_REPO_ID } from "../system/manifest.js";
import { loadDeclaredRepos } from "../system/systemRepos.js";
import { CODE_MAP_FILE, CodeMap, parseCodeMap, Place } from "./codeMap.js";
import { derivePlaces } from "./places.js";
import { codeRootPlaces } from "./codeRoots.js";

export type LoadedCodeMap =
  /** No `code-map.yaml` beside the model, or one whose `model:` names another model file. */
  | { kind: "none" }
  | { kind: "ok"; path: string; map: CodeMap }
  | { kind: "invalid"; path: string; diagnostics: Diagnostic[] };

/**
 * Read the code map that describes `modelFile`: `code-map.yaml` in the model's directory. A map
 * whose `model:` names a different file is not this model's (same posture as the state file's
 * `Model file:` bullet: one file per directory, attributed to the model it names) — so a scratch
 * copy or a second model in the directory does not inherit it.
 */
export function loadCodeMap(modelFile: string): LoadedCodeMap {
  const path = join(dirname(modelFile), CODE_MAP_FILE);
  if (!existsSync(path)) return { kind: "none" };
  const diagnostics: Diagnostic[] = [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    pushDiag(diagnostics, "code-map-invalid", { message: `cannot read ${CODE_MAP_FILE}: ${(e as Error).message}` });
    return { kind: "invalid", path, diagnostics: diagnostics.map(inCodeMap) };
  }
  const parsed = parseCodeMap(text);
  if (!parsed.ok) {
    for (const p of parsed.problems) pushDiag(diagnostics, "code-map-invalid", { message: `${CODE_MAP_FILE}: ${p.message}`, line: p.line });
    return { kind: "invalid", path, diagnostics: diagnostics.map(inCodeMap) };
  }
  if (parsed.map.model !== null && parsed.map.model !== basename(modelFile)) return { kind: "none" };
  return { kind: "ok", path, map: parsed.map };
}

/** A diagnostic whose `line` counts in the code map, not in the `.em` file. */
function inCodeMap(d: Diagnostic): Diagnostic {
  return { ...d, file: CODE_MAP_FILE };
}

/**
 * Every code-map diagnostic for one model. `fallback` is the default place(s) outside the map
 * (see `derivePlaces`) — by default the state file's `Code roots:` (GH #530), so a map with no
 * `default:` beside a state file that declares code roots leaves nothing unplaced.
 */
export function validateCodeMap(
  model: NormalizedModel,
  refs: RefsResult,
  modelFile: string,
  fallback: Place[] = codeRootPlaces(modelFile),
): Diagnostic[] {
  const loaded = loadCodeMap(modelFile);
  if (loaded.kind === "none") return [];
  if (loaded.kind === "invalid") return loaded.diagnostics;
  const { map } = loaded;
  const fileDiags: Diagnostic[] = [];

  // Repo ids: `self`, plus whatever the governing manifest declares.
  const rules = [...(map.default ? [{ key: "default", place: map.default.place, line: map.default.line }] : []), ...map.personas, ...map.contexts, ...map.elements];
  const named = rules.filter((r) => r.place.repo !== SELF_REPO_ID);
  if (named.length > 0) {
    const declared = loadDeclaredRepos(dirname(modelFile));
    const known = new Set(declared.kind === "ok" ? declared.repos.map((r) => r.id) : []);
    // Relative to the model's directory: a message must not carry one machine's checkout path.
    const manifest = declared.kind === "none" ? "" : relative(dirname(modelFile), declared.manifestPath).split(sep).join("/");
    const where =
      declared.kind === "none"
        ? "no system.yaml governs this model — a repo other than `self` must be declared under `repos:` in a system.yaml (systemSchemaVersion \"2.1\") at or above the model's directory"
        : declared.kind === "invalid"
          ? `${manifest} cannot be used (${declared.message})`
          : known.size === 0
            ? `${manifest} declares no \`repos:\``
            : `${manifest} declares: ${[...known].join(", ")}`;
    const reported = new Set<string>();
    for (const r of named) {
      if (known.has(r.place.repo) || reported.has(r.place.repo)) continue;
      reported.add(r.place.repo);
      pushDiag(fileDiags, "code-map-unknown-repo", { message: `${CODE_MAP_FILE}: unknown repo id "${r.place.repo}" — ${where}`, line: r.line });
    }
  }

  const hint = (name: string, known: string[]): string => {
    const near = known.find((k) => k.toLowerCase() === name.toLowerCase());
    return near ? ` (did you mean "${near}"?)` : known.length > 0 ? ` (the model has: ${known.join(", ")})` : "";
  };
  for (const r of map.personas) {
    if (!model.personas.includes(r.key)) {
      pushDiag(fileDiags, "code-map-unknown-persona", { message: `${CODE_MAP_FILE}: persona "${r.key}" is not in the model${hint(r.key, model.personas)}`, line: r.line });
    }
  }
  for (const r of map.contexts) {
    if (!model.contexts.includes(r.key)) {
      pushDiag(fileDiags, "code-map-unknown-context", { message: `${CODE_MAP_FILE}: context "${r.key}" is not in the model${hint(r.key, model.contexts)}`, line: r.line });
    }
  }
  const allRefs = new Set(refs.refById.values());
  for (const r of map.elements) {
    if (!allRefs.has(r.key)) {
      pushDiag(fileDiags, "code-map-unknown-element", {
        message: `${CODE_MAP_FILE}: element "${r.key}" is not in the model — an override is keyed by the element's export ref (<slice-key>/<kind>.<slug>, as \`em refs\` prints it)`,
        line: r.line,
      });
    }
  }

  const out = fileDiags.map(inCodeMap);
  const placement = derivePlaces(model, refs, map, fallback);
  model.elements.forEach((el, i) => {
    const p = placement.elements[i];
    if (p.places.length > 0) return;
    pushDiag(out, "code-map-element-unplaced", {
      message: `${el.kind} "${el.name}" has no place: ${p.unplacedReason} — add \`${p.ref}\` under \`elements:\` in ${CODE_MAP_FILE}, or give the map a \`default:\` (or the state file a \`Code roots:\` bullet)`,
      line: el.line,
      refs: [p.ref],
    });
  });
  return out;
}
