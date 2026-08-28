<!-- DSL behavior change? Update BOTH docs/dsl.md and .claude/skills/event-modeling-shared/reference/em-dsl.md -->

# `em` DSL Reference & Cheatsheet

The `em` tool (`@milehimikey/em`) is a slice-first text DSL rendered to a strict Graphviz
swimlane grid. Use this reference so the models you generate are **valid** and render cleanly.
Keep `.em` files focused on **structure**; put deep design in markdown linked via `note`.

---

## CLI

<!-- GENERATED:cli:start -- run `npm run docs:generate` to refresh, do not hand-edit -->
```bash
em --version                                                  # print the installed em version
em init [file]                                                # scaffold a starter .em model
em init [file] -f, --force                                    # overwrite if the file exists
em scaffold <name>                                            # scaffold a full project: <slug>/<slug>.em, README.md, .event-modeling.md (see docs/cli.md — for just a starter .em, use `em init`; for a multi-model project, pass --under to nest it under a shared parent directory)
em scaffold <name> -f, --force                                # overwrite the directory's contents if it already exists
em scaffold <name> --under <dir>                              # parent directory to scaffold into — writes <dir>/<slug>/ instead of ./<slug>/, the supported multi-model layout (docs/cli.md, "Multi-model projects"): one directory per model, so each model's slices/ never collides with a sibling model's
em render <file>                                              # transpile a model and render it (or emit DOT)
em render <file> -o, --out <path>                             # output path (extension picks the format)
em render <file> -T, --format <fmt>                           # output format (svg, png, pdf, ...)
em render <file> --slice <name>                               # render only this slice, redrawn in its own canonical pattern shape (default out: slices/<kebab-slug>.svg)
em render <file> --emit-dot                                   # print the generated DOT instead of rendering
em render <file> --keep-empty-lanes                           # keep the API lane even when empty
em export <file>                                              # export a versioned JSON snapshot of the normalized model
em export <file> -o, --out <path>                             # write to a file instead of stdout
em export <file> --slice <key>                                # export only this slice's object (pattern/fields/doc) instead of the whole model (export key, MIL-128) — refuses only if THIS slice has an error; an unrelated slice's breakage elsewhere in the model doesn't block it (see docs/cli.md)
em typespec <file>                                            # EXPERIMENTAL/POC (MIL-159): generate a TypeSpec contract for a model's commands, public events, and public views (see docs/cli.md)
em typespec <file> -o, --out <path>                           # write to a file instead of stdout
em diff <old> [new]                                           # compare two models structurally (two files, or one file across git revisions)
em diff <old> [new] --from <rev>                              # diff <old> against this git revision instead of a second file
em diff <old> [new] --to <rev>                                # diff against this git revision instead of the current file (requires --from)
em diff <old> [new] --exit-code                               # exit 1 if the models differ, 0 if identical (git-diff convention)
em diff <old> [new] --json                                    # print a JSON document instead of the text report (see docs/cli.md)
em glossary <files>                                           # cross-model glossary of terms, with consistency checks across models (see docs/cli.md)
em glossary <files> --json                                    # print the full glossary document instead of the text report
em glossary <files> -o, --out <path>                          # write the JSON document to a file instead of stdout (requires --json)
em glossary <files> --list-conflicts                          # print only the conflict lines, no summary
em glossary <files> --fail-on-conflicts                       # exit non-zero if any cross-model term conflicts were found (opt-in — conflicts are warnings and don't block by default)
em catalog <files>                                            # generate a browsable static HTML catalog site over one or more .em models (see docs/cli.md)
em catalog <files> -o, --out <dir>                            # output directory
em catalog <files> -T, --format <fmt>                         # diagram format embedded in the catalog (svg or png)
em catalog <files> --title <text>                             # catalog site title
em catalog <files> --keep-empty-lanes                         # keep the API lane even when empty
em slice new <name>                                           # scaffold a fresh slices/<key>.md doc — the 5 frontmatter keys required at `status: draft` plus the `# Slice:` heading and diagram-image stub; judgment sections (Intent, Scenarios, Open Questions, ...) stay hand-authored (see docs/slice-doc-schema.md, templates/slice.md)
em slice new <name> --pattern <pattern>                       # slice pattern: state-change | state-view | automation | translation
em slice new <name> --swimlane <swimlane>                     # swimlane, e.g. "Persona → Context"
em slice new <name> -f, --force                               # overwrite the file if it already exists
em slice new <name> --wire <model-file>                       # also insert the `note "slices/<key>.md"` line onto the slice's primary element in this .em file (matched by export key), instead of just printing it to paste by hand (MIL-161)
em slice index <file>                                         # rewrite the model's sibling README.md's GENERATED Slices table from `em export`'s slice facts (key, pattern, doc status/implementedIn) — the hand-maintained table is deprecated
em slice index <file> --check                                 # verify the table is current; exit non-zero on drift without writing (CI)
em slice mark-implemented <file> <slice-key> <pr-url>         # flip a slice doc's frontmatter to `status: implemented` / `implementedIn: <pr-url>` — the one edit an implementing agent makes to a ratified doc at merge (MIL-103, replaces the em-sdd-bridge `em-sdd-mark-implemented` script; see reference/implement.md §6). Idempotent on the same URL; refuses to overwrite a different one; never touches `version:` or the doc body
em slice ratify <file> <slice-key>                            # flip a slice doc's frontmatter to `status: ready-to-implement` and record `ratifiedBy:`/`ratifiedOn:` — the handoff sign-off (MIL-165, docs/process.md#what-ratified-means) that makes who ratified, and when, a first-class recorded fact. Idempotent on the same --by/--on pair; refuses to overwrite a different one already recorded; never touches `version:` or the doc body
em slice ratify <file> <slice-key> --by <name>                # the ratifier's name
em slice ratify <file> <slice-key> --on <date>                # ratification date, YYYY-MM-DD (default: today)
em slice reratify <file> <slice-key>                          # bump `version:` and flip a shipped slice doc's frontmatter back to `status: ready-to-implement` — the re-ratification mechanical edit (MIL-161, mirrors `em slice mark-implemented`). Only applies to a doc at `status: implemented`; clears any stale `ratifiedBy:`/`ratifiedOn:` (they describe the PRIOR version's sign-off) so a follow-up `em slice ratify --by` applies cleanly; never touches `implementedIn:` or the doc body
em changelog <file>                                           # render a model's git history as a business-readable ledger (see docs/cli.md)
em changelog <file> --from <rev>                              # start the walk at this revision (inclusive)
em changelog <file> --to <rev>                                # end the walk at this revision (inclusive; default HEAD)
em changelog <file> -o, --out <path>                          # write to a file instead of stdout
em state read [dir]                                           # print the state file's mechanical fields as JSON
em state set-phase <phase> [dir]                              # rewrite Current phase: (and Last updated:); --step also rewrites Current step:
em state set-phase <phase> [dir] --step <n>                   # also set Current step: to this value
em state set-conformance <revision> [dir]                     # rewrite Last conformance: (and Last updated:) in the exact format reference/conform.md parses
em state set-conformance <revision> [dir] --report <path>     # path to the conformance report just written
em state set-review <date> [dir]                              # rewrite Last stakeholder review: (and Last updated:)
em state log-usage <file>                                     # append one Usage log line — phase(s) touched + em validate's diagnostic categories hit, deduped and canonically formatted (MIL-161, docs/usage-data.md) — the mechanical half of 'save state at the end of every session' that used to be run-validate-then-hand-format; state file resolved next to <file>, same convention as em conform-scope
em state log-usage <file> --phases <list>                     # comma-separated phase(s) touched this session: discover, extract, model, slice, implement, conform, review, validate, watch
em usage-report [root]                                        # aggregate every .event-modeling.md's Usage log under [root] into phase/diagnostic-category tallies (MIL-161) — replaces docs/usage-data.md's hand-rolled grep/awk/sort pipeline; a logged line that doesn't match the canonical em state log-usage format is reported under unparseableLines rather than silently mistallied or dropped
em usage-report [root] --json                                 # print a JSON document instead of the text report
em conform-scope <file>                                       # mechanize conform phase step 1 (reference/conform.md): map the target repo's changed paths since Last conformance: to slices via each slice doc's implementedIn, JSON to stdout — --seed-asis also seeds the <model>-asis.em scratch model (see docs/cli.md)
em conform-scope <file> --repo <path>                         # path to (or inside) the target codebase's git repository
em conform-scope <file> --full                                # ignore Last conformance:/changed paths; scope every implemented slice
em conform-scope <file> --seed-asis                           # write <model>-asis.em as a byte copy of the canonical model and ensure it's gitignored
em conform-supersede <file> <report-path>                     # stamp a conformance report with a "superseded as of <rev>" banner once its findings have been ruled on (MIL-164, docs/process.md#what-ratified-means) — the companion step to run at ratification time so a reader following the report's file:line citations knows they describe an ancestor of the current model. Additive-only splice, never a rewrite of the report; idempotent on the same --as-of/--findings/--on stamp; refuses if the report doesn't exist
em conform-supersede <file> <report-path> --as-of <rev>       # the revision this ruling was made against — same value passed to `em state set-conformance`
em conform-supersede <file> <report-path> --findings <spec>   # which finding number(s) this stamps as ruled, e.g. "1-3" or "1,2,4"
em conform-supersede <file> <report-path> --on <date>         # ruling date, YYYY-MM-DD (default: today)
em watch <file>                                               # re-render on every save
em watch <file> -o, --out <path>                              # output path (extension picks the format)
em watch <file> -T, --format <fmt>                            # output format (svg, png, pdf, ...)
em watch <file> --keep-empty-lanes                            # keep the API lane even when empty
em watch <file> --serve                                       # serve a live viewer with instant push-reload (no polling)
em watch <file> --port <n>                                    # port for --serve (default 5173)
em validate <file>                                            # check a model against event-modeling rules
em validate <file> --list-issues                              # print only open `issue` diagnostics (slice, element, line, text)
em validate <file> --list-divergences                         # print only accepted-divergence annotations (slice, element, line, text) — never fails the build
em validate <file> --list-public                              # print only events and views marked `public` (slice, kind, name, line) — an integration-surface audit, never fails the build
em validate <file> --fail-on-issues                           # exit non-zero if the model has any open `issue`s (opt-in — issues are warnings and don't block by default)
em validate <file> --slice-ready <key>                        # readiness gate for one slice (export key): status ready-to-implement, doc resolvable via note binding, zero unchecked Open Questions — exits non-zero if not ready (MIL-87)
em validate <file> --json                                     # print a JSON document instead of text — works on a model WITH errors, unlike `em export` (MIL-128, see docs/cli.md); exit codes are unchanged
em migrate <file>                                             # rewrite the old two-slice Automation/Translation shape into the merged single-slice shape MIL-120 made canonical (see docs/cli.md)
em migrate <file> --write                                     # apply the rewrite to the file (default: dry run — report only, write nothing)
em ledger <file>                                              # check slice docs' version: field agrees with their content across two git revisions (opt-in CI check, MIL-89 — never part of `em validate`, see docs/ci.md)
em ledger <file> --from <rev>                                 # baseline revision
em ledger <file> --to <rev>                                   # compare revision (default: current working tree)
em ledger <file> --json                                       # print a JSON document instead of the text report (see docs/cli.md)
em coverage <file>                                            # check that every INV-* invariant ID cited in a ready-to-implement/implemented slice doc is cited by a test under --tests <dir> (MIL-130) — mechanizes reference/implement.md's definition-of-done citation check; advisory by default, --strict for CI
em coverage <file> --tests <dir>                              # directory to scan recursively for test files citing invariant IDs
em coverage <file> --strict                                   # exit non-zero if any invariant ID has zero citations (CI)
em coverage <file> --json                                     # print a JSON document instead of the text report (see docs/cli.md)
em status <files>                                             # deterministic state-of-the-system rollup over one or more .em models: slices by lifecycle status, driftSignal breakdown, invariant coverage totals (with --tests), open issue markers + unchecked Open Questions, and last-conformance commits-behind-HEAD (MIL-163, see docs/cli.md)
em status <files> --tests <dir>                               # directory to scan for INV-* test citations — enables invariant coverage totals
em status <files> --repo <path>                               # git repo to compute commits-behind-HEAD in (default: each model's own directory)
em status <files> --json                                      # print a JSON document instead of the text report (see docs/cli.md)
em status <files> --md                                        # print a markdown block suited for README embedding
em status <files> --badge                                     # print a generated SVG badge
em status <files> -o, --out <path>                            # write output to a file instead of stdout
em freshness <file>                                           # standalone freshness signal for one model's conformance record (MIL-164): "last conformed <rev> — N commits and M slice-PRs behind HEAD", computed from the same conform-scope machinery `em status`'s conformance clause uses — for when you want just this fact, no full state-of-the-system rollup (see docs/cli.md)
em freshness <file> --repo <path>                             # git repo to compute behind-HEAD in (default: the model's own directory)
em freshness <file> --json                                    # print a JSON document instead of the text line
em contract                                                   # print the packaged implementation contract (reference/implement.md) to stdout — the agent-neutral discovery path for any agent that can run a shell, not just Claude Code (MIL-129); see docs/cli.md
em mcp                                                        # start an MCP (Model Context Protocol) server over stdio, exposing validate/slice_ready/list_markers/export_model/export_slice/coverage/contract as tools (MIL-21) — a structured, agent-facing alternative to shelling out to `em`; see docs/mcp.md. Equivalent to running the `em-mcp` bin directly
em skill install                                              # copy the event-modeling skill bundle into .claude/skills/ (event-modeling, event-modeling-discover/-design/-implement/-conform/-review, event-modeling-shared)
em skill install -f, --force                                  # overwrite an existing installation
em skill install --no-agents-md                               # skip writing/updating the AGENTS.md agent-contract section (on by default, MIL-129)
em skill sync [path]                                          # update the vendored .claude/skills/ event-modeling skill bundle in [path] to match the installed em package (overwrites unconditionally; local edits are never merged, MIL-93)
em skill sync [path] --no-agents-md                           # skip writing/updating the AGENTS.md agent-contract section (on by default, MIL-129)
em skill check [path]                                         # check the vendored .claude/skills/ event-modeling skill bundle in [path] for drift against the installed em package; exits non-zero on any mismatch (CI-ready, MIL-93)
em skill check [path] --json                                  # print a JSON document instead of the text report (see docs/cli.md)
em ci init <model>                                            # install .github/workflows/em-ci.yml (PR gates: em validate, em slice index --check, em coverage --strict, em ledger, em skill check, em glossary --fail-on-conflicts, plus a push-triggered status-badge rebuild) and em-conform.yml (scheduled, advisory-only conformance cadence) — same install discipline as `em skill install`: marker-delimited, idempotent, --check for CI self-verification (MIL-166, see docs/ci.md)
em ci init <model> --tests <dir>                              # test directory the coverage/status steps scan for INV-* citations
em ci init <model> -f, --force                                # replace an existing workflow file that has no GENERATED markers
em ci init <model> --check                                    # verify both files match the current preset; exit non-zero on drift without writing (CI)
```
<!-- GENERATED:cli:end -->

Install if missing: `npm i -g @milehimikey/em`. SVG, PNG, and PDF all work with no system
deps; only rarer formats (ps, eps, ...) need `rsvg-convert`.

---

## Grammar

```
model "Name"                     # diagram title

