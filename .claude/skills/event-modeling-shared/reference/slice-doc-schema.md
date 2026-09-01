<!-- GENERATED FILE — do not hand-edit. Synced from docs/slice-doc-schema.md by
     scripts/generate-skill-docs.ts (`npm run docs:generate`); `npm run docs:check` fails
     on drift. A few links below are rewritten for this vendored location (see that
     script's buildVendoredSliceDocSchema for exactly what changes and why) — everything
     else is identical to the source doc. -->

# Slice-doc frontmatter schema

This documents the machine-read YAML frontmatter dialect `src/catalog/sliceDoc.ts` parses out
of `slices/<slice-key>.md` — the contract `em export`'s slice-frontmatter join reads. It covers
the **frontmatter block only**. Body/prose authoring conventions (Intent, Scenarios, Open
Questions, …) live in the event-modeling skill's
[`templates/slice.md`](../templates/slice.md), not here — with two
exceptions:

- The `## Open Questions` section's GFM checkboxes (`- [ ]` / `- [x]`) *are* now machine-parsed
  by `sliceDoc.ts` too (`openQuestionsTotal`/`openQuestionsUnchecked`, MIL-87), feeding
  `em validate --slice-ready <key>` (see [validation.md#slice-readiness](https://github.com/milehimikey/em/blob/main/docs/validation.md#slice-readiness)).
  The section's cross-version lifecycle (MIL-156) is documented here too, alongside `## Delta`'s
  — see [Open Questions section: lifecycle](#open-questions-section-lifecycle) below. Everything
  else about the section's authoring — what a good open question looks like, when to resolve one
  — stays owned by the skill template; this doc only covers the counting mechanics and lifecycle.
- The `## Delta` section's grammar and lifecycle (MIL-88) is documented here, in full, alongside
  the lineage keys it complements — a 2026-08-14 ruling deliberately kept the slice-doc contract
  as one document rather than splitting a structurally-related convention across two files, even
  though (unlike Open Questions) `## Delta` is currently display-only prose that no `em` command
  parses yet. See [Delta section: grammar and lifecycle](#delta-section-grammar-and-lifecycle)
  below; authoring voice/tone for the section still lives in the skill template, same as every
  other body section.

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
| `schemaVersion` | integer | `1` (current dialect version) | its *value* is not read back by any `em` command today (reserved) — but its *presence* is required by `hasUsableFrontmatter()`: a doc omitting it is `frontmatter-invalid` (see below) |
| `pattern` | string | `state-change` \| `state-view` \| `automation` \| `translation` | authored/informational only — `em catalog` and `em export` both derive pattern from the `.em` AST instead (`em export`'s `slice.pattern`, schema `1.4`) |
| `swimlane` | string | free text, `<Persona> → <Context>` | display-only |
| `status` | string, case-insensitive | `draft` \| `reviewed` \| `ready-to-implement` \| `implemented` | `em catalog`, `em render`/`em watch` header coloring; joined into `em export`'s `slice.doc.status` (schema `1.4`); paired with `implementedIn` to compute `slice.doc.driftSignal` (schema `1.5`, MIL-85) and `em validate`'s frontmatter-coherence check (MIL-85 — see [validation.md#frontmatter-coherence](https://github.com/milehimikey/em/blob/main/docs/validation.md#frontmatter-coherence)) |
| `version` | integer | positive integer, starts at `1` | joined into `em export`'s `slice.doc.version` (schema `1.4`, MIL-91) |
| `implementedIn` | string | free text (PR/commit link) | joined into `em export`'s `slice.doc.implementedIn` (schema `1.4`, MIL-91); paired with `status` to compute `slice.doc.driftSignal` (schema `1.5`, MIL-85) and `em validate`'s frontmatter-coherence check (MIL-85 — see [validation.md#frontmatter-coherence](https://github.com/milehimikey/em/blob/main/docs/validation.md#frontmatter-coherence)) |
| `split-from` | single ref | `<slice-key>@v<N>` | joined into `em export`'s `slice.doc.splitFrom` (schema `1.4`, MIL-91) and `em diff`'s `slice-added` entries (schema `1.6`, MIL-84); current-tree referential checks by `em validate` (MIL-84 — see [validation.md#lineage](https://github.com/milehimikey/em/blob/main/docs/validation.md#lineage)) |
| `merged-from` | list of refs | comma-separated `<slice-key>@v<N>, ...` | joined into `em export`'s `slice.doc.mergedFrom` (schema `1.4`, MIL-91) and `em diff`'s `slice-added` entries (schema `1.6`, MIL-84); current-tree referential checks by `em validate` (MIL-84 — see [validation.md#lineage](https://github.com/milehimikey/em/blob/main/docs/validation.md#lineage)) |
| `superseded-by` | list of refs | comma-separated `<slice-key>@v<N>, ...` | joined into `em export`'s `slice.doc.supersededBy` (schema `1.4`, MIL-91) and `em diff`'s `slice-removed` entries (schema `1.6`, MIL-84); current-tree referential checks by `em validate` (MIL-84 — see [validation.md#lineage](https://github.com/milehimikey/em/blob/main/docs/validation.md#lineage)) |
| `covers` | list of slice keys | comma-separated `<slice-key>, ...` (plain keys — **not** the `<slice-key>@v<N>` ref grammar above) | ratifies a cross-slice binding (MIL-121 — see [Cross-slice coverage](#cross-slice-coverage-covers) below): read by `em export`'s doc join, `em validate --slice-ready`, and (best-effort) `em render`/`em watch`'s Slice Status legend |
| `ratifiedBy` | string | free text (typically a person's name) | written only by `em slice ratify` (MIL-165 — see [cli.md](https://github.com/milehimikey/em/blob/main/docs/cli.md#em-slice-ratify-file-slice-key---by-name)); joined into `em export`'s `slice.doc.ratifiedBy` (schema `1.8`) and `em slice index`'s Ratified by column |
| `ratifiedOn` | string | `YYYY-MM-DD` | written only by `em slice ratify` (MIL-165); joined into `em export`'s `slice.doc.ratifiedOn` (schema `1.8`) |
| `owner` | string | free text (typically a person or team name) | hand-filled — no `em` command writes it; joined into `em export`'s `slice.doc.owner` (schema `1.9`, MIL-171), `em slice index`'s Owner column, and `em status`'s per-slice `owners[]` |
| `tracking` | string | free text (typically an external ticket/issue URL) | hand-filled — no `em` command writes it; joined into `em export`'s `slice.doc.tracking` (schema `1.9`, MIL-171) and `em slice index`'s Tracking column. This is the exact field `em-tracker-bridge` reads to find the ticket mirroring this slice — `em` only stores and displays it, it never talks to a tracker itself |

Five keys — `schemaVersion`/`pattern`/`swimlane`/`status`/`version` — are what
`hasUsableFrontmatter()` requires: a doc omitting any of them is `frontmatter-invalid` to
`em export`'s doc join and to `em validate --slice-ready` (the parser itself never *throws*
over an omission — it reports). `implementedIn` and the lineage keys are the genuinely
optional ones; `implementedIn`'s required-once-implemented rule in the table below is
convention, not parser-enforced.

## Required vs optional, by `status`

| Key | draft | reviewed | ready-to-implement | implemented |
|---|---|---|---|---|
| `schemaVersion`, `pattern`, `swimlane`, `status` | required | required | required | required |
| `version` | required (starts at `1`) | required | required | required |
| `implementedIn` | optional | optional | optional | required once the slice has *ever* reached `implemented` — may still name a **prior** version's PR during re-ratification, see below |
| `split-from`, `merged-from`, `superseded-by` | optional in every state — present only on docs created by a split/merge, or on a doc that has been retired |
| `covers` | optional in every state — present only on a doc that deliberately also serves another slice (MIL-121, see below); most docs never carry it |
| `ratifiedBy`, `ratifiedOn` | optional in every state — present once `em slice ratify` (MIL-165) has run at least once; a doc predating this feature, or ratified by hand, simply omits both |
| `owner`, `tracking` | optional in every state — hand-filled whenever a team wants a who-holds-this / external-tracker link; most docs never carry either (MIL-171) |

`em export`'s slice-doc join (MIL-91) is the first `em` command to mechanically check the
required row above: a bound doc missing any of `schemaVersion`/`pattern`/`swimlane`/`status`/
`version` (or missing a frontmatter block entirely) reports `slice.doc.reason:
"frontmatter-invalid"` plus a warning diagnostic — report, never fail, same as every other
export finding. `implementedIn`'s conditional requirement (once a slice has *ever* reached
`implemented`) is **not** checked — that needs git history no doc-only parse has access to.
No `em` command fails a build over this table. `em validate`'s frontmatter-coherence check
(MIL-85 — see [validation.md#frontmatter-coherence](https://github.com/milehimikey/em/blob/main/docs/validation.md#frontmatter-coherence)) warns
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
[validation.md#lineage](https://github.com/milehimikey/em/blob/main/docs/validation.md#lineage) for exactly what's checked (grammar,
self-reference/cycles, dangling `superseded-by`, impossible version arithmetic) versus what's
deliberately never flagged (a `split-from`/`merged-from` naming a key legitimately absent from
the current tree — the normal state after a real split/merge). Deep historical verification —
did `slice@vN` really, once, exist? — stays out of core validate; the reason that's sufficient
is a same-commit authoring convention, not new plumbing (`em ledger`, below, is the opt-in,
two-revision command for the related-but-different version/content invariant):

> Lineage refs (`split-from:`/`merged-from:`/`superseded-by:`) are written in the same
> ratification commit that performs the operation they record, so the PR diff contains both
> sides of the claim (the predecessor at its final version, and the ref naming it). The review
> airlock is the history check.

## Cross-slice coverage: `covers`

Since `em` 1.7.1 (MIL-120), the canonical Automation/Translation shape is two raw slices: a
bare `view` slice, and the reaction+command+event slice that reads it. Each slice can still bind
its own `slices/<key>.md` doc the ordinary way, but a team documenting the whole design unit as
**one** doc needs a way to make the view-only slice count as doc-bound too, without splitting
the write-up back into two files. `covers` (MIL-121) is that escape hatch — a deliberately
two-ended handshake, not a one-sided claim:

1. In the `.em`, an element in the *covered* slice (the one with no doc of its own) carries
   `note "slices/<other-key>.md"` — a path in the ordinary `slices/<key>.md` shape, just naming
   a *different* slice's canonical doc instead of its own.
2. That other doc's own frontmatter ratifies the coverage with `covers`, naming the covered
   slice's key back — same comma-separated, single scalar-line shape as `merged-from`/
   `superseded-by` (this parser's frontmatter dialect has **no** real YAML list support, see
   above):
   ```yaml
   covers: detect-unpaid-orders
   ```
   Multiple covered slices: `covers: detect-unpaid-orders, some-other-slice`.

Both sides are required. A `note` naming another slice's doc with no matching `covers` entry on
that doc — the file is missing, its frontmatter isn't usable, or `covers` doesn't list this
slice back — leaves the noting slice exactly as unbound as if it had no note at all
(`no-doc-bound`); em never guesses at a one-sided claim. When ratified, every consumer that
reads a bound doc's canonical fields (`em export`'s `slice.doc`, `em validate --slice-ready`,
`em render`/`em watch`'s Slice Status legend) reads the **covering** doc's `status`/`version`/
`implementedIn`/lineage/Open Questions, not the covered slice's own (nonexistent) file. A doc
covers its own canonical slice key implicitly — `covers` never needs to list it.

`covers` is a plain list of slice keys (`<slice-key>`, e.g. `detect-unpaid-orders`), **not** the
`<slice-key>@v<N>` ref grammar the lineage keys use above: coverage is a standing "this doc also
serves that slice" declaration, with no version component — unlike lineage, which records a
specific historical hop.

**Out of scope for THIS join:** `resolveSliceDocJoin` itself never warns on a *mismatched*
cross-note (a note naming a doc that doesn't ratify it back) — the slice's doc join still stays
silently `no-doc-bound`, the same as never having written the note; the join's own job is
resolving the *winning* binding, not auditing every note that didn't win. `em validate` does flag
the mismatch, as its own separate rule (MIL-126) — see
[validation.md#note-binding-mismatch](https://github.com/milehimikey/em/blob/main/docs/validation.md#note-binding-mismatch): a dangling cross-note
(missing file), one pointing at a doc with unusable frontmatter, one pointing at a usable doc
that just doesn't ratify (`covers` doesn't list this slice back), and an extra note doing nothing
in a slice that's already bound elsewhere, each get their own diagnostic there.

## Delta section: grammar and lifecycle

`## Delta` is the body section that pairs with a re-ratification (see "`status` under
re-ratification" below) — a structured record of what changed to produce the version currently
in the frontmatter, in typed operation blocks (MIL-88) rather than a one-line summary. Like the
lineage keys above, it's currently authored, not parsed — no `em` command reads *this section*
— but it's documented here rather than left purely to the skill template because its shape is a
structural contract other tooling may parse later, same reasoning as the lineage grammar.
`em diff --json` now emits the same four-word vocabulary on its own structural entries (`op:
"Added" | "Modified" | "Removed" | "Renamed"`, schema `1.7`, MIL-131 — see
[cli.md](https://github.com/milehimikey/em/blob/main/docs/cli.md#em-diff-old-new)), so the two sides speak the same language; comparing an
authored `## Delta` against the structural diff of the revisions it claims to describe is still
a separate, not-yet-built decision.

**The heading is always the literal string `## Delta` — never a variable heading** (e.g. never
`## Delta: v1 → v2`). Several consumers key on exact `##` text when locating sections in a slice
doc (the SDD-bridge's section splitter, the slice-to-spec mapping table, the redirect prompt
preambles); a heading that changes every ratification would break exact-match lookup and move
the anchor on every hop — the same problem a made-up per-doc key would cause anywhere else in
this schema. Version range, ratification date, and a one-line summary go on the **first line
inside** the section instead, as display text — not a frontmatter key, not parsed:

```markdown
## Delta
**v1 → v2, ratified 2026-08-12** — one-line summary of the ratified change.

### Added
#### Requirement: {{title}} ({{stable ID, e.g. an INV-<MNEMONIC>-n from ## Invariants}})
{{requirement text}}
##### Scenario: {{name}}
- **Given:** {{...}}
- **When:** {{...}}
- **Then:** {{...}}

### Modified
(same shape as Added — the ID names the requirement that changed)

### Removed
#### Requirement: {{title}} ({{stable ID}})
{{why it was removed}}

### Renamed
- {{old title}} ({{old ID}}) → {{new title}} ({{new ID}})
```

Stable IDs follow `INV-<MNEMONIC>-<n>` — a short (2-4 uppercase letters/digits) abbreviation of
the slice's key, unique among the model's slices, then a small integer, optionally letter-suffixed
for a closely-related sub-invariant (`INV-CHK-3a`) — see the Invariants section guidance in
[`templates/slice.md`](../templates/slice.md). Per-slice prefixes
make IDs globally unique across the model, so an `em coverage` citation is exact instead of
ambiguous across slices.

**Four `###` subsections, in that fixed order, Title Case singular words** — `Added`, `Modified`,
`Removed`, `Renamed` — not OpenSpec's shouting-case `ADDED Requirements` grouping. This is the
one deliberate divergence from the OpenSpec grammar the convention was validated against: the
four *operations* are retained (independent convergent design — OpenSpec arrived at the same
vocabulary from its own change-management-first angle), but OpenSpec's flat, file-per-delta
heading topology is not, because a slice doc's delta is a section inside a doc with its own
parsed heading contract, not a standalone file. Omit any of the four subsections with no entries
this hop — most re-ratifications touch one or two operations, not all four.

**`Renamed` is a requirement-level operation, not a slice-level one.** It records an invariant or
requirement *within this slice* being renamed or renumbered (e.g. `INV-CHK-3` → `INV-CHK-3a`) —
it is not a substitute for the `split-from`/`merged-from`/`superseded-by` lineage keys above,
which record the slice-doc-level operation of one doc splitting, merging, or being renamed into
another. `em diff`'s own `ChangeType` deliberately treats a slice/element rename as remove+add,
never a first-class rename (`src/model/diff.ts`: "a rename IS a model change") — `Renamed` here
is a finer grain, inside one otherwise-unchanged slice, and doesn't revisit that decision.

**Lifecycle: replace, never accumulate — the section is a window onto the latest hop, not a
scroll of every hop.** A slice's first version (`v1`) carries no `## Delta` section at all —
absence means no hop has happened yet, not an empty section. Ratifying `v2` writes the section
for the first time, in the same commit that bumps `version` and flips `status`. Ratifying `v3`
**overwrites** it with the `v2 → v3` hop; the `v1 → v2` content is not retained in the doc.
Full history is git's job — the same-commit ratification convention above makes `git log -p
slices/<name>.md` a precise, zero-maintenance delta archive — and a rolled-up multi-hop view, if
ever wanted, is a *rendering* (e.g. a future `em changelog`), never hand-maintained doc content.
An accumulating in-doc log would be a second history that diverges from git, grows unboundedly
over a slice's life, references requirements that have since moved (a *live* doc quietly going
stale reads as current, unlike git which is honestly historical), and forces every reader to
work out which delta is the live one — exactly the ambiguity `driftSignal` (MIL-85, below) is
built to avoid.

## Open Questions section: lifecycle

`## Open Questions` (MIL-87 for the counting mechanics; MIL-156 for this lifecycle) had no
cross-version story until now: `countOpenQuestions()` counts every GFM task item under the
heading, but nothing ever pruned a resolved (`- [x]`) one — left unaddressed, the section grows
by accretion across every re-ratification of a long-lived slice, the same problem `## Delta`
(above) solves for by replacing its content wholesale each hop.

**Decision: prune resolved items on the same commit that ratifies the next version — replace,
never accumulate, same stance as `## Delta`, applied by hand instead of by section-rewrite.**
Concretely:

- While the *current* version is still being drafted or reviewed, a checked item can stay in the
  doc — it's a visible record of what this round already decided, not yet an accumulation
  problem (a slice's first version, `v1`, commonly ships with every question already resolved;
  see `examples/order-fulfillment/slices/browse-catalog.md`).
- On the commit that bumps `version` and rewrites `## Delta` for the next hop, prune every
  already-checked item from `## Open Questions` — keep only what's still open (`- [ ]`), plus
  anything new that hop's change surfaced.
- Full history isn't lost: it lives in git the same way `## Delta`'s superseded hops do —
  `git log -p slices/<name>.md` shows exactly which questions were open, and how they were
  answered, at each prior version.

**Why not keep resolved items as a permanent audit trail instead?** Same reasoning `## Delta`'s
lifecycle section gives: an ever-growing scroll of resolved questions is a second history that
diverges from git, grows unboundedly over a long-lived slice's life, and forces every reader to
work out which resolutions are still relevant to the *current* version versus leftover from a
prior one — exactly the ambiguity a live, current-version-only section avoids.

**Not a parsing/grammar change.** `countOpenQuestions()` (`sliceDoc.ts`) and
`slice-ready-open-questions-unchecked` (`sliceReadyValidate.ts`,
[validation.md#slice-readiness](https://github.com/milehimikey/em/blob/main/docs/validation.md#slice-readiness)) are unaffected: both already
only care about the CURRENT doc's checkbox state, never about how many hops of history the
section has accumulated. This is purely an authoring convention — same "documented, not
mechanically enforced" status `## Delta`'s own lifecycle has (no `em` command checks that pruning
actually happened on re-ratification).

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
[validation.md#frontmatter-coherence](https://github.com/milehimikey/em/blob/main/docs/validation.md#frontmatter-coherence).

Pair a re-ratification with a `## Delta` section (see
[Delta section: grammar and lifecycle](#delta-section-grammar-and-lifecycle) above) recording
the ratified change in typed operation blocks, so it's reviewable without opening git.

**Mechanically checking the invariant this section describes:** `em ledger` (MIL-89, opt-in —
see [cli.md#em-ledger-file](https://github.com/milehimikey/em/blob/main/docs/cli.md#em-ledger-file)) checks that `version:` and a slice doc's
content (body + lineage refs) always change together across two git revisions — a version bump
with no real content change, or a content change with no version bump, is a ledger bug.
It **deliberately excludes `status`/`implementedIn`** from what counts as "content" for exactly
the reason this section explains: a re-ratification legitimately flips `status` and leaves
`implementedIn` naming prior work, with no version bump of its own — including either field in
the comparison would flag every ordinary lifecycle transition as a false positive.

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
| Read by `em` today | Value: no — captured, not exposed on `SliceDoc`. Presence: required for usable frontmatter | Yes — parsed onto `SliceDoc.version` |

## Legacy status bullet line

Docs written before the frontmatter dialect existed may use `- **Status:** ...` instead of
frontmatter `status:` — still accepted, status only. `version` and the lineage keys have no
legacy form; they're frontmatter-only from the day they were introduced.

## See also

- [cli.md](https://github.com/milehimikey/em/blob/main/docs/cli.md#em-render-file) — slice status colors
- [cli.md](https://github.com/milehimikey/em/blob/main/docs/cli.md#em-catalog-files) — pattern / doc lookup
- [cli.md](https://github.com/milehimikey/em/blob/main/docs/cli.md#em-slice-ratify-file-slice-key---by-name) — `em slice ratify`, the mechanized ratification act (`ratifiedBy`/`ratifiedOn`, schema `1.8`, MIL-165)
- [cli.md](https://github.com/milehimikey/em/blob/main/docs/cli.md#em-slice-reratify-file-slice-key) — `em slice reratify`, the mechanized re-ratification version bump/status flip (MIL-161)
- [cli.md](https://github.com/milehimikey/em/blob/main/docs/cli.md#em-export-file) — the `em export` join (`slice.pattern`/`slice.doc`, schema `1.4`, MIL-91), including `owner`/`tracking` (schema `1.9`, MIL-171)
- [cli.md](https://github.com/milehimikey/em/blob/main/docs/cli.md#em-diff-old-new) — the `em diff` lineage annotation (schema `1.6`, MIL-84)
- [validation.md#lineage](https://github.com/milehimikey/em/blob/main/docs/validation.md#lineage) — `em validate`'s lineage-ref resolution (MIL-84)
- [validation.md#slice-readiness](https://github.com/milehimikey/em/blob/main/docs/validation.md#slice-readiness) — `em validate --slice-ready`'s note-binding gate, including the `covers` cross-binding (MIL-121)
- [cli.md#em-coverage-file---tests-dir](https://github.com/milehimikey/em/blob/main/docs/cli.md#em-coverage-file---tests-dir) — `em coverage`'s INV-ID extraction, scoped to the Invariants/Delta sections' structural (non-nested) bullet lines (MIL-149/MIL-155/MIL-156)
- [validation.md#note-binding-mismatch](https://github.com/milehimikey/em/blob/main/docs/validation.md#note-binding-mismatch) — `em validate`'s check for a doc-shaped note that doesn't participate in its slice's binding (MIL-126)
- [`templates/slice.md`](../templates/slice.md) — the authored template
