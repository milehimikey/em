// SPDX-License-Identifier: MIT
// `em slice amend` (GH #488): re-sign a PROSE-ONLY change to a signed slice doc in place. The
// 1.15.0 rule "a new version takes both gates" is relaxed for confined changes (slate #499 R1):
// confined = every changed authored section is class prose (catalog/sectionSignature.ts, GH #487)
// and the public surface is untouched. Anything else still takes `em slice revise`, review and
// ratify.
//
// Legal on `status: ready-to-implement` (with a recorded sign-off) or `status: implemented`, with
// a `ratifiedHash:` the body no longer matches. A body that still matches is a no-op. `draft` /
// `reviewed` docs are refused — nothing is signed, just edit the doc.
//
// What an amendment writes (surgical single-line edits, ratify's discipline): `ratifiedHash:` and
// `ratifiedSections:` re-stamped to the current body; `amendedBy:`/`amendedOn:` recorded right
// after `ratifiedSections:` (the latest amendment wins — an earlier pair is replaced; the git
// history of the doc is the audit trail, so there is deliberately no `amendments:` counter, which
// would be a second source of truth that merges can corrupt); `ratifiedRef:` follows ratify's rule
// (HEAD inside git, refusing an uncommitted doc; hash only with --no-ref or outside git, a stale
// `ratifiedRef:` dropped). Everything else — `version:`, `status:`, `ratifiedBy`/`ratifiedOn`,
// `reviewedBy`/`reviewedOn`, the meaning confirmation, `implementedIn:`, the `shipped*` and
// `conformed*` keys, and the body — is copied through verbatim.
//
// Public surface: it lives in the MODEL and the contract generated from it (`em api generate`),
// never in an authored prose section (a field table is a generated region, outside the hash), so a
// prose-only doc change cannot move it. What CAN be wrong is a slice whose committed contract is
// already stale: the same `contractStatus` check `--slice-ready` runs refuses the amendment then,
// so it never papers over a gate that readiness would fail anyway.
//
// A shipped doc whose shipped record is still read from `ratifiedRef:` (`status: implemented`, no
// `shippedVersion:` — shipped before 1.15) keeps `ratifiedRef:` untouched, or the record would move.

import { readFileSync, writeFileSync } from "node:fs";
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { continuationOf } from "../model/continuation.js";
import { resolveSliceDocJoin } from "../catalog/docJoin.js";
import { ratifiedHashScope, splitFrontmatter } from "../catalog/sliceDoc.js";
import { classifySections, proseHeadingsFor } from "../catalog/sectionSignature.js";
import { ContractCheckInput, contractStatus, isPublicTouchingSlice } from "../catalog/apiFirst.js";
import { docAbsPath } from "../catalog/docLocate.js";
import { GitRunner, realGit } from "./diff-inputs.js";
import { fieldLineWithEolRegex, insertLineAfterField, replaceFieldValue } from "./frontmatterSurgery.js";
import { RatifiedIdentity, resolveRatifiedIdentity } from "./ratify.js";
import { isValidDateString } from "./stateFile.js";

/** The frontmatter keys an amendment records — cleared by `em slice revise` with the sign-off. */
export const AMEND_KEYS = ["amendedBy", "amendedOn"] as const;

export type ApplyAmendResult =
  | { ok: true; content: string; changed: boolean; changedProse: string[] }
  | { ok: false; message: string };

/** What `applyAmendFrontmatter` needs beyond the doc text. */
export interface AmendInputs {
  sliceKey: string;
  by: string;
  on: string;
  proseHeadings?: readonly string[];
  /** Resolves the identity to record; called only once every refusal has passed (it may use git). */
  identity: (raw: string) => { ok: true; identity: RatifiedIdentity } | { ok: false; message: string };
}

function field(raw: string, key: string): string | null {
  const v = splitFrontmatter(raw).fields.get(key.toLowerCase());
  return v === undefined || v.trim() === "" ? null : v.trim();
}

/** True when the doc is shipped with the shipped record read from `ratifiedRef:` (see header). */
function shipRecordReadsRatifiedRef(raw: string): boolean {
  return field(raw, "status")?.toLowerCase() === "implemented" && field(raw, "shippedVersion") === null;
}

