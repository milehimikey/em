# Driving em from your own harness

`em` plans work and records it. It does not run it. The engagement skill is one thing that runs
it (a single lead session dispatching sub-agents); a ticket queue feeding cloud agents is
another; an orchestrator of your own is a third. This page is the contract between `em` and
whatever drives the work: what `em` publishes, what stays yours, and how the pieces of one slice
are found again across repositories.

It matters most when a model's code is in more than one repository
([multi-repository models](code-map-schema.md)), because then one slice is several pull requests
in several places and something has to keep track of the set.

## What em publishes

One document: `em engagement plan <model>.em <slug> --json`
([cli.md](cli.md#em-engagement-plan-file-slug---json)). It is derived fresh on every run from
the model, the slice docs, the code map and the Ledger. Nothing about the graph is stored.

| In the plan | What it is |
|---|---|
| `slices[]` | One entry per slice of the engagement: readiness, level, holds, Ledger state, PR title |
| `units[]` (when the model has a code map) | The unit graph: one `kind: "unit"` node per slice × repository, one `kind: "close"` node per slice |
| `units[].dependsOn` | The ids a node waits for |
| `units[].partOf` | The slice a node belongs to. A slice is done when all its nodes are |
| `units[].state`, `units[].pr` | Where each node stands, from the Ledger |
| `units[].branch`, `units[].marker` | The join key (below) |

`dependsOn` and `partOf` are the only two relations. Nodes that share a `partOf` are siblings;
there is no edge between them.

**With no `units` key** (the model has no code map) every `slices[]` entry is one unit: one
branch, one pull request, in the model's own repository. Treat it as a node with no
dependencies and its own closing bookkeeping, as before 1.24.0.

A node is **ready** when its slice is not held (`slices[].held` is `null`), its `state` is
`planned`, and every node in its `dependsOn` is `merged`. That one rule schedules work units and
closing steps alike.

For each work unit, `em engagement brief <model>.em <slug> --slice <key> --unit <repo>` is the
self-contained work order: the spec, the unit's elements and place, its siblings as context, and
its definition of done.

## What em records

One file: the engagement file, `<model dir>/engagements/<slug>.md`, in the model's repository
([engagement-schema.md](engagement-schema.md)). It holds each slice's, and each unit's, state,
branch, base and pull request URL.

- **One writer.** Only `em engagement set`, run in the model's repository, writes it. A worker in
  a code repository never does. It reports its result to the harness, and the harness records it:
  `em engagement set <model>.em <slug> <key> --unit <repo> --state <state> --pr <url>`.
- **Stored, not looked up.** `em` never asks a forge whether a pull request is open or merged.
  Your harness sees the merge and tells `em`.
- **A slice's state follows from its units.** It is `merged` only when every unit is.

Two more records are written at a slice's closing step, also in the model's repository: the
slice's bindings file, and the slice doc's shipped record
(`em slice mark-implemented … --unit <repo>`, once per unit).

## What stays yours

| Yours | Why em does not do it |
|---|---|
| **Claims**: which worker has which node | A claim has to be decided in one place at one instant: a lock, a transaction, a ticket's assignee. `em`'s only store is a file committed to git, which several branches can change at once. The engagement skill is a single lead, so it holds claims in its own head; your harness uses whatever authority it has |
| **Retries and timeouts** | They are about your workers, not about the model |
| **Seeing a merge** | `em` is not a forge client. Poll, or take a webhook, and call `em engagement set … --state merged` |
| **Checkouts** | `em` resolves a repo id to a checkout and reports what is missing ([`em repos check`](cli.md#em-repos-check-target)). It never clones, pulls or pushes |
| **Running the closing step** | It is a node in the graph so you can schedule it. Its steps are in [external-implementers.md](external-implementers.md#when-the-code-is-in-another-repository) |

## The join key: finding a slice's pull requests

A slice in three repositories is three pull requests that no forge links. Every unit pull
request therefore carries a join key, in two forms, so the set can be recovered from the forge
alone, without the engagement file.

**1. The branch name.** Every unit of one slice uses the same branch name in its own repository:
`impl/<slice-key>`, as `units[].branch` gives it. The closing step's branch is
`close/<slice-key>`, in the model's repository. Listing open pull requests whose head is
`impl/<slice-key>`, in each repository of the system, finds the slice's units.

**2. A line in the pull request body.** Exactly as `units[].marker` gives it:

```
Em-Unit: <modelKey>:<sliceKey>@<repo>
```

for example `Em-Unit: checkout:place-order@storefront-web`. The closing step's is
`Em-Unit: <modelKey>:<sliceKey>@close`. `<modelKey>` is the model's key (the kebab-case of its
`model "Name"`), so two models with a slice of the same name do not collide. Searching a forge
for `"Em-Unit: checkout:place-order@"` finds every pull request of that slice, in every
repository, open or merged.

Both forms are derived from the slice key and the repo id alone, so they are the same on every
run and need no registry. The branch name is the one a person sees; the body line survives a
branch rename and names the model. `em` writes neither: the worker that opens the pull request
does, from the plan or the brief, and the brief states both.

A unit id (`<sliceKey>@<repo>`) is unique within one model. Qualified with the model key, as in
the marker, it is unique within a system.

## A minimal loop

```
loop:
  plan = em engagement plan <model>.em <slug> --json
  for node in plan.units where ready(node) and not claimed(node):     # claims are yours
    claim(node)
    if node.kind == "unit":
      checkout = resolve(node.repo)                                   # em repos check --json
      brief = em engagement brief <model>.em <slug> --slice <node.partOf> --unit <node.repo>
      worker opens a PR in checkout: branch node.branch, title node.prTitle, body has node.marker
      em engagement set <model>.em <slug> <node.partOf> --unit <node.repo> --state review --pr <url>
    else:                                                              # the closing step
      write the bindings file, em conform bindings check, em slice mark-implemented --unit …, PR
  for each PR your harness sees merged:
      em engagement set <model>.em <slug> <key> --unit <repo> --state merged
  stop when em engagement status reports closable: true
```

Every `em engagement set` runs in the model's repository, from one process at a time.

## See also

- [code-map-schema.md](code-map-schema.md): where a model's code lives.
- [engagement-schema.md](engagement-schema.md): the engagement file.
- [external-implementers.md](external-implementers.md): the ticket-driven loop, step by step.
- [cli.md](cli.md#em-engagement): every `em engagement` command.
