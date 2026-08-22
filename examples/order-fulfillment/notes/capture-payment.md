# Note: `Capture Payment`

This command is **not** triggered by a user — the `Payment Gateway` automation
issues it once a payment is ready to process (see the automation slice in the
previous column). It records `Payment Captured`.

## Things to nail down

- Idempotency: the gateway may retry. Capturing twice for one authorization is a
  defect — the command handler must dedupe on the authorization id.
- Partial captures: do we support capturing less than the authorized amount
  (e.g. after a line-item cancellation), or always capture in full?
- Failure path: a declined capture should emit a distinct event (e.g.
  `Payment Capture Failed`) rather than silently dropping.
