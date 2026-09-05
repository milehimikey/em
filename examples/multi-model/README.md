# multi-model

A worked example of the **one-directory-per-model** convention for a project with more than
one event model (MIL-160) — see
[docs/cli.md, "Multi-model projects"](https://github.com/milehimikey/em/blob/main/docs/cli.md#multi-model-projects)
for the full rationale.

```
multi-model/
  system.yaml              # seam manifest (MIL-194): which public event feeds which reaction
  models/
    checkout/
      checkout.em          # model "Checkout" — a slice literally named "Checkout"
    fulfillment/
      fulfillment.em        # model "Fulfillment" — ALSO has a slice named "Checkout"
```

Both models deliberately declare a slice named **"Checkout"** — on purpose, to make the point
concrete: because `checkout/` and `fulfillment/` are separate directories, `em`'s doc lookup
(`slices/<slug>.md`, always a sibling of the `.em` file) never has to tell the two "Checkout"
slices apart. Each model's own `slices/checkout.md` would be a completely different file. No
model-qualified key, no configuration — directory placement alone is the whole guardrail.

Try it from this directory:

```bash
em validate models/checkout/checkout.em                                          # ok — no issues
em validate models/fulfillment/fulfillment.em                                    # ok — no issues
em status models/checkout/checkout.em models/fulfillment/fulfillment.em --json   # "diagnostics": [] — no collision
em catalog models/checkout/checkout.em models/fulfillment/fulfillment.em -o site # 2 models, 7 slices, no warnings
em system system.yaml                                                            # 1 seam verified + 1 dangling-public-event warning
em system system.yaml --json                                                     # the same, plus the context map (2 nodes, 1 edge)
```

## The seam

The two models also form one real integration seam (MIL-194). Checkout publishes
`event Order Submitted @Order public`; Fulfillment receives it in an externally-fed Translation
slice — `translation Order Intake` with no `from` (nothing inside Fulfillment feeds it), issuing
`Accept Order` → `Order Accepted` in the same slice, per
[patterns.md](https://github.com/milehimikey/em/blob/main/docs/patterns.md#translation). Both
models validate cleanly on their own: `em validate` exempts a public event from "nobody reads it"
and a reaction without `from` from any source check, because each one's other end is outside the
model by design. `system.yaml` is where that other end is declared:

```yaml
seams:
  - from: checkout:checkout/event.order-submitted
    to: fulfillment:receive-order/translation.order-intake
```

`em system system.yaml` verifies it (both endpoints resolve, the source is `public`, the consumer
is a reaction) and reports the one thing left unbound on purpose — Checkout's second public event,
`Order Cancelled`, which no seam names, as a `dangling-public-event` warning. Rename either endpoint
without touching the manifest and the seam fails as an error, instead of a heuristic link quietly
disappearing.

This layout is what `em scaffold <name> --under models` produces for each model — run it once
per model to add a third:

```bash
em scaffold "Billing" --under models   # writes models/billing/{billing.em,README.md,.event-modeling.md}
```

**What would break this.** If `checkout.em` and `fulfillment.em` were flattened into the SAME
directory instead (both sharing one `slices/` folder), their two "Checkout" slices would
collide on the exact same `slices/checkout.md` path. `em status`/`em catalog` — the only
commands that ever compile more than one model together — detect this directly and print a
`cross-model-slice-doc-collision` warning naming both files; nothing else in `em` checks for it,
so don't rely on validate alone. Layout, not tooling, is what avoids the problem in the first
place.
