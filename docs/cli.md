# CLI reference

| Command | What it does |
|---|---|
| `em init [file]` | Scaffold a starter model (default `model.em`) |
| `em scaffold <name>` | Scaffold a full project directory: `<slug>/<slug>.em`, `README.md`, `.event-modeling.md` |
| `em render <file>` | Render a model to SVG/PNG/PDF, or emit Graphviz DOT |
| `em watch <file>` | Re-render on every save; `--serve` adds a live browser view |
| `em validate <file>` | Check the model against event-modeling rules |
| `em export <file>` | Export a versioned JSON snapshot of the normalized model |
| `em diff <old> <new>` | Compare two models structurally (or one file across git revisions) |
| `em ledger <file>` | Check slice docs' `version:` field agrees with their content across two git revisions (opt-in CI check) |
| `em coverage <file> --tests <dir>` | Check that every `INV-*` invariant ID in a ready-to-implement/implemented slice doc is cited by a test (advisory by default, `--strict` for CI) |
| `em status <files...>` | Deterministic state-of-the-system rollup over one or more models: lifecycle status, driftSignal, invariant coverage, open issues, and conformance |
| `em glossary <files...>` | Cross-model glossary of terms, with consistency checks across models |
| `em catalog <files...>` | Generate a browsable static HTML catalog site over one or more models |
| `em changelog <file>` | Render a model's git history as a business-readable ledger |
| `em state read [dir]` | Print the state file's mechanical fields as JSON |
| `em state set-phase <phase> [dir]` | Rewrite `Current phase:` (and `Current step:` with `--step`) |
| `em state set-conformance <revision> [dir]` | Rewrite `Last conformance:` in the exact format `conform` parses |
| `em state set-review <date> [dir]` | Rewrite `Last stakeholder review:` |
| `em contract` | Print the packaged implementation contract (`reference/implement.md`) to stdout |
| `em mcp` | Start an MCP server over stdio, exposing structured model access as tools (also available as the `em-mcp` bin) |
| `em skill install` | Copy the bundled Claude Code skill into the current project |
| `em skill sync [path]` | Update a vendored skill copy to match the installed em package (overwrites unconditionally) |
| `em skill check [path]` | Check a vendored skill copy for drift against the installed em package; exits non-zero on mismatch |

Every command that reads a model also parses and validates it first, printing any
diagnostics (see [validation.md](validation.md)).

