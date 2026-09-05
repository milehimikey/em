// SPDX-License-Identifier: MIT
// Verifies a seam manifest against the models' export documents (MIL-194) — the cross-model
// half of the bedrock "both ends of a flow" rule. A seam is a `public` event/view on one side
// bound to a reaction (translation/automation-kind element) on the other; `em` already has both
// ends of every seam, it just never had them as data. This module makes the binding explicit and
// checks it: both endpoints resolve, the source really is `public`, the consumer really is a
// reaction, nothing published goes unread, nothing externally fed goes unclaimed, and the old
// portal name-matching heuristic is demoted to a lint (`undeclared-seam-candidate`).
//
// It reads EXPORT DOCUMENTS ONLY — the `SystemExportDoc` shape below is the slice of `em
// export --json` (schema >= 1.10: `model.key`, `model.edges`) this check needs, and nothing here
// touches a NormalizedModel. That's the constraint the ticket sets ("models still compile
// independently — no compile-time coupling"): a `.em` source is compiled into the same export
// document by the caller (src/cli/systemInputs.ts), so this verifier can't tell a co-located
// repo from a CI job aggregating exports from ten repos. Pure: no fs, no clock; output order
// is manifest order for models/seams and stable derivation order for everything else.

import { AUTOMATION_KINDS, ElementKind } from "../parser/ast.js";
import { normalizeName } from "../model/model.js";
import { formatQualifiedRef, parseQualifiedRef } from "../model/qualifiedRef.js";
import { pushDiag, RuleCode } from "../model/rules.js";
import type { Diagnostic } from "../model/validate.js";
import type { SystemManifest } from "./manifest.js";

/** The subset of one `em export --json` document `verifySystem` reads. */
export interface SystemExportElement {
  ref: string;
  kind: ElementKind;
  name: string;
  line: number;
  public: boolean;
}
export interface SystemExportSlice {
  key: string;
  name: string;
  elements: SystemExportElement[];
}
export interface SystemExportDoc {
  schemaVersion: string;
  model: {
    key: string;
    name: string | null;
    slices: SystemExportSlice[];
    edges: { from: string; to: string }[];
  };
}

export type SystemSourceKind = "em" | "export";

/** One model, loaded by the caller: the manifest's entry plus its export document and the
 *  path diagnostics about it should point at (the `.em` file, or the export `.json`). */
export interface SystemModelInput {
  key: string;
  source: string;
  sourceKind: SystemSourceKind;
  owner: string | null;
  /** Path diagnostics about this model's elements point at — resolved, as the CLI prints it. */
  file: string;
  doc: SystemExportDoc;
}

/** A diagnostic plus the file it concerns — `em status --json`'s multi-model convention. */
export interface SystemDiagnostic extends Diagnostic {
  file: string;
}

export interface SystemModelReport {
  key: string;
  name: string | null;
  source: string;
  sourceKind: SystemSourceKind;
  owner: string | null;
  /** Unqualified (`<sliceKey>/<kind>.<slug>`) refs of every `public` element, export order. */
  publicSurface: string[];
}

export interface SystemSeamReport {
  /** Resolved, element-level qualified ref when the endpoint resolved; else the ref as written. */
  from: string;
  to: string;
  fromSlice: string | null;
  toSlice: string | null;
  description: string | null;
  status: "verified" | "error";
  /** Codes of every diagnostic raised on this seam (errors and warnings), in raise order. */
  diagnostics: string[];
}

export interface ContextMap {
  nodes: { key: string; name: string | null; owner: string | null }[];
  /** One edge per ordered model pair with at least one declared seam (verified or not), sorted
   *  by (from, to); `seams` counts the declarations. */
  edges: { from: string; to: string; seams: number }[];
}

export interface SystemReport {
  name: string | null;
  models: SystemModelReport[];
  seams: SystemSeamReport[];
  contextMap: ContextMap;
  diagnostics: SystemDiagnostic[];
}

