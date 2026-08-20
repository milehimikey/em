# CLI reference

| Command | What it does |
|---|---|
| `em init [file]` | Scaffold a starter model (default `model.em`) |
| `em render <file>` | Render a model to SVG/PNG/PDF, or emit Graphviz DOT |
| `em watch <file>` | Re-render on every save; `--serve` adds a live browser view |
| `em validate <file>` | Check the model against event-modeling rules |
| `em export <file>` | Export a versioned JSON snapshot of the normalized model |
| `em diff <old> <new>` | Compare two models structurally (or one file across git revisions) |
| `em ledger <file>` | Check slice docs' `version:` field agrees with their content across two git revisions (opt-in CI check) |
| `em glossary <files...>` | Cross-model glossary of terms, with consistency checks across models |
| `em catalog <files...>` | Generate a browsable static HTML catalog site over one or more models |
| `em changelog <file>` | Render a model's git history as a business-readable ledger |
| `em skill install` | Copy the bundled Claude Code skill into the current project |
| `em skill sync [path]` | Update a vendored skill copy to match the installed em package (overwrites unconditionally) |
| `em skill check [path]` | Check a vendored skill copy for drift against the installed em package; exits non-zero on mismatch |

Every command that reads a model also parses and validates it first, printing any
diagnostics (see [validation.md](validation.md)).

## `em init [file]`

Writes a starter model — the same order-fulfillment model the [tutorial](tutorial.md)
builds, minus fields and notes. Defaults to `model.em`.

| Flag | Effect |
|---|---|
| `-f, --force` | Overwrite the file if it already exists |

## `em render <file>`

Renders the model. The output format is `-T` when given, otherwise it's derived from the
`-o` extension; with neither, the output is `<basename>.svg` next to where you run the
command. SVG and
PNG are fully in-process; PDF and other formats shell out to a system `rsvg-convert` (see
[dependencies.md](dependencies.md)). If validation finds errors, `em render` prints them
and refuses to render. A `note` clause pointing at a missing file gets a warning but still
renders.

| Flag | Effect |
|---|---|
| `-o, --out <path>` | Output path; the extension picks the format |
| `-T, --format <fmt>` | Output format (`svg`, `png`, `pdf`, …); takes precedence over the `-o` extension |
| `--slice <name>` | Render only this slice, redrawn in its own canonical pattern shape (default out: `slices/<kebab-slug>.svg`) |
| `--emit-dot` | Print the generated Graphviz DOT instead of rendering (or write it with `-o`) |
| `--keep-empty-lanes` | Keep the API lane even when no slice uses it |

```bash
em render model.em                 # -> model.svg
em render model.em -o out/model.png
em render model.em --emit-dot      # inspect the DOT
em render model.em --slice "Place Order"   # -> slices/place-order.svg
```

`--slice` doesn't crop the full diagram — it classifies the slice into one of the 4 Event
Modeling patterns (State Change, State View, Automation, Translation) and redraws just its
own canonical shape with a fresh layout, matched by an exact, case-sensitive `--slice` name
against the model's slices (an unknown name lists every valid one). Only the minimum real
context the pattern needs is pulled in: a State View's source event(s), or an Automation/
Translation's watched read model — both resolved via `from`, even across slices. Never more
than one hop away, so this can't balloon into showing most of the model. Can't be combined
with `--emit-dot`. This is exactly
the path convention the `event-modeling` skill's `slice` phase writes to, and that
`em catalog` looks for (see below).

**Slice status colors.** Every slice's title cell is colored by its slice doc's status
(`slices/<kebab-slug>.md`, same doc `em catalog` reads — see below), whenever one exists next
to the `.em` file. Status comes from the doc's leading YAML frontmatter (`status: ...`) —
the canonical dialect — or, for docs written before frontmatter existed, a legacy
`- **Status:** ...` bullet line; frontmatter wins if a doc somehow has both:

| Status | Color |
|---|---|
| `reviewed` | blue |
| `ready-to-implement` | amber |
| `implemented` | green |
| `draft`, no doc, or an unrecognized value | default gray (unchanged) |

A "Slice Status" legend is appended below the diagram whenever at least one slice resolves to
a recognized status. This is on by default and non-breaking: a model with no `slices/` docs
at all renders exactly as before. Matching is case-insensitive and free-text otherwise — like
`em catalog`, `em render` doesn't validate the Status value, it just doesn't color slices it
doesn't recognize.

See [slice-doc-schema.md](slice-doc-schema.md) for the complete frontmatter schema, including
`version` and the lineage keys (`split-from`/`merged-from`/`superseded-by`) — neither affects
header coloring.

## `em watch <file>`

Renders once, then re-renders on every save — of the `.em` file, or of any of its slices'
`slices/*.md` slice docs (so flipping a frontmatter `status:` value, or a legacy
`- **Status:** ...` line, live-updates header colors without touching the model). Saves with
validation errors are skipped (the errors print; the previous render stays on disk). Ctrl-C to
stop.

| Flag | Effect |
|---|---|
| `-o, --out <path>` | Output path; the extension picks the format |
| `-T, --format <fmt>` | Output format; takes precedence over the `-o` extension |
| `--keep-empty-lanes` | Keep the API lane even when no slice uses it |
| `--serve` | Serve a live browser viewer with instant push-reload |
| `--port <n>` | Port for `--serve` (default 5173; falls forward if taken) |

With `--serve`, `em` starts a loopback HTTP server on the output directory and prints a URL
like `http://localhost:5173/?svg=model.svg`. After each successful re-render it pushes a
reload over Server-Sent Events, so the browser updates the moment you save, with no polling
and no flicker. The server serves the directory the SVG is written to, which is what keeps
`note` links inside the SVG clickable.

