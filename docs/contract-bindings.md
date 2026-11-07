# Binding files — extending a generated contract without forking it

`em api generate` writes a model-owned TypeSpec contract (`<model dir>/contracts/<model
key>.tsp`, see [cli.md](cli.md#em-api-generate-file--em-api-check-file)) — commands, events and
views, schema only, no routes, no protocol facts, no decorators. Real teams need more than
schema: HTTP routes and error shapes, message-channel bindings, envelopes, versioning. This page
documents the one supported way to add that: a **binding file**, a second, hand-authored
TypeSpec file that `import`s the generated contract and layers the rest on top.

**Not [`docs/bindings.md`](bindings.md).** That page is a different, unrelated artifact that
happens to share the word "bindings": the per-slice `conformance/bindings/<slice-key>.yaml`
manifest `em conform bindings check` reads, which binds a slice's model elements and invariants
to *source-code locations* (a file + an identifier string). This page is about TypeSpec files
that bind *protocol and transport concerns* to a generated API contract. Nothing here touches
that YAML schema, and nothing there touches TypeSpec. If you came here looking for the slice
bindings manifest, see [bindings.md](bindings.md) instead.

## The rule: import the generated contract, never edit it

A binding file lives next to, or above, the generated contract and references it with a plain
relative TypeSpec `import`:

```tsp
import "./checkout.tsp";

using Checkout;
```

Everything downstream — routes, channels, envelopes, decorators — goes in that second file.
The generated `.tsp` itself is never hand-edited, and `em` has no emitter config, template hook,
or plugin system to make it emit differently for different teams (ruling on GH #443 ask 3: this
was considered and rejected). That's deliberate, not an oversight: `em api check` (and the
API-first `--slice-ready` gate, see [cli.md](cli.md#em-api-check)) decide "current" vs. "stale"
by regenerating the contract from the working-tree model and byte-comparing it against the
committed file. If generation were configurable, two checkouts — or two points in a template's
history — could regenerate the "same" model into two different texts, and "current" would stop
meaning anything the gate could trust. Keeping the generator config-free is what keeps that
byte-compare honest; every team-specific need is pushed into a file `em` never reads or writes,
where it can vary all it likes without touching the contract's own currency.

## Per-field customization: augment decorators

TypeSpec's `@@` **augment decorators** apply a decorator from outside a declaration, by
reference — `@@decorator(Namespace.Model.property, ...)` — and they can only target a `model` or
a `model property`, never a positional operation parameter. That constraint is exactly why `em
api generate` always emits a command's input as a named payload model rather than positional
parameters (GH #445): `interface Commands { op submitOrder(payload: SubmitOrder): void; }` with
a separate `model SubmitOrder { total: decimal; note?: string; }`, instead of
`op submitOrder(total: decimal, note?: string): void;`. The payload model is what gives a
binding file something to point at. Had the fields stayed positional op parameters, no `@@`
decorator could ever reach them — a binding file would have nothing to augment.

Given the real, committed contract at
[`examples/multi-model/models/checkout/contracts/checkout.tsp`](../examples/multi-model/models/checkout/contracts/checkout.tsp):

```tsp
model SubmitOrder {
  /** INV-CHK-1: An order is submitted with a positive total */
  total: decimal;
  note?: string;
}

interface Commands {
  op submitOrder(payload: SubmitOrder): void;
}
```

a binding file can customize the `note` field, without touching the generated model:

```tsp
import "./checkout.tsp";

using Checkout;

// Treat `note` as Markdown on the wire, not plain text.
@@format(Checkout.SubmitOrder.note, "markdown");

// `note` is settable at creation but never echoed back on reads.
@@visibility(Checkout.SubmitOrder.note, Lifecycle.Create);
```

`@format` and `@visibility`/`@@visibility` are TypeSpec built-ins (`Lifecycle` too) — no import
beyond the generated contract itself is needed for this example. The same pattern reaches event
and view payload fields the same way (`@@visibility(Checkout.OrderSubmitted.placedAt,
Lifecycle.Read)`), since every public element — command, event, or view — is emitted as a named
model, not an inline shape.

## Wrapping via generic models

A team whose API wraps every payload in an envelope (`{ data: ..., meta: ... }`, a
cursor-paginated list, a result-or-error union) does that in the binding file with an ordinary
generic TypeSpec model, instantiated against the generated models:

```tsp
import "./checkout.tsp";

using Checkout;

model Envelope<T> {
  data: T;
  requestId: string;
}

op getSubmitOrderEnvelope(): Envelope<Checkout.SubmitOrder>;
```

Nothing about `Envelope<T>` is em-specific — it's exactly how any TypeSpec project wraps a
shape it doesn't own. The generated contract's models are ordinary TypeSpec models from the
binding file's point of view; they compose with templates, `extends`, `is`, and every other
TypeSpec feature the same as a hand-written model would.

## A worked OpenAPI binding

Routes, HTTP methods, status codes and error shapes are binding-file concerns — `@typespec/http`
is never imported by the generated contract, only by a binding file that wants it. Building on
`Commands` (the write API) and `Views` (the read API) from
[`checkout.tsp`](../examples/multi-model/models/checkout/contracts/checkout.tsp) and
[`order-fulfillment.tsp`](../examples/order-fulfillment/contracts/order-fulfillment.tsp):

```tsp
import "./checkout.tsp";
import "@typespec/http";

using Checkout;
using TypeSpec.Http;

namespace CheckoutApi;

model ApiError {
  code: string;
  message: string;
}

@error
model ApiErrorResponse {
  @statusCode statusCode: 400 | 404 | 409;
  @body error: ApiError;
}

@route("/orders")
interface Orders {
  @post
  op submitOrder(@body payload: Checkout.SubmitOrder): {
    @statusCode statusCode: 201;
    @body result: Checkout.OrderSubmitted;
  } | ApiErrorResponse;

  @get
  op getOpenOrders(): {
    @statusCode statusCode: 200;
    @body result: Checkout.OrderSubmitted[];
  } | ApiErrorResponse;
}
```

This is the compile-ready shape: `Checkout.SubmitOrder` and `Checkout.OrderSubmitted` are the
generated models, referenced by qualified name exactly as the `using Checkout;` import makes
them available; `@route`, `@post`, `@get`, `@body` and `@statusCode` all come from
`@typespec/http`, imported only here. Compiling this binding file (not the generated contract)
through the `@typespec/openapi3` emitter is what turns it into an OpenAPI document — that step
happens in the consuming team's own toolchain, the same posture [cli.md](cli.md#em-api-generate)
describes ("Teams compile the TypeSpec to OpenAPI / JSON Schema / AsyncAPI in their own
toolchain").

## A worked AsyncAPI binding

Channel and publish/subscribe bindings for the model's events work the same way, targeting the
generated `interface Events` ops with `@@` augments — using the community
[`typespec-asyncapi`](https://www.npmjs.com/package/typespec-asyncapi) emitter (not an em
dependency; consult that package's own docs for its exact decorator signatures and current
namespace, which are outside em's control and may move independently of this page):

```tsp
import "./checkout.tsp";
import "typespec-asyncapi";

using Checkout;

@@channel(Checkout.Events.onOrderSubmitted, "orders.lifecycle");
@@publish(Checkout.Events.onOrderSubmitted);

@@channel(Checkout.Events.onOrderCancelled, "orders.lifecycle");
@@publish(Checkout.Events.onOrderCancelled);

// See "DCB tags and correlationId" below before picking a correlationId pointer.
@@correlationId(Checkout.Events.onOrderSubmitted, "/orderId");
```

**DCB tags and `correlationId`.** The generated contract is schema only — it never carries a
model's DCB tag metadata ([dsl.md's Event tags](dsl.md#event-tags)) forward, because tags aren't
part of the public surface `em api generate` renders. If you want `@@correlationId` to track the
same key the model itself uses to decide which events belong together (an event-sourced store's
consistency boundary, e.g. Axon's `@EventTag`), don't guess from the `.tsp` file — read the
model's own tag declaration (`em export --json`'s per-event `tags` array, or the `.em` source
directly) to find the tagged field's name, then point `correlationId` at that same field in the
generated payload model. The field names always agree between the model and the generated
contract; only the tag metadata itself doesn't make the trip.

## What belongs where

| Concern | Owner | File |
|---|---|---|
| Field shapes, types, optionality, invariants | The model | `<model dir>/contracts/<model key>.tsp` (generated, never hand-edited) |
| Per-field format/visibility/constraints | The binding | A binding file's `@@` augments against the generated models |
| Envelopes, wrappers, pagination shapes | The binding | A binding file's own generic models |
| Routes, HTTP methods, status codes, error shapes | The binding | A binding file importing `@typespec/http` |
| Channels, publish/subscribe, message correlation | The binding | A binding file importing an AsyncAPI emitter library |

Shapes are model-owned because they come from the event model itself and must stay
byte-comparable to it. Everything with a protocol opinion — a route, a channel, an envelope — is
binding-owned, because two consumers of the same model are free to disagree about it without
either one forking the contract.

A scaffolder for binding files (`bind init`) and a drift check between a binding file and the
contract it imports are companion-tool scope — planned, outside `em` itself, possibly in a
separate repository with its own dependency on `@typespec/compiler`.
