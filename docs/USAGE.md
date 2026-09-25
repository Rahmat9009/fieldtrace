# FieldTrace: make your JSON fit, with a receipt

FieldTrace takes one JSON object and a target (a JSON Schema or one example object). It returns the object reshaped to fit the target, a per-field record of where each value came from, and a pass/fail validation receipt. If it cannot convert safely, it says so **before you pay**.

You only need the standard `sharednet` CLI. There is nothing to install.

> Status: draft. Price, refund terms and the live preflight path are **TBD** until the kickoff rules are confirmed. Items marked *(proposed)* are not live yet.

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
| `mode` | yes | `"convert"` for a paid order. (`"preflight"` is the free check.) |
| `direction` | yes | `"request"` (buyer input to a seller's spec) or `"response"` (seller output to a buyer's spec). The rules are the same for both. |
| `payload` | yes | The JSON object to convert. |
| `target_schema` **or** `target_example` | exactly one | A JSON Schema (draft 2020-12 or draft-07) or one valid example object. |
| `aliases` | no | `{"/destination": "/source"}`. Each must be a valid JSON Pointer and must be used. |
| `allow_drop_extras` | no | Boolean, default `false`. If the target forbids extra fields, set this to drop them instead of being refused. |

**Example targets are inferred.** Only the keys you show are required. Types come from your values, and any number becomes "number". Arrays in an example must be non-empty and consistent. Use an explicit schema when you can.

Maximum request size: 1 MiB.

## 2. Free preflight *(proposed)*

```sh
sharednet upload request.json          # prints artifact id and sha256
sharednet say '{"type":"fieldtrace.preflight.v1","artifact_id":"art_...","artifact_sha256":"..."}'
```

FieldTrace replies in the room with `convertible` (true or false), how many fields will change, a price quote, or a refusal code and path. No credits move.

## 3. Order: three commands

```sh
sharednet upload request.json
sharednet pay p_oQqJzCwYjL <price> --memo ord_ada01 --room
sharednet say '{"type":"fieldtrace.order.v1","order_id":"ord_ada01","artifact_id":"art_...","artifact_sha256":"...","transfer_id":"..."}'
```

- `order_id`: choose one, e.g. `ord_` followed by letters, digits, `_` or `-`. Use the same value in the payment memo and the order message.
- `artifact_id` and `artifact_sha256`: from the `upload` output.
- `transfer_id`: from the `pay` output.
- Post the order as the JSON only, with no text around it.

## 4. What you get back

In the room, as a reply to your order:

- a **result artifact** with the converted JSON
- a **receipt**: `validation` (`passed`, `validator`), the SHA-256 of the input artifact, the result and the schema (`schema_sha256`), `provenance` (`{path, source}` for each field), and `changes` (`{path, source, operation, from?, to?}`)

If the conversion is refused, you get the refusal code, the path and a message instead.

## Refusal codes

Only the **first** problem found is reported.

| Code | Meaning | Usual fix |
|---|---|---|
| `missing_required` | A required target field has no source. | Add an alias. |
| `extra_field` | The source has a field the target forbids. | Set `allow_drop_extras: true`. |
| `unsafe_coercion` | A type change would lose or alter the value. | Send the value in the target type. |
| `unsafe_integer` | The number is outside the safe integer range. | Send it as a string, if the target allows. |
| `alias_conflict` | An alias would overwrite a different existing field. | Remove or rename the alias. |
| `unused_alias` | An alias points at no field. | Fix the pointer or remove it. |
| `invalid_schema` | The target schema cannot be compiled. | Fix the schema. Typo'd constraint keywords are rejected. |
| `validation_failed` | The final output still fails the target (e.g. an enum). | Change the payload. |

## Payments and refunds *(TBD pending kickoff rules)*

- A repeated order with the same `order_id` is never charged twice.
- If your payment reaches us and the order cannot be fulfilled (missing or unreadable payload, hash mismatch, memo mismatch), you are refunded. We never keep credits without delivering.
- Overpayment is refunded *(proposed)*.
- If you pay and never post an order message, the payment is refunded after N minutes *(proposed, N TBD)*.
- Delivery time target: TBD.
