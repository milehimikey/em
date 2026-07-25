# CLI reference

| Command | What it does |
|---|---|
| `em init [file]` | Scaffold a starter model (default `model.em`) |
| `em render <file>` | Render a model to SVG/PNG/PDF, or emit Graphviz DOT |
| `em watch <file>` | Re-render on every save; `--serve` adds a live browser view |
| `em validate <file>` | Check the model against event-modeling rules |
| `em export <file>` | Export a versioned JSON snapshot of the normalized model |
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

## `em skill install`

Copies the bundled `event-modeling` Claude Code skill out of the npm package into
`.claude/skills/event-modeling/` in the current directory. Prints a reminder to run
`/event-modeling` in Claude Code afterwards. See [ai-workflow.md](ai-workflow.md).

| Flag | Effect |
|---|---|
| `-f, --force` | Overwrite an existing installation |
