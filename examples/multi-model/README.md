# multi-model

A worked example of the **one-directory-per-model** convention for a project with more than
one event model (MIL-160) — see
[docs/cli.md, "Multi-model projects"](https://github.com/milehimikey/em/blob/main/docs/cli.md#multi-model-projects)
for the full rationale.

```
multi-model/
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
em catalog models/checkout/checkout.em models/fulfillment/fulfillment.em -o site # 2 models, 4 slices, no warnings
```

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
