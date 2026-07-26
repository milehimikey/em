# CLI reference

| Command | What it does |
|---|---|
| `em init [file]` | Scaffold a starter model (default `model.em`) |
| `em render <file>` | Render a model to SVG/PNG/PDF, or emit Graphviz DOT |
| `em watch <file>` | Re-render on every save; `--serve` adds a live browser view |
| `em validate <file>` | Check the model against event-modeling rules |
| `em export <file>` | Export a versioned JSON snapshot of the normalized model |
| `em diff <old> <new>` | Compare two models structurally (or one file across git revisions) |
| `em skill install` | Copy the bundled Claude Code skill into the current project |

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
| `--emit-dot` | Print the generated Graphviz DOT instead of rendering (or write it with `-o`) |
| `--keep-empty-lanes` | Keep the API lane even when no slice uses it |

```bash
em render model.em                 # -> model.svg
em render model.em -o out/model.png
em render model.em --emit-dot      # inspect the DOT
```

## `em watch <file>`

Renders once, then re-renders on every save. Saves with validation errors are skipped (the
errors print; the previous render stays on disk). Ctrl-C to stop.

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

## `em validate <file>`

Runs every rule in [validation.md](validation.md) and prints the diagnostics. Exits
non-zero if there are errors; exits zero on warnings or a clean model, printing
`ok — no issues` when there is nothing to report. Useful in CI to keep a committed model
honest.

| Flag | Effect |
|---|---|
| `--list-issues` | Print only the open `issue "text"` diagnostics (slice, element, line, text) instead of the full diagnostic list |
| `--fail-on-issues` | Exit non-zero if the model has any open issues (opt-in — issues are warnings and don't block by default) |

```bash
em validate model.em                          # full diagnostics; exits non-zero only on errors
em validate model.em --list-issues             # just the open `issue` clauses, for a quick sweep
em validate model.em --fail-on-issues          # CI gate: fail while any issue remains open
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

**Schema summary** (`schemaVersion: "1.0"`):

- `generator` — `{ name, version }` of the tool that produced the export.
- `source` — `{ path, sha256 }`; `path` is exactly what was passed on the command line.
- `model` — `name`, `personas`, `contexts`, `hasAutomation`, `slices`, `arrows`.
  - Each **slice** has a stable `key` (`slug(name)`, with a `~2`, `~3`, … suffix — and a
    warning diagnostic — if two slices share a name), plus `name`, `index`, `line`, and its
    `elements`. Elements appear only inside their slice, not flattened at `model.elements`.
  - Each **element** has a stable `ref` — `<sliceKey>/<kind>.<slug(name)>`, suffixed the same
    way on a same-kind-same-name collision within one slice — plus `kind`, `name`, `line`,
    `fields`, `note`, `issue`, `from`, `persona`, `context`, `again`, and `logicalRef`.
    Fields that don't apply to a given element are emitted as explicit `null` (not omitted),
    so a typed consumer (e.g. Pydantic) doesn't have to sniff for key presence. `from` is
    resolved to both the referenced name and its `ref`. `logicalRef` points at the first
    timeline instance of a `view … again` read model; `null` for everything else.
  - Each **arrow** carries its endpoint names plus resolved `fromRef`/`toRef`.
- `diagnostics` — every diagnostic `em validate` would print (severity, message, line),
  plus any export-only ref-collision warnings.

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
slices and elements added/removed/moved, field/`from`/note changes, and issue lifecycle
(opened, resolved, text changed). It's the semantic counterpart to `git diff` on a `.em`
file: raw `git diff` shows line hunks; `em diff` groups them into what actually happened to
the model, and — crucially — collapses a cross-slice move into one `moved:` line instead of
a delete-hunk-plus-add-hunk in two different places.

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

**`--json` shape** (`diffSchemaVersion: "1.0"`, versioned independently of the npm package,
same policy as `em export`'s `schemaVersion`): stdout is exactly one JSON document (no text
report). Diagnostics are still printed to stderr, *and* carried in the document.

- `generator` — `{ name, version }` of the tool that produced the diff.
- `oldModel` / `newModel` — `{ label, sha256 }`. `label` is the same string diagnostics are
  prefixed with (a file path, or `path@rev` for the `--from`/`--to` form); `sha256` hashes
  that side's source text, so a consumer can pin exactly what was compared.
- `identical` — `true` when the models have no structural differences (`hasChanges()`
  negated).
- `counts` — the same 13 counters the text rollup line summarizes (`slicesAdded`,
  `elementsMoved`, `fieldChanges`, `issuesResolved`, …), as-is.
- `changes` — `ChangeEntry[]` in new-file document order (additions and changes).
- `removals` — `ChangeEntry[]` in old-file document order.
- `diagnostics` — both sides' warnings, flat and side-tagged:
  `{ side: "old" | "new", severity, message, line }`. Empty when neither side warned.
  (`em diff` refuses to run at all if either side has *errors*, so these are warnings.)

Every key is a valid JavaScript identifier — hence `oldModel`/`newModel` rather than
`old`/`new`, since `const { old, new } = doc` is a syntax error.

Every `ChangeEntry` carries all its optional fields (`kind`, `name`, `sliceName`,
`fromSlice`, `toSlice`, `field`, `fieldType`, `oldType`, `newType`, `source`, `oldNote`,
`newNote`, `oldText`, `newText`, `from`, `to`) — explicit `null` when unused by that entry's
`type`, never omitted, so a typed consumer can destructure without sniffing for key
presence (same convention as `em export`). Output is byte-deterministic for the same two
inputs.

Entries identify elements by display name (`name`, `sliceName`), not by the `em export`
`ref`/slice `key` the diff actually matched on — joining a diff entry back to an `em export`
document means re-deriving the slug. Carrying refs on entries is a planned additive change
([#40](https://github.com/milehimikey/em/issues/40)).

## `em skill install`

Copies the bundled `event-modeling` Claude Code skill out of the npm package into
`.claude/skills/event-modeling/` in the current directory. Prints a reminder to run
`/event-modeling` in Claude Code afterwards. See [ai-workflow.md](ai-workflow.md).

| Flag | Effect |
|---|---|
| `-f, --force` | Overwrite an existing installation |
