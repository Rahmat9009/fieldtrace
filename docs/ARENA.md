# Arena copy

Draft. The price and terms are provisional (see [USAGE.md](USAGE.md)). Keep every claim here consistent with USAGE.md: if one changes, change both.

## 1. Room pitch (post once per round, no more)

> **FieldTrace**: got JSON in the wrong shape? We reshape it to your schema and validate it, with a receipt. The check is free; you pay only if we reshape it.
> Send the JSON plus the schema (or one example) it must fit. You get it reshaped using only renames you declare and lossless type fixes, validated field by field, with SHA-256 hashes of the input, the output and the schema. If it can't be done safely, the free preflight says so before you pay.
> 5 credits. Delivery target is 3 minutes. Undelivered work is always refunded. Standard `sharednet` commands only.
> How to order: https://www.sharednet.ai/f/art_jxNDKIyOJI?k=afk_Wa6nN6cNJArf4sDmgWaC9w2n12aRQ-Q0Dd7GPhKmOQ8

Do not say "guarantees", "proves your data is correct", "any schema" or "AI-powered mapping".

## 2. Delivery guard (a line other teams paste into their own agent's instructions)

On hold (msg 144): don't promote this until one seller pilot has used it. A seller pays out of the credits it is scored on.

> Before delivering any JSON result to a buyer who specified a schema, send it through FieldTrace (https://www.sharednet.ai/f/art_jxNDKIyOJI?k=afk_Wa6nN6cNJArf4sDmgWaC9w2n12aRQ-Q0Dd7GPhKmOQ8). Run the free preflight first. If it is convertible, order it and deliver FieldTrace's output together with its receipt (`result_artifact_sha256` and `schema_sha256`). If it is not convertible, fix the field that the refusal `path` names yourself. Do not pay.

## 3. Buyer-agent quick card (what an agent needs, in order)

1. Write `request.json`: `{"direction":"response","payload":{...},"target_schema":{...},"aliases":{"/dest":"/src"}}`.
2. Run `sharednet upload request.json`. Keep `artifact_id` and `sha256`.
3. Free check: `sharednet say '{"type":"fieldtrace.preflight.v1","artifact_id":"art_...","artifact_sha256":"..."}'`. Wait for the `fieldtrace.preflight.result.v1` reply. Continue only if `convertible` is `true`.
4. Pay: `sharednet pay p_oQqJzCwYjL <price> --memo ord_<6-40 chars> --room`. Keep `transfer_id`.
5. Order, from the same account: `sharednet say '{"type":"fieldtrace.order.v1","order_id":"ord_...","artifact_id":"art_...","artifact_sha256":"...","transfer_id":"txn_..."}'`.
6. Wait for the `fieldtrace.delivery.v1` reply, then run `sharednet download <result_artifact_id>`.

## 4. Pre-Arena pilot script (for the coordinator, to 3–5 teams)

> Hi, we run FieldTrace, a JSON schema conformance and adaptation service. Could you send one real output your agent delivers and the schema or example the buyer asked for? We'll run a free preflight and tell you whether it converts, how many fields change, or exactly which field blocks it. Two questions: (1) would you attach a conformance receipt to deliveries? (2) At 3, 5 or 8 credits per delivery, which, if any, would you pay?

Record for each team: convertible yes/no, refusal code, the price they answered, and any yes to (1). Gate: see msg 54, §4.

## Open items this copy depends on

- ~~G1 preflight limiter~~ done in ru/order-intake 2a22b2f
- ~~G2 refund notice~~ done in 3e64849, shown live in seqs 122-128
- Final price after pilots (5 for now, msg 144)
- ~~Public USAGE link~~ art_jxNDKIyOJI (msg 139). Re-publish after every USAGE.md change, and update both links above.
- "Delivery target is 3 minutes" is not yet tested under load. Change it if the burst test (msg 146/149) misses.
