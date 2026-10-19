# Inventory API — spec

Base path `/v1`. All requests are authenticated warehouse clients.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/skus` | Register a SKU `{skuId, description}`. 201 on success, 409 if it exists. |
| POST | `/receipts` | Record stock arriving `{skuId, quantity, receivedAt}`. 404 for an unknown SKU. |
| GET | `/stock` | Current stock per SKU `{skuId, description, quantity}`; reflects receipts and reservations. |
| POST | `/reservations` | Reserve stock `{reservationId, skuId, quantity}`. 422 if more than is on hand. |

`PUT /skus/{id}`, `PATCH /skus/{id}`, `DELETE /skus/{id}` also exist for maintenance and are not part of the walkthroughs.

## Walkthroughs

### Walkthrough 1: Receive stock

1. A client registers a new SKU with `POST /skus`.
2. Stock arrives; the client records it with `POST /receipts`.
3. The client reads `GET /stock` and sees the SKU with the received quantity.

### Walkthrough 2: Reserve stock

1. A client reserves part of the stock with `POST /reservations`.
2. The client reads `GET /stock` again and sees the quantity reduced by the reservation.
