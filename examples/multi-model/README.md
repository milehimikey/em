# multi-model

A worked example of the **one-directory-per-model** convention for a project with more than
one event model (MIL-160) — see
[docs/cli.md, "Multi-model projects"](https://github.com/milehimikey/em/blob/main/docs/cli.md#multi-model-projects)
for the full rationale.

```
multi-model/
  system.yaml              # system manifest (schema 2.0): which models make up the system
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
em system                                                                        # same check; reads ./system.yaml (without one, discovers every tracked *.em)
```

## The seam

The two models also form one real integration seam (MIL-194, consumer-side since MIL-235).
Checkout publishes `event Order Submitted @Order public`; Fulfillment receives it in an
externally-fed Translation slice — `translation Order Intake` with no `from` (nothing inside
Fulfillment feeds it), issuing `Accept Order` → `Order Accepted` in the same slice, per
[patterns.md](https://github.com/milehimikey/em/blob/main/docs/patterns.md#translation). The
consumer declares the binding on the translation itself:

```
translation Order Intake consumes checkout:event.order-submitted
```

`checkout:event.order-submitted` is a contract ref — `<modelKey>:<kind>.<slug>`, no slice and no
version — so Checkout can move the event between slices without breaking Fulfillment. Both models
still validate cleanly on their own: `em validate` checks only the ref's grammar, never the other
model (compile isolation). `em system` is where the ref is resolved: it fails with
`consumes-unknown-model`/`consumes-unknown-element` if the ref names no model or no `public`
element, and reports the one thing left unbound on purpose — Checkout's second public event,
`Order Cancelled`, which nothing consumes, as a `dangling-public-event` warning. Each model header
also names its owning team (`model "Checkout" owner "Storefront team"`), which `em system` shows
on the context map.

This example was migrated from the old schema 1.0 manifest (seams and owners in `system.yaml`) by
`em upgrade <model>.em --apply`'s `system-manifest` step — see
[docs/upgrading.md](https://github.com/milehimikey/em/blob/main/docs/upgrading.md#1140).

## CI

`.github/workflows/` holds the output of `em ci init system.yaml` (MIL-233): one `em-ci.yml` with
`validate-`, `api-check-`, `slice-index-`, `coverage-`, `ledger-`, `upgrade-check-` and `status-badge-<key>` jobs
for each of the two models plus a shared `skill-check` and `glossary`, and an `em-conform.yml`
whose `conform` job runs over a matrix of the two model directories. Re-running `em ci init
system.yaml` is a no-op, `--check` verifies both models' sections, and `em ci init
models/checkout/checkout.em` refuses rather than narrow the workflow to one model.

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
