# Slice-doc frontmatter schema

This documents the machine-read YAML frontmatter dialect `src/catalog/sliceDoc.ts` parses out
of `slices/<slice-key>.md` — the contract `em export`'s slice-frontmatter join reads. It covers
the **frontmatter block only**. Body/prose authoring conventions (Intent, Scenarios, the
`Delta:` line, Open Questions, …) live in the event-modeling skill's
[`templates/slice.md`](../.claude/skills/event-modeling/templates/slice.md), not here — with one
exception: the `## Open Questions` section's GFM checkboxes (`- [ ]` / `- [x]`) *are* now
machine-parsed by `sliceDoc.ts` too (`openQuestionsTotal`/`openQuestionsUnchecked`, MIL-87),
feeding `em validate --slice-ready <key>` (see [validation.md#slice-readiness](validation.md#slice-readiness)).
Everything else about that section's authoring — what a good open question looks like, when to
resolve one — stays owned by the skill template; this doc only covers the counting mechanics.

## How the parser reads frontmatter

A leading `---` / `---` fence, at the literal start of the file (like Jekyll/Hugo — a guidance
comment above the fence means the frontmatter doesn't count yet). Inside the fence: top-level
scalar `key: value` lines only — **no lists, no nesting, no real YAML**. Quoted values have
their outer quotes stripped; a value that's empty after trimming is dropped. Keys are matched
case-sensitively as `[A-Za-z][\w-]*` but folded to lowercase for lookup. Any line that doesn't
match that shape — including `#`-prefixed comment lines, blank lines, and YAML list
continuation lines (`  - item`) — is silently skipped. An unterminated fence (no closing `---`)
means "no frontmatter at all": the whole file is treated as body.

No `yaml` dependency, by design — a real YAML parser was added and reverted (commit `6de0a05`,
"keep the Two Laws of the Timeline"). This is a deliberately shallow line-scan, and stays that
way: real YAML would also start accepting nesting/lists that this schema explicitly doesn't
define a meaning for.

`SliceDoc` (`src/catalog/sliceDoc.ts`) also exposes `frontmatterPresent` (was a well-formed
fence found and closed at all) and `missingRequiredFields` (which of the required-at-every-
status keys, above, were absent) — the mechanical basis `em export`'s doc join (MIL-91) uses
to decide `frontmatter-invalid` without re-deriving frontmatter-shape rules of its own.

## Canonical keys

| Key | Type | Grammar / enum | Read by |
|---|---|---|---|
| `schemaVersion` | integer | `1` (current dialect version) | not read back by any `em` command today — reserved |
| `pattern` | string | `state-change` \| `state-view` \| `automation` \| `translation` | authored/informational only — `em catalog` and `em export` both derive pattern from the `.em` AST instead (`em export`'s `slice.pattern`, schema `1.4`) |
| `swimlane` | string | free text, `<Persona> → <Context>` | display-only |
| `status` | string, case-insensitive | `draft` \| `reviewed` \| `ready-to-implement` \| `implemented` | `em catalog`, `em render`/`em watch` header coloring; joined into `em export`'s `slice.doc.status` (schema `1.4`); paired with `implementedIn` to compute `slice.doc.driftSignal` (schema `1.5`, MIL-85) and `em validate`'s frontmatter-coherence check (MIL-85 — see [validation.md#frontmatter-coherence](validation.md#frontmatter-coherence)) |
| `version` | integer | positive integer, starts at `1` | joined into `em export`'s `slice.doc.version` (schema `1.4`, MIL-91) |
| `implementedIn` | string | free text (PR/commit link) | joined into `em export`'s `slice.doc.implementedIn` (schema `1.4`, MIL-91); paired with `status` to compute `slice.doc.driftSignal` (schema `1.5`, MIL-85) and `em validate`'s frontmatter-coherence check (MIL-85 — see [validation.md#frontmatter-coherence](validation.md#frontmatter-coherence)) |
| `split-from` | single ref | `<slice-key>@v<N>` | joined into `em export`'s `slice.doc.splitFrom` (schema `1.4`, MIL-91) and `em diff`'s `slice-added` entries (schema `1.6`, MIL-84); current-tree referential checks by `em validate` (MIL-84 — see [validation.md#lineage](validation.md#lineage)) |
| `merged-from` | list of refs | comma-separated `<slice-key>@v<N>, ...` | joined into `em export`'s `slice.doc.mergedFrom` (schema `1.4`, MIL-91) and `em diff`'s `slice-added` entries (schema `1.6`, MIL-84); current-tree referential checks by `em validate` (MIL-84 — see [validation.md#lineage](validation.md#lineage)) |
| `superseded-by` | list of refs | comma-separated `<slice-key>@v<N>, ...` | joined into `em export`'s `slice.doc.supersededBy` (schema `1.4`, MIL-91) and `em diff`'s `slice-removed` entries (schema `1.6`, MIL-84); current-tree referential checks by `em validate` (MIL-84 — see [validation.md#lineage](validation.md#lineage)) |

`status` and `version` also have this document's own required/optional rules below;
`schemaVersion`/`pattern`/`swimlane`/`implementedIn` are unconditionally optional today (the
parser never fails a doc for omitting them, though the template always includes the first four).

## Required vs optional, by `status`

| Key | draft | reviewed | ready-to-implement | implemented |
|---|---|---|---|---|
| `schemaVersion`, `pattern`, `swimlane`, `status` | required | required | required | required |
| `version` | required (starts at `1`) | required | required | required |
| `implementedIn` | optional | optional | optional | required once the slice has *ever* reached `implemented` — may still name a **prior** version's PR during re-ratification, see below |
| `split-from`, `merged-from`, `superseded-by` | optional in every state — present only on docs created by a split/merge, or on a doc that has been retired |

`em export`'s slice-doc join (MIL-91) is the first `em` command to mechanically check the
required row above: a bound doc missing any of `schemaVersion`/`pattern`/`swimlane`/`status`/
`version` (or missing a frontmatter block entirely) reports `slice.doc.reason:
"frontmatter-invalid"` plus a warning diagnostic — report, never fail, same as every other
export finding. `implementedIn`'s conditional requirement (once a slice has *ever* reached
`implemented`) is **not** checked — that needs git history no doc-only parse has access to.
No `em` command fails a build over this table. `em validate`'s frontmatter-coherence check
(MIL-85 — see [validation.md#frontmatter-coherence](validation.md#frontmatter-coherence)) warns
(never fails) on the one combination checkable without git history: `status: implemented` with
no `implementedIn` link at all.

## Lineage: grammar and cardinality

Grammar: `<slice-key>@v<N>` — `<slice-key>` is the referenced slice's kebab-case filename stem
(matches `kebabSlug()`, `src/util/slug.ts`); `<N>` is a positive integer, the referenced
slice's `version` at the point of reference.

| Key | Cardinality | Why |
|---|---|---|
| `split-from` | **single** ref | A slice splits *from* exactly one parent, even though a split can produce multiple successors. |
| `merged-from` | **list**, comma-separated | A merge combines two or more source slices into one surviving doc. |
| `superseded-by` | **list**, comma-separated | The retired side of a split names potentially multiple successors; the retired side of a merge or a simple rename usually names exactly one, but the grammar stays list-shaped either way. |

**Worked example** (a split): `checkout` v4 splits into `checkout` v5 plus a new
`apply-discount` v1. The retired parent doc, `checkout.md`, gets:

```yaml
version: 4
status: implemented
superseded-by: checkout@v5, apply-discount@v1
```

Both surviving docs carry the back-link — `checkout.md` (now at v5) and `apply-discount.md`
each get:

```yaml
split-from: checkout@v4
```

**Scope note:** the parser (`sliceDoc.ts`) itself still never checks that a referenced
slice/version actually *exists* — that stays deliberately out of scope here, by design (fs-free,
pure). A malformed or dangling ref still parses (its `raw` text is preserved, `sliceKey`/
`version` come back `null` for a malformed value); referential checking is a separate, fs-aware
layer.

`em validate` (`src/catalog/lineageValidate.ts`, MIL-84) is that layer. It checks what the
*current tree* can prove wrong and stays silent about what it can't — see
[validation.md#lineage](validation.md#lineage) for exactly what's checked (grammar,
self-reference/cycles, dangling `superseded-by`, impossible version arithmetic) versus what's
deliberately never flagged (a `split-from`/`merged-from` naming a key legitimately absent from
the current tree — the normal state after a real split/merge). Deep historical verification —
did `slice@vN` really, once, exist? — stays out of core validate; the reason that's sufficient
is a same-commit authoring convention, not new plumbing:

> Lineage refs (`split-from:`/`merged-from:`/`superseded-by:`) are written in the same
> ratification commit that performs the operation they record, so the PR diff contains both
> sides of the claim (the predecessor at its final version, and the ref naming it). The review
> airlock is the history check.

## `status` under re-ratification

When a new version is ratified for a slice whose previous version already shipped, `status`
tracks the **current version's** implementation state, not a running "has this ever shipped"
flag. Ratifying v2 on an `implemented` slice flips `status` back to `ready-to-implement`, while
`implementedIn` keeps naming the v1 PR until v2 ships. That deliberate mismatch — version 2,
implemented-link still pointing at v1's work — is not staleness, it's the **drift signal**: a
reader, `em export`'s `slice.doc.driftSignal` (`"unpropagated-delta"`, schema `1.5`, MIL-85), and
the event-modeling skill's `conform` phase all read it the same way — a ratified delta hasn't
shipped yet, not a fresh finding against the still-live v1 code. `em validate`'s
frontmatter-coherence check (MIL-85) deliberately never flags this combination — only
`status: implemented` with no `implementedIn` link at all is checkable incoherence; see
[validation.md#frontmatter-coherence](validation.md#frontmatter-coherence).

Pair a re-ratification with a `Delta: vX → vY, ratified <date>: <summary>` line under the doc's
`# Slice:` heading (body prose, not a frontmatter key) so the lineage is readable without
opening git.

## Unknown keys

**Captured, never read, never a warning or error.** Real docs in the wild carry extra
non-canonical keys — `id`, `title`, `model`, `created`, `updated`, and YAML-list-valued keys
like `upstreamEvents`. Every top-level `key: value` scalar line is captured internally
regardless of whether it's one of the keys above; only the keys this document defines are ever
read back out onto `SliceDoc`. A list-valued key's own line (`upstreamEvents:`, value empty) is
captured with an empty value; its `- item` continuation lines don't match the `key: value` shape
at all and are simply skipped. Nothing throws, nothing warns — adding a new non-canonical key to
a doc is always safe.

## `schemaVersion` vs `version` — don't conflate these

| | `schemaVersion` | `version` |
|---|---|---|
| What it versions | The frontmatter dialect itself | This one slice's ratified definition |
| Who bumps it | `em` maintainers, when the dialect's canonical keys change | Whoever ratifies a delta on this slice |
| Cardinality | One value, same across every doc using this dialect | One per slice doc, incrementing per ratified delta |
| Current value | `1` (unchanged since MIL-86) | Starts at `1` |
| Read by `em` today | No — captured, not exposed on `SliceDoc` | Yes — parsed onto `SliceDoc.version` |

## Legacy status bullet line

Docs written before the frontmatter dialect existed may use `- **Status:** ...` instead of
frontmatter `status:` — still accepted, status only. `version` and the lineage keys have no
legacy form; they're frontmatter-only from the day they were introduced.

## See also

- [cli.md](cli.md#em-render-file) — slice status colors
- [cli.md](cli.md#em-catalog-files) — pattern / doc lookup
- [cli.md](cli.md#em-export-file) — the `em export` join (`slice.pattern`/`slice.doc`, schema `1.4`, MIL-91)
- [cli.md](cli.md#em-diff-old-new) — the `em diff` lineage annotation (schema `1.6`, MIL-84)
- [validation.md#lineage](validation.md#lineage) — `em validate`'s lineage-ref resolution (MIL-84)
- [`templates/slice.md`](../.claude/skills/event-modeling/templates/slice.md) — the authored template
