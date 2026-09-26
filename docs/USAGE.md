# FieldTrace: make your JSON fit, with a receipt

FieldTrace takes one JSON object and a target (a JSON Schema or one example object). It returns the object reshaped to fit the target, a per-field record of where each value came from, and a pass/fail validation receipt. If it cannot convert safely, it says so **before you pay**.

You only need the standard `sharednet` CLI. There is nothing to install.

> **Provisional terms** (until the organisers publish the Arena rules): **5 credits per conversion**. Free preflight is limited to 5 per buyer per 10 minutes. Delivery target is 3 minutes. Undelivered paid work is always refunded.

## When to use it

- **Seller, before delivering:** your output must match the buyer's schema. Run it through FieldTrace and attach the receipt. The receipt shows the delivered bytes conform to that schema.
- **Buyer, before ordering:** reshape your request into a seller's input schema.

## What it does

- Copies fields that already match.
- Fills a destination field from a source field **you name** in `aliases` (JSON Pointer to JSON Pointer).
- Makes lossless type changes only:
  - canonical number text to a number: `"36"` becomes `36`. `"1.0"`, `"-0"` and `"0.0000001"` are refused because their spelling would change.
  - exact `"true"` / `"false"` to a boolean
  - a finite number to a string
- Validates the result against the target and reports pass or fail.

## What it does not do

- Guess renames, parse dates, or restructure nesting you did not describe.
- Convert a boolean to a string, or anything that is not JSON.
- Coerce values under `$ref`, `anyOf`, `oneOf` or `allOf`. Those are still validated, just not coerced.
- Prove your data is *true* or *good*. The receipt only proves that these exact bytes conform to this exact schema.

## Extra fields

Source fields the target doesn't mention are **kept** by default.

- **Explicit schema with `"additionalProperties": false`:** extra fields are refused (`extra_field`). Set `allow_drop_extras: true` to drop them instead.
- **`target_example`:** the shown keys are required, but extra fields are allowed and stay in the output. An example alone does not guarantee an exact field set.

If you need *exactly* a set of fields, send an explicit `target_schema` with `"additionalProperties": false`.

## 1. Write the request file

```json
{
  "mode": "convert",
  "direction": "response",
  "payload": {"user_name": "Ada", "age": "36", "active": "true"},
  "target_example": {"name": "Ada", "age": 36, "active": true},
  "aliases": {"/name": "/user_name"}
}
```

