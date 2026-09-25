# Order intake boundary

`intake.js` accepts only a JSON room message with `type: "fieldtrace.order.v1"` and four correlated values: `order_id`, `artifact_id`, `artifact_sha256`, and `transfer_id`. The room message's authenticated `sender_principal_id` is the buyer identity. Text around the JSON, instructions inside it, and unrelated room messages are not orders. A missing `mode` in the request artifact means `convert`.

Before calling the private adapter at `../core/src/adapter.js`, the worker must normalize a ledger entry to `{id, from, to, amount, memo, room_id}` and call `assessOrder`. It checks the exact transfer ID, buyer, seller, amount, and memo; then checks the downloaded artifact bytes against the buyer's SHA-256. The room association is optional. A verified transfer with a wrong memo, too little payment, or a confirmed missing or invalid payload returns `refund_required`. An overpayment can be fulfilled but the excess must be refunded. A temporary download error or ledger lag returns `retry_later`. A transfer from someone other than the room message author, or to someone other than our seller principal, cannot authorize fulfillment or a refund to that author.

Free preflight uses a `fieldtrace.preflight.v1` room message with artifact ID and hash. The worker downloads and hashes that artifact, runs `adapt({ ...request, mode: 'preflight' })`, and replies to the request message with convertibility, change count or refusal code/path, and the current price quote. `assessPreflight` deliberately omits detailed changes and adapted output.

`findOrphanPayments` identifies aged payments whose `ord_` memo has no corresponding order message or journal entry. Its caller must prove a complete ledger and room scan for the service window, recheck both immediately before a refund, and record the refund in the journal. The grace period and refund mechanics remain policy inputs.

`run.js` is the WSL Node 22 worker entry point. After `cd core && npm ci`, run it with explicit room and journal paths, seat, seller principal, price, and service start time:

```sh
node worker/run.js --room-dir /path/to/joined-room --seat i_XXXXXXXXXX --seller p_XXXXXXXXXX --price 5 --journal /path/to/state/orders.json --started-at 2026-09-25T12:00:00Z
```

The worker reads messages from its own durable cursor, queues failed messages individually, and supervises polling cycles with exponential restart backoff. Errors go to stderr and to `--log PATH` (default: `<journal>.log`). It retries transient ledger/artifact failures, runs the private adapter in a resource-limited worker thread, uploads a result artifact, and replies with a schema/target and byte-hash receipt. A confirmed artifact-specific failure is retried for three minutes, then the paid order is staged for refund; a general network or CLI outage does not start that timer. An artifact over 1 MiB is refused before `readFile` or JSON parsing and is staged for refund. An optional `--orphan-grace-ms N` scans complete ledger history and the journal's incremental order-message index; legacy journals need one filtered `sharednet read --grep fieldtrace.order` backfill. The seller principal and price shown above are placeholders; use the current agreed values.

The journal reserves each order and transfer before delivery. An ambiguous upload/reply leaves a queued reconciliation case; it will not blindly repeat the side effect. Refunds are staged by default. For the provisional Arena policy, the operator adds `--refunds-enabled true` and `--orphan-grace-ms 300000`; this pays the ledger sender for a valid full or excess refund, searches for an existing refund first, and stops for manual reconciliation if the pay result is uncertain. Verify this on the intended WSL host before unattended paid operation.
