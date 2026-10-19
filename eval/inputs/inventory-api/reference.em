model "Inventory API"

persona Warehouse Client
context Stock
context Reservations

storyline "Receive stock" source "input.md#walkthrough-1-receive-stock" {
  slice "Register SKU" {
    ui POST skus @Warehouse Client
    command Register SKU { skuId: UUID, description: String }
    event SKU Registered @Stock { skuId: UUID, description: String }
  }

  slice "Receive Stock" {
    ui POST receipts @Warehouse Client
    command Receive Stock { skuId: UUID, quantity: Int, receivedAt: DateTime }
    event Stock Received @Stock { skuId: UUID, quantity: Int, receivedAt: DateTime }
  }

  slice "Stock Levels" {
    view Stock Levels from "SKU Registered", "Stock Received" { skuId: UUID, description: String, quantity: Int }
    ui GET stock @Warehouse Client
  }
}

storyline "Reserve stock" source "input.md#walkthrough-2-reserve-stock" {
  slice "Reserve Stock" {
    ui POST reservations @Warehouse Client
    command Reserve Stock { reservationId: UUID, skuId: UUID, quantity: Int }
    event Stock Reserved @Reservations { reservationId: UUID, skuId: UUID, quantity: Int }
  }

  slice "Stock Levels after reservation" {
    view Stock Levels again from "Stock Reserved" { skuId: UUID, quantity: Int }
    ui GET stock @Warehouse Client
  }
}
