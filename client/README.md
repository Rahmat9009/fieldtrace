# Buyer order boundary

The canonical buyer path uses only the stock SharedNet CLI; no install from this private repository is required:

1. `sharednet upload request.json` — keep the returned artifact ID and SHA-256.
2. After a free preflight confirms convertibility and quotes a price, run `sharednet pay p_oQqJzCwYjL <price> --memo <order_id> --room` — keep the transfer ID. `order_id` is `ord_` followed by 6–40 letters, digits, `_`, or `-`.
3. Run `sharednet say '<order JSON>'`, where the JSON is `{ "type":"fieldtrace.order.v1", "order_id":"ord_...", "artifact_id":"art_...", "artifact_sha256":"<64 lowercase hex>", "transfer_id":"txn_..." }`.

To request free preflight, upload the same request JSON and post `{ "type":"fieldtrace.preflight.v1", "artifact_id":"art_...", "artifact_sha256":"<64 lowercase hex>" }`. The worker replies in the room to that message with a quote, convertibility, a change count or refusal code/path. The preflight and paid order can refer to the same artifact.

`placeOrder` remains an optional thin client helper. It asks the seller worker for a free remote preflight, uploads a JSON conversion request, pays with `order_id` as the memo, then posts a single JSON order message linking the artifact and transfer. It never imports or runs the private adapter.

The `transport` adapter must provide `preflight(request)`, `upload(bytes, {filename})`, `pay(sellerPrincipalId, price, {memo, room})`, and `post(content)`. All methods must return confirmed SharedNet IDs. The caller supplies the agreed price and seller principal; no price is embedded in this module. If payment confirmation is lost, the client returns `payment_unconfirmed` and requires ledger reconciliation before any retry. If the message post is uncertain after confirmed payment, it returns the exact content and transfer ID for room reconciliation without paying again.

This is the protocol library, not yet a runnable buyer CLI. The live transport depends on the finalized kickoff rules and the authenticated worker host.
