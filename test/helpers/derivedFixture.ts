// SPDX-License-Identifier: MIT
// Shared `derived` fixture (MIL-200, R12): the invented room-booking/waitlist domain from
// `internal/engagements/human-gate-2026-09/findings/recon-pilot.md` §9 ("FIXTURE DRAFT B"),
// adjusted until `em validate` is warning-free.
//
// Two adjustments beyond the recon draft:
//   1. Every command needed an explicit trigger (a `ui` in its own slice) — the draft's
//      commands had none.
//   2. Per R14, a traced `derived from "Event A", "Event B"` clause's names must resolve among
//      the view's ACTUAL sources (its own `from` list) — the recon draft's `Waitlist Queue`
//      traced four events in its `status` field's `derived from` but only named one
//      (`"Waitlist Entry Added"`) in the view's own `from`. Fixed here by widening each such
//      view's `from` to include every event its derived field(s) trace to; the same widening
//      applies to `Room Listings`, whose `status` traces to both events feeding `Room Catalog`.
//
// Reproduces the pilot's three derived-field shapes (all "for review" evidence in MIL-200,
// never judged issues until this ticket — the pilot's own names never appear here):
//   - "catalog-availability": a field derived from exactly the two events that also feed the
//     view (`Room Catalog.availability`), and the same shape reused for a second, independent
//     view (`Room Listings.status`, "owner-listing-status").
//   - "queue-position/status": one bare `derived` computed ordinal with no traced source
//     (`Waitlist Queue.position`) alongside a traced `derived from` field spanning four events
//     on the SAME view (`Waitlist Queue.status`).
export const DERIVED_FIXTURE = `model "room-catalog-fixture"

persona Requester
persona Owner
context Room
context Waitlist

slice "Book Room" {
  ui Book Room Screen @Owner
  command Book Room {
    roomId: UUID
    ownerPhone: String
  }
  event Room Booked @Room {
    roomId: UUID assigned
    ownerPhone: String
    bookedAt: Instant assigned
  }
}

slice "Delist Room" {
  ui Delist Room Screen @Owner
  command Delist Room {
    roomId: UUID
  }
  event Room Delisted @Room {
    roomId: UUID
    delistedAt: Instant assigned
  }
}

# Shape 1 — "catalog-availability": a field derived from exactly the two events that feed the
# view it lives on, traced with \`derived from\`.
slice "Browse Rooms" {
  view Room Catalog from "Room Booked", "Room Delisted" {
    roomId: UUID
    bookedAt: Instant
    availability: String derived from "Room Booked", "Room Delisted"
  }
  ui Browse Rooms @Requester
}

# Shape 3 — "owner-listing-status": the same derived-from-two-events shape, on a second,
# independent view.
slice "See My Listings" {
  view Room Listings from "Room Booked", "Room Delisted" {
    roomId: UUID
    bookedAt: Instant
    status: String derived from "Room Booked", "Room Delisted"
  }
  ui My Rooms @Owner
}

slice "Join Waitlist" {
  ui Join Waitlist Screen @Requester
  command Join Waitlist {
    roomId: UUID
    requesterPhone: String
  }
  event Waitlist Entry Added @Waitlist {
    entryId: UUID assigned
    roomId: UUID
    requesterPhone: String
    addedAt: Instant assigned
  }
}

slice "Notify Waitlist Entry" {
  ui Notify Waitlist Entry Screen @Owner
  command Notify Waitlist Entry {
    entryId: UUID
  }
  event Waitlist Entry Notified @Waitlist {
    entryId: UUID
    notifiedAt: Instant assigned
  }
}

slice "Expire Waitlist Entry" {
  ui Expire Waitlist Entry Screen @Owner
  command Expire Waitlist Entry {
    entryId: UUID
  }
  event Waitlist Entry Expired @Waitlist {
    entryId: UUID
    expiredAt: Instant assigned
  }
}

slice "Withdraw Waitlist Entry" {
  ui Withdraw Waitlist Entry Screen @Requester
  command Withdraw Waitlist Entry {
    entryId: UUID
  }
  event Waitlist Entry Withdrawn @Waitlist {
    entryId: UUID
    withdrawnAt: Instant assigned
  }
}

# Shape 2 — "queue-position/status": a bare \`derived\` computed ordinal (no traced source) next
# to a traced \`derived from\` field spanning four events, on the same view.
slice "See Waitlist" {
  view Waitlist Queue from "Waitlist Entry Added", "Waitlist Entry Notified", "Waitlist Entry Expired", "Waitlist Entry Withdrawn" {
    entryId: UUID
    roomId: UUID
    addedAt: Instant
    position: Integer derived
    status: String derived from "Waitlist Entry Added", "Waitlist Entry Notified", "Waitlist Entry Expired", "Waitlist Entry Withdrawn"
  }
  ui Room Detail @Requester
}
`;
