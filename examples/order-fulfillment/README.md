# order-fulfillment

A worked sample project for `em` — a real, complete project directory (not just a bare
`.em` file) walking through the tool end to end. The business process itself is
deliberately simple: a customer browses a catalog, places an order, checks out, the system
automatically captures payment from a gateway, and a receipt appears. Seven slices, three of
the four Event Modeling patterns (State Change, State View, Automation — see
[docs/patterns.md](https://github.com/milehimikey/em/blob/main/docs/patterns.md) for the
fourth, Translation). See [docs/tutorial.md](https://github.com/milehimikey/em/blob/main/docs/tutorial.md)
if you'd rather build this same model from scratch instead of reading a finished one.

**What to look at, and in what order**, if you're exploring this as a tour of `em` rather
than just reading the model:

1. **The diagram** — `order-fulfillment.svg` (or run `em watch order-fulfillment.em -o
   order-fulfillment.svg --serve` and open the URL it prints for the live pan/zoom viewer).
   Notice the note markers (amber) and how one slice (Capture Payment) has no `ui` at all —
   it's triggered by the `Payment Gateway` processor instead of a person.
2. **The model file**, `order-fulfillment.em` — see `tag`/`renamed from` in
   [examples/event-tags.em](../event-tags.em)/[examples/renames.em](../renames.em) for two
   DSL features this particular model doesn't happen to use.
3. **The slice docs**, `slices/*.md` — only 4 of the 7 slices are documented here
   (**Browse Catalog**, **Checkout**, **View Open Orders**, **Capture Payment** — two State
   Changes plus one of each remaining pattern), not all 7. Notice their statuses differ on
   purpose: `browse-catalog` and `checkout` are `ready-to-implement` with every Open
   Question resolved (`checkout` has none to begin with); `view-open-orders` and
   `capture-payment` are only `reviewed`, each with a real, unresolved Open Question the doc
   is honest about rather than guessing at.
4. **Run the readiness gate, both ways** —
   `em validate order-fulfillment.em --slice-ready checkout` actually passes: exit 0, `slice
   "checkout" is ready-to-implement`. Then run it against `browse-catalog` instead — same
   `ready-to-implement` status, same zero Open Questions, but it still reports NOT ready.
   Why: two of this model's `em validate` warnings (`Order Placed`'s system-generated
   `orderId`/`placedAt` fields) are *correct and permanent* — see
   [docs/validation.md](https://github.com/milehimikey/em/blob/main/docs/validation.md)'s
   Fields Completeness section — but `--slice-ready` blocks on *any* diagnostic touching a
   slice, without distinguishing "permanent and fine" from "needs fixing." `checkout`'s
   command and event happen to declare only fields that trace cleanly to each other, so it
   has nothing to warn about in the first place — that's what makes it the one that passes,
   not a difference in how thoroughly it was documented. That contrast is worth sitting with:
   a real property of the gate, not a bug in this example.
5. **`.event-modeling.md`** — a filled-in, resumable session state file: a Decisions log
   with real reasoning (including one near-miss — see the `Pending Payments` entry), and an
   Open Questions/parking lot that matches the slice docs' own unresolved items.
6. **Try the machine-readable surfaces** — `em export order-fulfillment.em`,
   `em validate order-fulfillment.em --json`. Also `em coverage order-fulfillment.em --tests
   <some-empty-dir>` — point it at any directory that isn't `slices/` itself (that directory
   is where the invariant IDs are *defined*, in prose; pointing `--tests` at it makes every
   `INV-*` mention in the docs look like a citation, which defeats the check). With no real
   test tree, all 3 of `browse-catalog`'s invariants correctly report `uncovered` — the
   honest answer for a docs-only sample, not a tool bug.

## Live view
While modeling, run the live view so the team can watch the diagram update:

```bash
em watch order-fulfillment.em -o order-fulfillment.svg --serve   # re-render + instant push-reload
# then open the URL it prints (http://localhost:5173/?svg=order-fulfillment.svg) and share the screen
```

Pan/zoom to navigate the diagram (drag, scroll; **Fit** resets), and click **Review mode** in
the header for a slice-by-slice walkthrough. If a save fails to render, the viewer keeps the
last good diagram and shows an error banner until the next successful load.

Static render: `em render order-fulfillment.em -o order-fulfillment.svg`

## Patterns legend
- **State Change** — UI → Command → Event
- **State View** — Event(s) → Read Model → UI
- **Automation** — Read Model (slice before) → Processor + Command → Event, together
- **Translation** — External input (or Read Model, slice before) → Translation + Command → Event, together

Between them these are the only legal connections: `ui → command`, `command → event`,
`event → read model`, `read model → ui`, `read model → reaction`, `reaction → command`. A command
never reaches a read model directly — the event goes between them. Every slice is joined up at
both ends: something triggers each command (the screen it's issued from, or the reaction that
triggers it, also in this slice), and every event a command records is read by some read model — so each State
Change slice is paired with the State View slice that projects its event. A read model repeated
along the timeline (`view X again`) shows the same projection at a later point; the instances are
never connected to one another.

## Slices
<!-- The canonical slice index — the ONE place slices are enumerated (the state file
     points here rather than keeping its own copy). Generated — run
     `em slice index order-fulfillment.em` to (re)write the table below from the model and its
     slice docs; never hand-edit between the markers. -->
<!-- GENERATED:slices:start -->
| # | Slice | Pattern | Status | Ratified by | Implemented in | Design doc |
|---|-------|---------|--------|-------------|----------------|------------|
| 1 | Browse Catalog | State Change | ready-to-implement | — | — | [slices/browse-catalog.md](slices/browse-catalog.md) |
| 2 | View Open Orders | State View | reviewed | — | — | [slices/view-open-orders.md](slices/view-open-orders.md) |
| 3 | Checkout | State Change | ready-to-implement | — | — | [slices/checkout.md](slices/checkout.md) |
| 4 | Manager Review | State View | no doc yet | — | — | [slices/manager-review.md](slices/manager-review.md) |
| 5 | Payments To Process | State View | no doc yet | — | — | [slices/payments-to-process.md](slices/payments-to-process.md) |
| 6 | Capture Payment | Automation | reviewed | — | — | [slices/capture-payment.md](slices/capture-payment.md) |
| 7 | Show Receipt | State View | no doc yet | — | — | [slices/show-receipt.md](slices/show-receipt.md) |
<!-- GENERATED:slices:end -->

## Status
See [`.event-modeling.md`](.event-modeling.md) for current phase, decisions, and open questions.