interface ResolvedEndpoint {
  modelKey: string;
  model: SystemModelInput;
  slice: SystemExportSlice;
  element: SystemExportElement;
}

const SEAM_ERROR_CODES: ReadonlySet<string> = new Set([
  "system-manifest-invalid",
  "seam-endpoint-unresolved",
  "seam-source-not-public",
  "seam-consumer-not-reaction",
]);

/** Verify `manifest` against the loaded `models` (one per manifest entry, same order).
 *  `manifestFile` is the path manifest-level diagnostics point at. */
export function verifySystem(manifest: SystemManifest, models: SystemModelInput[], manifestFile: string): SystemReport {
  const diagnostics: SystemDiagnostic[] = [];
  const raise = (file: string, code: RuleCode, extra: { message: string; line?: number; refs?: string[] }) => {
    const bucket: Diagnostic[] = [];
    pushDiag(bucket, code, extra);
    diagnostics.push({ ...bucket[0], file });
  };
  const qualify = formatQualifiedRef;

  // Models are addressed by their MANIFEST key throughout — even on a mismatch, so a seam
  // written against the manifest's own vocabulary still verifies and the one error tells the
  // author exactly which key to change.
  const byKey = new Map<string, SystemModelInput>();
  for (const m of models) {
    byKey.set(m.key, m);
    if (m.doc.model.key !== m.key) {
      const entry = manifest.models.find((e) => e.key === m.key);
      const modelLabel = m.doc.model.name === null ? "(unnamed model)" : `model "${m.doc.model.name}"`;
      raise(manifestFile, "system-model-key-mismatch", {
        message:
          `manifest key "${m.key}" does not match the computed key "${m.doc.model.key}" of ${modelLabel} ` +
          `(${m.source}) — rename the manifest entry to "${m.doc.model.key}"`,
        line: entry?.line,
      });
    }
  }

  const isReaction = (el: SystemExportElement) => AUTOMATION_KINDS.has(el.kind);
  const isSurface = (el: SystemExportElement) => el.public === true && (el.kind === "event" || el.kind === "view");

  const findElement = (model: SystemModelInput, ref: string): { slice: SystemExportSlice; element: SystemExportElement } | undefined => {
    for (const slice of model.doc.model.slices) {
      for (const element of slice.elements) if (element.ref === ref) return { slice, element };
    }
    return undefined;
  };

  // ---- Seams: resolve both endpoints, then check what each one is. ----
  const consumedSurface = new Set<string>(); // qualified refs named as a resolved `from`
  const boundReactions = new Set<string>(); // qualified refs named as a resolved `to`
  const declaredPairs = new Map<string, Set<string>>(); // fromQualified -> set of toQualified
  const seenPairs = new Set<string>();
  const seamsByModelPair = new Map<string, number>();

  const seams: SystemSeamReport[] = manifest.seams.map((seam, i) => {
    const codes: string[] = [];
    const seamRaise = (code: RuleCode, message: string, refs?: string[]) => {
      codes.push(code);
      raise(manifestFile, code, { message: `seams[${i}] (${seam.from} -> ${seam.to}): ${message}`, line: seam.line, refs });
    };

    const resolveModel = (raw: string, side: "from" | "to"): { modelKey: string; ref: string; model: SystemModelInput } | undefined => {
      const parsed = parseQualifiedRef(raw);
      if (parsed.modelKey === null) {
        seamRaise("system-manifest-invalid", `\`${side}\` must be a model-qualified ref (<modelKey>:<sliceKey>/<kind>.<slug>), got "${raw}"`);
        return undefined;
      }
      const model = byKey.get(parsed.modelKey);
      if (!model) {
        seamRaise(
          "system-manifest-invalid",
          `\`${side}\` names unknown model key "${parsed.modelKey}" — declared models are: ${manifest.models.map((m) => m.key).join(", ")}`,
        );
        return undefined;
      }
      return { modelKey: parsed.modelKey, ref: parsed.ref, model };
    };

    // `from`: an element ref that must be a `public` event/view.
    let from: ResolvedEndpoint | undefined;
    const fromModel = resolveModel(seam.from, "from");
    if (fromModel) {
      const hit = findElement(fromModel.model, fromModel.ref);
      if (!hit) {
        seamRaise(
          "seam-endpoint-unresolved",
          `no element "${fromModel.ref}" in model "${fromModel.modelKey}" — check \`em export\`'s refs, or re-declare the seam after a rename`,
        );
      } else {
        from = { modelKey: fromModel.modelKey, model: fromModel.model, ...hit };
        if (!isSurface(hit.element)) {
          const why =
            hit.element.kind === "event" || hit.element.kind === "view"
              ? "is not marked `public`"
              : `is a ${hit.element.kind}, not a \`public\` event or view`;
          seamRaise("seam-source-not-public", `${hit.element.kind} "${hit.element.name}" ${why}`, [qualify(from.modelKey, hit.element.ref)]);
        }
      }
    }

    // `to`: an element ref to a reaction, or a bare slice ref containing exactly one reaction.
    let to: ResolvedEndpoint | undefined;
    const toModel = resolveModel(seam.to, "to");
    if (toModel) {
      if (toModel.ref.includes("/")) {
        const hit = findElement(toModel.model, toModel.ref);
        if (!hit) {
          seamRaise(
            "seam-endpoint-unresolved",
            `no element "${toModel.ref}" in model "${toModel.modelKey}" — check \`em export\`'s refs, or re-declare the seam after a rename`,
          );
        } else {
          to = { modelKey: toModel.modelKey, model: toModel.model, ...hit };
          if (!isReaction(hit.element)) {
            seamRaise(
              "seam-consumer-not-reaction",
              `${hit.element.kind} "${hit.element.name}" is not a reaction — \`to\` must name a translation/automation/processor/saga element`,
              [qualify(to.modelKey, hit.element.ref)],
            );
          }
        }
      } else {
        const slice = toModel.model.doc.model.slices.find((s) => s.key === toModel.ref);
        if (!slice) {
          seamRaise("seam-endpoint-unresolved", `no slice "${toModel.ref}" in model "${toModel.modelKey}"`);
        } else {
          const reactions = slice.elements.filter(isReaction);
          if (reactions.length === 1) {
            to = { modelKey: toModel.modelKey, model: toModel.model, slice, element: reactions[0] };
          } else {
            seamRaise(
              "seam-consumer-not-reaction",
              reactions.length === 0
                ? `slice "${slice.name}" has no reaction element — \`to\` must name (or contain exactly one) translation/automation element`
                : `slice "${slice.name}" has ${reactions.length} reaction elements (${reactions.map((r) => r.ref).join(", ")}) — name one explicitly`,
              [qualify(toModel.modelKey, slice.key)],
            );
          }
        }
      }
    }

    const fromQualified = from ? qualify(from.modelKey, from.element.ref) : seam.from;
    const toQualified = to ? qualify(to.modelKey, to.element.ref) : seam.to;

    // Duplicate: same resolved (from, to) pair declared twice (a bare-slice `to` and its
    // element-level spelling are the same seam). Warned on the second occurrence.
    const pairKey = `${fromQualified} -> ${toQualified}`;
    if (seenPairs.has(pairKey)) {
      seamRaise("seam-duplicate", "already declared earlier in the manifest");
    }
    seenPairs.add(pairKey);

    // A half-resolved seam still claims the endpoint it did resolve, so a typo on one side
    // doesn't ALSO report the other side as dangling/unbound on top of the resolution error.
    if (from) consumedSurface.add(fromQualified);
    if (to) boundReactions.add(toQualified);
    if (from && to) {
      if (!declaredPairs.has(fromQualified)) declaredPairs.set(fromQualified, new Set());
      declaredPairs.get(fromQualified)!.add(toQualified);
    }
    if (fromModel && toModel) {
      const k = `${fromModel.modelKey} ${toModel.modelKey}`;
      seamsByModelPair.set(k, (seamsByModelPair.get(k) ?? 0) + 1);
    }

    const hasError = codes.some((c) => SEAM_ERROR_CODES.has(c));
    return {
      from: fromQualified,
      to: toQualified,
      fromSlice: from ? qualify(from.modelKey, from.slice.key) : null,
      toSlice: to ? qualify(to.modelKey, to.slice.key) : null,
      description: seam.description,
      status: hasError ? "error" : "verified",
      diagnostics: codes,
    };
  });

  // ---- Per-model surface + the two "other end missing" checks, manifest order. ----
  const modelReports: SystemModelReport[] = models.map((m) => {
    const publicSurface: string[] = [];
    for (const slice of m.doc.model.slices) {
      for (const el of slice.elements) {
        if (!isSurface(el)) continue;
        publicSurface.push(el.ref);
        const q = qualify(m.key, el.ref);
        if (!consumedSurface.has(q)) {
          raise(m.file, "dangling-public-event", {
            message: `public ${el.kind} "${el.name}" (${q}) is consumed by no declared seam — declare its reader, or drop \`public\``,
            line: el.line,
            refs: [q],
          });
        }
      }
    }
    return { key: m.key, name: m.doc.model.name, source: m.source, sourceKind: m.sourceKind, owner: m.owner, publicSurface };
  });

  // "Externally fed" is computed from the export's own edge list, never re-derived: a reaction
  // with no incoming edge in `model.edges` (no `from` view feeds it — pattern, `from`, or arrow)
  // is fed from outside its model by construction. With no seam claiming it, nobody in the
  // system says what feeds it.
  for (const m of models) {
    const fedInside = new Set(m.doc.model.edges.map((e) => e.to));
    for (const slice of m.doc.model.slices) {
      for (const el of slice.elements) {
        if (!isReaction(el) || fedInside.has(el.ref)) continue;
        const q = qualify(m.key, el.ref);
        if (boundReactions.has(q)) continue;
        raise(m.file, "unbound-translation", {
          message: `${el.kind} "${el.name}" (${q}) has no in-model source and no seam feeds it — declare the seam whose \`to\` is this reaction, or add a \`from\``,
          line: el.line,
          refs: [q],
        });
      }
    }
  }

  // The old portal heuristic, demoted: a public element in model A sharing its normalized
  // name with a reaction or event in model B (B != A), with no seam between them.
  for (const a of models) {
    for (const aSlice of a.doc.model.slices) {
      for (const el of aSlice.elements) {
        if (!isSurface(el)) continue;
        const aq = qualify(a.key, el.ref);
        const wanted = normalizeName(el.name);
        for (const b of models) {
          if (b === a) continue;
          for (const bSlice of b.doc.model.slices) {
            for (const other of bSlice.elements) {
              const matchKind = isReaction(other) ? "reaction" : other.kind === "event" ? "event" : undefined;
              if (!matchKind || normalizeName(other.name) !== wanted) continue;
              const bq = qualify(b.key, other.ref);
              const declared = declaredPairs.get(aq);
              const connected =
                matchKind === "reaction"
                  ? declared?.has(bq) === true
                  : [...(declared ?? [])].some((t) => t.startsWith(`${b.key}:`));
              if (connected) continue;
              raise(a.file, "undeclared-seam-candidate", {
                message:
                  `public ${el.kind} "${el.name}" (${aq}) and ${other.kind} "${other.name}" (${bq}) look connected by name, ` +
                  "but no seam declares it — declare the seam or rename",
                line: el.line,
                refs: [aq, bq],
              });
            }
          }
        }
      }
    }
  }

  const contextMap: ContextMap = {
    nodes: modelReports.map((m) => ({ key: m.key, name: m.name, owner: m.owner })),
    edges: [...seamsByModelPair.entries()]
      .map(([k, count]) => {
        const [from, to] = k.split(" ");
        return { from, to, seams: count };
      })
      .sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to)),
  };

  return { name: manifest.name, models: modelReports, seams, contextMap, diagnostics };
}
