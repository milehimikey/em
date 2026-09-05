# MCP server

`em` ships an MCP ([Model Context Protocol](https://modelcontextprotocol.io)) server that
exposes structured, read-only access to `.em` models as tools — the same JSON documents the
CLI's `--json`/`em export`/`em contract` surfaces print, reached over stdio instead of a shell
(MIL-21). It exists for agent tooling that talks MCP natively rather than shelling out: the
Slicewright story's cross-agent demonstration, and any other MCP client (Cursor, other coding
agents, custom tooling) that wants em model data without a subprocess wrapper.

The server lives outside the CLI core — `src/mcp/` never imports `src/cli.ts` or commander, and
reuses the exact same data-layer builders the CLI's own JSON flags call
(`src/emit/json.ts`, `src/emit/validateJson.ts`, `src/emit/diffJson.ts`, `src/emit/glossaryJson.ts`,
`src/catalog/sliceReadyValidate.ts`, `src/cli/contract.ts`, `src/cli/changelogBuild.ts`,
`src/cli/conformScope.ts`). One schema per surface: an MCP client and a shell script parsing
`em export --json` see byte-identical documents for the same model.

## MCP parity: a stated invariant

**Every read surface `em` ships must reach agents two ways: as a CLI `--json` flag (or, for a
surface with no natural JSON shape like `em changelog`, as its plain-text stdout) *and* as an MCP
tool, byte-identical for the same inputs.** This isn't a description of what happened to be built
— it's a rule the project holds itself to going forward (MIL-167): a new read surface (`status`,
`query`, `system` today; `metrics` later, per [roadmap.md](roadmap.md)) ships its MCP tool in the *same*
release, not as a follow-up ticket. The reason is architectural, not stylistic: for an agent, MCP
*is* the conversation channel to this tool — "use agents and tools to talk to our architecture"
fails wherever a surface is CLI-only, no matter how good that surface's `--json` output is.

Mechanically, the rule is cheap to keep because it's structural rather than promised: every tool
below calls the *exact same builder function* (`buildDiffJson`, `buildGlossaryJson`,
`buildChangelogDoc`, `buildConformScope`, …) its CLI command calls, never a second
implementation that happens to produce similar-looking JSON. Byte-identity is a consequence of
sharing code, not a thing tested into existence after the fact — though it's tested too (see
`test/mcp.test.ts`'s per-tool assertions that spawn the real CLI and diff its stdout against the
MCP tool's result).

## Starting it

Two equivalent entry points:

```bash
em-mcp    # dedicated bin, works from any installed em package
em mcp    # same server, started via the em CLI (discoverability)
```

Both start a stateless stdio MCP server: every tool call takes the model file path as an input
parameter and compiles fresh — no session state, no caching, nothing held between calls. Nothing
is written to stdout outside the MCP protocol itself; diagnostics go to stderr.

## Client configuration

Point any MCP client's server config at the `em-mcp` bin. From a global install:

```json
{
  "mcpServers": {
    "em": {
      "command": "em-mcp"
    }
  }
}
```

Without a global install, run it through `npx`:

```json
{
  "mcpServers": {
    "em": {
      "command": "npx",
      "args": ["-p", "@milehimikey/em", "em-mcp"]
    }
  }
}
```

This works the same way in Claude Code's `.mcp.json`, Cursor's MCP settings, or any other
client that reads an `mcpServers` map.

## Tools

Every tool's `file` input is a `.em` model path, resolved relative to the server process's
working directory — the same working-directory convention every `em` CLI command already uses.

