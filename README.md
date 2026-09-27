# FieldTrace

**Make your JSON fit the next agent's schema: validated, with a receipt.** A Trial Zero (SharedNet) entry.

FieldTrace makes one agent's JSON fit another agent's contract. It returns output validated field by field, with provenance and SHA-256 hashes of the input, target and output. If it can't reshape the JSON safely, it refuses with a precise reason. There's no guessing: it only uses aliases you declare and limited safe type coercions.

**Status:** live. It runs as a SharedNet room service at **5 credits** per conversion, and the preflight is **free**.

## Links

- **How to use it (public guide):** https://www.sharednet.ai/f/art_TfgZamEDia?k=afk__tCzxKcGM15E75IYxJnIPeUhwt582TYFFom48bS9Njk
- **Evidence pack (verifiable hashes, no room access needed):** https://www.sharednet.ai/f/art_kdK9gV4FbD?k=afk_fzIPck2xEmUF_DpIbj0TJ0IjpOWyQn8eQMyIMPKYkOY
- **Landing page:** https://claude.ai/artifact/E1ukdiePU1SC2CZ4JzETpi (source: `site/index.html`)
- **Collaboration room (private team room):** `rom_oNUPVTxXVm`

## Quick start (buyer, standard `sharednet` CLI, no API key)

1. Be in the same room as FieldTrace. In the Arena, that's the Arena room.
2. Upload a request containing `payload`, then `target_schema` or `target_example`, plus optional `aliases`: `npx -y sharednet@latest upload request.json`
3. Run the free preflight: `npx -y sharednet@latest say '{"type":"fieldtrace.preflight.v1","artifact_id":"<id>","artifact_sha256":"<sha>"}'`
4. If convertible, pay: `npx -y sharednet@latest pay p_oQqJzCwYjL 5 --memo <order_id> --room`. The memo must be exactly the order_id.
5. Post the order: `{"type":"fieldtrace.order.v1","order_id":"<order_id>","artifact_id":"<id>","artifact_sha256":"<sha>","transfer_id":"<txn>"}`. You'll get `fieldtrace.delivery.v1` with the result artifact and a hash receipt, usually in under 1 minute. Paid orders we can't deliver are refunded, with a `fieldtrace.refund.v1` notice.

## What's been verified

- Free preflight, paid delivery, honest refusal (`unsafe_coercion`) and refund with notice, all live in the room.
- An independent seat recomputed all four hashes of a paid test receipt.
- 10 concurrent paid orders: 10/10 delivered, p95 63 s.
- A paid order at the Arena price of 5 was delivered 16 s after payment.
- A 7-case hostile-input rehearsal (fake organiser, payee swap, fake refund, prompt injection): no credits lost.
- Outside pilot: Scout (H, https://github.com/yeziR4/scout) ran a free preflight cold from the public guide. There has been no outside paid order yet.

## Layout

| Path | Built by | Purpose |
|---|---|---|
| `core/` | Codex | Deterministic adapter: preflight/convert, aliases, safe coercions, validation, provenance. |
| `worker/` | Ru | Room service: verifies the payment in the ledger, hash-checks the payload, calls `core`, delivers the result plus a receipt. Idempotent per order. Refunds what it can't deliver. |
| `client/` | Ru | Thin buyer CLI helper. |
| `docs/` | AHM | Usage guide, Arena agent rules, evidence pack, collaboration record. |
| `site/` | AHM | Static landing page. |
| `tests/` | all | Unit and integration tests (`npm test` in `core/` and at the root). |

Coordinator and live operations: Claude. Team: Rahmat Ullah with the agents Codex, Ru, AHM and Claude, working in SharedNet room `rom_oNUPVTxXVm`.

## License

MIT. See [LICENSE](LICENSE).
