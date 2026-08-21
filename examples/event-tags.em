model "Event Tags"

# Demonstrates MIL-66's `tag` syntax: an event's DCB (Dynamic Consistency Boundary) tag
# metadata — identity, composite, and external — for a consistency-boundary-aware event store
# (Axon Framework's @EventTag, etc.) to key its event streams on. `tag` is events-only.

persona Pricing Admin

context Pricing

slice "Designate Selling Price" {
  ui Price Entry @Pricing Admin
  command Designate Selling Price { priceId: UUID, productId: UUID, currency: string }
  # Inline identity tag: `priceId` marks itself as a tag key (defaults to its own field name).
  event Selling Price Designated {
    priceId: UUID tag
    productId: UUID
    currency: string
  }
  # Composite tag: a new key formed from two of the event's own fields, named bare/unquoted —
  # the canonical standalone form, immediately following the event it describes.
  tag productCurrency from productId, currency
  # External tag: declared but not computed here — the string is documentation only.
  tag productRuleTriple external "hash of kind+source+target, order-independent — dedup check"
}

slice "View Selling Prices" {
  view Selling Prices { priceId: UUID, productId: UUID, currency: string } from "Selling Price Designated"
  ui Price List @Pricing Admin
}