| Tool | Input | Returns |
|---|---|---|
| `validate` | `{ file }` | The `em validate --json` document — works even on a model with errors |
| `slice_ready` | `{ file, sliceKey }` | The `em validate --slice-ready --json` machine verdict for one slice |
| `list_markers` | `{ file, issues?, divergences?, public? }` (booleans, default `true`) | The `--list-issues`/`--list-divergences`/`--list-public --json` marker document |
| `export_model` | `{ file }` | The full `em export` document — refuses (tool error) if the model has errors |
| `export_slice` | `{ file, sliceKey }` | One slice's scoped `em export --slice` document — refuses only if *that* slice has an error, or the key is unknown |
| `coverage` | `{ file, testsDir }` | The `em coverage --tests <dir> --json` document: per-slice, per-invariant citation status |
| `status` | `{ files, testsDir?, repo? }` | The `em status <files...> --json` document: state-of-the-system rollup across one or more models |
| `query` | `{ files, verb, event?, of?, depth?, pattern?, status?, context?, persona?, tag?, id?, testsDir?, name?, from?, to? }` | The `em query <verb> <files...> --json` document: deterministic graph queries (consumers/producers/downstream/upstream/slices/invariant/field/path) over the compiled model |
| `system` | `{ manifest }` | The `em system <manifest> --json` document: a seam manifest (`system.yaml`) verified against each model's export — every `public` event/view bound to another model's reaction — plus the org-level context map |
| `diff` | `{ oldFile, newFile? }` or `{ oldFile, from, to? }` (git — see below) | The `em diff --json` document: structural changes between two models, or one model across git revisions |
| `glossary` | `{ files }` | The `em glossary --json` document: cross-model term aggregation plus kind/field-type conflicts |
| `changelog` | `{ file, from?, to? }` (git — see below) | The exact markdown `em changelog` prints: the model's git history as a business-readable ledger |
| `conform_scope` | `{ file, repo, full? }` (git — see below) | The `em conform-scope --repo <repo>` document: changed paths mapped to slices via `implementedIn` |
| `freshness` | `{ file, repo? }` | The `em freshness <file> --json` document: one model's conformance record — last-conformed revision, commits behind HEAD, slice-PRs behind HEAD |
| `contract` | *(none)* | The packaged implementation contract (`reference/implement.md`), same as `em contract` |

Each document's shape — field names, `schemaVersion`, diagnostic codes — is documented once, in
[cli.md](cli.md), under the matching CLI flag (`em validate --json`, `em validate --slice-ready
--json`, `em validate --list-issues --json`, `em export`, `em export --slice`, `em contract`).
This page doesn't re-document those shapes; it only documents the MCP-specific wiring (tool
names, inputs, error behavior).

### `validate`

Same document as `em validate <file> --json`: a pass/fail summary plus every diagnostic (code,
message, line, refs, `usageCategory`). This is the tool to reach for first — it's the only one
that still returns a useful document when the model has errors.

### `slice_ready`

Same document as `em validate <file> --slice-ready <sliceKey> --json`: the 4 named gates (doc
bound, frontmatter usable, status `ready-to-implement`, no unchecked Open Questions), the
overall `ready` boolean, and the diagnostics behind it. An unknown `sliceKey` is **not** a tool
error here — it's represented in the document itself (`gates: null`, `ready: false`, a
`slice-ready-unknown-slice` diagnostic), exactly like the CLI's own `--json` output.

### `list_markers`

Same document as `em validate <file> --list-issues --list-divergences --list-public --json`.
`issues`/`divergences`/`public` each default to `true`; pass `false` to narrow. Errors still
appear in the document's `diagnostics` field regardless of which marker kinds are requested.

### `export_model`

Same document as `em export <file>`. Refuses — a tool error, not a partial document — when the
model has any error-severity diagnostic, matching the CLI's own refusal.

### `export_slice`

Same document as `em export <file> --slice <sliceKey>`. Refuses only when the named slice
itself has an error, or when `sliceKey` matches no slice in the model — an unrelated slice's
breakage elsewhere never blocks it. Use this to read one already-ratified slice while the rest
of a large, still-WIP model has unrelated errors.

### `coverage`

