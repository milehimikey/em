# Roadmap

Directions under consideration, in rough priority order. Nothing here is a commitment.

Recently shipped, for context on where things are heading: open questions as diagram-visible
red notes (`issue`), JSON export with stable refs, structural `em diff`, the `conform` phase
for model-versus-code drift, `em changelog`, accepted-divergence annotations (`divergence`) so
a ratified model-vs-code deviation stops re-firing as drift, provenance links from a slice back
to its ticket (`source`), a lightweight usage-data convention (skill Usage log —
[usage-data.md](usage-data.md)) so the next roadmap pass has real signal instead of guesswork,
and a `public` marker on events for integration-surface promotion (contract generators can now
tell a published event from an internal-only fact), stakeholder review mode — a slice-by-slice
storyboard walkthrough in the live viewer (`em watch --serve`'s "Review mode"), with red notes
captured live during the session — `em glossary` — a cross-model glossary of element names,
field names, personas, and contexts, with kind- and field-type-conflict checks across models —
giving the `extract`/`conform` phases a fuzzy-name-matching aid so extraction vocabulary drift
doesn't masquerade as real drift, and nested/structured field types (a top-level
`type Name { ... }` declaration, referenced bare or as `Name[]` from any field), and
`em catalog` — a static-site generator (index + per-slice pages, slice docs rendered as HTML)
over one or more models, git still the only history store — alongside `em render --slice`
rewritten to redraw a single slice in its own pattern shape (State Change/View/Automation/
Translation) instead of cropping the full diagram, and slice headers now color-coded by
design-doc status (reviewed/ready-to-implement/implemented). Most recently, export refs
(`ref`/`sliceKey`) carried directly on `em diff --json` entries so they join straight back to
an `em export` document without re-deriving slugs, and — in 1.6.1 — clause keywords made
case-sensitive and operand-checked so element names containing words like "From", "Public",
or "Again" are no longer silently corrupted at parse time, `from` kind-mismatch errors that
name the actual kind instead of claiming the name is unknown, and the automation read-model
naming rule (name the to-do list after the pending work, never after the triggering event)
stated explicitly in the pattern docs. Most recently, the slice-doc metadata dialect is now
canonically YAML frontmatter (`status`/`pattern`/`swimlane`/`implementedIn`, plus
`schemaVersion`) — `templates/slice.md` and `em catalog`/`em render`/`em watch`'s status
parsing all read frontmatter first, with the old `- **Status:** ...` bullet line kept as
legacy/accepted input for docs written before frontmatter existed. It also just gained a
`version` field and three lineage keys
(`split-from`/`merged-from`/`superseded-by`, `<slice-key>@v<N>` grammar) for split/merge/rename
provenance, plus a documented machine schema
([slice-doc-schema.md](slice-doc-schema.md)) spelling out required-vs-optional keys per
`status` and the unknown-key policy. Most recently, `em export` joins that frontmatter
straight into the export JSON — every slice gains a model-derived `pattern` and a `doc` object
(status/version/implementedIn/lineage, or a `no-doc-bound`/`binding-missing-file`/
`frontmatter-invalid` reason when there's nothing clean to join) — and every diagnostic
`em export`/`em diff` emit now carries a stable `code` plus `refs` back to the entities it
concerns, so a consumer can gate or bucket findings without parsing prose (added at
`schemaVersion` `1.4` / `diffSchemaVersion` `1.5`; current values `1.5` and `1.6`). Most
recently, those lineage keys are now
read, not just carried: `em diff` annotates a `slice-added`/`slice-removed` entry with its
slice doc's resolved `split-from`/`merged-from`/`superseded-by` when one's declared (a real
split reads as "split from", not a bare remove+add), and `em validate` resolves lineage refs
against the current tree — malformed grammar, self-reference/cycles, a dangling
`superseded-by`, and version arithmetic that names a future that hasn't happened are all
errors, while a `split-from`/`merged-from` naming a key legitimately absent from the current
tree (the steady state after a real split or merge) deliberately raises nothing at all
(`diffSchemaVersion` `1.6`; see [validation.md#lineage](validation.md#lineage)). Rounding out
the same wave: `em validate --slice-ready <key>` as the native handoff gate (doc bound,
status `ready-to-implement`, open questions all checked), typed `## Delta` operation blocks
(Added/Modified/Removed/Renamed) for re-ratified slices, multi-word `@Persona`/`@Context`
tags parsing without quotes, and an agent guide
([reference/implement.md](../.claude/skills/event-modeling-implement/reference/implement.md)) shipped
inside the bundled skill so implementing agents follow one contract from ratified slice to
merged PR. [workflow.md](workflow.md) is the resulting picture. Most recently (MIL-26): every
no-fields box in a swimlane row now shares the row's tallest natural height instead of each
sizing independently (a wrapped 3-line label no longer leaves its short row-mates looking
short and misaligned); note/issue/divergence corner markers gained a white halo so they read
clearly against any element-kind fill, not just the ones with enough contrast by luck; and
PDF is now composed in-process with pdfkit + svg-to-pdfkit — no system `rsvg-convert`/librsvg
needed for PDF anymore (see [dependencies.md](dependencies.md)). Most recently (MIL-148): a
trailing `assigned` clause marks an event field as system-assigned (server-minted IDs,
decision-time timestamps) — it's excluded from the event ← command fields-completeness check
entirely, so `em validate --slice-ready` no longer permanently blocks on the exact pattern the
shipped example model itself uses (`schemaVersion` `1.7`; see
[validation.md#fields-completeness](validation.md#fields-completeness)). Most recently
(MIL-131): `em diff --json` entries now carry `op`, each `ChangeType` coarsened onto the same
Added/Modified/Removed/Renamed vocabulary a slice doc's `## Delta` section uses (MIL-88) —
shared vocabulary only, `diffSchemaVersion` `1.7`; comparing an authored `## Delta` against the
structural diff it claims to describe is still a separate, not-yet-built decision (see
[slice-doc-schema.md#delta-section-grammar-and-lifecycle](slice-doc-schema.md#delta-section-grammar-and-lifecycle)).
Most recently (MIL-165): "who ratified, and when" is now a first-class recorded fact —
`em slice ratify <model>.em <key> --by <name>` flips `status` to `ready-to-implement` and
records `ratifiedBy:`/`ratifiedOn:` in the same surgical-edit, idempotency-discipline shape as
`em slice mark-implemented` (`schemaVersion` `1.8`), and a documented CODEOWNERS convention
routes `slices/**` through a designated ratifier so the edit itself can't merge unreviewed (see
[ci.md#codeowners-routing-ratification-review](ci.md#codeowners-routing-ratification-review)).
Most recently (MIL-163): `em status <files...>` — one deterministic command answering "what
state is the system in" over one or more models, aggregating slices by lifecycle status,
`driftSignal` breakdown, invariant coverage totals (reusing `em coverage`'s report builder),
open `issue` markers + unchecked Open Questions, and last-conformance commits-behind-HEAD
(reusing `em conform-scope`'s injectable-git-runner walk) — as text, `--json`
(`statusSchemaVersion` `1.0`), a `--md` block for README embedding, and a generated `--badge`
SVG, plus a byte-identical MCP `status` tool (see [mcp.md](mcp.md)). The first surface built for
1.9.0, "the communication layer": everything downstream (a portal, notifications, metrics, CI)
consumes this rollup rather than re-deriving it. MIL-162 ("explore: interactive, teachable
navigator for event models") explored what that portal should be and decided: a separate add-on
tool (working name **em-portal**) consuming `em export --json` + `em status --json`, not a
rework of `em catalog` — see
[docs/decisions/mil-162-teachable-navigator.md](decisions/mil-162-teachable-navigator.md) for
the reasoning, the onboarding/cross-model-navigation design, and prototype scale numbers up to
1,200+ slices across 20 models. Follow-up work lives in the em-portal Linear project, not here.
Most recently (MIL-171): optional `owner:`/`tracking:` frontmatter keys — who (a person or team)
holds a slice, and a URL into an external tracker mirroring it — both hand-filled, no dedicated
`em` write path, same as `implementedIn`. Surfaced in `em export`'s doc join (`schemaVersion`
`1.9`), `em slice index`'s new Owner/Tracking columns, and `em status --json`'s new per-slice
`owners[]` list (`statusSchemaVersion` `1.2`). This is the `em`-side half of slice ownership —
`tracking` is the exact field `em-tracker-bridge` (built in parallel) reads to find the mirrored
ticket; `em` only stores and displays, it never talks to a tracker itself.

**Modeling and rendering**

- **UI-field tracing** — extend fields-completeness validation (shipped for view←event and
  event←command) to trace `ui` fields back to the read model they display.

**The conformance loop**

- **Slice-doc ↔ model consistency as a validate rule** — partially shipped: `status`/
  `implementedIn` coherence is now a deterministic `em validate` rule and an `em export`
  field (`slice.doc.driftSignal`, MIL-85), so the `conform` phase reads a computed answer
  instead of judging it fresh each time. `{ fields }`-block-level consistency checking remains
  judgment-only ([#41](https://github.com/milehimikey/em/issues/41)).
- **Version/content ledger agreement** — shipped: an opt-in `em ledger` CI check (MIL-89)
  flags a slice doc whose `version:` didn't bump despite a content change, or vice versa (or
  a version that went backwards), reusing `em diff`'s git-revision plumbing rather than adding
  a new `em validate` rule — that check needs history, and `em validate` deliberately never
  touches it.
- **Vendored-skill drift** — shipped: the bundled `event-modeling` skill can itself go
  stale two ways. In-repo, an `em-version:` stamp plus a doctest/generated-reference gate
  (MIL-92) keeps this repo's own skill docs honest release-over-release. Downstream, `em skill
  sync`/`em skill check` (MIL-93) let a repo that vendored the skill via `em skill install`
  materialize the current copy or CI-gate on drift against whatever `em` is actually
  installed, instead of a hand-rolled sync guard per consuming repo.

**Bigger, and deliberately waiting for a reason**

These are real ideas held back on purpose until something concrete asks for them:

- An MCP server over `em export`, for agent surfaces beyond Claude Code — waiting for a
  second agent surface actually in use against em models. (The static catalog used to sit
  here with the same posture; its trigger fired, and it shipped as `em catalog`.)

Have a case for one of these, or something missing? Open an issue — a concrete use case is
exactly what moves something out of the waiting list.