persona Name                     # a UI swimlane row (actor)
context Name                     # an event swimlane row (bounded context / aggregate)

slice "Name" [source "url"] {    # one vertical time step (a column); source is optional
  ui   Free Text @Persona        # screen; @Persona picks its row (defaults to first/"User")
  command Free Text              # state-changing request (API band)
  view Free Text from "Event A", "Event B"   # read model fed by event(s)
  view Free Text again from "Event C"        # later instance of an evolving read model (see Clauses)
  event Free Text @Context       # recorded fact; @Context picks its row (defaults to "Domain")
  processor Free Text from "View"   # automation; aliases: automation | saga | translation
}

arrow From Element -> To Element    # explicit cross-slice edge (overrides inferred flow)

type Name { field: Type, ... }      # named structured type, reusable from any field (see Named types)
```

### Element kinds (8 keywords, nothing else)
| Keyword | Band | Meaning | Tag | Extra clauses |
|---|---|---|---|---|
| `ui` | persona | screen / interface | `@Persona` | `note`, `issue`, `divergence`, `{ fields }` |
| `command` | API | state-changing request | — | `note`, `issue`, `divergence`, `renamed from`, `{ fields }` |
| `view` | API | read model / projection | — | `from "Event"…`, `note`, `issue`, `divergence`, `public`, `{ fields }` |
| `event` | context | recorded fact (past tense) | `@Context` | `note`, `issue`, `divergence`, `public`, `tag`, `renamed from`, field-level `assigned`, `{ fields }` |
| `processor` / `automation` / `saga` / `translation` | automation | system reaction / adapter | — | `from "…"`, `note`, `issue`, `divergence`, `{ fields }` |

### Clauses
- **Tags:** `@Persona` only on `ui`; `@Context` only on `event`. Undeclared tags auto-create a
  row. Multi-word tags need no quoting — the tag captures everything after `@` to end of line
  (`ui Ticket Queue @Customer Service` matches `persona Customer Service`).
- **`from "X"`** on views/automations declares the source(s); names are quoted, comma-separated.
  Matching is case-insensitive and whitespace-normalized. A `from` may never point at an event or
  view that first appears in a LATER slice (forward-only timeline — validation error).
  Kinds never cross: a view's `from` resolves ONLY to events; a reaction's `from` resolves ONLY
  to read models — naming an event on a reaction is a validation error even though the event
  exists. Feed an event to a reaction by projecting it into a view first (the automation's
  "to-do list") and pointing the reaction at that view. Name that view after the pending work
  (`Payments To Process`), never after the triggering event — a view reusing the event's name
  collides in the shared namespace and draws a duplicate-name warning.
- **`again`** (views only): `view <Name> again [from "Event", …]` declares a later instance of an
  already-declared read model — the forward-only device for a view that evolves as later events
  land. Instances are ONE logical view: the first declaration owns the `note` binding; each
  instance's `from` lists only the NEW events landing at that point (not cumulative); a reaction
  (`from "View"`) reads the nearest instance at-or-before its own slice. Instances are NEVER
  connected to one another — continuity is implied by the shared name, and the events reaching each
  instance are what show the view changing. `again` with no earlier declaration is a validation error.
  Use `again` (not a plain repeated `view` name) whenever the view is referenced by a
  `from`/`arrow` — plain repeats are only warning-free while unreferenced.
- **`note "path.md"`** on ANY element links a markdown doc. Relative to the `.em` file. Renders as
  a clickable marker in SVG and a legend entry in PNG/PDF. **This is how slice docs attach.**
- **`issue "text"`** on ANY element flags an open question inline — the diagram-visible red
  sticky note. Renders as a red corner marker (opposite corner from `note`, so both can coexist
  on one element) plus a legend entry; `em validate` warns on every open issue. **Prefer this
  over a `# TBD` comment for anything that should show up on the rendered diagram** — `# TBD` is
  invisible once rendered, `issue` isn't.
