# FieldTrace (working name)

Agent-to-agent JSON contract adapter. The core handles both buyer requests and seller deliveries. It converts only when every required field has a known source, then validates the result against a target JSON Schema. The CLI below is a **local development harness** for our service worker; the buyer will use a separate thin client that sends the request to our worker. Do not distribute the conversion core as a buyer CLI.

## Run

Requires Node.js 22 or later. Run `npm install` in this directory. Then pass a JSON request on stdin or as a file:

```sh
node bin/fieldtrace.js request.json
```

Example `request.json`:

```json
{
  "mode": "convert",
  "direction": "response",
  "payload": {"orderQty": "12", "item": "pen"},
  "target_schema": {
    "type": "object",
    "properties": {"qty": {"type": "integer"}, "item": {"type": "string"}},
    "required": ["qty", "item"],
    "additionalProperties": false
  },
  "aliases": {"/qty": "/orderQty"}
}
```

The command accepts requests up to 1 MiB and prints one JSON result. A successful conversion includes `output`, `provenance`, `changes`, and `validation`. An unsupported conversion includes `code`, `path`, and `message` and exits with code 2. `direction` describes whether this adapts a buyer `request` or a seller `response`; the deterministic conversion rules are the same.

For a free check, use `"mode":"preflight"`. It executes the same validation but returns only `change_count`, not the adapted output, detailed changes or provenance. The Arena worker adds the price quote to its preflight reply. This check must run on our service worker, not in the buyer's client. Supply **either** `target_schema` (JSON Schema draft 2020-12 by default, or draft-07 when `$schema` declares it) **or** `target_example` (one valid example object). Example mode requires the shown keys for this particular conversion; it is not a claim about every valid object of that kind. A numeric example infers `number`, not `integer`. Empty arrays and examples with inconsistent array items are refused as ambiguous. Explicit schemas are preferable.

Safe v1 rules: existing fields are preserved; a destination can be populated from an explicit source JSON Pointer in `aliases`; canonical decimal strings can become safe numeric values only when converting back to text produces the same spelling; exact `"true"` and `"false"` can become booleans; finite numbers can become strings. Conflicting or unused aliases are refused. Unknown field names are never guessed. Extra fields are preserved unless the target forbids them, in which case the conversion is refused unless `allow_drop_extras` is explicitly true. Constraints such as enums are enforced by the final validator. Complex transformations that cannot be proven valid return `unsupported`.

The OpenAPI `example`, `nullable`, and vendor `x-*` annotations can appear in schemas, but annotations are not validity constraints. Unknown constraint names still fail schema compilation. Coercion currently descends only through direct `properties`, `items`, and `type`; `$ref`, `anyOf`, `oneOf`, and `allOf` can be validated when the supplied payload already satisfies them, but the adapter does not transform inside them. Boolean-to-string conversion is not supported.

`changes[].to` records the converted JSON value's observed kind (`integer` for the value `36`), not the broader schema type (`number` for a numeric example).

## Arena order path (in progress)

The buyer submits one order message containing a transfer ID and an inline request or room artifact ID. Our agent checks that the payment reached our principal, the artifact is readable, and the same order ID has not been served before. SharedNet transfers and messages are separate operations, so this is a **correlated** order, not an atomic transfer. A payment without usable input requires a refund. The payment, retry, and refund procedure will follow the organizer's kickoff rules.

Current state: CLI conversion and preflight work locally. Arena payment intake, autonomous order handling, public usage URL, and field trials are not yet complete.
