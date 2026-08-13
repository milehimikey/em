# Slice-doc frontmatter schema

This documents the machine-read YAML frontmatter dialect `src/catalog/sliceDoc.ts` parses out
of `slices/<slice-key>.md` — the contract `em export`'s slice-frontmatter join reads. It covers
the **frontmatter block only**. Body/prose authoring conventions (Intent, Scenarios, the
`Delta:` line, Open Questions, …) live in the event-modeling skill's
[`templates/slice.md`](../.claude/skills/event-modeling/templates/slice.md), not here.

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

## Canonical keys

| Key | Type | Grammar / enum | Read by |
|---|---|---|---|
| `schemaVersion` | integer | `1` (current dialect version) | not read back by any `em` command today — reserved |
| `pattern` | string | `state-change` \| `state-view` \| `automation` \| `translation` | authored/informational only — `em catalog` derives pattern from the `.em` AST instead |
| `swimlane` | string | free text, `<Persona> → <Context>` | display-only |
| `status` | string, case-insensitive | `draft` \| `reviewed` \| `ready-to-implement` \| `implemented` | `em catalog`, `em render`/`em watch` header coloring |
| `version` | integer | positive integer, starts at `1` | parsed onto `SliceDoc.version`; not yet joined into `em export` |
| `implementedIn` | string | free text (PR/commit link) | display-only |
| `split-from` | single ref | `<slice-key>@v<N>` | parsed onto `SliceDoc.splitFrom`; referential validation is future work |
| `merged-from` | list of refs | comma-separated `<slice-key>@v<N>, ...` | parsed onto `SliceDoc.mergedFrom`; referential validation is future work |
| `superseded-by` | list of refs | comma-separated `<slice-key>@v<N>, ...` | parsed onto `SliceDoc.supersededBy`; referential validation is future work |

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

Nothing in `em` enforces this table today (no `required key missing` error exists yet) — it's
the authoring contract the template follows and the one future `em validate` checks (if added)
would check against.

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

**Scope note:** neither this schema nor `sliceDoc.ts` checks that a referenced slice/version
actually *exists* — that referential validation (does `split-from` name a real slice@version)
is deliberately out of scope for the parser. A malformed or dangling ref still parses (its
`raw` text is preserved, `sliceKey`/`version` come back `null` for a malformed value), it's
just not verified.

## `status` under re-ratification

When a new version is ratified for a slice whose previous version already shipped, `status`
tracks the **current version's** implementation state, not a running "has this ever shipped"
flag. Ratifying v2 on an `implemented` slice flips `status` back to `ready-to-implement`, while
`implementedIn` keeps naming the v1 PR until v2 ships. That deliberate mismatch — version 2,
implemented-link still pointing at v1's work — is not staleness, it's the **drift signal**: a
reader (or a future conformance check) sees at a glance that a ratified delta hasn't shipped
yet.

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
- [`templates/slice.md`](../.claude/skills/event-modeling/templates/slice.md) — the authored template
