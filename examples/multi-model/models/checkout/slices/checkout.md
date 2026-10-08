---
schemaVersion: 1
pattern: state-change
swimlane: Customer → Order
status: draft
version: 1
---
# Slice: Checkout

![Diagram](./checkout.svg)

## Intent
A customer turns a filled basket into an order the warehouse can fulfil.

## Trigger & Actor
The customer, on the Checkout Screen, submits the order (State Change).

## Command / Input
<!-- GENERATED:em-slice-command:start — generated from the model by `em slice sync`; do not hand-edit -->
**Command:** `Submit Order`

| Field | Type | Required | Rules / Validation |
|-------|------|----------|--------------------|
| total | decimal | yes | — |
| note | text | no | — |
<!-- GENERATED:em-slice-command:end -->

## Trigger
**Triggered by:** screen `Checkout Screen` @Customer

## Event(s) Emitted
<!-- GENERATED:em-slice-event:start — generated from the model by `em slice sync`; do not hand-edit -->
**Event:** `Order Submitted` → context `Order`

| Field | Type | Immutable Fact? | Source / Notes |
|-------|------|-----------------|----------------|
| orderId | uuid | yes | assigned (set by the handler) |
| total | decimal | yes | from command `Submit Order` |
| placedAt | datetime | yes | assigned (set by the handler) |
| note | text | yes | from command `Submit Order`; optional |
<!-- GENERATED:em-slice-event:end -->
**Read by:** `Order Confirmation` (slice "Order Confirmation"), and — across the seam — fulfillment's `Order Intake` translation

## Read Model / View
<!-- GENERATED:em-slice-view:start — generated from the model by `em slice sync`; do not hand-edit -->
_This slice has no read model in the model._
<!-- GENERATED:em-slice-view:end -->
- **Consumed by:** n/a — this slice produces no read model

## Invariants / Business Rules
<!-- GENERATED:em-slice-invariants:start — generated from the model by `em slice sync`; do not hand-edit -->
- **INV-CHK-1** — An order is submitted with a positive total
<!-- GENERATED:em-slice-invariants:end -->
<!-- elaborate below this list; IDs are declared in the model -->
- INV-CHK-1 — a zero or negative total is rejected before any event is recorded; the screen shows the error.

## Scenarios (Given / When / Then)
### Scenario: Customer submits an order
- **Given:**
  - a basket with a positive total
- **When:**
  - the customer submits the order
- **Then:**
  - `Order Submitted` is recorded with a fresh `orderId`
  - the Order Confirmation shows the order

### Scenario: Non-positive total is rejected (INV-CHK-1)
- **Given:**
  - a basket whose total is 0
- **When:**
  - the customer submits the order
- **Then:**
  - the command is rejected with a validation error
  - no event is recorded

## Alternate & Error Flows
- Submitting the same basket twice records one order: the handler de-duplicates on the basket.

## Non-Functional Requirements
- **Security / authz:** the signed-in customer who owns the basket
- **PII & compliance:** the optional `note` may hold free text from the customer
- **Performance / SLA:** none

## Dependencies & Read Models Affected
- **Upstream events this slice relies on:** none
- **Downstream read models / slices affected:** Order Confirmation; fulfillment's Receive Order (via the public `Order Submitted`)

## Open Questions
- [ ] Should a submitted order carry the basket's line items, or only its total?