Same document as `em coverage <file> --tests <testsDir> --json`: for every slice whose joined
doc status is `ready-to-implement` or `implemented`, each `INV-*` invariant ID the doc's own
`## Invariants` / `## Delta` sections *define* (see **Token format** under
[`em coverage`](cli.md#em-coverage-file---tests-dir) for exactly what counts as a definition),
whether a test under `testsDir` cites it, and every citing `file:line`. Refuses (a
tool error) when the model has errors, or when `testsDir` doesn't exist — matching the CLI's own
hard-error behavior for a missing `--tests` directory. This is a *checking* tool, not a
*judgment* one: it confirms an ID is cited, never whether the citing test is good or passing.

### `status`

Same document as `em status <files...> --tests <testsDir> --repo <repo> --json` (MIL-163): a
deterministic state-of-the-system rollup across one or more models — slices by lifecycle status,
`driftSignal` breakdown, invariant coverage totals, open `issue` markers + unchecked Open
Questions, and last-conformance commits-behind-HEAD per model. `files` takes one or more `.em`
paths (same resolution convention as every other tool's `file`); `testsDir`/`repo` are optional,
mirroring the CLI's `--tests`/`--repo` flags — `invariants` comes back `null` when `testsDir` is
omitted. Refuses (tool error) when any input model has errors, or when `testsDir` is given but
doesn't exist — matching `em status`'s own CLI refusal. Doc-join warnings
(`binding-missing-file`/`frontmatter-invalid`) reach this tool's `diagnostics` field exactly as
they reach the CLI's stderr-plus-JSON pair — an MCP tool call has no stderr channel of its own,
so the document is the only place they surface here. See [`em status`](cli.md#em-status-files)
for the full JSON shape.

### `query`

Same document as `em query <verb> <files...> --json` (MIL-168): scoped, token-cheap graph
answers over the compiled model — 8 verbs selected by `verb`
(`consumers`/`producers`/`downstream`/`upstream`/`slices`/`invariant`/`field`/`path`), each
taking whichever of `event`/`of`/`depth`/`pattern`/`status`/`context`/`persona`/`tag`/`id`/
`testsDir`/`name`/`from`/`to` that verb uses (unused params for a given verb are ignored; a
required-but-missing one is a tool error naming it). `event`/`of`/`from`/`to` accept a stable
export ref or a bare display name; an ambiguous bare name is a tool error listing every
candidate ref, never a guess. Built from the exact same `ModelIndex`/verb functions
(`src/model/queryIndex.ts`, `src/query/verbs.ts`) the CLI's own `query` subcommands call — same
parity contract as every other tool. Refs in `results` are `<modelKey>:<ref>`-qualified whenever
`files` has more than one entry, bare otherwise — `<modelKey>` is the kebab-slug of each file's
declared `model "Name"` (basename fallback), the same key `export_model` returns as `model.key`
and every other em surface uses (see [`em query`'s Cross-model
addressing](cli.md#em-query-verb-files) and [Model-qualified refs](cli.md#model-qualified-refs),
MIL-193). Two files deriving the same key are suffixed `~2`/`~3`, … in `files` order; the CLI
prints a `duplicate-model-key` warning for that on stderr, and — like every other compile
warning under `query` — the tool returns the (identical) JSON document without it. Refuses (tool
error) when any input model has errors, same as `em query`'s own CLI refusal; a legitimately
empty answer (e.g. an event with no consumers) is `results: []`, not an error. See [`em
query`](cli.md#em-query-verb-files) for the full JSON shape, per-verb result fields, and the
legal-connection graph traversal runs over.

### `system`

Same document as `em system <manifest> --json` (MIL-194): the seam manifest at `manifest`
(`system.yaml` — YAML or JSON; resolved relative to the server's working directory, with each
model's `source` resolving relative to the manifest itself) verified against every model it
declares — both endpoints resolve, the `from` is a `public` event/view, the `to` is a
translation/automation-kind element (or a slice holding exactly one) — plus the cross-model lints
(`dangling-public-event`, `unbound-translation`, `undeclared-seam-candidate`) and the
`contextMap` (models as nodes, seams as edges) em-portal renders. Built from the exact same
loader/verifier/builder (`src/cli/systemInputs.ts`, `src/system/verify.ts`,
`src/emit/systemJson.ts`) the CLI calls — same parity contract as every other tool. Verification
reads export JSON only: a `.em` source is compiled to the same document `export_model` returns,
a `.json` source is read as one (schema ≥ 1.10). Refuses (tool error) when the manifest is
unreadable or invalid, or any source can't be read/compiled or has errors — the CLI's own
refusal. A seam that fails verification is **not** a tool error: the document comes back with
that seam's `status: "error"` and its codes, exactly as the CLI prints it (with exit 1). See
[`em system`](cli.md#em-system-manifest) for the manifest format, every check, and the full JSON
shape.

### `diff`

Same document as `em diff --json`, in either of its two mutually exclusive forms: pass
`oldFile` + `newFile` to compare two files directly, or `oldFile` + `from` (and optionally `to`)
to diff one file across git revisions. **The git-revision form requires `oldFile` to be tracked
in a git repository** reachable from the server process's working directory — it resolves each
revision's content via `git show <rev>:<path>`, the same as the CLI. `to` defaults to the file's
current on-disk content when omitted. An invalid combination (e.g. both `newFile` and `from`) is
a tool error naming the conflict, mirroring the CLI's own argument validation
(`planDiffArgs`). Refuses (tool error) when either side fails to compile or has validation
errors, same as the CLI. See [`em diff`](cli.md#em-diff-old-new) for the full JSON shape.

### `glossary`

Same document as `em glossary <files...> --json`: element, field, persona, and context terms
aggregated across the given models, plus `kind-conflict`/`field-type-conflict` findings where
the same normalized term disagrees across ≥2 models. Each file is compiled independently, never
merged — same semantics as the CLI. Refuses (tool error) if any file fails to compile or has
validation errors. See [`em glossary`](cli.md#em-glossary-files) for the full JSON shape.

### `changelog`

Returns the exact markdown text `em changelog <file>` prints to stdout — **not** JSON, since the
CLI command itself has no `--json` form; the rendered document *is* the artifact, one section per
commit (newest first) with its structural delta and any dated Decisions-log entries woven in.
**Requires `file` to be tracked in a git repository** reachable from the server process's working
directory (the walk is `git log --follow`). `from`/`to` bound the walk, same semantics as the
CLI's flags. See [`em changelog`](cli.md#em-changelog-file) for the full section-by-section
anatomy.

### `conform_scope`

Same document as `em conform-scope <file> --repo <repo>`: the state file's `Last conformance:`
marker, the target repo's changed paths since that revision, each mapped to a candidate slice via
its doc's `implementedIn`, and any leftover unmapped paths. **Requires `repo` to be (or be
inside) a git repository**, and `file`'s sibling state file (`.event-modeling.md`) to exist and
parse. `full: true` mirrors the CLI's `--full` flag (scope every `status: implemented` slice,
ignoring `Last conformance:`/changed paths). **Deliberately narrower than the CLI**: the CLI's
`--seed-asis` flag (which writes a `<model>-asis.em` scratch file and touches `.gitignore`) has
no MCP equivalent — this tool never writes anything, keeping every MCP tool in this server
read-only. Use the CLI directly for that step. See [`em conform-scope`](cli.md#em-conform-scope-file)
for the full JSON shape.

### `freshness`

Same document as `em freshness <file> --json` (MIL-164): one model's conformance record — the
exact same `ConformanceEntry` `status`'s `conformance[]` array carries for that model, wrapped in
its own versioned envelope — without pulling in the rest of `em status`'s rollup. Useful for an
agent that only wants to qualify an answer ("per the model, last verified against code N commits
ago") without paying for a full state-of-the-system compile. `repo` is optional, mirroring the
CLI's `--repo` flag. Refuses (tool error) when the model has errors, matching `em freshness`'s
own CLI refusal. See [`em freshness`](cli.md#em-freshness-file) for the full JSON shape.

### `contract`

No input. Returns `reference/implement.md` verbatim, from the skill directory bundled with
whichever `em` package is running — the implementation contract every agent (Claude Code or
not) should read before implementing a slice.

## Trust model

`em-mcp` is a local stdio server, launched by the user's own MCP client configuration — it runs
with exactly the privileges of running `em` in a shell, as the same OS user, with the same
filesystem access. Every tool's `file` (and `coverage`'s `testsDir`) is resolved by the server
process the same way a CLI argument is: relative to its working directory, with **no path
containment**. A client that lets an agent choose these paths freely can point them anywhere the
server process can read.

This is a deliberate choice, not an oversight (PR #101 review): containment/sandboxing is the
MCP client's and the OS's job — scope what the agent can reach via your client's own controls
(working directory, filesystem permissions, container/sandbox boundaries), not by asking `em-mcp`
to second-guess paths it's handed. `em-mcp` stays a thin, predictable data layer over the same
model files the CLI already reads.

## Error behavior

A missing file, a parse error, or (for `export_slice`) an unknown slice key comes back as an
MCP tool error (`isError: true`, with a message explaining what went wrong) — never a process
crash and never a bare protocol-level error. A model *with validation errors* is not a tool
error for `validate`/`slice_ready`/`list_markers`: those are exactly the tools built to work on
a broken model. `export_model`/`export_slice`/`diff`/`glossary`/`conform_scope`/`status`/`query`/`system` do refuse on
errors (as tool errors), matching each command's own CLI behavior (`system` refuses only when the
manifest or a model source can't be loaded — a failing *seam* is reported inside the document). The three git-backed tools
(`diff`'s revision form, `changelog`, `conform_scope`) surface every git failure mode the same
way — not inside a git repository, an untracked file, an unknown revision — as a tool error with
the same message the CLI would print to stderr, never a crash.

## See also

- [cli.md](cli.md) for the full JSON document shapes each tool returns.
- [ai-workflow.md](ai-workflow.md#implementing-outside-claude-code) for the wider agent-neutral
  discovery story this server is part of (`em contract`, the readiness gate, `em export
  --slice`) — MCP is one more route to the same data, not a separate contract.
