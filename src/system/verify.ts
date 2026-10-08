// SPDX-License-Identifier: MIT
// Verifies a system — a set of models' export documents (MIL-194) — the cross-model half of the
// bedrock "both ends of a flow" rule. A seam is a `public` event/view on one side bound to a
// reaction on the other. Since MIL-235 the binding is declared consumer-side, versionless, on
// the consuming translation itself (`consumes <modelKey>:<kind>.<slug>`, carried in the export
// as `elements[].consumes`), so it travels with the model; this module resolves every such ref
// against the other models' public surface (`consumes-unknown-model`/`-element`), then runs the
// MIL-194 checks off those bindings: nothing published goes unread, nothing externally fed goes
// unclaimed, and the old portal name-matching heuristic stays a lint (`undeclared-seam-
// candidate`). A legacy 1.0 manifest's `seams:` are still verified (same codes as before) with a
// `system-manifest-outdated` warning, so an unmigrated estate keeps working until `em upgrade`.
//
// It reads EXPORT DOCUMENTS ONLY — the `SystemExportDoc` shape below is the slice of `em
// export --json` (schema >= 1.10: `model.key`, `model.edges`) this check needs, and nothing here
// touches a NormalizedModel. That's the constraint the ticket sets ("models still compile
// independently — no compile-time coupling"): a `.em` source is compiled into the same export
// document by the caller (src/cli/systemInputs.ts), so this verifier can't tell a co-located
// repo from a CI job aggregating exports from ten repos. Pure: no fs, no clock; output order
// is model order (manifest or discovery) for models and bindings — every `consumes` binding in
// model/slice/element/ref order, then any legacy manifest seams — and stable derivation order
// for everything else.

import { AUTOMATION_KINDS, ElementKind } from "../parser/ast.js";
import { normalizeName } from "../model/model.js";
import { formatContractRef, formatQualifiedRef, parseContractRef, parseQualifiedRef } from "../model/qualifiedRef.js";
import { pushDiag, RuleCode } from "../model/rules.js";
import type { Diagnostic } from "../model/validate.js";
import { AdaptationField, adaptationMessage, compareConsumerFields } from "./adaptation.js";
import { LEGACY_SYSTEM_MANIFEST_SCHEMA_VERSION, SYSTEM_MANIFEST_SCHEMA_VERSION, SystemManifest } from "./manifest.js";

/** The subset of one `em export --json` document `verifySystem` reads. */
export interface SystemExportElement {
  ref: string;
  kind: ElementKind;
  name: string;
  line: number;
  public: boolean;
  /** Export schema >= 1.15 (MIL-235): a translation's contract refs. Absent on older exports —
   *  read as none. */
  consumes?: string[] | null;
  /** The element's declared fields (MIL-239 reads them for the consumer-adaptation check).
   *  Absent on an export that carries none; read as no fields. */
  fields?: AdaptationField[] | null;
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
    /** Export schema >= 1.15 (MIL-235): the header's `owner` entries. Absent on older exports. */
    owner?: string[];
    slices: SystemExportSlice[];
    edges: { from: string; to: string }[];
  };
}

export type SystemSourceKind = "em" | "export";

/** One model, loaded by the caller: its key (the manifest's, or the computed one in discovery
 *  mode), its export document, and the path diagnostics about it should point at (the `.em`
 *  file, or the export `.json`). */
export interface SystemModelInput {
  key: string;
  source: string;
  sourceKind: SystemSourceKind;
  /** The model header's `owner` entries (export `model.owner`); a legacy 1.0 manifest's
   *  `owner:` fills in when the header names none. `[]` when neither does. */
  owner: string[];
  /** Path diagnostics about this model's elements point at — resolved, as the CLI prints it. */
  file: string;
  doc: SystemExportDoc;
}

/** How a discovered system (no manifest, MIL-235 R4) was found: the repo root (or start
 *  directory) as reached from the path the caller gave — never absolutized, same "as given"
 *  posture as a manifest path — and every discovered `.em` file relative to it, sorted. */