/**
 * Pure transition: the amended text of `raw`, a no-op (`changed: false`, content identical) when
 * the body still matches `ratifiedHash`, or a refusal. See the module header for the rules.
 */
export function applyAmendFrontmatter(raw: string, inputs: AmendInputs): ApplyAmendResult {
  const { sliceKey } = inputs;
  const by = inputs.by.trim();
  if (!by) return { ok: false, message: "an amender name is required (--by)" };
  if (/[\x00-\x1f\x7f]/.test(by)) return { ok: false, message: "amender name must not contain control characters" };
  if (!isValidDateString(inputs.on)) return { ok: false, message: `invalid date "${inputs.on}" — expected YYYY-MM-DD` };

  const status = field(raw, "status")?.toLowerCase() ?? null;
  if (status !== "ready-to-implement" && status !== "implemented") {
    return {
      ok: false,
      message:
        `slice "${sliceKey}" is \`status: ${status ?? "(empty)"}\` — nothing is signed yet, so there is nothing to amend: ` +
        "just edit the doc, then review and ratify it",
    };
  }
  const recordedHash = field(raw, "ratifiedHash");
  if (field(raw, "ratifiedBy") === null || recordedHash === null) {
    return {
      ok: false,
      message:
        `slice "${sliceKey}" records no sign-off with a \`ratifiedHash:\` — there is no signed body to amend; ` +
        "sign it with `em slice ratify --by` (or `em slice revise` first when it shipped)",
    };
  }

  if (ratifiedHashScope(raw, recordedHash) !== "mismatch") {
    return { ok: true, content: raw, changed: false, changedProse: [] }; // body still matches the sign-off
  }

  const sections = classifySections(raw, inputs.proseHeadings);
  if (sections.some((s) => s.changed === null)) {
    return {
      ok: false,
      message:
        `slice "${sliceKey}" records no section hashes (\`ratifiedSections:\`) — it was signed before per-section ` +
        "signatures, so em cannot tell which sections changed; run `em upgrade` while the body still matches " +
        "ratifiedHash (revert the edit first), or re-sign it with `em slice revise` and `em slice ratify`",
    };
  }
  const behaviour = sections.filter((s) => s.changed === true && s.class === "behaviour").map((s) => s.heading);
  if (behaviour.length > 0) {
    const route =
      status === "implemented"
        ? "`em slice revise` opens the next version, which takes review and ratification"
        : "`em slice revise` (with `--withdraw` for a slice that never shipped) reopens it for review and ratification";
    return {
      ok: false,
      message:
        `slice "${sliceKey}": behaviour section(s) changed since sign-off — ${behaviour.map((h) => `"${h}"`).join(", ")}. ` +
        `Only prose sections can be amended in place; ${route}`,
    };
  }
  const changedProse = sections.filter((s) => s.changed === true).map((s) => s.heading);

  const id = inputs.identity(raw);
  if (!id.ok) return id;
  const { identity } = id;
  const keepRef = shipRecordReadsRatifiedRef(raw);

  let out = raw;
  for (const key of AMEND_KEYS) {
    const re = fieldLineWithEolRegex(key);
    while (re.test(out)) out = out.replace(re, ""); // the latest amendment wins
  }
  const set = (key: string, value: string): boolean => {
    const next = replaceFieldValue(out, key, value);
    if (next === null) return false;
    out = next;
    return true;
  };
  if (!set("ratifiedHash", identity.hash)) return { ok: false, message: "no `ratifiedHash:` line to re-stamp" };
  const sectionsText = identity.sections ?? null;
  if (sectionsText !== null && !set("ratifiedSections", sectionsText)) {
    return { ok: false, message: "no `ratifiedSections:` line to re-stamp" };
  }
  if (!keepRef) {
    if (identity.ref === null) {
      out = out.replace(fieldLineWithEolRegex("ratifiedRef"), ""); // a stale pointer is what --no-ref declines
    } else if (!set("ratifiedRef", identity.ref)) {
      const line = `ratifiedRef: ${identity.ref}`;
      const after = insertLineAfterField(out, "ratifiedOn", line) ?? insertLineAfterField(out, "ratifiedBy", line);
      if (after === null) return { ok: false, message: "no `ratifiedBy:` line to anchor `ratifiedRef:` to" };
      out = after;
    }
  }
  // amendedBy/amendedOn directly after `ratifiedSections:` (present: classification above returns
  // `changed: null` for a doc without it).
  const withBy = insertLineAfterField(out, "ratifiedSections", `amendedBy: ${by}`);
  if (withBy === null) return { ok: false, message: "no `ratifiedSections:` line to anchor `amendedBy:` to" };
  const withOn = insertLineAfterField(withBy, "amendedBy", `amendedOn: ${inputs.on}`);
  if (withOn === null) return { ok: false, message: "could not record `amendedOn:`" };
  return { ok: true, content: withOn, changed: true, changedProse };
}

