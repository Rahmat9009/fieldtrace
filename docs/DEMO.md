# Arena demo script

This is one success and one honest refusal. The outputs below are real: they come from `core/bin/fieldtrace.js` (the local test harness). Core v0.1.2 (`codex/core` `f86a2e0`) returns the same convert output as `81ae306`; only preflight changed. In the live demo, the same request goes through the room order path in [USAGE.md](USAGE.md), and the worker adds the quote and receipt hashes.

## A0. Free preflight for request A

Core v0.1.2 preflight output (verified by Codex, msg 66). The worker adds the price quote:

```json
{"status": "ok", "mode": "preflight", "direction": "response", "convertible": true,
 "target": "example_inferred_for_this_request",
 "validation": {"passed": true, "validator": "ajv-draft-2020-12"}, "change_count": 3}
```

**Say:** "The free check tells the buyer yes, 3 fields change, 5 credits. It doesn't reveal the converted data. That comes with payment."

## A. Success: a seller reshapes its output to the buyer's schema

**Situation:** the buyer asked for `{name, age, active}` with real types. The seller's agent produced `user_name` and string values.

Request:

```json
{
  "mode": "convert",
  "direction": "response",
  "payload": {"user_name": "Ada", "age": "36", "active": "true"},
  "target_example": {"name": "Ada", "age": 36, "active": true},
  "aliases": {"/name": "/user_name"}
}
```

Result:

```json
{
  "status": "ok", "mode": "convert", "direction": "response", "convertible": true,
  "target": "example_inferred_for_this_request",
  "changes": [
    {"path": "/name", "source": "/user_name", "operation": "alias"},
    {"path": "/age", "source": "/age", "operation": "coerce", "from": "string", "to": "integer"},
    {"path": "/active", "source": "/active", "operation": "coerce", "from": "string", "to": "boolean"}
  ],
  "validation": {"passed": true, "validator": "ajv-draft-2020-12"},
  "output": {"name": "Ada", "age": 36, "active": true},
  "provenance": [
    {"path": "/name", "source": "/user_name"},
    {"path": "/age", "source": "/age"},
    {"path": "/active", "source": "/active"}
  ]
}
```

**Say:** "Every field shows where it came from. The rename happened only because the seller declared it. Nothing was guessed. The seller attaches this receipt to the delivery."

Note: `"to": "integer"` is the kind of the value produced (36). The target type inferred from the example is `number`. With an example target, extra source fields would be kept. Use a strict `target_schema` when the field set must be exact.

## B. Honest refusal: FieldTrace says no before any credits move

**Situation:** the price arrives as `"1.0"`, and there is an extra `note` field that the target forbids.

Preflight request:

```json
{
  "mode": "preflight",
  "direction": "response",
  "payload": {"price": "1.0", "sku": "A1", "note": "x"},
  "target_schema": {
    "type": "object",
    "properties": {"price": {"type": "number"}, "sku": {"type": "string"}},
    "required": ["price", "sku"],
    "additionalProperties": false
  }
}
```

Result (exit code 2):

```json
{
  "status": "unsupported", "mode": "preflight", "direction": "response", "convertible": false,
  "code": "unsafe_coercion", "path": "/price",
  "message": "Decimal text would change when converted to a JSON number"
}
```

**Say:** "`1.0` would become `1`, so the delivered bytes would not match what the seller sent. FieldTrace refuses, and it does so during the free check, so there is no charge and no refund dispute. It reports the first problem only. `note` would be refused next unless `allow_drop_extras` is true."

## C. Real transcript (live worker, real credits, room `rom_oNUPVTxXVm`, 2026-09-26)

This is the evidence for judges. Every step below is a real room message.

| Seq | Who | What |
|---|---|---|
| 85 | buyer | `fieldtrace.preflight.v1` for `art_upt3A4esQ8` |
| 86 | worker | `preflight.result.v1`: convertible, `change_count` 3, `price` 1. Free; no output revealed. |
| 99 | buyer `p_Q7IIjsUJeW` | pays 1 credit, memo `ord_smoke01` (`txn_Pwd6AA1XeI`) |
| 100 | buyer | `fieldtrace.order.v1` linking `ord_smoke01`, `art_r9uENF4zAf`, `txn_Pwd6AA1XeI` |
| 101 | worker | `fieldtrace.delivery.v1`: result `art_SdonY2UuLG`, sha `39a06acd…`, and the receipt. The buyer and Codex each downloaded it independently: hash verified, output `{"name":"Ada","age":36,"active":true}`, validation passed. |
| 102 | buyer | pays 1 credit, memo `ord_smoke02` (`txn_qMFowpzc69`) |
| 103 | buyer | order claims that transfer but says `ord_smoke03`: a deliberate memo mismatch |
| 104 | worker | **refunds** 1 credit (`txn_rUFei2w95R`, memo `refund:ord_smoke03:txn_qMFowpzc69`) about 20 s later. Nothing was delivered and nothing was kept. |
| 109 | buyer | `fieldtrace.preflight.v1` for demo B's request (`art_pbajmVbpgi`) |
| 110 | worker | `preflight.result.v1`: `convertible: false`, `unsafe_coercion` at `/price`. It refused before any payment. |
| 122 | worker | after the upgrade, posts `fieldtrace.refund.v1` for `ord_smoke03` as a reply to its order: `memo_mismatch`, `transfer_id` `txn_qMFowpzc69`, `refund_transfer_id` `txn_rUFei2w95R` |
| 123–124 | buyer | a second negative test: pays `txn_czqlRFERWV` with memo `ord_smoke12`, orders as `ord_smoke13` |
| 127–128 | worker | refunds 1 credit (`txn_JAwIMcYirZ`), then replies `fieldtrace.refund.v1` `memo_mismatch` to the order. The buyer's balance is restored. |

Seqs 122–128 show the structured `fieldtrace.refund.v1` notice live (B2). Codex independently recomputed all four receipt hashes for `ord_smoke01` (seq 113).

## Demo checklist

- [x] Run both requests through the live worker, not the local harness (seqs 85–104).
- [ ] Show the room messages: preflight, pay, order, delivery. Show the ledger entry for the transfer.
- [x] Show the receipt's result hash matching the delivered artifact (seqs 106, 113).
- [x] After B2: show a `fieldtrace.refund.v1` reply for the negative order (seqs 127–128).
- [ ] Do not say "proves the data is correct". Say "proves these bytes match this schema".
