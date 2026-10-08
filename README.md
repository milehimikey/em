# em — event modeling in plain text

`em` is a command-line tool for [Event Modeling](https://eventmodeling.org/). You write a
model in a small, slice-first DSL and `em` renders it as a clean, deterministic diagram.
Because the source is plain text — diff-able, reviewable, unambiguous — it's as easy for an
AI to write and edit as it is for a person, and `em validate` keeps either one honest.

![An order-fulfillment event model rendered by em](https://raw.githubusercontent.com/milehimikey/em/main/examples/order-fulfillment.svg)

The source for that diagram is [about 70 lines of text](examples/order-fulfillment.em) — or
see it as a [full project](examples/order-fulfillment/), slice docs and all, for a guided
tour of the rest of the toolchain.

## Install

```bash
npm install -g @milehimikey/em
```

Requires Node ≥ 18. SVG, PNG, and PDF rendering are all fully self-contained (Graphviz runs
as bundled WebAssembly); nothing else to install. Only rarer formats (ps, eps, ...) need an
optional system dependency — see [docs/dependencies.md](docs/dependencies.md).

### Pinning a version per project

A global install means every contributor (and every agent) runs whatever version happens to be
installed on their machine, which drifts over time. To pin an exact version for one project — no
`package.json` required, works in any repo regardless of language — drop a `.em-version` file next
to the model (or anywhere above it):

```bash
echo "1.14.0" > .em-version
```

From then on, running the globally-installed `em` transparently re-execs the pinned version via
`npx` whenever it differs from what's installed — same command, same output, nothing else to
remember. This is the same pattern Node's Corepack uses for npm/yarn/pnpm's `packageManager`
field. A repo without `.em-version` sees no change in behavior. Set `EM_SKIP_VERSION_PIN=1` to
bypass pinning outright (e.g. while developing em itself from a local checkout).

## Quickstart

```bash
em init model.em          # scaffold a starter model
em render model.em        # -> model.svg  (open it in a browser)
em watch model.em --serve # live browser view, re-renders on every save
em validate model.em      # check event-modeling rules
```

Once a model is real and committed, `em` keeps working on it over time:

```bash
em export model.em        # versioned JSON, for agents and tooling
em diff model.em --from HEAD~1   # what this change did to the model
em changelog model.em     # the model's git history as a business ledger
```

A system of several models — one per team or bounded context, each in its own directory —
gets the same treatment across model boundaries. A producer marks the commands, events and
views other teams depend on `public`, and `em api generate` writes them as the model's own
TypeSpec contract (`contracts/<model>.tsp`). A consumer declares what it reads on its own side,
`translation Order Intake consumes checkout:event.order-submitted`. `em system` finds the
models (a `system.yaml` listing them, or discovery of every `.em` in the repo), resolves every
`consumes` against the producers' public surface, fails when a consumer still reads a field its
producer dropped, and emits the org-level context map. `em system codeowners` puts every
consuming team on the producer's contract file in CODEOWNERS, so a contract change cannot merge
without them, and two gates hold the line: `--slice-ready` will not hand off a slice whose
contract is stale, and `em system scope` fails a PR that changes a contract and its consumer
together ([docs/process.md](docs/process.md#seams-between-models-who-does-what); worked example
in [examples/multi-model/](examples/multi-model/)).

A model is a list of slices — vertical time steps, read left to right — whose elements land
in swimlane rows:

```em
model "Order Fulfillment"

persona Customer
context Order

slice "Browse Catalog" {
  ui Product Catalog @Customer
  command Place Order
  event Order Placed @Order
}

slice "View Open Orders" {
  view Open Orders from "Order Placed"
  ui Order List @Customer
}
```

The [tutorial](docs/tutorial.md) builds a complete model from an empty file in about twenty
minutes, and [docs/workflow.md](docs/workflow.md) picks up where it leaves off: how a model
gets specified, gated in CI, handed to implementation, and checked against the code that
implements it.

## How it works

Model, gate, ratify, implement, check — repeat as the system evolves. Humans make the calls
that matter (build the model, ratify a slice, rule on drift); `em` and its agents handle the
mechanical parts in between. This is the loop in miniature — see
[docs/workflow.md](docs/workflow.md) for the full seven-stage lifecycle and
[docs/process.md](docs/process.md) for exactly who (or what) does each part.

```mermaid
flowchart LR
    Model["Model<br/>.em file"] --> Gate["Gate<br/>em validate in CI"]
    Gate --> Ratify["Ratify a slice<br/>a human signs off"]
    Ratify --> Implement["Implement<br/>agent or engineer builds it"]
    Implement --> Conform["Conform<br/>em conform checks the code"]
    Conform -->|drift found, ratified| Model
```

## Model with AI

`em` ships a Claude Code skill bundle — one router skill plus six focused, SDLC-stage skills
(discover/extract, model/slice, implement, conform/validate, watch/review) — that runs a
facilitated Event Modeling session: the AI asks the questions, you supply the domain, and the
model renders live as it grows.

Install it as the `em` Claude Code plugin, pinned to the release you run (two commands, once per
machine; replace `1.14.0` with your `em --version`):

```bash
claude plugin marketplace add milehimikey/em@v1.14.0 --scope project
claude plugin install em@em-1-14-0 --scope project
```

Then run `/em:event-modeling` in Claude Code. The older vendored route (`em skill install`,
which copies the bundle into `.claude/skills/`) still works but is deprecated since 1.14;
`em upgrade --apply` moves a vendored repo to the pinned plugin in one commit. The same bundle
also runs the reverse direction:
`extract` derives a model from a system that already exists, and `conform` checks a model
against the code implementing it and reports where they've drifted. See
[docs/ai-workflow.md](docs/ai-workflow.md) for the phases and what a session produces, and the
[em-with-ai repository](https://github.com/milehimikey/em-with-ai) for a ~50-slice model
built this way.

## Documentation

| Doc | What it answers |
|---|---|
| [docs/tutorial.md](docs/tutorial.md) | Learn the tool by building a model from scratch |
| [docs/workflow.md](docs/workflow.md) | The model lifecycle: specify, gate, hand off, track change, detect drift |
| [docs/process.md](docs/process.md) | Who does what: where humans are required, where agents work with review, and the seam lifecycle between models |
| [docs/patterns.md](docs/patterns.md) | The four Event Modeling patterns and their DSL shapes |
| [docs/dsl.md](docs/dsl.md) | Full DSL reference: keywords, `from`, `again`, fields, notes |
| [docs/cli.md](docs/cli.md) | Every command and flag |
| [docs/validation.md](docs/validation.md) | Every rule `em validate` checks, and the fixes |
| [docs/ci.md](docs/ci.md) | Copy-paste CI recipes: validate `.em` changes, the multi-model gates, run conformance on a schedule |
| [docs/upgrading.md](docs/upgrading.md) | Bring a model repo forward across em releases: `em upgrade`, release by release |
| [docs/timeline.md](docs/timeline.md) | The Two Laws of the Timeline |
| [docs/ai-workflow.md](docs/ai-workflow.md) | The Claude Code skill: install, phases, artifacts |
| [docs/dependencies.md](docs/dependencies.md) | What's bundled vs. what needs a system install |
| [docs/usage-data.md](docs/usage-data.md) | What usage data em captures, and how to roll it up for a retro |
| [docs/architecture.md](docs/architecture.md) | How rendering works; why Graphviz, not PlantUML |
| [docs/roadmap.md](docs/roadmap.md) | What's planned |
| [docs/decisions/](docs/decisions/) | Write-ups for open design questions ([MIL-162](docs/decisions/mil-162-teachable-navigator.md), the stakeholder-portal decision; [MIL-194](docs/decisions/mil-194-seam-manifest.md), the seam manifest) |

## Development

```bash
npm install
npm run build          # produces dist/, exposes the `em` bin
npm test               # vitest
npx tsx src/cli.ts <command> ...   # run straight from source
```

## License

[MIT](LICENSE) © milehimikey
