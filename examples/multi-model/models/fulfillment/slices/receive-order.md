---
schemaVersion: 1
pattern: translation
swimlane: Warehouse → Order
status: draft
version: 1
---
# Slice: Receive Order

![Diagram](./receive-order.svg)

## Intent
Every order checkout submits reaches the warehouse as an order to fulfil.

## Trigger & Actor
Externally triggered: checkout's public `Order Submitted` event, consumed across the seam by the `Order Intake` translation, which triggers `Accept Order`.

## Command / Input
<!-- GENERATED:em-slice-command:start — generated from the model by `em slice sync`; do not hand-edit -->
**Command:** `Accept Order`

| Field | Type | Required | Rules / Validation |
|-------|------|----------|--------------------|
| orderId | uuid | yes | — |
| total | decimal | yes | — |
<!-- GENERATED:em-slice-command:end -->

## Trigger
**Triggered by:** translation `Order Intake`, also in this slice

## Event(s) Emitted
<!-- GENERATED:em-slice-event:start — generated from the model by `em slice sync`; do not hand-edit -->
**Event:** `Order Accepted` → context `Order`

| Field | Type | Immutable Fact? | Source / Notes |
|-------|------|-----------------|----------------|
| orderId | uuid | yes | from command `Accept Order` |
| total | decimal | yes | from command `Accept Order` |
| acceptedAt | datetime | yes | assigned (set by the handler) |
<!-- GENERATED:em-slice-event:end -->
**Read by:** `Orders To Fulfil` (slice "Orders To Fulfil")

## Read Model / View
<!-- GENERATED:em-slice-view:start — generated from the model by `em slice sync`; do not hand-edit -->
_This slice has no read model in the model._
<!-- GENERATED:em-slice-view:end -->
- **Consumed by:** n/a — this slice produces no read model

## Invariants / Business Rules
<!-- GENERATED:em-slice-invariants:start — generated from the model by `em slice sync`; do not hand-edit -->
- **INV-FUL-1** — An order is accepted at most once per checkout order id
<!-- GENERATED:em-slice-invariants:end -->
<!-- elaborate below this list; IDs are declared in the model -->
- INV-FUL-1 — a redelivered `Order Submitted` for an already-accepted `orderId` is acknowledged and dropped; no second `Order Accepted` is recorded.

## Scenarios (Given / When / Then)
### Scenario: A submitted order is accepted
- **Given:**
  - checkout recorded `Order Submitted` for order 42
- **When:**
  - `Order Intake` triggers `Accept Order` for order 42
- **Then:**
  - `Order Accepted` is recorded for order 42
  - order 42 appears on the Fulfilment Board

### Scenario: A redelivered order is accepted once (INV-FUL-1)
- **Given:**
  - `Order Accepted` is already recorded for order 42
- **When:**
  - `Order Intake` triggers `Accept Order` for order 42 again
- **Then:**
  - the command is a no-op
  - no second `Order Accepted` is recorded

## Alternate & Error Flows
- Checkout's event can arrive more than once; INV-FUL-1 makes the intake idempotent.

## Non-Functional Requirements
- **Security / authz:** system only — no person issues `Accept Order`
- **PII & compliance:** none
- **Performance / SLA:** an order reaches the board within a minute of submission

## Dependencies & Read Models Affected
- **Upstream events this slice relies on:** checkout's public `Order Submitted` (`checkout:event.order-submitted`)
- **Downstream read models / slices affected:** Orders To Fulfil

## Open Questions
- [ ] What happens to an order checkout cancels after the warehouse accepted it?