export type RunAmendResult =
  | { ok: true; path: string; changed: boolean; changedProse: string[] }
  | { ok: false; message: string };

/**
 * Resolves `sliceKey` to its bound doc (the join `runRatify` uses), refuses a public-touching
 * slice whose contract is stale, then reads/applies/writes the doc. `contract` is the
 * `--slice-ready` input (model path, source, compile diagnostics); null skips the contract check
 * (function-level tests of the doc rules).
 */
export function runAmend(
  model: NormalizedModel,
  refs: RefsResult,
  baseDir: string,
  sliceKey: string,
  by: string,
  on: string,
  contract: ContractCheckInput | null,
  git: GitRunner | null = realGit,
  noRef = false,
): RunAmendResult {
  const sliceIndex = refs.sliceKeys.indexOf(sliceKey);
  if (sliceIndex === -1) return { ok: false, message: `no slice with export key "${sliceKey}" in this model` };
  const slice = model.slices[sliceIndex];
  const { doc, continuationOf: continuationOfKey } = resolveSliceDocJoin(model, refs, slice, sliceKey, baseDir, (id) => refs.refById.get(id)!);

  if (continuationOfKey) {
    const continuation = continuationOf(model, refs, sliceIndex)!;
    const viewName = model.byId.get(continuation.viewLogicalId)!.name;
    return {
      ok: false,
      message:
        `"${sliceKey}" is a continuation of "${continuationOfKey}" (view "${viewName}" again) — ` +
        `it has no doc of its own; amend "${continuationOfKey}" instead`,
    };
  }
  if (doc.reason === "no-doc-bound") {
    return { ok: false, message: `slice "${sliceKey}" has no doc bound via \`note "slices/${sliceKey}.md"\` — nothing to amend` };
  }
  if (doc.reason === "binding-missing-file") {
    return { ok: false, message: `slice "${sliceKey}" notes "${doc.path}" but no such file exists` };
  }
  if (doc.reason === "frontmatter-invalid") {
    return { ok: false, message: `slice doc "${doc.path}" has missing or invalid frontmatter — run \`em validate\` for details` };
  }

  const absPath = docAbsPath(baseDir, doc.path);
  const raw = readFileSync(absPath, "utf8");
  // A shipped doc whose record reads `ratifiedRef:` records no ref, so git is not consulted for it.
  const gitForIdentity = shipRecordReadsRatifiedRef(raw) ? null : git;
  const applied = applyAmendFrontmatter(raw, {
    sliceKey,
    by,
    on,
    proseHeadings: proseHeadingsFor(baseDir),
    identity: (text) => resolveRatifiedIdentity(gitForIdentity, baseDir, doc.path, text, { noRef }),
  });
  if (!applied.ok) return { ok: false, message: `${doc.path}: ${applied.message}` };

  // Public surface: a prose-only change cannot move it (module header), but a stale contract on a
  // public-touching slice is a gate `--slice-ready` would fail — refuse rather than re-sign over it.
  if (applied.changed && contract !== null && isPublicTouchingSlice(model, refs, sliceKey)) {
    const { state, contractPath } = contractStatus(model, refs, contract);
    if (state !== "current") {
      return {
        ok: false,
        message:
          `slice "${sliceKey}" touches the public surface and its contract ${contractPath} is ${state} — ` +
          `run \`em api generate ${contract.file}\` and commit it first; an amendment never re-signs over a stale contract`,
      };
    }
  }
  if (applied.changed) writeFileSync(absPath, applied.content, "utf8");
  return { ok: true, path: doc.path, changed: applied.changed, changedProse: applied.changedProse };
}
