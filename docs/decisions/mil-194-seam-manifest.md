# MIL-194 — a declarative seam manifest and `em system`

**Status:** decided, shipped in em 1.10.0. [MIL-194](https://linear.app/milehimikey/issue/MIL-194)
follows directly from the gap [MIL-162](mil-162-teachable-navigator.md) found and left open:
"em has no DSL-level cross-model reference," so the portal's cross-model links were a
name-matching heuristic with no compiler guarantee behind them.

## Problem

Several sub-departments each maintain a model, and many model pairs are the two sides of one
integration seam — yet "model A's public event feeds model B" existed nowhere as data. `public`
marks a published surface without saying who reads it; `from` resolves only inside one model;
the portal joined models by exact name. Rename an event and the link vanished silently.

The core observation: **em already has both ends of every seam.** A seam is a `public` event
(or view) on one side and an externally-fed Translation/Automation slice — a reaction with no
in-model `from` — on the other. What was missing is the binding between them, and a check that
extends the bedrock ["both ends of a flow"](../validation.md#both-ends-of-a-flow) rule across
models: every public event needs a declared reader somewhere in the system; every externally-fed
reaction needs a declared producer.

## Options considered

- **(A) A declarative seam manifest + `em system`.** A YAML file listing bindings in
  model-qualified refs, verified against the models' export documents by a new command (CLI
  `--json` and MCP tool, parity as usual). *Chosen.*
- **(B) A DSL-level cross-model reference** — `from "Order Placed" in model "checkout"`. Rejected
  for now: it couples one model's compile to another's source, breaks "models compile
  independently," and forces a decision about where the other model lives (path? package?
  registry?) into every `.em` file. It remains a possible *graduation* once manifests have been
  used in anger — a seam that has been declared and stable for a while is a candidate for
  becoming syntax — but not the first step.
- **(C) Status quo plus a naming convention** ("name your translation after the event it
  receives"). Rejected: it's exactly the silent heuristic the ticket exists to replace, and it
  can't express one event feeding two readers, or a reader whose name legitimately differs.

## Decision

Option A. The manifest is deliberately small:

```yaml
systemSchemaVersion: "1.0"
name: Meridian Goods
models:
  checkout:      { source: models/checkout/checkout.em, owner: Storefront team }
  fulfillment:   { source: models/fulfillment/fulfillment.em, owner: Warehouse team }
seams:
  - from: checkout:checkout/event.order-placed
    to: fulfillment:intake/translation.order-received
```

- **Model keys are MIL-193's.** The `models:` keys are the kebab-slug of each declared model
  name — the same `model.key` `em export` carries and `em query` qualifies with — verified
  against the export (`system-model-key-mismatch`), never invented here.
- **Refs are export refs.** `from`/`to` use the one qualified-ref grammar
  (`src/model/qualifiedRef.ts`); there is no second identifier scheme. A bare slice ref is
  accepted on the `to` side as a convenience and always resolved to the element in the output.
- **Verification reads export JSON only.** A `.em` source is compiled in-process into the exact
  `em export --json` document; a `.json` source is read as one (schema ≥ 1.10, for `model.key`
  and `model.edges`). One verifier, one input shape — so a monorepo pointing at `.em` files and a
  CI job aggregating exports from ten repositories are the same case. No LLM, no hosted storage,
  no deployment glue: `em system` verifies and emits; what publishes the exports is the
  consumer's business.
- **The old heuristic survives as a lint.** `undeclared-seam-candidate` fires when a public
  element's name matches a reaction or event in another model with no seam declared — "looks
  connected; declare the seam or rename." It is a warning, never a link.

## What "externally fed" means, precisely

A reaction is externally fed when its model's export has **no edge into it** in `model.edges` —
the deduped semantic edge list (`pattern` + `from` + `arrow` sources) `em export` carries since
MIL-191. That is the same derivation the renderer draws and `em query` traverses, so `em system`
never re-derives "is anything feeding this" from slice shape. A `translation`/`processor` with a
`from "View"` has an in-model source; one without (the externally triggered Translation shape
in [patterns.md](../patterns.md#translation)) does not. An externally fed reaction that no seam
names as `to` is `unbound-translation`; a `public` event/view that no seam names as `from` is
`dangling-public-event`. `em validate` stays quiet on both halves — each is a legitimate
single-model shape — which is exactly why the system-level check has to exist.

## The open question: where do manifests live?

Deliberately undecided, to be settled by pilot use: **one central manifest** for the system, or
**one manifest per repository** (each declaring its own models and the seams that touch them),
aggregated by CI. The tooling precludes neither — every manifest is a complete system for
`em system`, verified on its own, and the document shape assumes nothing about how many exist.
Per-repo manifests naturally give each team ownership of its seams; a central one gives the
context map a single source. When real usage picks one, that's a docs change, not a tool change.
