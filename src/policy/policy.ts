// SPDX-License-Identifier: MIT
// GH #493: `em-policy.yaml` -- process policy declared once per project instead of passed as flags
// on every run. Discovered like the ratifier roster: the nearest `em-policy.yaml` walking up from
// the model's directory to the repo root. File absent = today's behaviour for every key.
//
//   policySchemaVersion: "1.0"
//   merge: squash | rebase | merge-commit          # squash/rebase = hash only (`ratify --no-ref`)
//   review: session | pull-request                 # pull-request = `ratify` on a draft records the review (GH #494)
//   ratification:
//     inline: internal | never | always            # parsed + reported; behaviour lands with #496
//     inline-violation: advisory | error
//   amendment:
//     prose-sections: [Intent, ...]                # overrides DEFAULT_PROSE_HEADINGS
//   ratifiers: [...]                               # the roster lists, same shape as ratifiers.yaml
//   reviewers: [...]
//
// Every key is optional. Unknown keys or invalid values are `policy-invalid` errors naming the key
// and the allowed values. `effectivePolicy` is the one reader other commands call: explicit
// defaults, and per key where the value came from (a file path, or "default").

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { LineCounter, parseDocument, isMap, isSeq, isScalar, Node, Pair, YAMLMap } from "yaml";
import type { Diagnostic } from "../model/validate.js";
import { pushDiag } from "../model/rules.js";
import { DEFAULT_PROSE_HEADINGS } from "../catalog/sectionSignature.js";
import {
  findFileAbove,
  loadRoster,
  POLICY_FILE,
  readRosterList,
  type ParseRosterResult,
  type RosterEntry,
} from "../roster/roster.js";

export const POLICY_SCHEMA_VERSION = "1.0";

export const MERGE_STRATEGIES = ["squash", "rebase", "merge-commit"] as const;
export const REVIEW_MODES = ["session", "pull-request"] as const;
export const INLINE_TIERS = ["internal", "never", "always"] as const;
export const INLINE_VIOLATIONS = ["advisory", "error"] as const;

export type MergeStrategy = (typeof MERGE_STRATEGIES)[number];
export type ReviewMode = (typeof REVIEW_MODES)[number];
export type InlineTier = (typeof INLINE_TIERS)[number];
export type InlineViolation = (typeof INLINE_VIOLATIONS)[number];

/** What one policy file declares; `null` = key not present. */
export interface PolicyFile {
  merge: MergeStrategy | null;
  review: ReviewMode | null;
  inline: InlineTier | null;
  inlineViolation: InlineViolation | null;
  proseSections: string[] | null;
  ratifiers: RosterEntry[] | null;
  reviewers: RosterEntry[] | null;
}

export type ParsePolicyResult = { ok: true; policy: PolicyFile } | { ok: false; diagnostics: Diagnostic[] };

const TOP_KEYS = ["policySchemaVersion", "merge", "review", "ratification", "amendment", "ratifiers", "reviewers"];
const RATIFICATION_KEYS = ["inline", "inline-violation"];
const AMENDMENT_KEYS = ["prose-sections"];

function scalarString(node: unknown): string | undefined {
  return isScalar(node) && typeof node.value === "string" ? node.value : undefined;
}

