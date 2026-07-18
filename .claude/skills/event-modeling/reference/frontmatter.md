# Slice Frontmatter Reference

Every slice doc (`slices/<id>.md`) starts with a required YAML frontmatter block, injected by
`em slice new` and kept fresh by `em slice sync`. This is what makes slices searchable and
versionable by AI agents across a model with hundreds of slices, without reading every doc's body.
Full rationale: `docs/1.0.0-spec.md` in the `em` repo. This file is the quick reference for
day-to-day use.

---

## Fields

**Core identity** (required, `em slice new` sets these):

| Field | Meaning |
|---|---|
| `schemaVersion` | Frontmatter format version. `1`. |
| `id` | Stable key, kebab-case, generated once. **Never** re-derived from the title. Reference slices by `id`, never by title or filename. |
| `title` | Human display name. |
| `pattern` | `state-change \| state-view \| automation \| translation` — the read/write/automation/translation facet. |
| `status` | See Lifecycle below. |
| `version` | Integer, bumped via `em slice update --bump-version` on a meaningful content change. Git log is the real history — this is just a "has it changed" signal. |
| `model` | Relative path to the `.em` file. |
| `sliceElement` | The `.em` `Element.id` this doc is linked from (via `note "slices/<id>.md"`). |

**Generated** (never hand-edit — run `em slice sync` after any `.em` edit that touches this
slice's elements):

| Field | Meaning |
|---|---|
| `commands`, `events`, `readModels` | Names of the command/event/view elements in this slice. |
| `contexts`, `personas` | Contexts/personas touched by this slice's event/ui elements. |
| `triggers` | (automation/translation only) The `id` of the slice doc for the command this reaction triggers, in the next slice. |
| `triggeredBy` | (command slices only) The inverse — set on the doc for the command an automation/translation triggers. |

`em validate` warns "frontmatter out of sync with .em; run \`em slice sync\`" if these drift from
what the `.em` actually says. It never auto-fixes this — you have to run `sync` yourself.

**Optional / authored:**

| Field | Meaning |
|---|---|
| `swimlane` | `{ persona, context }` — structured form of the body's `**Swimlane:**` line. |
| `upstreamEvents` | Only for dependencies **not** visible in the `.em`'s wiring (an invariant reading state from an event not consumed via `from`). If the `.em` already expresses it, it belongs in the generated fields above, not here. |
| `relatedSlices` | Freeform cross-references to other slice `id`s. |
| `tags` | Free text, searchable via `em slice search --tag`. |
| `owner`, `created`, `updated` | |
| `supersededBy`, `implementedRef` | Written by external build tools, not by `em` — see Handoff below. |

---

## Lifecycle

```
draft → reviewed → ready-to-implement → in-progress → implemented → (deprecated | superseded)
```

- `draft` / `reviewed` / `ready-to-implement` — the `slice` phase drives these. Move a doc forward
  with `em slice update <id> --status <status>`.
- `in-progress` / `implemented` / `deprecated` / `superseded` — **post-handoff.** `em` never writes
  these; they exist so validation tolerates a build tool writing them back into the same file.
  Don't set these yourself during a design session.

---

## Handoff to build / SDD tooling

A slice is **ready** when `status` is `ready-to-implement` or later, **and** `em validate` is
clean for both the `.em` and this doc. At that point, here's what's authoritative for whatever
implements it:

- **`id`** — the only stable key. Never key generated code, tests, or tickets on title/filename.
- **Command/Input field table** — the real parameter contract (richer than the `.em`'s lightweight
  inline `{ field: Type }`, which is a structural preview only — they aren't cross-validated in
  1.0, so the doc wins if they disagree).
- **Event table's "Immutable Fact?" column** — treat as compile-time-enforced immutability.
- **`INV-n` invariant ids** — cite them in generated tests (`test("INV-1: ...")`).
- **Given/When/Then** — acceptance criteria. Happy path is the floor; rule-boundary scenarios
  trace to their `INV-n`.
- **Alternate & Error Flows** — required test cases, not optional.
- `triggers`/`triggeredBy` plus upstream/downstream (joining doc + `.em`) — a sequencing hint for
  a build orchestrator (don't build a slice until its upstream slices are `implemented`),
  advisory only.

`em` never clobbers fields it doesn't recognize on write (`sync`/`update` shallow-merge) — a build
tool's own bookkeeping fields survive.

---

## CLI

```bash
em slice new "Place Order" [--pattern state-change] [--id <id>]   # scaffold slices/<id>.md
em slice sync <id>                     # after wiring `note "slices/<id>.md"` into the .em
em slice sync --all                    # re-sync every doc in the directory
em slice list [--status <s>] [--pattern <p>] [--format json]
em slice show <id> [--body] [--format json]
em slice search "<query>" [--pattern <p>] [--status <s>] [--context <c>] [--tag <t>] [--format json]
em slice update <id> [--status <s>] [--bump-version]
em migrate <model-dir> [--dry-run] [--report <path>]    # one-time upgrade from a pre-1.0 model
```

All commands take `--dir <path>` (default `.`) and `--model <path.em>` if a directory has more
than one `.em` file. `list`/`show`/`search` read **frontmatter only** — never the `.em`, never the
doc body — so they stay cheap across a large model.