export interface SystemDiscovery {
  root: string;
  files: string[];
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
  owner: string[];
  /** Unqualified (`<sliceKey>/<kind>.<slug>`) refs of every `public` element, export order. */
  publicSurface: string[];
}

export interface SystemSeamReport {
  /** Resolved, element-level qualified ref of the producing element when it resolved; else the
   *  ref as written (a `consumes` contract ref, or a legacy manifest `from`). */
  from: string;
  /** Qualified ref of the consuming reaction (resolved), else the legacy manifest `to` as written. */
  to: string;
  fromSlice: string | null;
  toSlice: string | null;
  /** Legacy 1.0 manifest seams only — `null` for a `consumes` binding. */
  description: string | null;
  status: "verified" | "error";
  /** Codes of every diagnostic raised on this binding (errors and warnings), in raise order. */
  diagnostics: string[];
}

export interface ContextMap {
  nodes: { key: string; name: string | null; owner: string[] }[];
  /** One edge per ordered (producer, consumer) model pair with at least one binding (verified or
   *  not), sorted by (from, to); `seams` counts the bindings. */
  edges: { from: string; to: string; seams: number }[];
}

export interface SystemReport {
  name: string | null;
  models: SystemModelReport[];
  seams: SystemSeamReport[];
  contextMap: ContextMap;
  /** MIL-239: `checked` = resolved `consumes` bindings whose consumer declares fields (so there
   *  was something to compare); `notAdapted` = how many of them raised `consumer-not-adapted`. */
  consumerAdaptation: { checked: number; notAdapted: number };
  diagnostics: SystemDiagnostic[];
}

/** Caller-supplied, impure inputs `verifySystem` cannot compute itself. */
export interface VerifySystemOptions {
  /** The short sha of the last commit that changed the producer model's source, or `null` when
   *  unknown (no git, no history, export-document source). Named in `consumer-not-adapted`. */
  producerCommit?: (model: SystemModelInput) => string | null;
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
  "consumes-unknown-model",
  "consumes-unknown-element",
  "consumer-not-adapted",
]);

/** The `<kind>.<slug>` tail of an export element ref (`<sliceKey>/<kind>.<slug>`). */
function elementTail(ref: string): string {
  const slash = ref.indexOf("/");
  return slash < 0 ? ref : ref.slice(slash + 1);
}

/** Verify a system: `models` (manifest order, or discovery order) plus, when the system came
 *  from a manifest, that `manifest` and the path manifest-level diagnostics point at. `manifest`
 *  is `null` in discovery mode (R4: no manifest found/given) — there is then no name, no
 *  manifest-key check, and no legacy seams. `preDiagnostics` (e.g. discovery's own
 *  `duplicate-model-key` warnings) lead the report's diagnostics unchanged. */