/** Parse and shape-check policy text. Every problem is a `policy-invalid` error (never a throw). */
export function parsePolicy(text: string): ParsePolicyResult {
  const diagnostics: Diagnostic[] = [];
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, prettyErrors: false });
  const lineOf = (n: Node | Pair | null | undefined): number | undefined => {
    const range = n && "range" in n ? n.range : n && "key" in n ? (n.key as Node | null)?.range : undefined;
    return range ? lc.linePos(range[0]).line : undefined;
  };
  const invalid = (message: string, line?: number) => pushDiag(diagnostics, "policy-invalid", { message, line });

  if (doc.errors.length > 0) {
    for (const e of doc.errors) invalid(`YAML parse error: ${e.message.trim()}`, e.linePos?.[0]?.line);
    return { ok: false, diagnostics };
  }
  const root = doc.contents;
  if (!isMap(root)) {
    invalid("em-policy.yaml must be a YAML mapping starting with `policySchemaVersion`");
    return { ok: false, diagnostics };
  }
  const versionNode = root.get("policySchemaVersion", true) as Node | undefined;
  const version = scalarString(versionNode);
  if (version === undefined) {
    invalid(`missing or non-string \`policySchemaVersion\` -- set \`policySchemaVersion: "${POLICY_SCHEMA_VERSION}"\``, lineOf(versionNode));
  } else if (version !== POLICY_SCHEMA_VERSION) {
    invalid(`unsupported policySchemaVersion "${version}" -- this em accepts "${POLICY_SCHEMA_VERSION}"`, lineOf(versionNode));
  }
  const unknownKeys = (map: YAMLMap, allowed: readonly string[], where: string) => {
    for (const pair of map.items) {
      const key = scalarString(pair.key);
      if (key === undefined || !allowed.includes(key)) {
        invalid(`${where}unknown key ${JSON.stringify(key ?? "?")} -- allowed: ${allowed.join(", ")}`, lineOf(pair));
      }
    }
  };
  unknownKeys(root, TOP_KEYS, "");

  const enumValue = <T extends string>(map: YAMLMap, key: string, allowed: readonly T[], label: string): T | null => {
    const node = map.get(key, true) as Node | undefined;
    if (node === undefined) return null;
    const v = scalarString(node);
    if (v === undefined || !allowed.includes(v as T)) {
      invalid(`\`${label}\` must be one of: ${allowed.join(" | ")}`, lineOf(node));
      return null;
    }
    return v as T;
  };
  const subMap = (key: string, allowed: readonly string[]): YAMLMap | null => {
    const node = root.get(key, true) as Node | undefined;
    if (node === undefined) return null;
    if (!isMap(node)) {
      invalid(`\`${key}\` must be a mapping with: ${allowed.join(", ")}`, lineOf(node));
      return null;
    }
    unknownKeys(node, allowed, `${key}: `);
    return node;
  };

  const merge = enumValue(root, "merge", MERGE_STRATEGIES, "merge");
  const review = enumValue(root, "review", REVIEW_MODES, "review");
  const ratification = subMap("ratification", RATIFICATION_KEYS);
  const inline = ratification ? enumValue(ratification, "inline", INLINE_TIERS, "ratification.inline") : null;
  const inlineViolation = ratification ? enumValue(ratification, "inline-violation", INLINE_VIOLATIONS, "ratification.inline-violation") : null;

  let proseSections: string[] | null = null;
  const amendment = subMap("amendment", AMENDMENT_KEYS);
  const proseNode = amendment?.get("prose-sections", true) as Node | undefined;
  if (proseNode !== undefined) {
    const items = isSeq(proseNode) ? proseNode.items.map((i) => scalarString(i)) : [];
    if (!isSeq(proseNode) || items.length === 0 || items.some((i) => i === undefined || i.trim() === "")) {
      invalid("`amendment.prose-sections` must be a non-empty list of section headings (omit the key for em's default list)", lineOf(proseNode));
    } else {
      proseSections = (items as string[]).map((i) => i.trim());
    }
  }

  const ratifiers = readRosterList(root, "ratifiers", invalid, lineOf);
  const reviewers = readRosterList(root, "reviewers", invalid, lineOf);
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, policy: { merge, review, inline, inlineViolation, proseSections, ratifiers, reviewers } };
}

/** The roster half of a policy file, for `loadRoster` (`ratifiers:` / `reviewers:`; absent = unrestricted). */
export function rosterOfPolicyText(text: string): ParseRosterResult {
  const parsed = parsePolicy(text);
  if (!parsed.ok) return parsed;
  const { ratifiers, reviewers } = parsed.policy;
  return { ok: true, roster: { rosterSchemaVersion: "1.0", ratifiers, reviewers } };
}

/** The nearest `em-policy.yaml` walking up from `baseDir` (same rule as the roster), or null. */
export function findPolicyAbove(baseDir: string): string | null {
  return findFileAbove(baseDir, [POLICY_FILE]);
}

export interface Sourced<T> {
  value: T;
  /** The policy file the value came from, or "default". */
  source: string;
}

export interface EffectivePolicy {
  policySchemaVersion: string;
  /** The `em-policy.yaml` read, or null. */
  file: string | null;
  merge: Sourced<MergeStrategy>;
  review: Sourced<ReviewMode>;
  ratification: { inline: Sourced<InlineTier>; inlineViolation: Sourced<InlineViolation> };
  amendment: { proseSections: Sourced<string[]> };
  /** `null` value = no roster list, so ratification is not restricted. */
  ratifiers: Sourced<RosterEntry[] | null>;
  reviewers: Sourced<RosterEntry[] | null>;
}

export type EffectivePolicyResult =
  | { ok: true; policy: EffectivePolicy }
  | { ok: false; path: string; diagnostics: Diagnostic[] };

