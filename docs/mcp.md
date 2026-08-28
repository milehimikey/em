# MCP server

`em` ships an MCP ([Model Context Protocol](https://modelcontextprotocol.io)) server that
exposes structured, read-only access to `.em` models as tools — the same JSON documents the
CLI's `--json`/`em export`/`em contract` surfaces print, reached over stdio instead of a shell
(MIL-21). It exists for agent tooling that talks MCP natively rather than shelling out: the
Slicewright story's cross-agent demonstration, and any other MCP client (Cursor, other coding
agents, custom tooling) that wants em model data without a subprocess wrapper.

The server lives outside the CLI core — `src/mcp/` never imports `src/cli.ts` or commander, and
reuses the exact same data-layer builders the CLI's own JSON flags call
(`src/emit/json.ts`, `src/emit/validateJson.ts`, `src/catalog/sliceReadyValidate.ts`,
`src/cli/contract.ts`). One schema per surface: an MCP client and a shell script parsing
`em export --json` see byte-identical documents for the same model.

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
doesn't exist — matching `em status`'s own CLI refusal. See [`em status`](cli.md#em-status-files)
for the full JSON shape.

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
a broken model. `export_model`/`export_slice` do refuse on errors (as tool errors), matching
`em export`'s own CLI behavior.

## See also

- [cli.md](cli.md) for the full JSON document shapes each tool returns.
- [ai-workflow.md](ai-workflow.md#implementing-outside-claude-code) for the wider agent-neutral
  discovery story this server is part of (`em contract`, the readiness gate, `em export
  --slice`) — MCP is one more route to the same data, not a separate contract.