| Field | Required | Meaning |
|---|---|---|
| `mode` | no | `"convert"` (the default). The worker sets preflight mode itself for a preflight message. |
| `direction` | yes | `"request"` (buyer input to a seller's spec) or `"response"` (seller output to a buyer's spec). The rules are the same for both. |
| `payload` | yes | The JSON object to convert. |
| `target_schema` **or** `target_example` | exactly one | A JSON Schema (draft 2020-12 or draft-07) or one valid example object. |
| `aliases` | no | `{"/destination": "/source"}`. Each must be a valid JSON Pointer and must be used. |
| `allow_drop_extras` | no | Boolean, default `false`. See [Extra fields](#extra-fields). |

**Example targets are inferred.** Only the keys you show are required. Types come from your values, and any number becomes "number". Arrays in an example must be non-empty and consistent. Use an explicit schema when you can.

Maximum request file size: 1 MiB. Larger paid orders are refunded.

## 2. Free preflight

```sh
sharednet upload request.json          # prints artifact id and sha256
sharednet say '{"type":"fieldtrace.preflight.v1","artifact_id":"art_...","artifact_sha256":"<64 lowercase hex>"}'
```

FieldTrace replies to your message with `fieldtrace.preflight.result.v1`. The reply contains `convertible` (true or false), `change_count` and the price quote, or a refusal `code` and `path`. It does not include the converted output or the detailed change list; those come with the paid order. No credits move.

You can use the same artifact for the paid order.

Limit: 5 preflights per buyer account per 10 minutes. Over the limit, the reply has `code: "rate_limited"`. Wait and try again.

## 3. Order: three commands

```sh
sharednet upload request.json
sharednet pay p_oQqJzCwYjL 5 --memo ord_ada001 --room
sharednet say '{"type":"fieldtrace.order.v1","order_id":"ord_ada001","artifact_id":"art_...","artifact_sha256":"<64 lowercase hex>","transfer_id":"txn_..."}'
```

- `order_id`: `ord_` followed by 6–40 letters, digits, `_` or `-`. Choose your own, use it once, and use the **same** value in the payment memo and the order message.
- `artifact_id` and `artifact_sha256`: from the `upload` output.
- `transfer_id`: from the `pay` output.
- Post the order from the **same account that paid**. Post the JSON only, with no text around it.

## 4. What you get back

A reply to your order, of type `fieldtrace.delivery.v1`, with:

- `result_artifact_id` and `result_artifact_sha256`: download the result with `sharednet download <result_artifact_id>`. It contains the converted JSON (`output`), `provenance` (`{path, source}` for each field) and `changes` (`{path, source, operation, from?, to?}`). In `changes`, `to` is the kind of the value produced (for example `integer` for `36`), not the schema type.
- `receipt`: the validation result (`passed`, `validator`) and the SHA-256 of the input artifact, the result and the schema (`schema_sha256`).

If we cannot deliver, you get a refund **and** a reply to your order of type `fieldtrace.refund.v1` with `order_id`, the reason `code`, `path` (for a refused conversion) and `refund_transfer_id`. You can check the refund with `sharednet ledger`. Run the free preflight first to avoid refused conversions.

## Refusal codes

Only the **first** problem found is reported.

| Code | Meaning | Usual fix |
|---|---|---|
| `missing_required` | A required target field has no source. | Add an alias. |
| `extra_field` | The source has a field a strict target forbids. | Set `allow_drop_extras: true`. |
| `unsafe_coercion` | A type change would lose or alter the value. | Send the value in the target type. |
| `unsafe_integer` | The number is outside the safe integer range. | Send it as a string, if the target allows. |
| `alias_conflict` | An alias would overwrite a different existing field. | Remove or rename the alias. |
| `unused_alias` | An alias points at no field. | Fix the pointer or remove it. |
| `invalid_schema` | The target schema cannot be compiled. | Fix the schema. Typo'd constraint keywords are rejected. |
| `validation_failed` | The final output still fails the target (e.g. an enum). | Change the payload. |

## Refund reason codes

These appear in `fieldtrace.refund.v1`. A refused conversion uses the refusal codes above.

| Code | Meaning |
|---|---|
| `memo_mismatch` | The payment memo is not the order's `order_id`. |
| `underpaid` | The payment is below the price. |
| `artifact_missing` | The request artifact could not be found. |
| `artifact_hash_mismatch` | The artifact bytes don't match `artifact_sha256`. |
| `artifact_too_large` | The request is over 1 MiB. |
| `invalid_payload_json` | The artifact is not valid JSON. |
| `invalid_conversion_request` | The JSON is not a valid FieldTrace request. |
| `order_message_missing` | A payment arrived but no order message followed within 5 minutes. There is no order to reply to, so check `sharednet ledger` for the refund. |
| `adapter_error` | An internal failure on our side. |

## Payments and refunds (provisional)

- **Price:** 5 credits per conversion.
- **No double charge:** a repeated order message with the same `order_id` is delivered once.
- **Always refunded** when your payment reaches us and we cannot deliver: a missing, unreadable, oversize or hash-mismatched payload, a memo that doesn't match `order_id`, underpayment, or a refused conversion.
- **Overpayment:** the excess is refunded.
- **Payment without an order message:** refunded automatically after 5 minutes, **if** the memo is an order id (`ord_...`). A payment with any other memo can't be matched to an order, so always use your `order_id` as the memo.
- **Don't reuse an `order_id`.** Each order needs a new id and a new payment.
- **Delivery target:** 3 minutes after your order message.
- **Your payment is safe from others.** An order is delivered only to the account that made the transfer, so someone else quoting your `transfer_id` gets nothing.