/** The effective policy for a model in `baseDir`: file values over explicit defaults, each with its
 *  source. The roster lists come from `em-policy.yaml`, else from a legacy `ratifiers.yaml`. An
 *  invalid file is `ok: false` -- callers that write refuse (`policy-invalid`), never fall back. */
export function effectivePolicy(baseDir: string): EffectivePolicyResult {
  const file = findPolicyAbove(baseDir);
  let declared: PolicyFile | null = null;
  if (file !== null) {
    const parsed = parsePolicy(readFileSync(file, "utf8"));
    if (!parsed.ok) return { ok: false, path: file, diagnostics: parsed.diagnostics };
    declared = parsed.policy;
  }
  const pick = <T>(v: T | null | undefined, def: T): Sourced<T> =>
    v !== null && v !== undefined && file !== null ? { value: v, source: file } : { value: def, source: "default" };
  const roster = loadRoster(baseDir);
  // A broken legacy ratifiers.yaml is the roster's own refusal (`roster-invalid`), not a policy error.
  if (roster.state === "invalid" && basename(roster.path) === POLICY_FILE) return { ok: false, path: roster.path, diagnostics: roster.diagnostics };
  const fromRoster = (role: "ratifiers" | "reviewers"): Sourced<RosterEntry[] | null> => {
    if (roster.state === "invalid") return { value: null, source: roster.path };
    if (roster.state !== "present") return { value: null, source: "default" };
    const list = roster.roster[role];
    return list !== null ? { value: list, source: roster.path } : { value: null, source: "default" };
  };
  return {
    ok: true,
    policy: {
      policySchemaVersion: POLICY_SCHEMA_VERSION,
      file,
      merge: pick(declared?.merge, "merge-commit"),
      review: pick(declared?.review, "session"),
      ratification: {
        inline: pick(declared?.inline, "internal"),
        inlineViolation: pick(declared?.inlineViolation, "advisory"),
      },
      amendment: { proseSections: pick(declared?.proseSections, [...DEFAULT_PROSE_HEADINGS]) },
      ratifiers: fromRoster("ratifiers"),
      reviewers: fromRoster("reviewers"),
    },
  };
}

/** The refusal text for an invalid policy on a write path. */
export function policyRefusal(res: Extract<EffectivePolicyResult, { ok: false }>): string {
  return `policy-invalid: ${res.path} -- ${res.diagnostics.map((d) => d.message).join("; ")}`;
}

/** One model's row in `em status` (text and `--json`): the effective policy, each key with where
 *  it came from; the roster lists as counts (`null` = no list, unrestricted). An invalid file is
 *  reported (`invalid` holds the messages) rather than thrown -- status is read-only. */
export interface StatusPolicyEntry {
  /** The model file as given to `em status`. */
  file: string;
  /** The `em-policy.yaml` read, or null. */
  policyFile: string | null;
  invalid: string[] | null;
  merge: Sourced<MergeStrategy>;
  review: Sourced<ReviewMode>;
  ratificationInline: Sourced<InlineTier>;
  ratificationInlineViolation: Sourced<InlineViolation>;
  amendmentProseSections: Sourced<string[]>;
  ratifiers: Sourced<number | null>;
  reviewers: Sourced<number | null>;
}

export function statusPolicyEntry(file: string, baseDir: string): StatusPolicyEntry {
  const res = effectivePolicy(baseDir);
  if (!res.ok) {
    const def = <T>(value: T): Sourced<T> => ({ value, source: "default" });
    return {
      file,
      policyFile: res.path,
      invalid: res.diagnostics.map((d) => d.message),
      merge: def("merge-commit"),
      review: def("session"),
      ratificationInline: def("internal"),
      ratificationInlineViolation: def("advisory"),
      amendmentProseSections: def([...DEFAULT_PROSE_HEADINGS]),
      ratifiers: def(null),
      reviewers: def(null),
    };
  }
  const p = res.policy;
  const count = (s: Sourced<RosterEntry[] | null>): Sourced<number | null> => ({ value: s.value === null ? null : s.value.length, source: s.source });
  return {
    file,
    policyFile: p.file,
    invalid: null,
    merge: p.merge,
    review: p.review,
    ratificationInline: p.ratification.inline,
    ratificationInlineViolation: p.ratification.inlineViolation,
    amendmentProseSections: p.amendment.proseSections,
    ratifiers: count(p.ratifiers),
    reviewers: count(p.reviewers),
  };
}