export function verifySystem(
  manifest: SystemManifest | null,
  models: SystemModelInput[],
  manifestFile: string | null,
  preDiagnostics: SystemDiagnostic[] = [],
  options: VerifySystemOptions = {},
): SystemReport {
  const diagnostics: SystemDiagnostic[] = [...preDiagnostics];
  const raise = (file: string, code: RuleCode, extra: { message: string; line?: number; refs?: string[] }) => {
    const bucket: Diagnostic[] = [];
    pushDiag(bucket, code, extra);
    diagnostics.push({ ...bucket[0], file });
  };
  const qualify = formatQualifiedRef;
  const manifestPath = manifestFile ?? "system.yaml";

  if (manifest && manifest.systemSchemaVersion === LEGACY_SYSTEM_MANIFEST_SCHEMA_VERSION) {
    raise(manifestPath, "system-manifest-outdated", {
      message:
        `systemSchemaVersion "${LEGACY_SYSTEM_MANIFEST_SCHEMA_VERSION}" is outdated — seams now live on the consuming translation ` +
        `(\`consumes <modelKey>:<kind>.<slug>\`) and owners on the model header (\`model "Name" owner "Team"\`); ` +
        `run \`em upgrade <model>.em --apply\` once to migrate this manifest to "${SYSTEM_MANIFEST_SCHEMA_VERSION}"`,
      line: manifest.versionLine,
    });
  }

  // Models are addressed by their MANIFEST key throughout — even on a mismatch, so a binding
  // written against the manifest's own vocabulary still verifies and the one error tells the
  // author exactly which key to change. In discovery mode the key IS the computed one (possibly
  // `~n`-deduped), so there is nothing to mismatch.
  const byKey = new Map<string, SystemModelInput>();
  for (const m of models) {
    byKey.set(m.key, m);
    if (manifest && m.doc.model.key !== m.key) {
      const entry = manifest.models.find((e) => e.key === m.key);
      const modelLabel = m.doc.model.name === null ? "(unnamed model)" : `model "${m.doc.model.name}"`;
      raise(manifestPath, "system-model-key-mismatch", {
        message:
          `manifest key "${m.key}" does not match the computed key "${m.doc.model.key}" of ${modelLabel} ` +
          `(${m.source}) — rename the manifest entry to "${m.doc.model.key}"`,
        line: entry?.line,
      });
    }
  }
  const modelKeyList = () => models.map((m) => m.key).join(", ");

  const isReaction = (el: SystemExportElement) => AUTOMATION_KINDS.has(el.kind);
  const isSurface = (el: SystemExportElement) => el.public === true && (el.kind === "event" || el.kind === "view");

  const findElement = (model: SystemModelInput, ref: string): { slice: SystemExportSlice; element: SystemExportElement } | undefined => {
    for (const slice of model.doc.model.slices) {
      for (const element of slice.elements) if (element.ref === ref) return { slice, element };
    }
    return undefined;
  };

  const consumedSurface = new Set<string>(); // qualified refs of resolved producers
  const boundReactions = new Set<string>(); // qualified refs of claimed consumers
  const declaredPairs = new Map<string, Set<string>>(); // fromQualified -> set of toQualified
  const seenPairs = new Map<string, "consumes" | "manifest">();
  const seamsByModelPair = new Map<string, number>();
  const seams: SystemSeamReport[] = [];
  const adaptation = { checked: 0, notAdapted: 0 };

  const record = (
    origin: "consumes" | "manifest",
    from: ResolvedEndpoint | undefined,
    to: ResolvedEndpoint | undefined,
    fromQualified: string,
    toQualified: string,
    fromModelKey: string | undefined,
    toModelKey: string | undefined,
    duplicate: (previous: "consumes" | "manifest") => void,
  ) => {
    // Duplicate: same resolved (from, to) pair bound twice (a legacy bare-slice `to` and its
    // element-level spelling, a ref repeated in `consumes`, or a 1.0 seam a `consumes` clause
    // already declares). Warned on the second occurrence.
    const pairKey = `${fromQualified} -> ${toQualified}`;
    const previous = seenPairs.get(pairKey);
    if (previous) duplicate(previous);
    else seenPairs.set(pairKey, origin);
    // A half-resolved binding still claims the endpoint it did resolve, so a typo on one side
    // doesn't ALSO report the other side as dangling/unbound on top of the resolution error.
    if (from) consumedSurface.add(fromQualified);
    if (to) boundReactions.add(toQualified);
    if (from && to) {
      if (!declaredPairs.has(fromQualified)) declaredPairs.set(fromQualified, new Set());
      declaredPairs.get(fromQualified)!.add(toQualified);
    }
    if (fromModelKey && toModelKey) {
      const k = `${fromModelKey} ${toModelKey}`;
      seamsByModelPair.set(k, (seamsByModelPair.get(k) ?? 0) + 1);
    }
  };

  // ---- `consumes` bindings (MIL-235): every ref on every translation, model order. ----
  for (const m of models) {
    for (const slice of m.doc.model.slices) {
      for (const el of slice.elements) {
        const refs = el.consumes ?? [];
        if (refs.length === 0) continue;
        const toQualified = qualify(m.key, el.ref);
        const to: ResolvedEndpoint = { modelKey: m.key, model: m, slice, element: el };
        for (const raw of refs) {
          const codes: string[] = [];
          const consumer = `${el.kind} "${el.name}" (${toQualified})`;
          const bindRaise = (code: RuleCode, message: string, refs: string[] = [toQualified, raw]) => {
            codes.push(code);
            raise(m.file, code, { message, line: el.line, refs });
          };
          let from: ResolvedEndpoint | undefined;
          const parsed = parseContractRef(raw);
          const producer = parsed ? byKey.get(parsed.modelKey) : undefined;
          if (!parsed) {
            bindRaise(
              "consumes-unknown-element",
              `${consumer} consumes "${raw}", which is not a <modelKey>:<kind>.<slug> contract ref (kind event or view)`,
            );
          } else if (!producer) {
            bindRaise(
              "consumes-unknown-model",
              `${consumer} consumes "${raw}", but this system has no model "${parsed.modelKey}" — models are: ${modelKeyList()}`,
            );
          } else {
            const tail = `${parsed.kind}.${parsed.slug}`;
            let hit: { slice: SystemExportSlice; element: SystemExportElement } | undefined;
            let unpublished: { slice: SystemExportSlice; element: SystemExportElement } | undefined;
            for (const ps of producer.doc.model.slices) {
              for (const pe of ps.elements) {
                if (pe.kind !== parsed.kind || elementTail(pe.ref) !== tail) continue;
                if (pe.public === true) hit ??= { slice: ps, element: pe };
                else unpublished ??= { slice: ps, element: pe };
              }
            }
            if (hit) {
              from = { modelKey: producer.key, model: producer, ...hit };
            } else if (unpublished) {
              bindRaise(
                "consumes-unknown-element",
                `${consumer} consumes "${raw}", but ${parsed.kind} "${unpublished.element.name}" ` +
                  `(${qualify(producer.key, unpublished.element.ref)}) is not marked \`public\` in model "${producer.key}"`,
              );
            } else {
              bindRaise(
                "consumes-unknown-element",
                `${consumer} consumes "${raw}", but model "${producer.key}" has no public ${parsed.kind} "${parsed.slug}"`,
              );
            }
          }
          const fromQualified = from ? qualify(from.modelKey, from.element.ref) : raw;
          record("consumes", from, to, fromQualified, toQualified, producer?.key, m.key, () => {
            codes.push("seam-duplicate");
            raise(m.file, "seam-duplicate", {
              message: `${consumer} binds "${raw}" more than once — remove the repeated \`consumes\` ref`,
              line: el.line,
              refs: [toQualified, raw],
            });
          });
          // MIL-239: the consumer's declared fields against the producer's public element now.
          const consumerFields = el.fields ?? [];
          if (from && consumerFields.length > 0) {
            adaptation.checked++;
            const problems = compareConsumerFields(consumerFields, from.element.fields ?? []);
            if (problems.length > 0) {
              adaptation.notAdapted++;
              bindRaise(
                "consumer-not-adapted",
                adaptationMessage(
                  consumer,
                  `${from.element.kind} "${from.element.name}" (${fromQualified})`,
                  problems,
                  options.producerCommit?.(from.model) ?? null,
                ),
                [toQualified, fromQualified],
              );
            }
          }
          seams.push({
            from: fromQualified,
            to: toQualified,
            fromSlice: from ? qualify(from.modelKey, from.slice.key) : null,
            toSlice: qualify(m.key, slice.key),
            description: null,
            status: codes.some((c) => SEAM_ERROR_CODES.has(c)) ? "error" : "verified",
            diagnostics: codes,
          });
        }
      }
    }
  }

  // ---- Legacy 1.0 manifest seams: resolve both endpoints, then check what each one is. ----
  (manifest?.seams ?? []).forEach((seam, i) => {
    const codes: string[] = [];
    const seamRaise = (code: RuleCode, message: string, refs?: string[]) => {
      codes.push(code);
      raise(manifestPath, code, { message: `seams[${i}] (${seam.from} -> ${seam.to}): ${message}`, line: seam.line, refs });
    };

    const resolveModel = (raw: string, side: "from" | "to"): { modelKey: string; ref: string; model: SystemModelInput } | undefined => {
      const parsed = parseQualifiedRef(raw);
      if (parsed.modelKey === null) {
        seamRaise("system-manifest-invalid", `\`${side}\` must be a model-qualified ref (<modelKey>:<sliceKey>/<kind>.<slug>), got "${raw}"`);
        return undefined;
      }
      const model = byKey.get(parsed.modelKey);
      if (!model) {
        seamRaise("system-manifest-invalid", `\`${side}\` names unknown model key "${parsed.modelKey}" — declared models are: ${modelKeyList()}`);
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
        const slice = toModel.model.doc.model.slices.find((sl) => sl.key === toModel.ref);
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
    record("manifest", from, to, fromQualified, toQualified, fromModel?.modelKey, toModel?.modelKey, (previous) =>
      seamRaise("seam-duplicate", previous === "manifest" ? "already declared earlier in the manifest" : "already declared by a `consumes` clause"),
    );
    seams.push({
      from: fromQualified,
      to: toQualified,
      fromSlice: from ? qualify(from.modelKey, from.slice.key) : null,
      toSlice: to ? qualify(to.modelKey, to.slice.key) : null,
      description: seam.description,
      status: codes.some((c) => SEAM_ERROR_CODES.has(c)) ? "error" : "verified",
      diagnostics: codes,
    });
  });

  // ---- Per-model surface + the two "other end missing" checks, model order. ----
  const modelReports: SystemModelReport[] = models.map((m) => {
    const publicSurface: string[] = [];
    for (const slice of m.doc.model.slices) {
      for (const el of slice.elements) {
        if (!isSurface(el)) continue;
        publicSurface.push(el.ref);
        const q = qualify(m.key, el.ref);
        if (!consumedSurface.has(q)) {
          raise(m.file, "dangling-public-event", {
            message:
              `public ${el.kind} "${el.name}" (${q}) is consumed by nothing in this system — add ` +
              `\`consumes ${formatContractRef(m.key, el.kind as "event" | "view", elementTail(el.ref).slice(el.kind.length + 1))}\` ` +
              "to the translation that reads it, or drop `public`",
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
  // is fed from outside its model by construction. With no binding claiming it, nobody in the
  // system says what feeds it.
  for (const m of models) {
    const fedInside = new Set(m.doc.model.edges.map((e) => e.to));
    for (const slice of m.doc.model.slices) {
      for (const el of slice.elements) {
        if (!isReaction(el) || fedInside.has(el.ref)) continue;
        const q = qualify(m.key, el.ref);
        if (boundReactions.has(q)) continue;
        raise(m.file, "unbound-translation", {
          message:
            el.kind === "translation"
              ? `translation "${el.name}" (${q}) has no in-model source and consumes nothing — add \`consumes <modelKey>:<kind>.<slug>\` naming the public event/view that feeds it, or add a \`from\``
              : `${el.kind} "${el.name}" (${q}) has no in-model source and nothing binds it — add a \`from\` (only a translation can \`consumes\` another model's public surface)`,
          line: el.line,
          refs: [q],
        });
      }
    }
  }

  // The old portal heuristic, demoted: a public element in model A sharing its normalized
  // name with a reaction or event in model B (B != A), with no binding between them.
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
                  "but no `consumes` binds them — add the `consumes` ref to the consuming translation, or rename",
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

  return { name: manifest?.name ?? null, models: modelReports, seams, contextMap, consumerAdaptation: adaptation, diagnostics };
}
