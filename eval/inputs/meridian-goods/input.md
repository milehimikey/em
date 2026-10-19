# Meridian Goods — ordering PRD

Meridian Goods sells household goods online. Two audiences: Customers and Fulfillment Staff.

1. A Customer places an order from the storefront (items, quantities, prices, total). Placing an order records who ordered, what, and when.
2. Once an order is placed, a payment is requested for its total. This happens automatically; nobody clicks anything.
3. The payment provider calls us back when a payment is captured. We record the capture (amount, provider reference, time). This is not initiated by anyone in the company.
4. Fulfillment Staff see a dashboard of open orders: placed orders, with the capture time once paid.
5. A Customer sees their order's status on their account page: placed, payment requested, paid.
6. A Customer can cancel an order from their account page. Cancelled orders drop off the staff dashboard.

Out of scope: shipping, refunds, inventory.
