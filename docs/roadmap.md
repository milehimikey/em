# Roadmap

Directions under consideration, in rough priority order. Nothing here is a commitment.

Recently shipped, for context on where things are heading: open questions as diagram-visible
red notes (`issue`), JSON export with stable refs, structural `em diff`, the `conform` phase
for model-versus-code drift, `em changelog`, accepted-divergence annotations (`divergence`) so
a ratified model-vs-code deviation stops re-firing as drift, provenance links from a slice back
to its ticket (`source`), a lightweight usage-data convention (skill Usage log —
[usage-data.md](usage-data.md)) so the next roadmap pass has real signal instead of guesswork,
a `public` marker on events for integration-surface promotion (contract generators can now
tell a published event from an internal-only fact), stakeholder review mode — a slice-by-slice
storyboard walkthrough in the live viewer (`em watch --serve`'s "Review mode"), with red notes
captured live during the session — and, most recently, `em glossary` — a cross-model glossary
of element names, field names, personas, and contexts, with kind- and field-type-conflict
checks across models — giving the `extract`/`conform` phases a fuzzy-name-matching aid so
extraction vocabulary drift doesn't masquerade as real drift. [workflow.md](workflow.md) is the
resulting picture.

**Modeling and rendering**

- **UI-field tracing** — extend fields-completeness validation (shipped for view←event and
  event←command) to trace `ui` fields back to the read model they display.
- **Multi-word `@tags`** — quoted persona/context tags (`@"Customer Service"`).
- **Uniform-per-lane box height** — optional rigid alignment when field counts differ a lot
  within a lane (the current default is Graphviz center alignment).
- **Theming / palette options** and additional export niceties.
- **Pure-JS PDF** so PDF needs no system dependency either.

**The conformance loop**

- **Slice-doc ↔ model consistency as a validate rule** — the `conform` phase checks this by
  judgment today, but slice-doc frontmatter and `{ fields }` blocks are structured enough to
  check deterministically ([#41](https://github.com/milehimikey/em/issues/41)).
- **Export refs on diff entries** so a `em diff --json` entry joins directly to an
  `em export` document without re-deriving slugs
  ([#40](https://github.com/milehimikey/em/issues/40)).

**Bigger, and deliberately waiting for a reason**

These are real ideas held back on purpose until something concrete asks for them — more
models than a repo can comfortably hold, a second agent surface, a non-engineer audience
that needs to browse models outside git:

- A static catalog site rendered from git history (git stays the only history store).
- An MCP server over `em export`, for agent surfaces beyond Claude Code.

Have a case for one of these, or something missing? Open an issue — a concrete use case is
exactly what moves something out of the waiting list.
