# Meridian Goods — order fulfilment PRD (excerpt)

## Background

Meridian Goods sells home goods online. Orders ship late and customers cannot tell where their
parcel is. We want every order to reach the customer on time and visibly.

## Journey: order to delivery

A customer browses the catalog, places an order and pays. When payment succeeds the warehouse
picks and packs the order, a carrier collects it, and the customer receives a tracking link by
email. When the carrier confirms delivery the order is complete.

## Journey: returning an item

A customer requests a return within 30 days of delivery. Support approves the request and the
customer receives a prepaid label. When the item arrives back at the warehouse the customer is
refunded.

## Requirements

- If the card is declined the customer sees why and can try another card.
- If a payment provider call times out, we retry it up to three times before cancelling the order.
- Payments are taken through the Stripe API.
- The order service writes a row to the stock_levels table when a pick is confirmed.
- The checkout page must respond within 300 ms at the 95th percentile.
- GET /orders/{id} returns the order with its status and tracking link.
- Should partial shipments be supported?
