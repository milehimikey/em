# Engagement file schema (`engagementSchemaVersion` 1.0)

An engagement file is `<model dir>/engagements/<slug>.md`, beside the model (MIL-268). It holds
one engagement: the slices a lead session builds as one stack of PRs, and the **Ledger** that
records where each slice stands. Commands: [`em engagement`](cli.md#em-engagement).

**Never hand-edit an engagement file.** `em engagement new` writes it. After that,
`em engagement set` is the only thing that changes a slice entry, and `em engagement close` is
the only thing that changes `status`. Each one splices a single line or the generated region and
leaves every other byte alone, line ending included. The file is never parsed and written back
out. A hand-edited entry that no longer fits on one line is refused, and so is a Ledger region
whose markers were deleted.

## Example

```markdown
---
engagementSchemaVersion: "1.0"
slug: loans
model: "../lending.em"
created: 2026-10-08
createdBy: "Alex Rivera"
parallel: 3
status: open
slices:
  - {key: overdue-loans-to-notify, state: merged, branch: "impl/overdue-loans-to-notify", base: "main", pr: "https://github.com/acme/lending/pull/12"}
  - {key: send-overdue-notice, state: review, branch: "impl/send-overdue-notice", base: "impl/overdue-loans-to-notify", pr: "https://github.com/acme/lending/pull/13"}
  - {key: tool-ratings, state: held, branch: null, base: null, pr: null, heldBy: human}
---
# Engagement: loans

Written by `em engagement new` and updated only by `em engagement set` / `em engagement close` —
never hand-edit the frontmatter `slices:` entries or the Ledger table (see docs/engagement-schema.md).

## Ledger

<!-- GENERATED:em-engagement-ledger:start -->
| Slice | Pattern | Doc status | State | Branch | Base | PR |
|---|---|---|---|---|---|---|
| `overdue-loans-to-notify` | state-view | implemented | merged | impl/overdue-loans-to-notify | main | https://github.com/acme/lending/pull/12 |
| `send-overdue-notice` | translation | ready-to-implement | review | impl/send-overdue-notice | impl/overdue-loans-to-notify | https://github.com/acme/lending/pull/13 |
| `tool-ratings` | state-view | draft | held (human) | — | — | — |
<!-- GENERATED:em-engagement-ledger:end -->
```

## Frontmatter

| Key | Type | Meaning |
|---|---|---|
| `engagementSchemaVersion` | string, `"1.0"` | This contract's version. Any other value is refused. |
| `slug` | kebab-case string | The engagement's name; also the file name stem. |
| `model` | string | The model file this engagement belongs to, as a `/`-separated path relative to the engagement file (`../lending.em`). `new` writes it. `plan`, `set`, `status` and `close` refuse a `<model>.em` argument that does not resolve to it (`em engagement <verb>: engagements/<slug>.md belongs to <model>, not <arg>`). `em status` counts an engagement only for its own model, so several models can share one directory. |
| `created` | `YYYY-MM-DD` | The local date `new` ran. This is the only date in the file. |
| `createdBy` | string or `null` | `new --by <name>`; `null` when not given. |
| `parallel` | positive integer | The per-level ceiling: how many slices of one level may be in flight at once (default 3). `plan` reports every level's width against it. |
| `status` | `open` \| `closed` | `close` sets `closed` once every slice is `merged` or `gap`. `em status` counts the open ones. |
| `slices` | list | One entry per unit (doc-owning slice), in model order. |

Each `slices` entry is a one-line flow mapping with its keys in this fixed order. String values
are double-quoted, so a URL or a branch name containing `:` stays valid YAML.

| Key | Type | Meaning |
|---|---|---|
| `key` | slice export key | The unit. Continuations and `covers:`-bound slices are folded into it and never listed on their own. |
| `state` | `planned \| building \| validating \| review \| awaiting-merge \| merged \| held \| gap` | The Ledger state. `merged` is terminal. |
| `branch` | string or `null` | The slice branch, normally `impl/<key>`. |
| `base` | string or `null` | The branch the PR targets (`main` or `impl/<upstream>`), as recorded. `plan` computes the current one. |
| `pr` | string or `null` | The PR URL. |
| `heldBy` | `human` (optional) | Present only while `state` is `held` through `em engagement set --state held`. |

`merged` is also *inferred*, without being written, when the slice doc reaches
`status: implemented`. `plan` and `status` report that as `state: merged`, `stateInferred: true`.
The plan's own computed hold (`not-ready`, `upstream-outside-engagement-unmerged`,
`multiple-unmerged-upstreams`) is never stored here; see
[`em engagement plan`](cli.md#em-engagement-plan-file-slug---json).

## Ledger region

The body's table sits between `<!-- GENERATED:em-engagement-ledger:start -->` and
`<!-- GENERATED:em-engagement-ledger:end -->`, the same generated-region convention slice docs
use. It is derived: every row comes from the frontmatter entry, plus the slice's pattern and its
doc's status at the moment of the write. `new` and `set` regenerate it. An empty cell is `—`,
and a human hold shows as `held (human)`. Text outside the region is yours to write, for notes
or a link to the plan.

## Versioning

`engagementSchemaVersion` is versioned independently of the npm package and of the two JSON
documents (`engagementPlanSchemaVersion` and `engagementStatusSchemaVersion`, each `"1.0"`). An
additive key bumps the minor version. Renaming or removing a key bumps the major version and
needs an `em upgrade` step.