For a project with more than one model, see [Multi-model projects](#multi-model-projects) below
`em scaffold` — the supported directory convention, and how `em status`/`em catalog` detect a
project that doesn't follow it.

## `em init [file]`

Writes a starter model — the same order-fulfillment model the [tutorial](tutorial.md)
builds, minus fields and notes. Defaults to `model.em`.

| Flag | Effect |
|---|---|
| `-f, --force` | Overwrite the file if it already exists |

## `em scaffold <name>`

Scaffolds a full project in one step, rather than just a starter `.em`. Kebab-slugs `<name>`
for the directory and file names (`kebabSlug()` — lowercase, non-alphanumeric runs collapsed to
a single `-`); the display name you passed is used as-is for titles/prose. Creates
`<slug>/` and writes:

| File | Content |
|---|---|
| `<slug>/<slug>.em` | The same starter model `em init` writes, titled `model "<name>"` |
| `<slug>/README.md` | Overview + slice index, `{{Model Name}}`/`{{model-name}}` filled in; the `GENERATED:slices` table stays empty (run `em slice index` once the model has slices) |
| `<slug>/.event-modeling.md` | Resumable session state — mechanical fields filled (`Current phase: discover`, `Current step: 1`, today's date, `Last conformance`/`Last stakeholder review: never`); judgment sections (Session inputs, Participants, Decisions log, Usage log, Open questions) are left as empty headers, not guessed |

This is the machinery behind the bundled `event-modeling` Claude Code skill's "scaffold the
project layout" setup step (see [ai-workflow.md](ai-workflow.md)) — the skill runs this
command rather than hand-copying its `templates/*` files.

| Flag | Effect |
|---|---|
| `-f, --force` | Overwrite the directory's contents if it already exists |
| `--under <dir>` | Scaffold into `<dir>/<slug>/` instead of `./<slug>/` — the supported multi-model layout, see [Multi-model projects](#multi-model-projects) below |

```bash
em scaffold "Order Fulfillment"                    # writes order-fulfillment/{order-fulfillment.em,README.md,.event-modeling.md}
em scaffold "Checkout" --under models               # writes models/checkout/{checkout.em,README.md,.event-modeling.md}
```

Refuses if `<slug>/` (or `<dir>/<slug>/` with `--under`) already exists (`refusing to overwrite
<slug>/ (use --force)`), matching `em init`'s convention. `--under` only changes *where* the
directory is created — every file inside it still uses the bare slug (`checkout.em`, not
`models-checkout.em`), so a model scaffolded under a parent directory looks identical to one
scaffolded standalone once you `cd` into it.

## Multi-model projects

Every doc-aware command (`em catalog`, `em export`, `em diff`, `em validate`, `em status`, `em
slice ratify`/`mark-implemented`, ...) resolves a slice's doc at a fixed, unconfigurable path:
`slices/<kebab-slug-of-slice-name>.md`, always a **sibling of the `.em` file that declares the
slice** (`baseDir` = `dirname(file)` — see `em catalog`'s "Slice docs" section above for the
exact rule). There is no model ID, namespace, or configurable slices-directory field anywhere —
directory placement is the *entire* mechanism, so it's the one thing a multi-model project has
to get right.

**The convention: one directory per model.** Give every model its own directory, and every
model's `slices/` is automatically isolated from every other model's — two models can freely
reuse the same slice name (`"Checkout"` in one model, `"Checkout"` in another) with zero
collision, because `slices/checkout.md` means something different relative to each model's own
directory. This is the same precedent `em catalog`'s own output already establishes for its
generated site (one `<model-key>/` subdirectory per input file, "so slice keys from different
files can never collide, even without a cross-file dedup pass" — `src/catalog/build.ts`); this
section formalizes the matching convention for the **source** layout `em catalog` (and every
other doc-aware command) reads from.

For more than a couple of models, nest their directories under a shared parent — conventionally
`models/` — so the project root stays uncluttered:

```
my-project/
  models/
    checkout/
      checkout.em
      checkout.svg
      README.md
      .event-modeling.md
      slices/
        add-item.md
        checkout.md          # <- this model's own "Checkout" slice
    fulfillment/
      fulfillment.em
      fulfillment.svg
      README.md
      .event-modeling.md
      slices/
        ship-order.md
        checkout.md          # <- a DIFFERENT model's own "Checkout" slice — no collision
```

Back this with `em scaffold <name> --under models` for each model (writes `models/<slug>/`
directly, rather than requiring a `cd models && em scaffold <name>` two-step) — see above. The
event-modeling skill's discovery step looks for a model in the working directory *or* a
`models/` subfolder, one level down, for exactly this layout (see `SKILL.md`).

**No key-namespacing needed.** Slice export keys and doc filenames stay exactly `kebabSlug(slice
name)` — unqualified, no `<model>/<slice>` prefix — regardless of how many models a project has.
Directory isolation is a *complete* guardrail on its own: as long as every model owns its own
directory, two models' slice keys can never collide, because they're never read from the same
`slices/` directory in the first place. Model-qualifying every key would only add ceremony (a
slice's key/doc-filename could no longer be derived from its display name alone) without closing
a gap directory isolation doesn't already close.

**Detection, for when the convention isn't followed.** Nothing stops two `.em` files from
sharing a directory — validate doesn't reject it, and `em status`/`em catalog` still compile
each file that's given to them. If two co-located models *do* produce the same slice key, they'd
silently read/write the same `slices/<key>.md` doc, each attributing the other's content to
itself. `em status <files...>` and `em catalog <files...>` — the only two commands that ever
compile more than one model in a single run — check for this directly and print a
`cross-model-slice-doc-collision` warning naming both files and the colliding key whenever it
happens (never fatal — a warning, same posture as every other doc-join diagnostic). A
single-model project, or a multi-model project laid out one-directory-per-model, never triggers
it.

## `em render <file>`

Renders the model. The output format is `-T` when given, otherwise it's derived from the
`-o` extension; with neither, the output is `<basename>.svg` next to where you run the
command. SVG, PNG, and PDF are fully in-process; any other format shells out to a system
`rsvg-convert` (see [dependencies.md](dependencies.md)). If validation finds errors, `em render` prints them
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
`note` links inside the SVG clickable. The viewer navigates like a map — drag to pan,
scroll/pinch to zoom, **Fit** to reset — and never goes blank: a save that fails to render
(or a load that breaks mid-transfer) keeps the last good diagram on screen behind an error
banner, and the viewer retries on its own until a render succeeds.

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
| `--json` | Print a JSON document instead of text — see below. Composes with every flag above; exit codes are unchanged in every case. |

```bash
em validate model.em                          # full diagnostics; exits non-zero only on errors
em validate model.em --list-issues             # just the open `issue` clauses, for a quick sweep
em validate model.em --list-divergences        # just the accepted `divergence` clauses, for an audit
em validate model.em --list-public             # just the events and views marked `public`, for an audit
em validate model.em --fail-on-issues          # CI gate: fail while any issue remains open
em validate model.em --slice-ready checkout    # is "checkout" safe to hand to an implementer?
em validate model.em --json                    # structured diagnostics — works even with errors
```

### `--json` (MIL-128)

Unlike `em export`, `em validate --json` runs on a model **with errors** — that's the point: it's
the only structured-diagnostics surface open precisely when the model is broken. Diagnostics are
still printed to stderr as usual (text mode's human-readable lines); stdout carries exactly one
JSON document, and the exit code is identical to text mode in every case. `--json` composes with
`--slice-ready`/`--list-*`, changing that mode's own output shape rather than adding a fourth one.
Every diagnostic in all three shapes below carries `usageCategory`, sourced from the `RULES`
registry (the same fixed vocabulary [usage-data.md](usage-data.md)'s Categories tables draw
from) — dedupe that field yourself rather than reaching for a separate flag; there isn't one.

**Plain `em validate model.em --json`** (`validateSchemaVersion: "1.0"`):

```json
{
  "validateSchemaVersion": "1.0",
  "generator": { "name": "@milehimikey/em", "version": "…" },
  "file": "model.em",
  "ok": false,
  "summary": { "errors": 1, "warnings": 2, "total": 3 },
  "diagnostics": [
    { "severity": "error", "code": "view-from-unresolved", "message": "…", "line": 4, "refs": ["checkout/view.…"], "usageCategory": "view references unknown event" }
  ]
}
```

`ok` mirrors the exit code (`true` exactly when there are no errors — warnings never flip it).
Each diagnostic is `serializeDiagnostic()`'s shape (same as `em export`/`em diff --json`:
`severity`, `code`, `message`, `line`, `refs`) plus `usageCategory`.

**`--slice-ready <key> --json`** (`validateSliceReadySchemaVersion: "1.0"`) — see the
`--slice-ready` section below for what each gate means:

```json
{
  "validateSliceReadySchemaVersion": "1.0",
  "generator": { "name": "@milehimikey/em", "version": "…" },
  "file": "model.em",
  "sliceKey": "checkout",
  "gates": { "docBound": true, "frontmatterUsable": true, "statusReady": false, "noUncheckedOpenQuestions": false },
  "ready": false,
  "diagnostics": [ … ]
}
```

`gates` names each of the 4 conditions individually, replacing both the scraped warning prose
and the two hand-parsed English sentences ("is ready-to-implement" / "is NOT ready-to-implement").
It's `null` when `sliceKey` matches no slice in the model (the unknown-key error case — nothing
to gate; check `diagnostics` for `slice-ready-unknown-slice` instead). A gate not reached because
an earlier one failed (e.g. `statusReady` when the doc itself isn't bound) reports `false`, not
`null`. `ready` is the same predicate driving the exit code — it can be `false` even when all 4
named gates pass, if something else concerning this slice is broken (e.g. a plain
`both-ends-of-a-flow` diagnostic on one of its own elements); `diagnostics` carries the full
scoped list so a consumer sees exactly why, not just the 4 named gates.

**`--list-issues`/`--list-divergences`/`--list-public --json`** (`validateListSchemaVersion:
"1.0"`) — each flag independently gates its own marker kind, same as text mode; passing more than
one merges their markers into the same array:

```json
{
  "validateListSchemaVersion": "1.0",
  "generator": { "name": "@milehimikey/em", "version": "…" },
  "file": "model.em",
  "markers": [
    { "markerKind": "issue", "sliceKey": "checkout", "sliceName": "Checkout", "elementRef": "checkout/command.place-order", "elementKind": "command", "elementName": "Place Order", "text": "who validates the discount code?", "line": 2 }
  ],
  "diagnostics": [ … ]
}
```

`elementRef` is the same export-stable ref `em export`/`em diff` use. `text` is the `issue`/
`divergence` annotation's own text; `null` for a `public` marker, which carries no text.
`diagnostics` is the same errors-only list text mode still prints — a genuine error still fails
the run regardless of which `--list-*` flag was passed.

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
| `--slice <key>` | Export only this slice's object instead of the whole model — see below (MIL-128) |

```bash
em export model.em                    # pretty JSON on stdout
em export model.em -o model.json      # write to a file
em export model.em --slice checkout   # just the "checkout" slice's object
```

### `--slice <key>` (MIL-128)

Exports one slice's object (`pattern`/`fields`/`doc`/…, the exact same shape as that slice's
entry in the full document's `model.slices`) instead of building the whole model. Written for an
implementing agent working one ratified slice at a time: piping the entire export just to read
one `slice.doc` is unnecessary I/O, and — more importantly — the whole-model error guard
shouldn't block a slice that's fine just because some *other*, unrelated slice in a large,
still-WIP model has an error. So the guard is scoped differently here: `--slice` refuses only
when an error concerns the **named slice itself** (a bare slice-key ref, or an element ref
prefixed `<key>/` — the same scoping `--slice-ready` uses); an error anywhere else in the model
is printed to stderr as usual but never blocks. A full, unscoped `em export` still refuses on
*any* error in the model, unchanged.

```json
{
  "schemaVersion": "1.8",
  "generator": { "name": "@milehimikey/em", "version": "…" },
  "source": { "path": "model.em", "sha256": "…" },
  "sliceKey": "checkout",
  "slice": { "key": "checkout", "name": "Checkout", "pattern": "state-change", "doc": { … }, "elements": [ … ], … },
  "diagnostics": [ … ]
}
```

`schemaVersion` is the same `1.8` the full export uses — `slice` is byte-for-byte the same shape
as `model.slices[i]` there, so there's no separate schema to track for it. `diagnostics` is
scoped to this slice's own refs only (same predicate as the refusal check above), not the whole
model's. An unknown `--slice` key is a CLI usage error (non-zero exit, no JSON printed).

**Determinism.** The same source text always exports to byte-identical JSON: no timestamps,
no git data, no absolute paths, no environment-derived values. `source.sha256` is a hash of
the source text, so a consumer can tell whether an export is stale without re-running `em`.

**Schema summary** (`schemaVersion: "1.8"`):

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
      `version`, `implementedIn`, `splitFrom`, `mergedFrom`, `supersededBy`, `driftSignal`,
      `ratifiedBy`, and `ratifiedOn` are populated from it (each `null`/`[]` otherwise).
      `driftSignal` (added in schema `1.5`,
      MIL-85) is `"in-sync"` | `"never-implemented"` | `"unpropagated-delta"` |
      `"implemented-without-link"` — the status/implementedIn coherence classification also
      driving `em validate`'s frontmatter-coherence warning (see
      [validation.md#frontmatter-coherence](validation.md#frontmatter-coherence)); it's paired
      with `version` from the same doc parse, so a consumer reporting drift should always cite
      both together. `ratifiedBy`/`ratifiedOn` (added in schema `1.8`, MIL-165) are the doc's
      `ratifiedBy:`/`ratifiedOn:` frontmatter, written only by `em slice ratify` — both `null`
      when absent (a doc predating this feature, or ratified by hand before it existed). Full
      contract: [slice-doc-schema.md](slice-doc-schema.md).
    Elements appear only inside their slice, not flattened at `model.elements`.
  - Each **element** has a stable `ref` — `<sliceKey>/<kind>.<slug(name)>`, suffixed the same
    way on a same-kind-same-name collision within one slice — plus `kind`, `name`, `line`,
    `fields`, `note`, `issue`, `divergence`, `from`, `persona`, `context`, `again`, `public`,
    `tags`, `renamedFrom`, and `logicalRef`. `divergence` (added in schema `1.1`) carries a `divergence "text"`
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
    [dsl.md](dsl.md#event-tags). `renamedFrom` (added in schema `1.6`, MIL-68) is
    `string[] | null` — the element's own `renamed from "Old1", "Old2"` clause (event/command
    only), most-recent-old-name first; `null` when the element carries none, including every
    element of a kind the clause can't parse on. Codegen/export metadata only: `em diff` does
    not read it and keeps reporting a rename as remove+add. See [dsl.md](dsl.md#renames).
    Fields that don't apply to a given element are emitted as explicit `null` (not omitted),
    so a typed consumer (e.g. Pydantic) doesn't have to sniff for key presence. `from` is
    resolved to both the referenced name and its `ref`. `logicalRef` points at the first
    timeline instance of a `view … again` read model; `null` for everything else.
  - Each **field** — on both a declared type's own `fields` and an element's `fields` — has
    `name`, `type` (the raw type string, unchanged), `typeRef` (added in schema `1.3`):
    `{ name, ref, array }` when `type` (bare or `[]`-suffixed) names a declared type, `null`
    otherwise (see [dsl.md](dsl.md#named-types)), `tag` (added in schema `1.6`, MIL-66):
    `true` when the field carries a trailing `tag` clause (an identity tag), `false` otherwise
    — always present, same `=== true` convention as `public` — and `renamedFrom` (added in
    schema `1.6`, MIL-68): `string[] | null` — the field's own trailing `renamed from "Old1",
    "Old2"` clause (event/command fields only), most-recent-old-name first; `null` (the
    `typeRef` nullable convention, not `tag`'s boolean-default one) when the field carries no
    such clause, which includes every field of a declared `type` — the clause can't parse
    there. See [dsl.md](dsl.md#event-tags) and [dsl.md](dsl.md#renames). `assigned` (added in
    schema `1.7`, MIL-148): `true` when the field carries a trailing `assigned` clause (event
    fields only — system-assigned, set by the server/handler rather than the triggering
    command), `false` otherwise — always present, same `=== true` convention as `tag`. Excludes
    the field from `em validate`'s event ← command fields-completeness check (and, since the
    diagnostic never fires, from `--slice-ready` as well); does not narrow view ← event
    tracing. See [validation.md#fields-completeness](validation.md#fields-completeness).
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

**`--json` shape** (`diffSchemaVersion: "1.7"`, versioned independently of the npm package,
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

**Delta vocabulary join** (`op`, added in schema `1.7`, MIL-131): every entry also carries a
coarsened `op: "Added" | "Modified" | "Removed" | "Renamed"`, the same four Title Case operation
words a slice doc's `## Delta` section uses (MIL-88, see
[slice-doc-schema.md](slice-doc-schema.md#delta-section-grammar-and-lifecycle)) — shared
vocabulary so a structural diff and an authored delta can eventually be checked against each
other (a separate, not-yet-built decision). Every `*-added` type (plus `issue-opened`) maps to
`"Added"`; every `*-removed` type (plus `issue-resolved`) maps to `"Removed"`; every `*-changed`
type, `element-moved`, and `event-marked-public`/`event-unmarked-public` map to `"Modified"`.
`"Renamed"` is never emitted — `em diff` still has no rename detection (see "Renames are out of
scope" above), so `op` reports the same honest read the rest of the entry already does, just in
the Delta section's own words.

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

## `em migrate <file>`

Rewrites the pre-1.7.1 two-slice Automation/Translation shape — a reaction's read model and the
reaction itself in one slice, that reaction's command and event in the immediately following
slice, linked only by file-position adjacency — into the merged single-slice shape MIL-120 made
canonical: the reaction, the command it triggers, and that command's event all in **one** slice
(see [patterns.md#automation](patterns.md#automation)). Re-rendering an old-shape model doesn't
fix it — the slice structure lives in the `.em` source text itself — so `em migrate` edits the
source directly. **This is `em`'s only command that mutates a `.em` file.**

Detection is narrow on purpose: a pair of adjacent slices is only considered at all once the
leading slice has no `command` but at least one reaction-kind element
(`automation`/`processor`/`saga`/`translation`), and the immediately following slice has at
least one `command`. Every other adjacent pair — the overwhelming majority in a normal model —
is left alone without comment. Once a pair clears that bar, anything short of the clean shape
(more than one reaction in the leading slice, a leading slice with elements beyond one view and
one reaction, a following slice that already has a reaction or more than one command, a
reaction with a `{ fields }` block, …) is a **per-site refusal**, printed with its reason —
never a guess. Refusals don't block other, unambiguous sites in the same file from migrating.

A clean site moves the reaction's own source line down into the following slice, immediately
before its `command`, adds an explicit `from "<view name>"` to it if the leading slice held a
view and the reaction didn't already name it, and deletes the leading slice entirely if that
was the only thing in it — otherwise the leading slice is left as a bare `view` slice, itself a
valid, complete State View. Everything else in the file — comments, blank lines, indentation —
is untouched; the rewrite is text-level and line-based, never a regeneration from the parsed
model. Running it twice is a no-op the second time: `--write`ing an already-migrated file (or
one with no old-shape sites at all) reports "nothing to migrate" and changes nothing.

Before writing anything, the full rewrite is re-parsed and re-validated in-process; if doing so
would introduce any error-severity diagnostic the original source didn't already have, the
whole write is aborted and the file is left untouched (the new errors are printed). This can't
happen for the shape the rewrite actually produces in practice — a reaction only ever legally
points forward to a command, and moving it one slice later can't desync any of `em validate`'s
error-tier checks — but the guard exists regardless, since this is the one command that writes.

If any element in the affected pair carries a `note "slices/<key>.md"` binding, the report adds
a pointer that doc bindings may need re-checking — merging or emptying a slice can change its
canonical export key — without attempting to rewrite the note itself (see
[slice-doc-schema.md](slice-doc-schema.md)).

**Dry run by default.** `em migrate`'s first release is also `em`'s first command that writes
to a `.em` file at all, so it defaults to the same posture every other command already has —
report, don't touch — and only writes with an explicit `--write`.

| Flag | Effect |
|---|---|
| `--write` | Apply the rewrite to the file. Without it, `em migrate` only reports what it would do. |

```bash
em migrate model.em             # dry run: report every site that would migrate, or refuse, and why
em migrate model.em --write     # apply it
```

**Exit codes:** `0` on a clean run (including "nothing to migrate"). `1` if the file can't be
read or doesn't parse, if the rewrite would introduce a new error and was aborted, or if any
site was refused — even when other sites in the same run migrated cleanly, since a refusal
means the file still needs a human.

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

## `em coverage <file> --tests <dir>`

Mechanizes the one honor-system line in `reference/implement.md`'s definition of done: "every
`INV-<MNEMONIC>-n` has a test that cites its ID" (MIL-130). For each slice whose joined doc's `status` is
`ready-to-implement` or `implemented`, extracts every `INV-*` invariant ID the doc's own
`## Invariants / Business Rules` or `## Delta` sections *define* (MIL-149; not every ID its prose
elsewhere merely mentions — see **Token format** below), then scans `--tests <dir>` recursively
for lines that cite each ID. Reports, per ID,
**cited** (every citing `file:line`) or **uncovered**. Checks that an ID is *cited* — not that
the citing test is good or passing; test quality stays with review, and test passing stays with
CI (see [ci.md](ci.md#em-coverage-opt-in) for the CI recipe).

Doc resolution is the same note-binding join every other doc-aware command uses
(`resolveSliceDocJoin`, [docJoin.ts](../src/catalog/docJoin.ts)) — the same join `em export`'s
doc field and `--slice-ready` use. A slice with no doc bound, a binding pointing at a missing
file, or unusable frontmatter is simply **not in scope** (none of those can carry a
ready/implemented status); a bound, usable doc whose `status` isn't `ready-to-implement` or
`implemented` is in scope for nothing (reported, `invariants: []`) rather than silently
dropped — see the `--json` shape below.

**Token format.** IDs are hand-authored per docs/slice-doc-schema.md ("give each a stable ID"),
not machine-generated, so no single fixed shape is enforced — the extraction regex matches
`INV-` followed by a run of alphanumeric/hyphen segments, covering both the documented per-slice
mnemonic prefix (`INV-CHK-4`, `INV-CHK-3a` for a rename target — the convention the template
now demonstrates) and older docs' bare running-number IDs (`INV-1`, `INV-2`) predating that
convention. Only the doc's own `## Invariants / Business Rules` section and `## Delta` section
(whose Added/Modified/Renamed requirement subsections legitimately introduce/rename IDs "from
Invariants below") count as *defining* an ID for that slice — an ID appearing only in another
section's prose (Dependencies, Open Questions, ...) is a citation-worthy mention, not an
attribution, and is **not** collected into that slice's own coverage ledger; the ID still belongs
to whichever slice's doc actually declares it under its own `## Invariants` (MIL-149). And within
that section, only the bullet's/subheading's own line counts as the definition — not a wrapped
continuation line or a bare paragraph, either of which may legitimately cite a sibling slice's ID
while explaining this doc's own rule (MIL-155). Citation matching is word-boundary-anchored so
`INV-KEY-1` never matches inside `INV-KEY-12`.

| Flag | Effect |
|---|---|
| `--tests <dir>` | Directory to scan recursively for test files citing invariant IDs (**required**) |
| `--strict` | Exit non-zero if any invariant ID has zero citations (CI) |
| `--json` | Print a JSON document instead of the text report |

```bash
em coverage model.em --tests test/                 # advisory — exits 0 regardless of uncovered IDs
em coverage model.em --tests test/ --strict         # CI gate — exits 1 on any uncovered ID
em coverage model.em --tests test/ --json           # machine-readable form
```

**Advisory by default** — a model with uncovered invariant IDs is not, by itself, a build
failure; `--strict` is the opt-in CI gate (unlike `em ledger`, where every finding is already a
defect once you've opted into running the command at all).

A model that doesn't compile is reported with its diagnostics, same as every other command — it
can't be coverage-checked. A missing `--tests <dir>` is a hard CLI error (no default guessing).

Example output:

```
$ em coverage model.em --tests test/
slice "checkout" (ready-to-implement):
  cited     INV-CHK-1
              test/checkout.test.ts:42
  uncovered INV-CHK-2
2 invariant(s) checked, 1 uncovered
$ echo $?
0
$ em coverage model.em --tests test/ --strict
...
$ echo $?
1
```

**`--json` shape** (`coverageSchemaVersion: "1.0"`, versioned independently of the npm package
and every other command's own schema):

- `generator` — `{ name, version }` of the tool that produced the document.
- `file` / `testsDir` — the inputs, verbatim.
- `ok` — `true` when every in-scope invariant ID has at least one citation (advisory verdict;
  independent of whether `--strict` was passed).
- `summary` — `{ totalInvariants, cited, uncovered }`, across every in-scope slice.
- `slices` — `{ key, status, docReason, inScope, invariants }[]`, one entry per slice in the
  model (including out-of-scope ones, for transparency):
  - `status` — the joined doc's `status`, or `null` when no usable doc was found.
  - `docReason` — the `resolveSliceDocJoin` join reason behind a `null` `status`:
    `"no-doc-bound"`, `"binding-missing-file"`, or `"frontmatter-invalid"` — or `null` when the
    doc joined cleanly (whether or not the slice is in scope; a `draft` slice with a perfectly
    good doc still has `docReason: null`). Lets a reader tell "nothing bound yet" apart from
    "bound but broken" without re-deriving the join.
  - `inScope` — `true` only when the doc was found, usable, and `status` is
    `ready-to-implement` or `implemented`.
  - `invariants` — `{ id, cited, citations }[]`, empty for an out-of-scope slice. `citations` is
    `{ file, line }[]`, relative to `testsDir`.

## `em status <files...>`

One deterministic command that answers "what state is the system in" over one or more models
(MIL-163) — the rollup a reader currently has to assemble by hand from the README's Slices
table, a conformance report, and `.event-modeling.md` (two of which are hand-maintained or
regenerated on demand). Pure aggregation over facts every other `em` command already computes —
nothing here re-derives a rule another module owns:

- **slices by lifecycle status** — the same doc join `em export`/`em coverage` use
  (`resolveSliceDocJoin`), bucketed into the 4 canonical statuses
  (`draft`/`reviewed`/`ready-to-implement`/`implemented`) plus `no-doc` (nothing bound at all, or
  a binding naming a missing file) and `frontmatterInvalid` (a doc *was* bound and found, but its
  frontmatter is missing or malformed — kept distinct from `no-doc`, since "nothing was ever
  referenced" and "something's referenced but broken" are different states worth telling apart)
  and `unknown` (a found, *usable* doc whose `status` isn't one of the 4 canonical strings).
- **`driftSignal` breakdown** — the same status/`implementedIn` coherence classification
  `em export`'s `slice.doc.driftSignal` carries (`catalog/driftSignal.ts`): `inSync`,
  `neverImplemented`, `unpropagatedDelta`, `implementedWithoutLink`, tallied across every slice
  with a usable doc. Two buckets exist for "nothing to classify," mirroring the status split
  above: `notApplicable` (no doc found at all) and `frontmatterInvalid` (a doc found, but
  unusable) — always equal to `slices.byStatus.frontmatterInvalid`, since it's the same slices in
  both dimensions.
- **invariant coverage totals** — `em coverage`'s own report builder, summed across every input
  model. Opt-in: only computed when `--tests <dir>` is given (see below).
- **open `issue` markers + unchecked Open Questions** — the same `issue "text"` predicate
  `em validate --list-issues` counts, and the same GFM-task-list count
  (`slices/<key>.md`'s `## Open Questions`) `--slice-ready`'s gate reads. A doc shared by several
  slices via MIL-121 `covers:` cross-binding (one doc ratifying coverage for more than one slice)
  is only counted **once** — an Open Question belongs to the doc, not to each slice bound to it,
  so a shared doc's single unresolved question doesn't inflate the total once per covering slice.
- **last-conformance revision, with computed commits-behind-HEAD** — reads each model's sibling
  state file's `Last conformance:` marker (`stateFile.ts`, same parser `em conform-scope`/
  `em state read` use), then walks `git rev-list --count <revision>..HEAD` in the target repo
  (the same injectable-git-runner convention `em conform-scope`'s own walk uses) — see `--repo`
  below for which repo that is.

A missing sibling state file is routine, not an error (not every model has reached the
`conform` phase) — that model's conformance entry just reports `hasStateFile: false`. A git
failure (not a repo, unknown revision), an unparseable state file, or a state file whose own
`Model file:` bullet names a *different* file are all carried as that entry's own `error` string
rather than aborting the whole rollup — `em status` is a soft report, not a gate, and one model's
broken conformance history shouldn't hide every other model's numbers. The `Model file:` check
matters because a state file is shared by every `.em` in its directory but describes exactly one
of them: without it, a `conform-scope --seed-asis` scratch copy (`checkout-asis.em`, sitting next
to `checkout.em`) would silently inherit `checkout.em`'s own conformance record just for being a
sibling file — `em status checkout-asis.em` instead reports `lastConformance: null` and an
`error` naming the mismatch.

Every input model must still compile without errors — same convention as `em glossary`/
`em catalog`: `em status` refuses (exits non-zero, prints each offending file's diagnostics)
if any input file has one, since there's no slice list to aggregate from a model that didn't
compile. Doc-join diagnostics (`binding-missing-file`/`frontmatter-invalid` warnings, the same
ones `em export`'s doc join raises) are never fatal, but they're never silently dropped either —
each is printed to stderr (tagged with the file it concerns) and carried in `diagnostics` in the
JSON document below, so a `frontmatterInvalid` count in `slices.byStatus` always has a matching
diagnostic explaining exactly which doc is broken and why.

Multiple input files are also when `em status` checks for a **cross-model slice-doc collision**
(MIL-160, see [Multi-model projects](#multi-model-projects) above): two files sharing a
directory whose compiled slice keys overlap would both resolve to the same `slices/<key>.md`.
When that happens, a `cross-model-slice-doc-collision` warning (also never fatal) is printed and
added to `diagnostics`, same channel as the doc-join warnings above.

**Deterministic core.** No LLM calls, no wall-clock timestamps in the output — byte-identical
for the same models/tests/git state, same posture as `em export`/`em diff`.

| Flag | Effect |
|---|---|
| `--tests <dir>` | Directory to scan for `INV-*` test citations — enables invariant coverage totals (omitted: `invariants` is `null`) |
| `--repo <path>` | Git repo to compute commits-behind-HEAD in (default: each model's own directory — the common single-repo project case; pass this when the implementation lives in a different repo, same convention as `em conform-scope --repo`) |
| `--json` | Print a JSON document instead of the text report (see below) |
| `--md` | Print a markdown block suited for README embedding |
| `--badge` | Print a generated SVG badge |
| `-o, --out <path>` | Write the output to a file instead of stdout |

`--json`/`--md`/`--badge` are mutually exclusive (a clear usage error if more than one is
passed); the default with none of them is the text report.

```bash
em status model.em                              # text report, no invariant coverage
em status model.em --tests test/                # text report, invariant coverage included
em status model.em --tests test/ --json          # machine-readable form
em status model.em --md                          # markdown block for a README
em status model.em --badge -o status.svg         # generated SVG badge, written to a file
em status checkout.em billing.em --tests test/   # aggregate over several models
```

Example text report:

```
$ em status model.em --tests test/
8/8 implemented · 20/20 invariants covered · 0 open issues · last conformed abc123f, 0 commits behind HEAD

slices: 8 total — 8 implemented, 0 ready-to-implement, 0 reviewed, 0 draft, 0 no doc, 0 frontmatter invalid, 0 unknown status
driftSignal: 8 in-sync, 0 never-implemented, 0 unpropagated-delta, 0 implemented-without-link, 0 n/a (no doc), 0 n/a (frontmatter invalid)
invariants: 20/20 covered (0 uncovered) — test/
issues: 0 open issues, 0/0 open question(s) unchecked
conformance: last conformed abc123f, 0 commits behind HEAD
```

A `doc issues: N warning(s) — see diagnostics (<codes>)` line is appended when any doc-join
diagnostic was raised (see `diagnostics` below) — omitted entirely when there are none, same
"nothing to report" convention as the rest of the detail block.

The first line is the rollup MIL-163 was written to make printable — `8/8 implemented · 20/20
invariants covered · 0 open issues · last conformed <rev>, N commits behind HEAD`. For more than
one input model, that line's conformance clause reports the *first* file's entry (a single-model
invocation is the common case it's written for); the full per-model breakdown is always in the
detail block below it, and in `--json`, regardless of file count.

**`--json` shape** (`statusSchemaVersion: "1.0"`, versioned independently of the npm package and
every other command's own schema — this is also the exact document the MCP `status` tool returns,
see [mcp.md](mcp.md)):

```json
{
  "statusSchemaVersion": "1.0",
  "generator": { "name": "@milehimikey/em", "version": "…" },
  "files": ["model.em"],
  "slices": {
    "total": 8,
    "byStatus": {
      "draft": 0, "reviewed": 0, "readyToImplement": 0, "implemented": 8,
      "noDoc": 0, "frontmatterInvalid": 0, "unknown": 0
    }
  },
  "driftSignal": {
    "inSync": 8, "neverImplemented": 0, "unpropagatedDelta": 0, "implementedWithoutLink": 0,
    "notApplicable": 0, "frontmatterInvalid": 0
  },
  "invariants": { "testsDir": "test/", "total": 20, "cited": 20, "uncovered": 0 },
  "issues": { "openIssues": 0, "openQuestionsTotal": 0, "openQuestionsUnchecked": 0 },
  "conformance": [
    {
      "file": "model.em",
      "modelDir": ".",
      "hasStateFile": true,
      "lastConformance": { "date": "2026-08-01", "revision": "abc123f" },
      "repo": ".",
      "commitsBehindHead": 0,
      "error": null
    }
  ],
  "diagnostics": []
}
```

`invariants` is `null` when `--tests <dir>` wasn't given. `conformance` has one entry per input
file, in argument order; a model with no sibling state file reports `hasStateFile: false`,
`lastConformance: null`, `commitsBehindHead: null`, `error: null` — not an error, just nothing to
report yet. `error` is also set (non-null) — with `lastConformance`/`commitsBehindHead` both
`null` — when the state file's own `Model file:` bullet names a different file than the one being
reported on (see above); a consumer that needs to tell "no history yet" apart from "history
exists but couldn't be attributed/verified" should check `error`, not just `lastConformance`.

`diagnostics` (added for the PR #116 review pass) carries every doc-join warning
(`binding-missing-file`/`frontmatter-invalid`) raised while resolving each slice's doc, across
every input file: `{ file, severity, code, message, line, refs }` — the same serialized shape
`em export`/`em diff --json` use, plus `file` since this is a multi-model surface. Empty when
every bound doc joined cleanly.

**`--md`** prints a small `| Metric | Value |` table — one row each for slices, invariants, open
issues, open questions, and one "Last conformed" row per input model (a single label when there's
one model, `Last conformed (<file>)` per model when there's more than one). It's a plain block,
not marker-managed like `em slice index`'s README table — where (or whether) to embed it is left
to the caller.

**`--badge`** prints a self-contained, dependency-free flat-style SVG badge (`em status` on the
left, a compact `N/M implemented · N/M invariants · N issues` message on the right). Color
contract:

| Color | Meaning |
|---|---|
| red `#e05d44` | A genuine problem: an open issue, an uncovered invariant, a `frontmatterInvalid` doc, or `implementedWithoutLink` drift (a doc claiming `implemented` with nothing linking to it). |
| yellow `#dfb317` | Things are merely in flight, **or conformance couldn't be verified**: not every slice implemented yet, an unchecked Open Question, any model with `commitsBehindHead > 0`, or any conformance entry carrying a non-null `error` (an unresolvable revision, an unparseable state file, a `--repo` that isn't a git repo, or a state-file `Model file:` mismatch). |
| green `#4c1` | Otherwise. |

The yellow/`error` rule (added for the PR #116 review pass) matters because `commitsBehindHead`
is `null` both when conformance is genuinely current-and-unverified-for-another-reason *and* when
it simply couldn't be computed — those are different facts, and `null ?? 0` must never be allowed
to read as "0 commits behind" and paint the badge green. A model with **no conformance history at
all** (`hasStateFile: false`, or `Last conformance: never` — both `error: null`) is deliberately
NOT covered by that rule: it's a legitimate, unremarkable state ("hasn't reached the `conform`
phase yet," not "broken"), so it stays eligible for green same as before. Badge text width is a
fixed per-character estimate, not a real font-metrics table — legible, not a claim of pixel parity
with shields.io.

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

Given more than one input model, `em catalog` also checks for a **cross-model slice-doc
collision** (MIL-160, see [Multi-model projects](#multi-model-projects) above): two input files
sharing a directory whose compiled slice keys overlap would both resolve doc lookups to the same
`slices/<key>.md` on disk. A `cross-model-slice-doc-collision` warning (never fatal — the build
still completes) is printed and added to the diagnostics `em catalog` prints after the build, the
same channel ref-collision warnings use. The documented one-directory-per-model layout never
triggers this.

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

## `em slice new <name>`

Scaffolds a fresh `slices/<key>.md` doc (MIL-97) — the filename key is `<name>` run through
`kebabSlug()`, the same slugging helper `em scaffold` uses, so the file can never drift from
what a `note "slices/<key>.md"` binding needs to match. Writes exactly the 5 frontmatter keys
[slice-doc-schema.md](slice-doc-schema.md#required-vs-optional-by-status) requires at
`status: draft` — `schemaVersion`, `pattern`, `swimlane`, `status`, `version` — no more: no
`implementedIn` (only required once a slice has ever reached `implemented`), no lineage keys
(`split-from`/`merged-from`/`superseded-by` only apply to a split/merge/rename doc), no
commented-out guidance. Body is just the `# Slice: <name>` heading and the diagram-image stub;
every judgment section (Intent, Command, Scenarios, Open Questions, ...) is deliberately left
for hand-authoring, matching `templates/slice.md` — this command mechanizes only the part that
was silently drifting when hand-typed (a placeholder left unedited, a key forgotten).

`--pattern` and `--swimlane` are both required — no placeholder fallback on omission, since a
guessed default would reintroduce the exact drift this command exists to kill. `--pattern` is
validated against the same 4-value enum as the schema's `pattern` key; an invalid value is a
clear error listing the valid choices, non-zero exit.

Creates `slices/` if it doesn't exist yet. Does **not** touch the model's `.em` source — writing
a brand-new file is safe to automate blindly, but editing existing `.em` text isn't, so the
command instead prints the exact `note "slices/<key>.md"` line to add to the slice's primary
element by hand.

| Flag | Effect |
|---|---|
| `--pattern <pattern>` | **Required.** `state-change` \| `state-view` \| `automation` \| `translation` |
| `--swimlane <swimlane>` | **Required.** Free text, conventionally `<Persona> → <Context>` |
| `-f, --force` | Overwrite the file if it already exists |

```bash
em slice new "Request Payment" --pattern automation --swimlane "System → Payment"
# -> writes slices/request-payment.md, prints the note "slices/request-payment.md" line to add
```

## `em slice index <file>`

Rewrites the marker-delimited Slices table in the model's sibling `README.md` (MIL-98) — the
"ONE place slices are enumerated" a model README carries (see `templates/model-readme.md`).
Every column comes from the same code paths `em export`/`em catalog` already use — export key,
AST-derived pattern (`classifySlicePattern`), and the slice-doc frontmatter join
(`resolveSliceDocJoin`) — never a second, hand-authored parse. This replaces hand-maintaining
the table by the `event-modeling` skill's `slice`/`implement` phases.

`README.md` is looked up next to `<file>`, same sibling convention as `slices/*.md`. Both the
file and the `<!-- GENERATED:slices:start -->` / `<!-- GENERATED:slices:end -->` marker pair
around the table must already exist — `em slice index` never creates either, so a missing
README or missing markers is a clear error naming the expected path/fix rather than a silent
file write. New models scaffolded from `templates/model-readme.md` already carry the marker
pair around an empty table.

| Column | Source |
|---|---|
| `#` | Row position (declaration order) |
| `Slice` | Slice name |
| `Pattern` | `em export`'s `pattern` (State Change / State View / Automation / Translation / Unclassified) |
| `Status` | The bound doc's `status`, `"unknown"` for a found-but-unusable doc (no/invalid frontmatter), or `"no doc yet"` when no doc is bound at all — same found/status split `em catalog`'s Status column uses, just with "no doc yet" instead of "no doc" |
| `Ratified by` | The doc's `ratifiedBy` (MIL-165), or `—` |
| `Implemented in` | The doc's `implementedIn`, or `—` |
| `Design doc` | Always a link to the conventional `slices/<slice-key>.md` path, whether or not that file exists yet |

| Flag | Effect |
|---|---|
| `--check` | Verify the table is current; exit non-zero on drift without writing (CI) |

```bash
em slice index model.em          # rewrite README.md's Slices table
em slice index model.em --check  # CI: fail if it's stale, never writes
```

Any input-model error (parse/validation) is reported and exits 1 before touching the README, same
as every other command. A `binding-missing-file`/`frontmatter-invalid` doc-join warning (a slice
notes a doc that's missing or malformed) prints the same way `em export` prints it — the table
still gets written, with that slice's Status reading `"no doc yet"`/`"unknown"` accordingly.

## `em slice ratify <file> <slice-key> --by <name>`

Makes "who ratified, and when" a first-class recorded fact (MIL-165) instead of an unnamed edit
anyone with commit access could make — see [process.md#what-ratified-means](process.md#what-ratified-means).
Sets three frontmatter fields on the doc resolved from `<slice-key>` via the same note-binding
join `mark-implemented`/`--slice-ready`/`em export` use (`resolveSliceDocJoin` — MIL-121
cross-binding included, so the file actually edited may be a *different* slice's doc when this
slice's doc is only reached via a ratified `covers:` entry):

```yaml
status: ready-to-implement
ratifiedBy: <name>
ratifiedOn: <date>
```

`--by <name>` is required — free text, typically a person's name (spaces are fine; unlike a
PR URL, a name legitimately contains them). `--on <date>` is optional, `YYYY-MM-DD`; defaults to
today (same convention `em state set-review`'s date argument uses). `ratifiedBy`/`ratifiedOn`
are additive, optional frontmatter keys (docs/slice-doc-schema.md) — a doc that predates this
feature, or was hand-ratified, simply has neither key, and every existing `em` command already
tolerates an unknown/absent field.

Never touches `version:` or the doc body: the write is a surgical in-place edit of just the
`status:`/`ratifiedBy:`/`ratifiedOn:` lines (inserting whichever of `ratifiedBy:`/`ratifiedOn:`
the doc doesn't have yet, right after `status:`), same as `em slice mark-implemented` — not a
parse-and-re-serialize, so every other line — key order, spacing, comments, the whole body —
survives byte-for-byte.

Idempotent: re-running with the same `--by`/`--on` pair once the doc is already
`status: ready-to-implement` with both recorded is a no-op (reports as such, exits 0). Refuses,
non-zero exit, leaving the file untouched, if the doc is already `status: ready-to-implement`
with a **different** `ratifiedBy`/`ratifiedOn` already recorded — this command never silently
overwrites provenance, same discipline `mark-implemented` holds for `implementedIn`. There's no
such refusal when `status` isn't already `ready-to-implement`: re-ratifying a slice that has
since moved on (e.g. back from `implemented` after a version bump — see
[slice-doc-schema.md#status-under-re-ratification](slice-doc-schema.md#status-under-re-ratification))
is the ordinary, expected use of this command, so it always applies cleanly in that case.

Scoped the same way `em export --slice`/`em validate --slice-ready`/`mark-implemented` are: only
a model error concerning THIS slice (its bare export key, or an element ref prefixed `<key>/`)
refuses — an unrelated slice's breakage elsewhere in a large, still-WIP model doesn't block it.

| Flag | Effect |
|---|---|
| `--by <name>` | **Required.** The ratifier's name |
| `--on <date>` | Ratification date, `YYYY-MM-DD` (default: today) |

| Error | Meaning |
|---|---|
| `no slice with export key "<key>" in this model` | `<slice-key>` isn't a known export key |
| `slice "<key>" has no doc bound via ...` | No `note "slices/<key>.md"` (or ratified cross-binding) resolves a doc |
| `slice "<key>" notes "..." but no such file exists` | The bound note names a file that isn't there |
| `slice doc "..." has missing or invalid frontmatter` | No fence, or missing a required key (`em validate` explains which) |
| `already ratified by ... — refusing to overwrite` | The idempotent/refusal guard — see above |
| `invalid --on date "..."` | `--on` didn't match `YYYY-MM-DD` |

```bash
em slice ratify model.em request-payment --by "Alex Rivera"
em slice ratify model.em request-payment --by "Alex Rivera" --on 2026-08-28
```

**CODEOWNERS.** `em slice ratify` mechanizes the *edit*; it can't by itself stop an
un-designated person from making the same edit by hand. Route `slices/**` through a
[CODEOWNERS](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)
entry naming your team's ratifiers so the platform enforces the review — see
[ci.md#codeowners-routing-ratification-review](ci.md#codeowners-routing-ratification-review).

## `em slice mark-implemented <file> <slice-key> <pr-url>`

The lifecycle flip a ratified slice's doc gets at merge (MIL-103) — see
[reference/implement.md §6](../.claude/skills/event-modeling/reference/implement.md). Sets
exactly two frontmatter fields on the doc resolved from `<slice-key>` via the same note-binding
join `--slice-ready`/`em export` use (`resolveSliceDocJoin` — MIL-121 cross-binding included, so
the file actually edited may be a *different* slice's doc when this slice's doc is only reached
via a ratified `covers:` entry):

```yaml
status: implemented
implementedIn: <pr-url>
```

Never touches `version:` — a bump here is an `em ledger` defect, since `version` moves only when
a delta is ratified, not at merge — and never touches the doc body: the write is a surgical
in-place edit of just the `status:`/`implementedIn:` lines (inserting `implementedIn:` fresh,
right after `status:`, if the doc doesn't have one yet), not a parse-and-re-serialize, so every
other line — key order, spacing, comments, the whole body — survives byte-for-byte.

Idempotent: re-running with the same `<pr-url>` is a no-op (reports as such, exits 0). Refuses,
non-zero exit, leaving the file untouched, if the doc is already `status: implemented` with a
**different** `implementedIn` — this command never silently overwrites provenance. There's no
starting-status precondition otherwise (unlike `--slice-ready`, which gates *starting*
implementation on `ready-to-implement`): this is supply-loop mechanics, not a ratification gate,
so it flips from whatever status the doc is currently in.

Scoped the same way `em export --slice`/`em validate --slice-ready` are: only a model error
concerning THIS slice (its bare export key, or an element ref prefixed `<key>/`) refuses —
an unrelated slice's breakage elsewhere in a large, still-WIP model doesn't block it.

| Error | Meaning |
|---|---|
| `no slice with export key "<key>" in this model` | `<slice-key>` isn't a known export key |
| `slice "<key>" has no doc bound via ...` | No `note "slices/<key>.md"` (or ratified cross-binding) resolves a doc |
| `slice "<key>" notes "..." but no such file exists` | The bound note names a file that isn't there |
| `slice doc "..." has missing or invalid frontmatter` | No fence, or missing a required key (`em validate` explains which) |
| `already marked implemented with a different URL` | The idempotent/refusal guard — see above |

```bash
em slice mark-implemented model.em request-payment https://github.com/org/repo/pull/42
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

## `em state`

Reads and writes the **mechanical** fields of a model's state file (`.event-modeling.md`,
see [ai-workflow.md](ai-workflow.md) and the `event-modeling` skill's `templates/state.md`):
`Model file:`, `Current phase:`, `Current step:`, `Last updated:`, `Last conformance:`, `Last
stakeholder review:`. This is the enforcement point for the phase enum and for the exact
`Last conformance:`/`Last stakeholder review:` formats the skill's `conform`/`review` phases
depend on — hand-editing these bullets risks a typo the next resume/conform run can't parse.

Everything else in the file — Session inputs, Participants, Decisions log, Usage log, Open
questions, Slice inventory — is agent-authored prose and stays out of `em state`'s reach;
every writer below touches only its one targeted bullet (plus `Last updated:`), leaving every
other byte of the file untouched.

**Locating the state file.** Every subcommand takes an optional `[dir]` (default: the current
directory) — either the model directory containing `.event-modeling.md`, or a direct path to
that file itself (its basename is checked against `.event-modeling.md` exactly). All four
subcommands fail clearly, non-zero, if the file — or the bullet a writer targets — is missing.

### `em state read [dir]`

Prints the six mechanical fields as JSON on stdout:

```json
{
  "modelPath": "order-fulfillment.em",
  "phase": "discover",
  "step": "1",
  "lastUpdated": "2026-08-20",
  "lastConformance": null,
  "lastReview": null
}
```

`lastConformance` is `null` for the template's `never` marker, otherwise `{ "date", "revision",
"report" }` parsed from the `Last conformance:` bullet. `lastReview` is `null` for `never`,
otherwise the `YYYY-MM-DD` at the start of the `Last stakeholder review:` bullet.

### `em state set-phase <phase> [dir]`

Rewrites `Current phase:` (and `Last updated:`) to today. `<phase>` must be one of the
canonical phases — `discover | extract | model | slice | implement | conform | review |
validate` (the same list `templates/state.md`'s placeholder documents) — an invalid value is
refused with the full list. `--step <n>` additionally rewrites `Current step:`.

| Flag | Effect |
|---|---|
| `--step <n>` | Also rewrite `Current step:` to this value |

```bash
em state set-phase slice my-model/
em state set-phase implement my-model/ --step 3
```

### `em state set-conformance <revision> [dir]`

Rewrites `Last conformance:` (and `Last updated:`) to the exact format
[reference/conform.md](../.claude/skills/event-modeling/reference/conform.md)'s scoping step
parses back out:

```
- **Last conformance:** <today> @ <revision> — report: <report>
```

`--report <path>` is required.

| Flag | Effect |
|---|---|
| `--report <path>` | Path to the conformance report just written (required) |

```bash
em state set-conformance abc123f my-model/ --report conformance/2026-08-20-report.md
```

### `em state set-review <date> [dir]`

Rewrites `Last stakeholder review:` (and `Last updated:`) to `<date> — attendees: see
Participants`, matching `templates/state.md`'s format. `<date>` must look like `YYYY-MM-DD`
(month/day range-checked, not a full calendar) — an invalid value is refused.

```bash
em state set-review 2026-08-20 my-model/
```

## `em conform-scope <file>`

Mechanizes the mechanical half of
[reference/conform.md](../.claude/skills/event-modeling/reference/conform.md)'s conform-phase
step 1 ("Scope") — reading the `Last conformance:` marker, running `git diff --name-only` in
the target repo, and mapping the changed paths to slices via each slice doc's `implementedIn` —
so the agent no longer does this by hand. Prints one JSON document to stdout:

```json
{
  "lastConformance": { "date": "2026-08-01", "revision": "abc123f" },
  "changedPaths": ["src/checkout/CheckoutHandler.kt", "README.md"],
  "candidateSlices": [
    { "key": "checkout", "matchedBy": "implementedIn", "paths": ["src/checkout/CheckoutHandler.kt"] }
  ],
  "unmappedPaths": ["README.md"]
}
```

| Field | Meaning |
|---|---|
| `lastConformance` | The state file's `Last conformance:` marker, parsed via `em state read`'s same `stateFile.ts` (`{ "date", "revision" }`), or `null` for the `never` marker (first run). Always echoed back as parsed, even under `--full`. |
| `changedPaths` | `git diff --name-only <lastConformance.revision>..HEAD` in `--repo`, repo-root-relative. `[]` when scoping in full mode (see below) — not omitted, so the JSON shape stays stable across modes. |
| `candidateSlices` | Slices the tool placed deterministically. `matchedBy: "implementedIn"` (diff-scoped mode) carries the subset of `changedPaths` that slice's doc `implementedIn` names; `matchedBy: "full"` (full mode) carries an empty `paths` — every `status: implemented` slice is in scope, not a specific changed path. |
| `unmappedPaths` | `changedPaths` matched by no slice — hand to agent judgment (grep fallback, evidence walks per `reference/conform.md`). Always `[]` in full mode. |

**Scoping mode.** Diff-scoped by default: when `lastConformance` is set and `--full` isn't
passed, `changedPaths` is fetched from `--repo` and mapped to slices. Full mode — every
`status: implemented` slice, `changedPaths`/`unmappedPaths` both `[]` — kicks in when
`lastConformance` is `null` (first run, matching `reference/conform.md` step 1) or `--full` is
passed.

**The `implementedIn` -> path matching rule** is deliberately conservative and never guesses: a
slice doc's `implementedIn` value counts as naming a changed path only when, after stripping a
leading `./`/trailing `/`, it's textually equal to that path or a directory prefix of it (e.g.
`implementedIn: src/checkout` matches `src/checkout/CheckoutHandler.kt`). A URL or SCP-style git
remote (`https://…`, `git@host:…` — the common PR/commit-link shape) carries no repo-relative
path information, so it deterministically matches nothing. There's no grep fallback here on
purpose — that judgment call belongs to the agent, one level up (`reference/conform.md` step 1).

| Flag | Effect |
|---|---|
| `--repo <path>` | Path to (or inside) the target codebase's git repository (required) |
| `--full` | Ignore `Last conformance:`/changed paths; scope every `implemented` slice |
| `--seed-asis` | Also seed the conform-phase scratch model (see below) |

```bash
em conform-scope my-model.em --repo ../target-repo
em conform-scope my-model.em --repo ../target-repo --full
em conform-scope my-model.em --repo ../target-repo --seed-asis
```

**`--seed-asis`** mechanizes the OTHER mechanical convention conform-phase step 1 describes:
byte-copies the canonical model to `<dirname(file)>/<stem>-asis.em`, and makes sure `*-asis.em`
is listed in the model's own repository's root `.gitignore` (creating the file, or appending the
line, only if it isn't already present anywhere in it — never duplicated). Reports what it did
as an additional `seeded` key in the JSON, omitted entirely when the flag isn't passed:

```json
{ "seeded": { "asisPath": "my-model-asis.em", "gitignoreUpdated": true } }
```

Any input-model error (parse/validation) is reported and exits 1 before any git call or file
write, same as every other command. A missing state file, an unparsable `Last conformance:`
bullet, a `--repo` that isn't a git repository, or an unknown revision in `Last conformance:`
each exit 1 with a clear message.

## `em contract`

Prints the packaged implementation contract — `reference/implement.md` from the skill
directory bundled with whatever `em` package is currently installed — to stdout, verbatim
(MIL-129).

`reference/implement.md` says up front that it applies to "any implementing agent, whether or
not the session started from `/event-modeling`" — but until this command, the only way to
reach it was `em skill install`/`em skill sync` copying it into
`.claude/skills/event-modeling/`, a path only Claude Code discovers. `em contract` needs no
vendored skill copy and no `.claude/` awareness at all: any agent that can run a shell gets
the contract straight from the installed package.

```bash
em contract                 # print the contract to stdout
em contract > CONTRACT.md   # or capture it to a file
```

No flags, no exit code other than 0 (or a failure reading the package's own bundled files,
which would mean a broken installation). See
[the bundled contract itself](../.claude/skills/event-modeling/reference/implement.md) for
its content, and the "Working with an AI agent" section below for how `em skill install`/
`em skill sync` point a repo's `AGENTS.md` at it.

## `em mcp`

Starts an MCP (Model Context Protocol) server over stdio, exposing the same structured JSON
surfaces `--json`/`em export`/`em contract` print — as MCP tools instead of shell commands
(MIL-21). A 3-line wrapper around the same server the `em-mcp` bin starts; the server itself
lives outside the CLI core (`src/mcp/`) and never imports `cli.ts`.

```bash
em mcp   # or: em-mcp
```

See [mcp.md](mcp.md) for the full tool list, input/output shapes, and client configuration.

## `em skill install`

Copies the bundled `event-modeling` Claude Code skill out of the npm package into
`.claude/skills/event-modeling/` in the current directory. Prints a reminder to run
`/event-modeling` in Claude Code afterwards. See [ai-workflow.md](ai-workflow.md).

By default, also writes/updates the `AGENTS.md` agent-contract section (see "Working with an
AI agent" below, MIL-129) — pass `--no-agents-md` to skip that. This happens even when the
skill is already installed and `-f`/`--force` isn't given, so the skill copy itself is
skipped: `install` always ensures the `AGENTS.md` section unless opted out.

| Flag | Effect |
|---|---|
| `-f, --force` | Overwrite an existing installation |
| `--no-agents-md` | Skip writing/updating the `AGENTS.md` agent-contract section |

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

By default, also writes/updates `[path]/AGENTS.md`'s agent-contract section (see "Working with
an AI agent" below, MIL-129) — pass `--no-agents-md` to skip that.

| Flag | Effect |
|---|---|
| `--no-agents-md` | Skip writing/updating the `AGENTS.md` agent-contract section |

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

## `em ci init <model>`

Installs the CI enforcement preset [docs/ci.md](ci.md) describes as a cookbook — two plain
GitHub Actions workflow files under `.github/workflows/`, wiring `em`'s own checks so a repo
gets them by running one command instead of copy-pasting YAML (MIL-166):

| File | Triggers | Jobs |
|---|---|---|
| `em-ci.yml` | `pull_request` (paths touching `**/*.em`, `**/slices/**`, `**/README.md`), `push` to `main` | `validate`, `slice-index`, `coverage`, `ledger`, `skill-check`, `glossary` — all PR merge gates; `status-badge` — push-triggered, publish-only, never a gate |
| `em-conform.yml` | `schedule` (weekly), `workflow_dispatch` | `conform` — advisory only, see [ci.md#conformance-cadence-advisory](ci.md#conformance-cadence-advisory) |

`<model>` is the anchor `.em` file the `slice index`/`coverage`/`ledger`/`status-badge` steps
point at (they each resolve `slices/` relative to it, the same convention every other
file-scoped command uses). `--tests <dir>` (default `test`) is the directory the `coverage` and
`status-badge` steps scan for `INV-*` citations.

| Flag | Effect |
|---|---|
| `--tests <dir>` | Test directory for the `coverage`/`status-badge` steps (default `test`) |
| `-f, --force` | Replace an existing workflow file that has no `GENERATED` markers |
| `--check` | Verify both files match the current preset; exit non-zero on drift without writing (CI) |

```bash
em ci init order-fulfillment/order-fulfillment.em
# installed .github/workflows/em-ci.yml
# installed .github/workflows/em-conform.yml
```

**Same install discipline as `em skill install`/`em slice index`:**

- **Marker-delimited.** Each file's job list sits between `# GENERATED:em-ci:start` /
  `# GENERATED:em-ci:end` (or `em-conform`) comment markers at column 0. Add your own jobs
  above or below the markers, at the same indent under `jobs:`, and a future `em ci init`
  (e.g. after upgrading `em`) refreshes only what's between them — your additions survive.
- **Idempotent.** Re-running with nothing changed leaves both files byte-identical. A file
  that already exists without the marker pair (a hand-written workflow at the same path) is
  left alone and reported, not an error — pass `-f`/`--force` to replace it wholesale.
- **`--check` for CI self-verification.** Never writes; reports `missing` / `stale` /
  `can't verify` (no markers) / `ok` for each file, CI-ready the same way `em slice index
  --check` is. The generated files are handed to the repo, not owned by `em` forever — past
  the initial `em ci init`, edit them freely. `--check` is there for a team that would rather
  pin the vanilla preset and gate on drift, the same opt-in posture `em skill check` already
  has in the cookbook above ("if you'd rather pin ... add `em skill check` as its own gate").

Every argument is validated against the shell-injection-relevant characters it would otherwise
carry into the generated workflow's `run:` steps (`"`, `` ` ``, `$`, a newline) — `em ci init`
refuses rather than emit a file with a broken (or exploitable) shell command.

## Working with an AI agent: the `AGENTS.md` managed section

`em skill install` and `em skill sync` both write/update a marker-delimited section in the
target repo's `AGENTS.md` by default (`--no-agents-md` to skip it) — the AGENTS.md-native
counterpart to the `event-modeling` Claude Code skill, so any implementing agent, not only
Claude Code, has a route to the implementation contract, the readiness gate, and the machine-
readable read path (MIL-129, Slicewright story gap G5). The section points at:

- **the contract**: `em contract`
- **the gate**: `em validate <model>.em --slice-ready <slice-key> --json`
- **the read path**: `em export <model>.em --slice <slice-key>` (and `em export <model>.em`
  for the whole model)
- **the MCP alternative**: `em-mcp` — the contract/gate/read-path above, plus full
  validate/export, as MCP tools instead of shell commands (see [mcp.md](mcp.md))

The markers are `<!-- GENERATED:agent-contract:start -->` / `<!-- GENERATED:agent-contract:end
-->`, matching the `<!-- GENERATED:<name>:start/end -->` convention `em slice index` already
uses for a model README's Slices table (`src/util/markers.ts`). Behavior:

- **No `AGENTS.md`** — created with just the managed section.
- **`AGENTS.md` exists with the markers** — only the region between them is rewritten; content
  outside the markers (and everywhere else in the file) is untouched.
- **`AGENTS.md` exists without the markers** — the section is appended, rather than refused;
  unlike `em slice index`'s README gate, there's no "scaffold it first" step to point at.

Every case is idempotent: a repeat `em skill sync` with nothing else changed leaves `AGENTS.md`
byte-identical.
