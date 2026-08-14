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
concerns, so a consumer can gate or bucket findings without parsing prose
(`schemaVersion` `1.4`, `diffSchemaVersion` `1.5`). Most recently, those lineage keys are now
read, not just carried: `em diff` annotates a `slice-added`/`slice-removed` entry with its
slice doc's resolved `split-from`/`merged-from`/`superseded-by` when one's declared (a real
split reads as "split from", not a bare remove+add), and `em validate` resolves lineage refs
against the current tree — malformed grammar, self-reference/cycles, a dangling
`superseded-by`, and version arithmetic that names a future that hasn't happened are all
errors, while a `split-from`/`merged-from` naming a key legitimately absent from the current
tree (the steady state after a real split or merge) deliberately raises nothing at all
(`diffSchemaVersion` `1.6`; see [validation.md#lineage](validation.md#lineage)).
[workflow.md](workflow.md) is the resulting picture.

**Modeling and rendering**

- **UI-field tracing** — extend fields-completeness validation (shipped for view←event and
  event←command) to trace `ui` fields back to the read model they display.
- **Multi-word `@tags`** — quoted persona/context tags (`@"Customer Service"`).
- **Uniform-per-lane box height** — optional rigid alignment when field counts differ a lot
  within a lane (the current default is Graphviz center alignment).
- **Theming / palette options** and additional export niceties.
- **Pure-JS PDF** so PDF needs no system dependency either.

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

**Bigger, and deliberately waiting for a reason**

These are real ideas held back on purpose until something concrete asks for them — more
models than a repo can comfortably hold, a second agent surface, a non-engineer audience
that needs to browse models outside git:

- An MCP server over `em export`, for agent surfaces beyond Claude Code.

Have a case for one of these, or something missing? Open an issue — a concrete use case is
exactly what moves something out of the waiting list.
