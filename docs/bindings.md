# Bindings manifest schema (`bindingsSchemaVersion` 1.0)

A bindings manifest is `<model dir>/conformance/bindings/<slice-key>.yaml`, one file per slice,
beside the model (GH #449). It records where a slice's model elements and invariants actually
live in the code: which file and which identifier string anchors each one. `em conform bindings
check` reads it back and verifies those claims — the bound file exists, the bound identifier is
in it — a deterministic, grep-level check that turns a conform run's evidence walk into
something incremental instead of re-derived from scratch every time.

**This is a file contract, not a CLI feature.** Nothing about writing a valid bindings file
requires `em` — any implementer, including a ticket-driven agent that has never run `em`, can
author one directly from this page. `em` only ever *reads* this file
([`em conform bindings check`](cli.md#em-conform-bindings-check-file---repo-path)); there is no
`em`-provided writer.

## Why per-slice

One file per slice, named after the slice, so two slices being implemented in parallel never
touch the same file — the same "one slice = one file" discipline a slice doc itself holds. A
file's own name is part of its identity: `slice:` inside it must equal the file's name stem
(`conformance/bindings/place-order.yaml` must carry `slice: place-order`), and `em conform
bindings check` refuses a mismatch as malformed.

## Example

```yaml
bindingsSchemaVersion: "1.0"
slice: place-order
elements:
  - ref: command.place-order
    file: src/orders/Handler.kt
    identifier: placeOrder
  - ref: event.order-placed
    file: src/orders/Handler.kt
    identifier: OrderPlaced
    note: emitted at the end of the same handler
invariants:
  - id: INV-PO-1
    enforcedIn: {file: src/orders/Handler.kt, identifier: validateStock}
    testedIn: {file: test/orders/HandlerTest.kt, identifier: "rejects when out of stock"}
```

## Top-level keys

| Key | Type | Required | Meaning |
|---|---|---|---|
| `bindingsSchemaVersion` | string | yes | This contract's version. Only `"1.0"` is accepted today. |
| `slice` | string | yes | The slice export key this file binds (the same key `em export`/`em query`/every `<slice-key>` CLI argument uses — see [cli.md#slice-keys](cli.md#slice-keys)). Must equal the file's own name stem. |
| `elements` | list | no (default `[]`) | Model elements bound to code — see below. |
| `invariants` | list | no (default `[]`) | `INV-*` invariants bound to their enforcement and test sites — see below. |

Any other top-level key is a shape error (an unrecognized key silently doing nothing would defeat
the point of a verified contract).

## `elements[]`

| Key | Type | Required | Meaning |
|---|---|---|---|
| `ref` | string | yes | `<kind>.<slug>` — the element's kind (`ui`, `command`, `event`, `view`, or `reaction`) and its kebab-cased name, lowercase, dot-separated (e.g. `event.order-placed`). **Bare, with no `<slice-key>/` prefix** — the slice is already named by this file, unlike `em export`'s own `<sliceKey>/<kind>.<slug>` refs. `em conform bindings check` resolves it against the compiled model's own export refs for this slice; a `ref` the model doesn't have is reported as an unknown-element-ref failure. |
| `file` | string | yes | Repo-relative path (resolved against whatever `--repo` names at check time — never absolutized here). |
| `identifier` | string | yes | A plain substring to search for in `file` — a function/class/symbol name, a string literal, anything findable with a text search. Never parsed as code: no language awareness, no AST, so the same schema binds Kotlin, TypeScript, Python, anything. |
| `note` | string | no (default `null`) | Free-text context for a human — why this file, why this identifier. Never checked. |

## `invariants[]`

| Key | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | An `INV-*` token — the same stable ID convention a slice doc's `## Invariants / Business Rules` section uses (see [slice-doc-schema.md](slice-doc-schema.md)). Only checked here for looking like an `INV-*` token; it is never cross-checked against the slice doc's own declared IDs (that is `em validate`/`em coverage`'s job, not this file's). |
| `enforcedIn` | `{ file, identifier }` | yes | Where the rule is enforced in code — same two fields as an element binding, same plain-substring check. |
| `testedIn` | `{ file, identifier }` | yes | Where the rule is exercised by a test — same shape. |

## What `em conform bindings check` verifies, and what it doesn't

Verifies, deterministically, for every binding:
- The bindings file itself parses and shape-validates (see above).
- `slice:` matches a real slice in the compiled model (an orphaned file naming a renamed/removed
  slice is its own failure kind, `unknown-slice`).
- Every `elements[].ref` resolves against that slice's own element refs in the model.
- Every bound `file` exists under `--repo`, and contains its `identifier` as a substring.

Never does, by design:
- **No code parsing.** `identifier` is matched as a plain substring — it doesn't confirm the
  identifier is a function definition, that it's actually *called*, or that the code does what
  the slice says. The bindings file is a claim an author makes; the check verifies the claim's
  two facts (file exists, string is in it), not the code's correctness.
- **No cross-check against a slice doc's own `INV-*` IDs.** A typo'd or stale `id` is caught only
  if it fails the token-shape check; it is never looked up against `## Invariants / Business
  Rules`.
- **No git.** `--repo` does not need to be a git repository; nothing here runs `git`.

## Advisory, not a gate

`em conform bindings check` is never wired into `em validate`, `--slice-ready`, or any other
pass/fail gate em ships. Its own exit code stays `0` unless `--exit-code` is given — the same
opt-in-CI-job posture [`em refs --reachable-from`](cli.md#em-refs-file---reachable-from-rev)
holds. Run it from a scheduled or opt-in CI job, same as `em-conform.yml`'s conform cadence (see
[ci.md](ci.md)) — never from the required-checks gate.

## Versioning

`bindingsSchemaVersion` is independent of the npm package version and of `em conform bindings
check`'s own output schema (`bindingsCheckSchemaVersion`, documented in
[cli.md](cli.md#em-conform-bindings-check-file---repo-path)). An additive key would bump the
minor version; renaming or removing a key would bump the major version and need every existing
bindings file rewritten. There is no migration tooling today — `"1.0"` is the only version this
`em` accepts, on both the manifest and the check's own JSON.
