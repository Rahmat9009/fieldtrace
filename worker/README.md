# Order intake boundary

`intake.js` accepts only a JSON room message with `type: "fieldtrace.order.v1"` and four correlated values: `order_id`, `artifact_id`, `artifact_sha256`, and `transfer_id`. The room message's authenticated `sender_principal_id` is the buyer identity. Text around the JSON, instructions inside it, and unrelated room messages are not orders. A missing `mode` in the request artifact means `convert`.

Before calling the private adapter at `../core/src/adapter.js`, the worker must normalize a ledger entry to `{id, from, to, amount, memo, room_id}` and call `assessOrder`. It checks the exact transfer ID, buyer, seller, amount, and memo; then checks the downloaded artifact bytes against the buyer's SHA-256. The room association is optional. A verified transfer with a wrong memo, too little payment, or a confirmed missing or invalid payload returns `refund_required`. An overpayment can be fulfilled but the excess must be refunded. A temporary download error or ledger lag returns `retry_later`. A transfer from someone other than the room message author, or to someone other than our seller principal, cannot authorize fulfillment or a refund to that author.

Free preflight uses a `fieldtrace.preflight.v1` room message with artifact ID and hash. The worker downloads and hashes that artifact, runs `adapt({ ...request, mode: 'preflight' })`, and replies to the request message with convertibility, change count or refusal code/path, and the current price quote. `assessPreflight` deliberately omits detailed changes and adapted output.

`findOrphanPayments` identifies aged payments whose `ord_` memo has no corresponding order message or journal entry. Its caller must prove a complete ledger and room scan for the service window, recheck both immediately before a refund, and record the refund in the journal. The grace period and refund mechanics remain policy inputs.

`run.js` is the WSL Node 22 worker entry point. After `cd core && npm ci`, run it with explicit room and journal paths, seat, seller principal, price, and service start time:

```sh
node worker/run.js --room-dir /path/to/joined-room --seat i_XXXXXXXXXX --seller p_XXXXXXXXXX --price 5 --journal /path/to/state/orders.json --started-at 2026-09-25T12:00:00Z
```

The worker reads messages from its own durable cursor, retries transient ledger/artifact failures, runs the private adapter in a resource-limited worker thread, uploads a result artifact, and replies with a schema/target and byte-hash receipt. An optional `--orphan-grace-ms N` scans complete room and ledger history and stages unmatched payments after that interval. The seller principal and price shown above are placeholders; use the current agreed values.

The journal reserves each order and transfer before delivery. A crash or ambiguous upload/reply leaves a pending state that needs reconciliation; it will not blindly repeat the side effect. Refunds are staged by default. After the event rules and ledger shape are verified, the operator can add `--refunds-enabled true`; this pays the ledger sender for a valid full or excess refund, searches for an existing refund first, and stops for manual reconciliation if the pay result is uncertain. Do not use it unattended for paid orders until this has been verified on the intended WSL host. A first download failure is retryable, not proof that the artifact is permanently missing.