- **`divergence "text"`** on ANY element records a reasoned, ratified deviation between this
  element and its implementation — the *resolved* sibling of `issue` (lint-suppression-with-
  rationale for the `conform` phase). Renders as a teal corner marker (bottom-right — distinct
  from `note`'s top-right and `issue`'s top-left, so all three can coexist) plus a legend entry.
  Raises **no** `em validate` warning by design; use `--list-divergences` to audit. `em diff
  --json` carries it forward as `acceptedDivergence` on the affected change/removal entry, so
  `conform` can cite an already-ratified deviation instead of re-flagging it as drift every run.
- **`public`** (events and views): marks the element as part of the published integration
  surface — a published event contract (e.g. AsyncAPI), or a view whose read API/response
  shape external consumers depend on — as opposed to an internal-only fact or projection.
  Plain structural flag, no free text and no diagram marker (same posture as `again`). Write
  it as the last token on the line; on an event, optionally right before a trailing
  `@Context` — `event X @Context public` or `event X public @Context` both work. A `public`
  element is exempt from the unread-event / unconsumed-view warnings (its consumer is outside
  this model). `em export` carries it as `public: true`/`false`; `em diff` reports a flip as
  `event marked public`/`event unmarked public` (the entry cites the element's kind, so a
  view flip reads `view "X"`); `em validate --list-public` audits the whole public surface.
