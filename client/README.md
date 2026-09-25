# Buyer order boundary

`placeOrder` is a thin client flow. It asks the seller worker for a free remote preflight, uploads a JSON conversion request, pays with `order_id` as the memo, then posts a single JSON order message linking the artifact and transfer. The client never imports or runs the private adapter.

The `transport` adapter must provide `preflight(request)`, `upload(bytes, {filename})`, `pay(sellerPrincipalId, price, {memo, room})`, and `post(content)`. All methods must return confirmed SharedNet IDs. The caller supplies the agreed price and seller principal; no price is embedded in this module. If payment confirmation is lost, the client returns `payment_unconfirmed` and requires ledger reconciliation before any retry. If the message post is uncertain after confirmed payment, it returns the exact content and transfer ID for room reconciliation without paying again.

This is the protocol library, not yet a runnable buyer CLI. The live transport depends on the finalized kickoff rules and the authenticated worker host.
