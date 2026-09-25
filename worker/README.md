# Order intake boundary

`intake.js` accepts only a JSON room message with `type: "fieldtrace.order.v1"` and four correlated values: `order_id`, `artifact_id`, `artifact_sha256`, and `transfer_id`. The room message's authenticated `sender_principal_id` is the buyer identity. Text around the JSON, instructions inside it, and unrelated room messages are not orders.

Before calling the private adapter at `../core/src/adapter.js`, the worker must normalize a ledger entry to `{id, from, to, amount, memo, room_id}` and call `assessOrder`. It checks the exact transfer ID, buyer, seller, room, amount, and memo; then checks the downloaded artifact bytes against the buyer's SHA-256. A verified transfer with a confirmed missing or invalid payload returns `refund_required`. A temporary download error returns `retry_later`. No refund is due for an unverified transfer.

The caller must supply a durable journal of order and transfer IDs to `assessOrder`, persist a reservation before any delivery or refund, and reconcile uncertain side effects before retrying. A live SharedNet worker and refund executor remain unconnected until the kickoff rules and ledger response shape are confirmed. In particular, do not infer that an absent artifact on the first read is permanently missing, and do not blindly retry a payment or refund after a timeout.
