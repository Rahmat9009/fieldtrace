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

## Demo checklist

- [ ] Run both requests through the live worker, not the local harness.
- [ ] Show the room messages: preflight, pay, order, delivery. Show the ledger entry for the transfer.
- [ ] Show the receipt's result hash matching the delivered artifact.
- [ ] Do not say "proves the data is correct". Say "proves these bytes match this schema".
