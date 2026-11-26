# Multi-repository example

One model whose code lives in three other repositories. The four directories here stand for
four separate git repositories checked out side by side:

```
storefront-model/     the model's repository: system.yaml, the model, its code map, bindings
storefront-web/       the web app          (repo id storefront-web)
checkout-svc/         the checkout service (repo id checkout-svc)
payments-svc/         the payments service (repo id payments-svc)
```

They are plain directories in this repository, so to try the commands that find repositories,
copy the example out and make each one a repository:

```bash
cp -r examples/multi-repo /tmp/storefront && cd /tmp/storefront
for r in storefront-model storefront-web checkout-svc payments-svc; do git -C $r init -q; done
cd storefront-model
```

## The three files

| File | Says |
|---|---|
| `storefront-model/system.yaml` | Which repositories exist: `repos:` maps a repo id to its remote (manifest schema 2.1) |
| `storefront-model/checkout/code-map.yaml` | Where each part of the model's code lives: a default, a place per persona, a place per context |
| nothing committed | Where each repository is checked out on your machine. Here they are siblings named after their ids, which `em` finds by itself; otherwise `.em/repos.local.yaml` or `--repo <id>=<path>` |

## What to run

```bash
em repos check checkout/checkout.em          # every repo id: resolved, missing, or not a git repo; the em pin in force
em validate checkout/checkout.em             # the code map is checked with the model
em query slices checkout/checkout.em         # each slice's places
em export checkout/checkout.em               # places on the model, each slice and each element
em conform bindings check checkout/checkout.em --exit-code   # each binding looked for in its own repository
```

## What it shows

- **A slice in two repositories.** `place-order` has a `ui` for `@Customer`, placed in
  `storefront-web` by the `personas:` rule, and a command and an event placed in `checkout-svc`
  by the default. It is two work units, `place-order@storefront-web` and
  `place-order@checkout-svc`, and two pull requests. `Order Placed` is `public`, so the two
  build in parallel against the contract.
- **An Automation slice across two services.** `take-payment`'s processor reads the
  `Orders To Charge` list, so it lives where that list lives (`checkout-svc`). Its command and
  event are in the `Payments` context, which the map places in `payments-svc`. With no `public`
  element in the slice, the processor's unit waits for the payments unit.
- **A slice in one repository.** `orders-to-charge` and `charged-orders` are entirely in
  `checkout-svc`: one unit each.
- **Bindings that name their repository.** `conformance/bindings/place-order.yaml` is schema
  1.1: each binding carries `repo:`. There is one bindings file per slice, in the model's
  repository, whichever repositories its code is in.
- **One em pin.** A real system pins `em` once, with a `.em-version` file in the model's
  repository (`echo "<version>" > storefront-model/.em-version`); the code repositories carry
  none, and `em repos check` reports any that do. The example ships without the file so that it
  runs on whichever `em` you have.

See [docs/multi-repo.md](../../docs/multi-repo.md) for the layouts this covers and how to choose
between them.