- **`tag`** (events only): declares a DCB (Dynamic Consistency Boundary) tag key. Three forms:
  a trailing `tag` on a field line inside the event's `{ … }` block (`priceId: UUID tag`, or
  typeless `priceId tag`) — an identity tag, key defaults to the field's own name; a bare field
  whose ENTIRE text is just `tag` is a field named `tag`, not a clause. `tag <key> from a, b`
  (composite, ≥2 bare/unquoted field names — unlike a view's quoted `from`). `tag <key>
  external "text"` (external — the string is documentation only, never parsed). Composite/
  external clauses are element-level: write them as a trailing clause on the event (same
  family as `note`/`issue`), or as one or more standalone `tag ...` lines immediately following
  the event inside the slice body (attaches to the most recently declared element, which must
  be an event); multiple accumulate. `tag` anywhere on a command/view/`ui`/`type` field, or an
  element-level `tag` clause on a non-event, is a parse error. `em export` carries every tag
  key under the event's `tags` array (`{ key, kind, fields, description }`); `em validate`
  flags a composite tag naming an unknown field and a duplicate tag key on one event.
- **`renamed from "Old1", "Old2"`** (events and commands only): records the prior name(s) an
  element, or one of its fields, was known as — codegen metadata for converting
  already-stored payloads instead of an upcaster chain. Element-level trails the element's own
  name (same trailing-clause family as `@Context`/`public`); field-level trails a field's type,
  or the bare name of a typeless field, inside the `{ … }` block — event/command fields only, a
  parse error on a view/`ui`/automation-kind field or a `type` field. The list is quoted,
  comma-separated, most-recent-old-name first. Inside one inline `{ … }` block, a bare quoted
  field name immediately after a renamed field is read as a CONTINUATION of that list, not a
  new field — give the quoted-name field a type, or write fields one per line, to avoid the
  ambiguity. `em export` carries it as `renamedFrom: string[] | null` on both the element and
  each field. **`em diff` does not read this clause** — a rename still reports as remove+add.
- **`assigned`** (event fields only): marks a field as system-assigned — set by the server/
  handler, never supplied by the triggering command (a minted ID, a decision-time timestamp).
  Trails a field's type, or the bare name of a typeless field (`orderId assigned`,
  `placedAt: Instant assigned`) — same trailing-clause family as `tag`/`renamed from`, composes
  with either in any order. A field whose ENTIRE text is just `assigned` is a field named
  `assigned`, not a clause. `assigned` on a command/view/`ui`/`type` field is a parse error.
  Excludes the field from `em validate`'s event ← command fields-completeness check (and thus
  from `--slice-ready`, since the diagnostic never fires) without narrowing view ← event
  tracing. `em export` carries it as `assigned: boolean` on the field, always present, same
  `=== true` convention as `tag`. **Reach for this before echoing a server-set field onto the
  command just to silence a fields-completeness warning** — that misrepresents what the client
  actually sends.
- **Fields:** `command Place Order { orderId: UUID, items: LineItem[], customerId }` — inline or
  one-per-line. Types are free text (no semantic checking) UNLESS the type string names a
  declared `type` (see Named types below), in which case it resolves to a structured
  reference. Keep these light; full field specs with rules live in the slice doc.
- **Comments:** `# ...` anywhere outside quotes (full-line or trailing).
- **Quoted strings:** everything between a `"` and its matching `"` is literal — `{`, `}`, `#`
  included, never re-interpreted as a field block or comment — so REST path-template
  placeholders are safe as-is: `issue "PUT v3/widgets/{widgetId}/suspend"`. Escape a literal
  `"` or `\` inside a string with `\"`/`\\`; no other backslash sequence is special. An
  unterminated string (missing closing `"`) is a parse error naming the clause it broke in.
- **`source "url"` on a slice header** (the only slice-level clause — everything above is
  per-element) links the slice back to the ticket/conversation it traces to, e.g.
  `slice "Checkout" source "https://linear.app/team/issue/MIL-60" { ... }`. Exports as
  `model.slices[].source` via `em export`, so an intake loop stays machine-traversable instead
  of relying on prose. Purely metadata — no visual marker, not validated. Don't confuse it with
  an element's `note "path.md"` (a markdown file link, not a URL).

### Named types

`type Name { field: Type, ... }` declares a reusable structured shape at the top level (any
order relative to `persona`/`context`/`slice`, no clauses). Reference it from any field
anywhere — bare (`winner: QuoteAcceptedLine`) for a nested object, `Name[]` for an array
(`lines: QuoteAcceptedLine[]`). Resolution is opportunistic: a type string only becomes a
structured reference when it names a declared type (case/whitespace-insensitive match); every
other type string stays free text exactly as before, so declaring no `type` blocks changes
nothing. Recursion between declared types is allowed as a DAG (e.g. a diamond shape like
`Order` referencing `Address` twice) — a bare/singular self- or mutual-cycle
(`type Node { child: Node }`) is a validation error, but the same shape through an array
(`type Node { children: Node[] }`) is legal since the array can terminate at runtime; this is
how tree/recursive data (categories, org charts, comment threads, BOMs) gets expressed.
`em export` lists every declared type under `model.types[]` (stable `ref`, e.g.
`types/quote-accepted-line`) and adds an additive `typeRef` key to every field (declared-type
fields and ordinary element fields alike) — `{ name, ref, array }` when resolved, `null`
otherwise. `em diff` tracks types added/removed and field changes on surviving types.

### Swimlane band order (top → bottom)
Header row → **Automation** (only if used) → **persona** rows (in declared order) → **API**
(commands + views share this lane) → **context** rows (in declared order).

### Colors (for orientation)
UI = white, command = blue, event = amber/orange, view = green, automation = gray.

---

## Pattern → DSL mapping

```em
# 1. State Change: UI -> Command -> Event
slice "Place Order" {
  ui Checkout @Customer
  command Place Order
  event Order Placed @Order
}

# 2. State View: Event(s) -> Read Model -> UI
slice "Open Orders" {
  view Open Orders from "Order Placed"
  ui Order List @Customer
}

# 3. Automation: read model in the slice before, reaction + command + event together
slice "Orders To Fulfill" {
  view Orders To Fulfill from "Order Placed"
}
slice "Ship Order" {            # reaction, command, and event all share this one slice
  processor Fulfillment Service from "Orders To Fulfill"
  command Ship Order
  event Order Shipped @Shipping
}
slice "Open Orders — shipped" {
  view Open Orders again from "Order Shipped"   # every event needs a reader
  ui Order List @Customer                       # ...and every read model needs a consumer
}

# 4a. Translation (external trigger, no durable artifact): external call -> translation -> command -> event
slice "Confirm Delivery" {
  translation Carrier Adapter         # inbound from outside the model; no internal `from`
  command Confirm Delivery
  event Delivery Confirmed @Shipping
}
slice "Open Orders — delivered" {
  view Open Orders again from "Delivery Confirmed"
  ui Order List @Customer
}

# 4b. Translation (external trigger, durable artifact): persisted inbound queue -> translation -> command -> event
slice "Receive Carrier Event" {           # ingest: persist the raw webhook before reacting to it
  ui Webhook Endpoint @Carrier
  command Receive Carrier Event
  event Carrier Event Received @Shipping  # scoped to @Shipping's fact, not the @Carrier caller
}
slice "Inbound Carrier Events" {
  view Inbound Carrier Events from "Carrier Event Received"   # the persisted inbound queue
}
slice "Acknowledge Carrier Event" {
  translation Carrier Queue Adapter from "Inbound Carrier Events"   # different producer than 4a's Carrier Adapter, so a distinct name
  command Acknowledge Carrier Event
  event Carrier Event Acknowledged @Shipping
}
slice "Inbound Carrier Events — processed" {
  view Inbound Carrier Events again from "Carrier Event Acknowledged"
  ui Delivery Board @Ops
}

# 4c. Translation (internal trigger, durable artifact): read model -> translation -> command -> event
slice "Accept Quote" {
  ui Quote Screen @Customer     # every command needs a trigger: a ui, or a reaction, in this slice
  command Accept Quote
  event Quote Accepted @Quote
}
slice "Quotes To Sync" {
  view Accepted Quotes from "Quote Accepted"
}
slice "Record Sync" {
  translation CRM Sync from "Accepted Quotes"   # reacts to our own state via the read model
  command Record Crm Sync
  event Quote Synced @Quote
}
slice "Accepted Quotes — synced" {
  view Accepted Quotes again from "Quote Synced"
  ui Sync Status @Customer
}
```

Trigger source (external/internal) and durable artifact (`view`-backed or not) are independent
axes — 4a and 4b are both "externally triggered" but only 4b has a queue, and a `view`-backed
translation reacts the same whether the view was filled by an outside system (4b) or the model's
own event (4c). An inbound message earns `event` status the same way any event does: scope it to
the context/lane whose fact it represents (e.g. `Carrier Event Received @Shipping` or its own
`Carrier` context), not by who committed it — that keeps it a legitimate boundary fact (à la an
Anti-Corruption-Layer event in DDD) instead of a technical artifact leaking foreign vocabulary
into the model.

A `translation` (like a `processor`) is a **reaction**: it triggers a command in the same slice —
same shape as the Automation pattern above, and the same shape `ui` already uses in State Change.
The reaction never records the event directly (there's no `reaction -> event` edge); the command
it triggers is what records it, and that event happens to live in the reaction's own slice now
because the command does.

Note the read slice closing each pattern: **every event must be read by some read model**
(warning 4 below). A command slice is not finished until the slice that projects its event
exists. Reactions don't count — they read *views*, not events.

### Headless / API systems & repeated read models

A headless system (no screens — clients call an API) still uses `ui`/`persona`: a slice **is**
trigger → command → event, read vertically, so the trigger belongs *in* the slice, never split into
one of its own. Declare a persona per external caller/role and treat its `ui` boxes as API calls
instead of shipped screens — same two patterns (State Change, State View) as any other slice, no new
shape:

```em
persona IntegratorAPI   # API-flagged lane: its `ui` boxes are API calls, not shipped screens

slice "Create Quote" {
  ui Create Quote @IntegratorAPI
  command Create Quote
  event QuoteCreated @Quote
}

slice "Read Quote — created" {
  view Quote from "QuoteCreated"
  ui Read Quote @IntegratorAPI
}
```

- **`translation` stays reserved for genuine reactions and real external-system boundaries** — an
  internal automation, or a webhook/adapter crossing into another system (see the Automation and
  4a/4b/4c Translation examples above, unchanged). It is **not** how you model a synchronous
  request/response API call — that's Pattern 1 (State Change) with an API persona, exactly like the
  `Create Quote` slice above.
- **Internal-only commands and views (no public route) carry no `ui` at all.** They follow the
  ordinary Automation pattern already documented: the reaction shares the command's slice, and an
  internal-only read model is consumed by that reaction (from the slice before), not by a screen
  or an API query.
- **Repeat the read model** in every slice where it's read so the timeline flows left-to-right, and
  **prefer `view X again`** for every instance after the first (see Clauses) — **each instance
  carries its own consumer** (the `ui` that reads it, or a reaction), not just the last one. `again`
  instances are exempt from the duplicate-name warning even when referenced, and each reference
  resolves to the right instance — a plain repeat only stays warning-free while nothing references it by name, and
  resolves to the *first* declaration when something does. **Wire each event to a read model exactly
  once:** a repeated instance's `from` lists only the **new** events since the previous instance
  (not cumulative), or the event draws a duplicate arrow to the same read model at every repeat. (An
  event may still feed several *different* read models, once each.)
- **Instances are never joined to one another.** No arrow between two instances of one read model,
  ever — an explicit one is a validation error. The repeat is a timeline device: continuity is
  implied by the shared name, and the events arriving at each instance are what show it changing.
- **Keep arrows span-1: put each repeat right after its feeding event.** Place a read-model instance
  immediately after the event that updates it, sourcing only that single adjacent event. The
  renderer routes a long arrow *around* intervening boxes rather than through them, so it no longer
  reads as a forbidden read→read link — but distance is still a real problem: the arrowhead lands
  columns away from the event that produced it, so **the write slice reads as dangling**, as if
  nothing consumed its event. You have to trace a line across the diagram to see the connection.
  Keep the read model adjacent to its event, and keep a sub-flow that detours into another context
  together rather than parking it at the end of the model.

### Reaction wiring — no positional gotcha

A reaction's command is inferred from **same-slice presence**, exactly like `ui -> command`: put
`processor`/`translation` in the same slice as the command it triggers, in either order, and `em`
wires it correctly regardless of what any other slice contains or where it sits in the file. There's
no adjacency to get right and no reordering hazard — the read model it watches (if any) is named
explicitly via `from "View"`, resolved by name to the nearest instance at or before its own slice,
not by position either.

The one thing that still doesn't wire on its own: a `ui` never triggers a reaction — no pattern has
a `ui` wired to `processor`/`automation`/`saga`/`translation`, only to `command`. A `ui` left in a
reaction's slice renders with no outgoing edge, disconnected, and `em validate` warns on it — move
it to the slice that displays the read model, or drop it.

---

## `em validate` rules (design to satisfy these)

**Errors (must fix):**
1. **Band collision** — two elements of the same band in one slice (e.g. two `command`s, or two
   `ui`s in the *same* persona row). Split them into separate slices/personas.
2. **Unknown event source** — `view X from "Event"` where the event doesn't exist anywhere.
3. **Unknown read-model source** — `processor X from "View"` where the view doesn't exist.
4. **Arrow endpoint mismatch** — `arrow A -> B` where A or B matches no element name.
5. **Backward timeline** ("time flows left to right") — an event feeding a view instance in an
   EARLIER slice (fix: add a `view X again` instance where the event lands and move the source
   there), a reaction reading a view before any instance of it exists, or an explicit backward
   `arrow`.
6. **`again` without an earlier declaration** — declare the view plainly the first time it appears.
7. **Illegal connection** — an `arrow` joining kinds the patterns don't connect. Only
   `ui -> command`, `command -> event`, `event -> view`, `view -> ui`, `view -> reaction`, and
   `reaction -> command` are allowed. A command straight to a view is the CQRS violation (an event
   has to sit between them); a view straight to a command needs a reaction between them; and two
   instances of one view are never connected at all. Inferred edges are always legal, so this only
   ever fires on a hand-written `arrow`.
8. **Cyclic type reference** — a declared `type` nesting itself with no array to terminate it
   (`type Node { child: Node }`, or the same shape across several types). Break the cycle, or
   route the self/mutual reference through an array (`children: Node[]`) if the data is
   genuinely tree-shaped.
9. **Lineage-ref errors** (slice-doc frontmatter, fs-aware) — a
   `split-from`/`merged-from`/`superseded-by` ref with malformed `<slice-key>@v<N>` grammar, a
   self-reference or cycle, a `superseded-by` naming a slice absent from the current model, or
   a ref naming a version higher than the target's own `version:`. A `split-from`/`merged-from`
   naming a key absent from the tree is deliberately silent — that's the normal state after a
   real split/merge (see the four `lineage-*` codes in the table below).

**Warnings (should fix):**
1. **Reaction with no command** — a `processor`/`automation`/`saga`/`translation` that triggers
   nothing. It never records an event itself; add the command it issues in this same slice, or an
   explicit `arrow` to one elsewhere.
2. **`ui` shares slice with a reaction** — a `ui` only ever wires to a `command` a person issues; no
   pattern has a `ui` triggering an automation/processor/saga/translation. Left in the reaction's
   own slice it renders disconnected, with no edge, whether or not that slice also has the
   reaction's own command. Move it to the slice that displays the read model, or drop it.
3. **Command with no trigger** — nothing issues it. A command needs a `ui` in its slice, or the
   reaction (automation/processor/saga/translation) that triggers it, *also* in this slice. The
   input-side mirror of (5): a command nothing points at is a write nobody can start.
4. **Command without event** — every command should record at least one event.
5. **Event nobody reads** — the mirror of (4): recording an event no read model projects is a
   write with no reader. Follow every write slice with the read slice that consumes its event.
   Counts as read when a `view` names it in `from` (any `again` instance will do), when a view
   with no `from` of its own sits in its slice, or via an explicit `event -> view` arrow.
   (Events marked `public` are exempt — their reader is outside the model; same for a
   `public` view and the no-consumer warning.)
6. **Read model without source** — add `from "Event"` or place the view in a slice with an event.
7. **Duplicate name** — the same name defined N times; references resolve to the first. Rename.
   (A duplicate `type` name always warns, unlike a duplicate element name — there's no
   legitimate unreferenced-duplicate case for a named type.)
8. **Open issue** — an element carries `issue "text"`; resolve the question, then remove the
   clause. `em validate --list-issues` prints just these; `--fail-on-issues` (opt-in) makes CI
   fail while any remain open.
9. **View field with no source** — a `view` field whose name matches no field on any instance
   of its source events. Only checked once BOTH the view and at least one source event declare
   `{ fields }`.
10. **Event field not from a command** — an `event` field whose name matches no field on any
    command in the same slice. Only checked once BOTH the event and at least one same-slice
    command declare `{ fields }`. This is the payoff of the fields feature for slicing rigor:
    once fields are written down, `em validate` checks that data flows forward consistently.
11. **Event with no producing command** — a fact with no traceable cause; add the command that
    records it (either order within the slice), or an explicit `arrow` from one.
12. **Two same-named `translation`s reading different producers** — rename one; fires
    unconditionally (unlike the duplicate-name warning), since the confusion is in reading
    the model, not resolving a reference.
13. **Frontmatter coherence** (slice docs, fs-aware) — `status: implemented` with no
    `implementedIn` link at all. The re-ratification mismatch (status flipped back while
    `implementedIn` names the prior PR) is deliberately never flagged — it's the drift
    signal, not incoherence.
14. **Doc-join problems** (`em export`/`--slice-ready`) — `binding-missing-file` (a
    `note "slices/<key>.md"` binding pointing at a file that doesn't exist) and
    `frontmatter-invalid` (the doc exists but lacks a frontmatter block or a required key).

`divergence "text"` is deliberately NOT in this list — it raises no warning at all, since it
records a deviation already reasoned through and accepted, not something to fix. Use
`em validate --list-divergences` to audit them on demand.

### Full rule code reference

Every rule above (and every fs-aware check `em validate` layers on top — lineage, frontmatter
coherence) has a stable `code`, generated below from the same registry `em` itself validates
against (`src/model/rules.ts`) — a new rule shows up here the moment it's registered, whether or
not the prose above has caught up yet. `--slice-ready <key>`-only codes are excluded; see
`docs/cli.md#em-validate-file` in the
[em repository](https://github.com/milehimikey/em/blob/main/docs/cli.md#em-validate-file).

<!-- GENERATED:validate-rules:start -- run `npm run docs:generate` to refresh, do not hand-edit -->
| Code | Severity | Title | Fix |
|---|---|---|---|
| `arrow-backward` | error | Backward arrow | Restructure so the target comes later. |
| `arrow-unresolved-source` | error | Arrow source unresolved | Fix the arrow's source name. |
| `arrow-unresolved-target` | error | Arrow target unresolved | Fix the arrow's target name. |
| `binding-missing-file` | warning | Doc binding points at a missing file | Create the slice doc, or fix the `note` path. |
| `both-ends-of-a-flow/command-no-event` | warning | Command without event | Add the event this command records. |
| `both-ends-of-a-flow/command-untriggered` | warning | Command with no trigger | Add a `ui` or the reaction that issues it, both in this slice. |
| `both-ends-of-a-flow/event-unproduced` | warning | Event with no producing command | Add the command that records it, or an explicit arrow from one. |
| `both-ends-of-a-flow/event-unread` | warning | Event nobody reads | Project it into a view, or reconsider recording it. |
| `both-ends-of-a-flow/reaction-no-command` | warning | Reaction with no command | Add the command it triggers, in this slice, or an explicit arrow to one. |
| `both-ends-of-a-flow/ui-unbacked` | warning | `ui` with no read model or command | Add a `view` it displays, or the command it triggers. |
| `both-ends-of-a-flow/view-unconsumed` | warning | Read model with no consumer | Add a `ui` or reaction that consumes it, or drop this instance. |
| `connection-legality/illegal-pair` | error | Illegal connection | Only ui→command→event→view→ui and view→reaction→command are legal — the message names the missing step. |
| `cross-model-slice-doc-collision` | warning | Colliding slice doc path across models | Give each model its own directory (see docs/cli.md, "Multi-model projects"). |
| `doc-model-element-not-in-doc` | warning | Model element the doc doesn't mention | Add the matching marker to the doc, or remove the element from the model. |
| `doc-model-element-not-in-model` | warning | Doc names an element the model doesn't have | Add the element to the model, or fix/remove it in the doc. |
| `doc-model-field-mismatch` | warning | Doc/model field mismatch | Reconcile the field table with the model's fields — names and types. |
| `doc-model-pattern-mismatch` | warning | Doc/model pattern mismatch | Fix the doc's `pattern:` frontmatter to match the model, or restructure the slice to match the doc. |
| `duplicate-element-ref` | warning | Duplicate element ref | Rename the element so its export ref is unique. |
| `duplicate-name` | warning | Duplicate name | Rename one of the duplicates. |
| `duplicate-slice-name` | warning | Duplicate slice name | Rename the slice so its export key is unique. |
| `duplicate-type-name` | warning | Duplicate type name | Rename one of the duplicate `type` declarations. |
| `duplicate-type-ref` | warning | Duplicate type ref | Rename the type so its export ref is unique. |
| `fields-completeness/event-field-no-source` | warning | Event field not from a command | Add the field to a command in the slice, or remove it from the event. |
| `fields-completeness/view-field-no-source` | warning | View field with no source | Add the field to a source event, or remove it from the view. |
| `frontmatter-coherence-implemented-without-link` | warning | Implemented without a link | Add `implementedIn` once the slice ships. |
| `frontmatter-invalid` | warning | Invalid or missing frontmatter | Add the required frontmatter keys, or add a frontmatter block. |
| `grid-collision` | error | Band collision | Split the colliding elements into separate slices. |
| `lineage-forward-dangling` | error | Dangling forward lineage ref | Fix the key, or remove the stale successor. |
| `lineage-ref-cycle` | error | Lineage cycle | Break the cycle — a slice can't be its own ancestor. |
| `lineage-ref-malformed` | error | Malformed lineage ref | Fix the value to `<slice-key>@v<N>`, or remove it. |
| `lineage-version-impossible` | error | Impossible lineage version | Fix the referenced version, or ratify the target slice first. |
| `note-binding-dangling` | warning | Dangling cross-slice note | Create the doc at that path, or fix/remove the note. |
| `note-binding-extra` | warning | Extra doc-binding note, ignored | Remove the note, or point it at the slice's actual bound doc. |
| `note-binding-unratified` | warning | Unratified cross-slice note | Add `covers: <this-slice-key>` to that doc's frontmatter, or correct the note's path. |
| `note-binding-unusable` | warning | Cross-slice note to a doc with unusable frontmatter | Fix that doc's frontmatter, or fix/remove the note. |
| `open-issue` | warning | Open issue | Resolve the question, then remove the `issue` clause. |
| `reaction-from-future-view` | error | Backward timeline (reaction reads a future view) | Declare the view in or before the reaction's slice. |
| `reaction-from-unresolved` | error | Unknown read-model source | Project the event into a view first, or fix the `from` reference. |
| `tag-composite-unknown-field` | error | Composite tag names an unknown field | Fix the field name, or add it to the event's fields. |
| `tag-duplicate-key` | error | Duplicate tag key | Rename one of the tags so every key on the event is unique. |
| `translation-name-collision` | warning | Translation name reused for different producers | Use a distinct name per producer to avoid confusion. |
| `type-cycle` | error | Cyclic type reference | Break the cycle, or route the self/mutual reference through an array. |
| `ui-shares-slice-with-automation` | warning | `ui` shares slice with a reaction | Move the `ui` to the slice that displays the read model, or drop it. |
| `view-again-without-earlier` | error | `again` without an earlier declaration | Declare the view plainly the first time it appears. |
| `view-from-future-event` | error | Backward timeline (view reads a future event) | Move the source to a later `view X again` instance. |
| `view-from-unresolved` | error | Unknown event source | Fix the `from` reference to name an existing event. |
| `view-no-source` | warning | Read model without source | Add `from "Event"`, or place the view in a slice with an event. |
<!-- GENERATED:validate-rules:end -->

**Design rules that keep models valid:**
- One element per band per slice (multiple personas/contexts are fine — they're different rows).
- Every `command` slice includes its `event`. Every `view` has a `from` source.
- **Every `command` has a trigger.** A `ui` in its slice, or the reaction that triggers it, also in
  its slice. A command nothing points at is a write nobody can start.
- **Every `event` has a reader.** A command slice isn't finished until the read slice that projects
  its event exists. Reactions don't count — they read views, not events. Pair each write slice with
  its read slice as you go rather than sweeping up dangling events at the end.
- **Every `view` has a consumer.** A `ui` in its slice, a reaction watching it, or (headless) a read
  translation. Every *instance* of a repeat, not just the last — a bare `view X again` slice is a
  half-slice, not a State View.
- **Only six connections are legal**, and only these are ever inferred:
  `ui → command`, `command → event`, `event → view`, `view → ui`, `view → reaction`,
  `reaction → command`. Anything else in an explicit `arrow` is an error — above all
  `command → view` (the CQRS violation: an event has to sit between them) and `view → command`
  (a reaction has to sit between them). If you reach for an arrow the patterns don't allow, the
  model is missing an element, not an arrow.
- A reaction (`processor`/`automation`/`saga`/`translation`) shares its slice with the `command` it
  triggers and that command's `event` — the same shape `ui` already uses in State Change. If it's
  internally triggered, the **view** (read model) it watches lives in the slice before, named via
  `from "X"` (which must resolve to a view, never an event directly). Externally-triggered reactions
  start from outside the model — no `from` at all, and no slice before them.
- Name everything uniquely and consistently.
- Events are past tense; commands are imperative; views name the thing shown.

A reaction that emits an event with no command anywhere between them — `translation T` and
`event E` in the same slice, nothing issuing it — is exactly what
`both-ends-of-a-flow/reaction-no-command` (above) catches: any reaction with no `command` in its
own slice, and no explicit arrow to one, warns. Still route every reaction through a real command
by construction (`reaction → command → event`) rather than an explicit `arrow "Reaction" -> "Event"`
— that shape is its own `connection-legality` error (a reaction never records an event itself).