The served viewer's header also carries **Review mode** — a slice-by-slice storyboard
walkthrough for stakeholder sessions: Prev/Next (or the arrow keys) steps through slices in
declaration order, panning/zooming each into view with everything else dimmed. Issues added
to the `.em` mid-session arrive over the same SSE push without leaving review mode; the
event-modeling skill's `review` phase ([ai-workflow.md](ai-workflow.md)) runs a facilitated
session on top of it.

## `em validate <file>`

Runs every rule in [validation.md](validation.md) and prints the diagnostics. Exits
non-zero if there are errors; exits zero on warnings or a clean model, printing
`ok — no issues` when there is nothing to report. Useful in CI to keep a committed model
honest. Takes exactly one file — passing more (`em validate a.em b.em`) errors out rather
than silently checking only the first one (MIL-123).

Every always-on rule except two is a pure function of the `.em` source (the opt-in
`--slice-ready` gate below reads the slice doc as well, by design). Both always-on exceptions
read `slices/*.md` frontmatter alongside the model: lineage-ref resolution (MIL-84) checks
`split-from`/`merged-from`/`superseded-by` refs against the current tree — see
[validation.md#lineage](validation.md#lineage); frontmatter coherence (MIL-85) flags a slice
doc whose `status: implemented` has no `implementedIn` link — see
[validation.md#frontmatter-coherence](validation.md#frontmatter-coherence) for exactly what's
checked (and, just as deliberately, what's never flagged — a re-ratified slice's stale
`implementedIn` is expected, not incoherent).

| Flag | Effect |
|---|---|
| `--list-issues` | Print only the open `issue "text"` diagnostics (slice, element, line, text) instead of the full diagnostic list |
| `--list-divergences` | Print only the `divergence "text"` annotations (slice, element, line, text) — for auditing, never affects the exit code |
| `--list-public` | Print only events and views marked `public` (slice, kind, name, line) — an integration-surface audit, never affects the exit code |
| `--fail-on-issues` | Exit non-zero if the model has any open issues (opt-in — issues are warnings and don't block by default) |
| `--slice-ready <key>` | Readiness gate for one slice (export key) — see below. Takes priority over `--list-*`/`--fail-on-issues` if combined. |

```bash
em validate model.em                          # full diagnostics; exits non-zero only on errors
em validate model.em --list-issues             # just the open `issue` clauses, for a quick sweep
em validate model.em --list-divergences        # just the accepted `divergence` clauses, for an audit
em validate model.em --list-public             # just the events and views marked `public`, for an audit
em validate model.em --fail-on-issues          # CI gate: fail while any issue remains open
em validate model.em --slice-ready checkout    # is "checkout" safe to hand to an implementer?
```

### `--slice-ready <key>` (MIL-87)

The handoff gate: is this one slice safe to hand to an implementer? Native `em` form of the
check that used to live only in em-sdd-bridge's `assertReadyToImplement` — useful for any
toolchain that reads slice docs directly rather than routing through the bridge. Exits non-zero
unless **all** of the following hold, printing which ones don't and why
(see [validation.md#slice-readiness](validation.md#slice-readiness) for the full code list):

- the slice has a doc bound via `note "slices/<key>.md"` on one of its elements (same
  note-binding gate `em export`'s doc join uses, MIL-91) and the doc's frontmatter is usable
- the doc's `status` is `ready-to-implement`
- every `## Open Questions` checkbox in the doc is checked (`- [x]`, none left `- [ ]`)
- no version/status/link incoherence is flagged for the slice (folds in the frontmatter-
  coherence check, MIL-85, for free — see [validation.md#frontmatter-coherence](validation.md#frontmatter-coherence))

```bash
$ em validate model.em --slice-ready checkout
  warn :12 slice "checkout" is status: draft, not ready-to-implement
  warn :12 slice "checkout" has 1 of 2 Open Question(s) unchecked
slice "checkout" is NOT ready-to-implement
$ echo $?
1
```

## `em export <file>`

Exports a versioned JSON snapshot of the normalized model — the machine-readable counterpart
to `em render`'s picture. Same validation as every other command: `em export` refuses (exits
non-zero, prints the diagnostics) when the model has errors; warnings never block and are
included in the output's `diagnostics` array instead. Writes pretty-printed JSON to stdout by
default (pipe-friendly); `-o` writes a file.

| Flag | Effect |
|---|---|
| `-o, --out <path>` | Write to a file instead of stdout |

```bash
em export model.em                    # pretty JSON on stdout
em export model.em -o model.json      # write to a file
```

**Determinism.** The same source text always exports to byte-identical JSON: no timestamps,
no git data, no absolute paths, no environment-derived values. `source.sha256` is a hash of
the source text, so a consumer can tell whether an export is stale without re-running `em`.

**Schema summary** (`schemaVersion: "1.6"`):

- `generator` — `{ name, version }` of the tool that produced the export.
- `source` — `{ path, sha256 }`; `path` is exactly what was passed on the command line. (This is
  the *document's* provenance — the `.em` file itself. Not to be confused with a slice's own
  `source`, below: same key name, different scope and shape.)
- `model` — `name`, `personas`, `contexts`, `hasAutomation`, `types`, `slices`, `arrows`.
  - `types` (added in schema `1.3`) lists every declared named type (see
    [dsl.md](dsl.md#named-types)), independent of the slice timeline. Each has a stable `ref`
    (`types/<slug(name)>`, suffixed `~2`, `~3`, … — plus a warning diagnostic — on a name
    collision), `name`, `line`, and `fields` in declaration order.
  - Each **slice** has a stable `key` (`slug(name)`, with a `~2`, `~3`, … suffix — and a
    warning diagnostic — if two slices share a name), plus `name`, `index`, `line`, `source`
    (the slice's `source "url"` clause — a link to the ticket/conversation it traces back to,
    or `null` if absent), `elements`, `pattern`, and `doc` (the latter two added in schema
    `1.4`, MIL-91):
    - `pattern` — `state-change` | `state-view` | `automation` | `translation` | `unclassified`,
      derived from the slice's element kinds (see [patterns.md](patterns.md)) — the same
      classification `em catalog` already shows, not the doc's own authored `pattern:`
      frontmatter value (that stays informational-only, unread by any command — see
      [slice-doc-schema.md](slice-doc-schema.md)).
    - `doc` — the slice-doc frontmatter join: **frontmatter only, never the markdown body**
      (no `.html`/prose ever appears here). Always a non-null object with a `found: boolean`
      and a `reason` distinguishing three states: `no-doc-bound` (no element in the slice
      carries a `note` clause naming the conventional `slices/<key>.md` path — a normal,
      unremarkable state, never a diagnostic), `binding-missing-file` (a note names that path
      but no file exists there — warns), and `frontmatter-invalid` (the file exists but has no
      frontmatter block, or is missing a required key — warns). `reason` is `null` exactly
      when `found` is `true` and the frontmatter parsed cleanly, at which point `status`,
      `version`, `implementedIn`, `splitFrom`, `mergedFrom`, `supersededBy`, and `driftSignal`
      are populated from it (each `null`/`[]` otherwise). `driftSignal` (added in schema `1.5`,
      MIL-85) is `"in-sync"` | `"never-implemented"` | `"unpropagated-delta"` |
      `"implemented-without-link"` — the status/implementedIn coherence classification also
      driving `em validate`'s frontmatter-coherence warning (see
      [validation.md#frontmatter-coherence](validation.md#frontmatter-coherence)); it's paired
      with `version` from the same doc parse, so a consumer reporting drift should always cite
      both together. Full contract: [slice-doc-schema.md](slice-doc-schema.md).
    Elements appear only inside their slice, not flattened at `model.elements`.
  - Each **element** has a stable `ref` — `<sliceKey>/<kind>.<slug(name)>`, suffixed the same
    way on a same-kind-same-name collision within one slice — plus `kind`, `name`, `line`,
    `fields`, `note`, `issue`, `divergence`, `from`, `persona`, `context`, `again`, `public`,
    `tags`, and `logicalRef`. `divergence` (added in schema `1.1`) carries a `divergence "text"`
    annotation — a reasoned, ratified deviation between this element and its implementation;
    `null` when the element carries none. `public` (added in schema `1.2`) is `true` when the
    event carries the `public` clause — part of the model's published integration surface —
    and `false` for every other element (including non-public events); see
    [dsl.md](dsl.md#integration-surface). `tags` (added in schema `1.6`, MIL-66) is
    `[{ key, kind, fields, description }] | null` — the event's DCB tag metadata, `null` when
    the element has none (events only in practice; `tag` clauses are a parse error on any other
    kind). `kind` is `"identity"` (from an inline field `tag`, `fields: [fieldName]`,
    `description: null`), `"composite"` (from `tag X from a, b`, `fields` the listed field
    names, `description: null`), or `"external"` (from `tag X external "text"`, `fields: null`,
    `description` the string). Order: inline field identity tags in field order, then
    element-level composite/external clauses in declaration order. See
    [dsl.md](dsl.md#event-tags).
    Fields that don't apply to a given element are emitted as explicit `null` (not omitted),
    so a typed consumer (e.g. Pydantic) doesn't have to sniff for key presence. `from` is
    resolved to both the referenced name and its `ref`. `logicalRef` points at the first
    timeline instance of a `view … again` read model; `null` for everything else.
  - Each **field** — on both a declared type's own `fields` and an element's `fields` — has
    `name`, `type` (the raw type string, unchanged), `typeRef` (added in schema `1.3`):
    `{ name, ref, array }` when `type` (bare or `[]`-suffixed) names a declared type, `null`
    otherwise (see [dsl.md](dsl.md#named-types)), and `tag` (added in schema `1.6`, MIL-66):
    `true` when the field carries a trailing `tag` clause (an identity tag), `false` otherwise
    — always present, same `=== true` convention as `public`. See [dsl.md](dsl.md#event-tags).
  - Each **arrow** carries its endpoint names plus resolved `fromRef`/`toRef`.
- `diagnostics` — every diagnostic `em validate` would print, plus export-only ref-collision
  and slice-doc-join warnings. Each has `severity`, `code` (added in schema `1.4`, MIL-91 — a
  stable, CI-matchable rule identifier; `message` stays free text and may be reworded without
  notice), `message`, `line`, and `refs` (added in schema `1.4`) — the export-stable
  `ref`/`key` of every entity the diagnostic concerns (0, 1, or more; e.g. a duplicate-name
  collision names both colliding entities). Never a second identifier scheme — always the
  same refs/keys the `model` section above uses.

**Stable identity.** `ref`/`key` are edit-stable: inserting or reordering slices never changes
an existing slice's `key` or an existing element's `ref` (only `index` moves). A rename does
change identity — that's intentional, a rename is a model change. These refs are NOT the same
as the internal id used by layout/rendering, which is document-order-deduped and only
render-stable.

**Versioning policy.** `schemaVersion` is independent of the npm package version. Additive
optional fields are a minor bump; renames, removals, or meaning changes are a major bump.
**Consumers must tolerate unknown fields.**

See [ci.md](ci.md) for using `em export` as a downstream-tooling artifact step alongside
`em validate` as a merge gate.

## `em diff <old> <new>`

Compares two models structurally and prints a rollup summary plus one line per change —
slices and elements added/removed/moved, a slice's `source` added/removed/changed,
field/`from`/note changes, issue lifecycle (opened, resolved, text changed), an event's
integration-surface promotion/demotion (`public` marked/unmarked), and declared types
added/removed along with their own field changes (see [dsl.md](dsl.md#named-types)). It's the
semantic counterpart to `git diff` on a `.em` file: raw `git diff` shows line hunks; `em diff`
groups them into what actually happened to the model, and — crucially — collapses a
cross-slice move into one `moved:` line instead of a delete-hunk-plus-add-hunk in two
different places.

When a change or removal involves an element the **old** side annotates with `divergence
"text"`, the entry is additionally tagged with that text — see "Accepted divergence" below.
This never suppresses the finding: `em diff` still reports the true structural state, it just
cites the reason a consumer (like the `conform` skill phase, see [ai-workflow.md](ai-workflow.md))
can use to classify it as accepted rather than fresh drift.

Two forms:

```bash
em diff old-model.em new-model.em             # two files
em diff model.em --from HEAD~5                # model.em now vs. 5 commits ago
em diff model.em --from v1.0 --to v1.1        # two tags of the same file
```

With `--from <rev>` (and optional `--to <rev>`), `em diff` resolves the file's content at
each git revision via `git show <rev>:<path>` — the file must be tracked in a git repo.
`--to` defaults to the file's current on-disk content. The two forms are mutually
exclusive: passing two file arguments together with `--from`/`--to` is an error.

Both sides must compile without errors (parse errors or validation errors) — `em diff`
refuses and prints diagnostics, same as `em render`/`em export`. Warnings are printed but
don't block the diff.

| Flag | Effect |
|---|---|
| `--from <rev>` | Diff `<old>` against this git revision instead of a second file |
| `--to <rev>` | Diff against this git revision instead of the current file (requires `--from`) |
| `--exit-code` | Exit 1 if the models differ, 0 if identical (opt-in, `git diff --exit-code` convention) |
| `--json` | Print a JSON document instead of the text report (see below) |

By default `em diff` always exits 0 (except on a compile error); pass `--exit-code` to use
it as a CI gate that fails when a model actually changed. `--exit-code` composes with
`--json`: stdout is still exactly the JSON document, and the exit code still reflects
whether the models differ.

**Identity.** Slices are matched by their `em export` key, elements by their `em export`
`ref` — the same edit-stable identity `em export` guarantees, so inserting or reordering
slices doesn't spuriously show up as changes.

**Renames are out of scope (deliberate).** There's no rename detection in v1: renaming an
element reads as a remove + an add (or as a move, if the same name reappears in a different
slice). This is intentional — a rename genuinely is a change to the model's ubiquitous
language, and `em diff` surfacing it as one is the honest read, not a bug to fix later.

**Integration-surface promotion/demotion** (`event-marked-public`/`event-unmarked-public`,
added in schema `1.2`). When an event's or view's `public` clause (see
[dsl.md](dsl.md#integration-surface)) is added or removed between the two sides, `em diff`
reports it as `event marked public` / `event unmarked public` — its own change type, not
lumped in with a generic field change, since a contract consumer needs to know exactly when
an element enters or leaves the published surface. (The change-type names predate the marker
widening to views; the entry's `kind` says which it was.)

**Declared types** (`type-added`/`type-removed`/`type-field-added`/`type-field-removed`/
`type-field-changed`, added in schema `1.3`). Types are matched by their `em export` `ref`,
same identity scheme as elements — but with no slice scoping and no move detection, since a
`type` declaration isn't slice-scoped. A type rename reads as remove+add, the same convention
as an element rename. A surviving type's own field changes are reported the same shape as an
element's field changes (`type-field-added`/`-removed`/`-changed`), just without the
slice/from/note/issue/public dimensions a `type` declaration doesn't have.

Example output:

```
1 slice added, 1 element moved, 1 field change, 1 issue resolved

~ field "total": Money added to command "Submit Order" (slice "Checkout")
issue resolved: event "Order Submitted" (slice "Checkout"): "do we need a currency code here?"
+ slice "Payment"
moved: event "Payment Failed" (slice "Checkout" -> slice "Payment")
```

A moved element's own field/note/issue changes aren't further diffed in v1 — only the move
itself is reported (`kind` + normalized name is the whole match key). Diff a version before
and after a move separately if you need both.

**`--json` shape** (`diffSchemaVersion: "1.6"`, versioned independently of the npm package,
same policy as `em export`'s `schemaVersion`): stdout is exactly one JSON document (no text
report). Diagnostics are still printed to stderr, *and* carried in the document.

- `generator` — `{ name, version }` of the tool that produced the diff.
- `oldModel` / `newModel` — `{ label, sha256 }`. `label` is the same string diagnostics are
  prefixed with (a file path, or `path@rev` for the `--from`/`--to` form); `sha256` hashes
  that side's source text, so a consumer can pin exactly what was compared.
- `identical` — `true` when the models have no structural differences (`hasChanges()`
  negated).
- `counts` — the same 23 counters the text rollup line summarizes (`slicesAdded`,
  `elementsMoved`, `fieldChanges`, `issuesResolved`, `sourceChanges`, `acceptedDivergences`,
  `eventsMarkedPublic`, `eventsUnmarkedPublic`, `typesAdded`, `typesRemoved`,
  `typeFieldChanges`, `slicesSplit`, `slicesMerged`, `slicesSuperseded`, …), as-is.
- `changes` — `ChangeEntry[]` in new-file document order (additions and changes).
- `removals` — `ChangeEntry[]` in old-file document order.
- `diagnostics` — both sides' warnings, flat and side-tagged:
  `{ side: "old" | "new", severity, code, message, line, refs }` (`code`/`refs` added in
  schema `1.5`, MIL-91 — same structured-diagnostic shape `em export` uses; see its schema
  summary above). Empty when neither side warned. (`em diff` refuses to run at all if either
  side has *errors*, so these are warnings.)

Every key is a valid JavaScript identifier — hence `oldModel`/`newModel` rather than
`old`/`new`, since `const { old, new } = doc` is a syntax error.

Every `ChangeEntry` carries all its optional fields (`kind`, `name`, `ref`, `sliceName`,
`sliceKey`, `fromSlice`, `fromSliceKey`, `toSlice`, `toSliceKey`, `field`, `fieldType`,
`oldType`, `newType`, `source`, `oldNote`, `newNote`, `oldText`, `newText`, `from`, `to`,
`acceptedDivergence`, `splitFrom`, `mergedFrom`, `supersededBy`) — explicit `null` when unused
by that entry's `type`, never omitted, so a typed consumer can destructure without sniffing
for key presence (same convention as `em export`). Output is byte-deterministic for the same
two inputs.

**Accepted divergence** (`acceptedDivergence`, added in schema `1.1`): non-null when the
**old**-side (canonical) element behind this entry carries a `divergence "text"` annotation —
the same text, cited rather than hidden. Applies to `element-removed` entries and to every
matched-pair change on an annotated element (`field-*`, `from-*`, `note-*`, `issue-*`); `null`
for `slice-added`/`slice-removed`, `arrow-added`/`arrow-removed`, `element-added`, and
`element-moved`, where there's no single canonical-side element to check. `counts.
acceptedDivergences` tallies how many changes/removals carry a non-null value — a
cross-cutting count, not a separate bucket (an annotated `element-removed` still counts
toward `elementsRemoved` too). This never changes `identical` or `--exit-code`: `em diff`
reports the true structural state regardless of annotation; classifying an annotated finding
as "not real drift" is the consumer's job (see the `conform` skill phase in
[ai-workflow.md](ai-workflow.md)), not `em diff`'s.

**Export-ref join** (`ref`, `sliceKey`, `fromSliceKey`, `toSliceKey`, added in schema `1.4`,
closes [#40](https://github.com/milehimikey/em/issues/40)): every entry that identifies a
specific slice or element also carries the `em export` identity it was matched on, not just
its display name. `ref` is the element/type's export ref (`<sliceKey>/<kind>.<slug>` for
elements, `types/<slug>` for declared types); `sliceKey` is a slice's export key. Both are
present on slice-scoped entries (`slice-added`/`slice-removed`, `source-*` — `sliceKey` only,
no single element `ref` applies) and element-scoped entries (`element-added`/`element-removed`,
`field-*`, `from-*`, `note-*`, `issue-*`, `event-marked-public`/`event-unmarked-public` — both
`ref` and `sliceKey`). `type-added`/`type-removed`/`type-field-*` carry `ref` only — types
aren't slice-scoped. `element-moved` carries `ref` (the element's new/target-side identity)
plus `fromSliceKey`/`toSliceKey` alongside `fromSlice`/`toSlice`, mirroring that pair's shape.
`arrow-added`/`arrow-removed` carry none of these — `em export` has no ref concept for arrows.
A `~2`/`~3`-style dedupe suffix on a colliding name flows through automatically, since these
values are read straight from the same `computeRefs()` `em export` already uses — a consumer
can join a diff entry straight to the matching `em export` document's slice `key` or
element/type `ref` without re-deriving the slug or reimplementing dedupe.

**Lineage annotation** (`splitFrom`, `mergedFrom`, `supersededBy`, added in schema `1.6`,
MIL-84): when a `slice-added` entry's *new*-side slice doc declares `split-from`/`merged-from`
frontmatter, or a `slice-removed` entry's *old*-side doc declares `superseded-by`, `em diff`
attaches the parsed ref(s) (same `{ raw, sliceKey, version }` shape as `em export`'s
`slice.doc.splitFrom`, see [slice-doc-schema.md](slice-doc-schema.md)) and counts it in
`counts.slicesSplit`/`slicesMerged`/`slicesSuperseded`. The text report renders it as a
suffix, e.g. `+ slice "Discount Rules" (split from "checkout"@v3)`. For the `--from`/`--to`
git-revision form, the doc is read at the same revision as that side's `.em` source (`git
show <rev>:slices/<key>.md`); for the two-file form, each side's doc is read relative to that
file's own directory. A doc that doesn't resolve on a given side (missing, or — for the git
form — not tracked at that revision) simply leaves these fields `null`/unset; `em diff` never
fails over an unresolvable doc, same report-not-gate philosophy as `em export`'s doc join.
**These refs are reported, never cross-checked** — whether `checkout@v3` actually exists or
the version is plausible is `em validate`'s job (see [validation.md#lineage](validation.md#lineage)), not `em diff`'s.

## `em ledger <file>`

Checks that a slice doc's `version:` frontmatter field and its content — body text plus the
three lineage fields (`split-from`/`merged-from`/`superseded-by`) — always change together
between two git revisions (MIL-89). `version:` is a pure "cache of git truth" (see
[slice-doc-schema.md](slice-doc-schema.md)): a version bump with no real content change is a
no-op ledger entry, a content change with no version bump is a stale ratification signal, and
a version going backwards is almost always a typo. **Opt-in and CI-recipe-tier** — deliberately
never folded into `em validate`, which stays a fast function of the current tree with no git
history access; see [ci.md](ci.md#em-ledger-opt-in) for the recipe.

`<file>` is an anchor `.em` file, used only to locate `slices/` relative to it — same
convention as `em diff --from`'s doc-lineage resolution. Unlike every other command, `<file>`
here is **never parsed or compiled**.

| Flag | Effect |
|---|---|
| `--from <rev>` | Baseline revision (required) |
| `--to <rev>` | Compare revision; omitted defaults to the current working tree (same convention as `em diff --to`) |
| `--json` | Print a JSON document instead of the text report |

```bash
em ledger model.em --from HEAD~5                # 5 commits ago vs. the working tree
em ledger model.em --from v1.0 --to v1.1         # two tags
em ledger model.em --from HEAD --json            # CI-friendly machine-readable form
```

Every finding is a defect once you've opted into running this command — `em ledger` exits 1 on
any mismatch, no separate `--exit-code`/`--fail-on-*` opt-in needed (unlike `em diff`/
`em glossary`, where "changed" or "conflicts" are neutral facts you may or may not want to
gate on).

**What counts as a content change, precisely.** Body text (`.trim()`-only comparison — leading/
trailing whitespace is ignored, everything else is exact) and the three lineage refs. `status`
and `implementedIn` are **deliberately excluded**: those change independently by design during
re-ratification (see
[slice-doc-schema.md#status-under-re-ratification](slice-doc-schema.md#status-under-re-ratification))
— including them would false-positive on every ordinary lifecycle transition. `pattern`/
`swimlane`/`schemaVersion` are also excluded — decorative, not currently exposed on `SliceDoc`
at all.

A slice doc that can't be usefully compared is **skipped**, not treated as a finding:

| Skip reason | Meaning |
|---|---|
| `no-prior-revision` | The doc doesn't exist (or isn't tracked) at `--from` — a new slice doc, routine |
| `deleted` | The doc existed at `--from` but not at `--to`/the working tree — a retired slice, routine |
| `frontmatter-invalid` | Either side's frontmatter isn't usable (`hasUsableFrontmatter()`) — same gate `em export`'s doc join and `em validate`'s frontmatter-coherence check both use |

Example output:

```
$ em ledger model.em --from HEAD~3
slice "checkout": doc content changed but version: didn't bump (still v3)
1 ledger mismatch(es)
$ echo $?
1
```

or `ok — ledger agrees (N slice doc(s) checked)` when nothing disagrees.

**`--json` shape** (`ledgerSchemaVersion: "1.0"`, versioned independently of the npm package and
every other command's own schema):

- `generator` — `{ name, version }` of the tool that produced the document.
- `from` / `to` — the revisions compared; `to` is explicit `null` for the working-tree form.
- `checkedCount` — total slice docs considered (the union of both revisions' `slices/*.md`),
  including skipped ones.
- `findings` — `{ sliceKey, code, message, oldVersion, newVersion, bodyChanged, lineageChanged }[]`.
  `code` is one of `ledger-content-without-version-bump`, `ledger-version-without-content-change`,
  `ledger-version-regression`.
- `skipped` — `{ sliceKey, reason }[]`, `reason` one of the three above.
- `ok` — `true` when `findings` is empty.

## `em glossary <files...>`

Aggregates the terms declared across N independently-compiled `.em` models — element
names, field names, personas, contexts — into one glossary, and flags a term used
inconsistently across models. This is the ubiquitous-language complement to `em diff`:
`em diff` compares two revisions of *one* model; `em glossary` compares vocabulary across
*several* models. Each file is compiled on its own (same as `em diff`'s two-file form) —
`em glossary` never merges models, only correlates their terms by normalized name.

Every input file must compile without errors; `em glossary` refuses (same convention as
`em render`/`em export`/`em diff`) and prints each offending file's diagnostics, prefixed
with its path, when any file has one. Warnings never block and are printed the same way,
to stderr — stdout stays clean for `--json`.

Two conflict rules in v1:

- **Kind conflict** — the same normalized element name is a different `kind` in ≥2 models
  (e.g. "Order" is an `event` in one model, a `view` in another). Requiring ≥2 distinct
  models keeps this from overlapping with `em validate`'s own single-model "ambiguous
  names" check (a name reused within one file).
- **Field-type conflict** — the same normalized field name has a different `type` (or is
  typed in one model and untyped in another) across ≥2 models. Field names are a global
  namespace, not qualified by owning element, matching how `em validate`'s own
  fields-completeness checks already union field names across a slice.

Persona/context naming (e.g. casing differences like "Customer" vs. "customer") is
explicitly out of scope for v1.

| Flag | Effect |
|---|---|
| `--json` | Print the full glossary document instead of the text report |
| `-o, --out <path>` | Write the JSON document to a file instead of stdout (requires `--json`) |
| `--list-conflicts` | Print only the conflict lines, no scale summary |
| `--fail-on-conflicts` | Exit non-zero if any cross-model conflicts were found (opt-in — conflicts are warnings and don't block by default) |

```bash
em glossary checkout.em billing.em                    # text report
em glossary checkout.em billing.em --list-conflicts    # just the conflicts, for grep/CI
em glossary checkout.em billing.em --json -o glossary.json
em glossary checkout.em billing.em --fail-on-conflicts # CI gate
```

Default text report: a one-line scale summary (`"3 models, 62 terms, 2 conflicts"`)
followed by either every conflict line or `"no conflicts"`. Deliberately **not** treated
like `divergence` (no `--fail-on-divergences` exists, because an accepted divergence must
never fail a build): a glossary conflict has no ratification mechanism in v1, so every
conflict reported is by construction un-ratified — closer in spirit to an open `issue`
than to an accepted `divergence` — hence `--fail-on-conflicts` exists, opt-in and off by
default, same shape as `em validate --fail-on-issues`.

Example output:

```
2 models, 5 terms, 2 conflicts

kind-conflict "Order Confirmed": event in checkout.em:5 (slice "Submit Order"), view in billing.em:4 (slice "Confirm Invoice")
field-type-conflict "total": Money on event "Order Confirmed" in checkout.em:5, number on view "Order Confirmed" in billing.em:4
```

**`--json` shape** (`glossarySchemaVersion: "1.0"`, versioned independently of both `em
export`'s `schemaVersion` and `em diff`'s `diffSchemaVersion` — a glossary is a
different-shaped artifact, an N-model aggregate rather than a single model's snapshot or a
two-model comparison, and `em glossary` never reads or requires an existing `em export`
document, so the schemas evolve independently):

- `generator` — `{ name, version }` of the tool that produced the glossary.
- `models` — `{ label, sha256 }` per input file, in argument order.
- `elements` — one entry per normalized element name: `{ key, name, occurrences }`, where
  each occurrence is `{ model, kind, line, sliceName }`.
- `fields` — one entry per normalized field name: `{ key, name, occurrences }`, where each
  occurrence is `{ model, elementKind, elementName, type, line, sliceName }` (`type` is
  `null` when the field is untyped).
- `personas` / `contexts` — one entry per normalized name: `{ key, name, occurrences }`,
  where each occurrence is just `{ model }` (collected for completeness; never
  conflict-checked in v1).
- `conflicts` — `{ type: "kind-conflict" | "field-type-conflict", term, occurrences }`,
  same occurrence shapes as above. `occurrences` is every occurrence of the term across
  *all* input models that declare it, not filtered down to the disagreeing subset — with
  3+ models, a conflict's `occurrences` array includes entries that agree with each other
  alongside the one(s) that don't (same "every occurrence" convention the text report's
  `formatConflictLine` already uses). Cross-reference `kind`/`type` per occurrence to see
  which side(s) actually disagree.

Every array is sorted by normalized key, so output is deterministic for the same set of
inputs in the same order.

## `em catalog <files...>`

Generates a browsable static HTML site over one or more models — an index page with each
model's diagram embedded inline plus a table of its slices, and a per-slice detail page
(diagram, elements, and its `slices/<slice-name>.md` slice doc rendered as HTML, if one
exists). Git stays the only
history store: the catalog is regenerated from the current `.em` file(s) each run, never a
new place data lives. This is the presentation layer the roadmap held back until there was
a concrete reason for it — more models than a repo can comfortably hold, or a non-engineer
audience that needs to browse models outside git (see [roadmap.md](roadmap.md)).

Every input file must compile without errors, same convention as `em glossary`/`em diff`:
`em catalog` refuses and prints each offending file's diagnostics, prefixed with its path,
if any file has one.

Output layout, one directory per input model so slice keys from different files never
collide even without a cross-file dedup pass:

```
<outDir>/
  index.html
  <model-key>/
    diagram.svg              (or .png, via -T)
    slices/
      <slice-key>.html
      <slice-key>.svg         (this slice's own diagram — always svg)
```

`<model-key>` and `<slice-key>` are the same kebab-case, `~2`/`~3`-deduped identity scheme
`em export` uses (`model-key` from the file's basename, `slice-key` from `em export`'s own
slice key) — stable, collision-safe, and consistent across commands.

**Slice diagrams.** Looked up at the same sibling location as slice docs —
`slices/<kebab-slug-of-slice-name>.svg`, next to the `.em` file — the path `em render
--slice` (and the `event-modeling` skill's `slice` phase) writes to. If found, it's copied
into the catalog's output tree as-is. If not, `em catalog` builds one itself (the same
pattern-shape render `--slice` does — no cropping, so this works regardless of the main
diagram's own `-T` format) and writes the result into its own output tree only — never back
into the source tree, per its presentation-layer philosophy above. Either way, the slice
page embeds this diagram as primary, with a link back to the full model diagram alongside
it. Always `.svg` — a slice diagram never depends on the catalog's own `-T` choice for the
main diagram.

**Slice docs.** A slice's doc is looked up deterministically at
`slices/<kebab-slug-of-slice-name>.md`, next to the `.em` file — the same path the
`event-modeling` skill's `slice` phase writes to. This is *not* the same thing as an
element's `note` clause (which annotates one diagram element, not a whole slice) — the two
are never conflated. Three outcomes, shown as the page/table's Status:

- No doc at that path → `no doc`; the page still shows the AST-derived facts (pattern,
  elements, fields), since those never depend on the doc.
- Doc exists but has no recognizable status — no frontmatter `status:` scalar and no legacy
  `- **Status:** ...` line (a freeform doc, not the template) → `unknown`; the doc's content
  still renders as HTML (with any frontmatter fences it does have stripped first).
- Doc matches the template → the Status value shown verbatim (`draft`, `reviewed`,
  `ready-to-implement`, `implemented`, …), read from frontmatter if present, else the legacy
  bullet line.

Both the main diagram and every per-slice diagram embedded in the catalog carry the same
status header coloring `em render`/`em watch` do (see above) — one status source, colored
consistently everywhere it's shown.

**Pattern.** `em catalog` derives a slice's pattern (State Change / State View / Automation /
Translation) from the slice's element kinds (see [patterns.md](patterns.md)) rather than reading
the doc's frontmatter `pattern:` field — that field is authored/informational only today, not
yet parsed by any `em` command. An Automation or Translation slice carries a reaction alongside
its `command`/`event`, so checking translation/automation kinds first is what makes it classify
correctly instead of reading as State Change.

The catalog's Status column surfaces one field of a larger schema — see
[slice-doc-schema.md](slice-doc-schema.md) for `version`, lineage, and the
required-vs-optional rules; neither `version` nor lineage is shown in the catalog UI yet.

| Flag | Effect |
|---|---|
| `-o, --out <dir>` | Output directory (default `catalog`) |
| `-T, --format <fmt>` | Diagram format embedded in the catalog — `svg` or `png` only (default `svg`); pdf isn't browser-embeddable, so it's out of scope here |
| `--title <text>` | Catalog site title (default `Event Model Catalog`) |
| `--keep-empty-lanes` | Keep the API lane even when no slice uses it |

```bash
em catalog model.em                              # -> catalog/
em catalog checkout.em billing.em -o site         # multiple models, one site
em catalog model.em -T png --title "Order System"
```

## `em changelog <file>`

Renders the model's git history as a business-readable ledger — one section per commit
that touched the file, newest first, each with its structural delta (via the same
machinery as `em diff`) and any dated Decisions-log entries from that day woven in.
Roadmap framing: the model's git history *is* a ledger of business decisions; `em
changelog` renders it as one, without an LLM — same deterministic posture as `em diff`
and `em export`.

`<file>` must be tracked in a git repository. Renames are followed (`git log --follow`),
so history survives a slice/file rename. Writes markdown to stdout by default (clean —
diagnostics never print); `-o` writes a file.

| Flag | Effect |
|---|---|
| `--from <rev>` | Start the walk at this revision (inclusive) |
| `--to <rev>` | End the walk at this revision (inclusive; default `HEAD`) |
| `-o, --out <path>` | Write to a file instead of stdout |

```bash
em changelog model.em                          # full history, newest first
em changelog model.em --from v1.0               # only commits at/after v1.0
em changelog model.em --from HEAD~5 --to HEAD~1 # a bounded window
em changelog model.em -o CHANGELOG.md
```

**`--from`/`--to` semantics.** Both bounds are inclusive of the named commit — the walk
compiles to git's `<from>^..<to>` idiom, so `--from`'s own commit is the oldest entry in
the output and `--to`'s is the newest. `--to` defaults to `HEAD`. `--from` on a root
commit (no parent to exclude) falls back to an unbounded walk up to `--to` — equivalent,
since there's nothing earlier to exclude anyway.

**Section anatomy.** Each section is `## <date> — <commit subject> (<short-hash>)`
(`<date>` is the commit's author date, `YYYY-MM-DD`), followed by the structural rollup
and per-change lines (identical to `em diff`'s text report — see above), and a
`Decisions:` block when the adjacent state file has a dated entry matching that date.
Sections with no structural change *and* no matching decision are omitted — a
whitespace- or comment-only commit produces no section. A revision that fails to
parse/validate never crashes the walk; it gets a `_could not compile this revision:
<reason>_` note in its own section instead, and the next good revision diffs against
the last revision that *did* compile.

**The oldest commit is the introduction**, not a diff (it has no predecessor): its
section reads `Model introduced: N slices, M elements.` — computed by compiling that
revision, not by diffing against an empty model.

**Decisions weaving.** If `<file>`'s directory has a `.event-modeling.md` state file (see
[ai-workflow.md](ai-workflow.md)), `em changelog` parses its `## Decisions log` section
for dated bullets (`- YYYY-MM-DD: …`, including any continuation lines) and attaches each
one to every section sharing its date. A decision whose date matches no commit in the
walk appears in a trailing `## Decisions not tied to a model commit` section — nothing
from the log is ever silently dropped. No state file at all is fine; the changelog just
carries no Decisions blocks.

**Determinism.** Given the same commit range and the same state file content, the output
is byte-identical — no timestamps beyond the commits' own author dates, no environment-
derived values.

## `em skill install`

Copies the bundled `event-modeling` Claude Code skill out of the npm package into
`.claude/skills/event-modeling/` in the current directory. Prints a reminder to run
`/event-modeling` in Claude Code afterwards. See [ai-workflow.md](ai-workflow.md).

| Flag | Effect |
|---|---|
| `-f, --force` | Overwrite an existing installation |

## `em skill sync [path]`

The downstream half of the skill-drift problem the in-repo MIL-92 gates (the `em-version:`
version stamp, skill doctests, and generated reference sections) cover only in this repo: a
repo that vendored the skill via `em skill install` has
no way to know its copy has gone stale as the source skill in the `em` npm package moves on.
`em skill sync` closes that gap — it updates `[path]/.claude/skills/event-modeling/` to
exactly match the skill bundled with whatever `em` is currently installed (MIL-93).

`[path]` defaults to the current directory. **The vendored copy is read-only** — sync always
overwrites unconditionally; a local edit is never merged, only clobbered on the next sync. This
is the opposite contract from `em skill install`, which refuses to touch an existing copy
without `-f`/`--force` (a first-time materialization you're expected to be able to customize).
If that's not the contract you want, don't run `sync` — stick with `install --force` for an
occasional, deliberate refresh instead.

```bash
em skill sync                 # sync ./.claude/skills/event-modeling/ against the installed em
em skill sync ../other-repo   # sync a different repo's vendored copy
```

Prints one `added:`/`modified:`/`removed:` line per changed file, or `up to date — ...` when
the vendored copy already matches.

## `em skill check [path]`

Checks `[path]/.claude/skills/event-modeling/` for drift against the skill bundled with the
installed `em`, without changing anything — the CI-gate counterpart to `sync`. Two independent
signals are checked and reported together (never short-circuited on the first):

- the vendored `SKILL.md`'s `em-version:` frontmatter stamp vs. the installed `em`'s own
  version (`em --version`)
- a full content diff against the packaged skill (same per-file hash comparison `sync` uses),
  which catches a hand-edited vendored file even when its stamp still happens to match

`[path]` defaults to the current directory, same convention as `sync`.

| Flag | Effect |
|---|---|
| `--json` | Print a JSON document instead of the text report |

```
$ em skill check
vendored skill's em-version: stamp (1.6.0) doesn't match installed em (1.7.0) — run `em skill sync`
1 mismatch(es)
$ echo $?
1
```

or `ok — vendored skill matches em <version>` when everything agrees. Every finding is a
defect once you've opted into running this command — `em skill check` exits 1 on any mismatch,
same no-opt-in-flag-needed convention as `em ledger`.

**`--json` shape** (`skillCheckSchemaVersion: "1.0"`, versioned independently of the npm
package and every other command's own schema):

- `generator` — `{ name, version }` of the tool that produced the document.
- `vendoredDir` — the vendored skill directory that was checked.
- `installedVersion` — the installed `em`'s own version (`em --version`).
- `findings` — `{ code, message, vendoredStamp, installedVersion, driftedFiles }[]`, every key
  always present (explicit `null` when unused by `code`, so a consumer can destructure without
  sniffing for key presence — same convention as `em diff`/`em export`'s schemas). `code` is one
  of `skill-check-not-installed` (nothing vendored at `[path]` at all — findings stop there,
  nothing else is checked), `skill-check-stamp-missing` (vendored `SKILL.md` has no
  `em-version:` stamp), `skill-check-stamp-mismatch` (stamp present but doesn't match the
  installed version — `vendoredStamp`/`installedVersion` non-null), or
  `skill-check-content-drift` (one or more files differ by hash from the packaged skill —
  `driftedFiles` non-null, sorted).
- `ok` — `true` iff `findings` is empty.
