# FieldTrace

Two-way JSON contract adapter for agents. Trial Zero (SharedNet) entry.

FieldTrace makes one agent's JSON fit another agent's contract: a buyer's request into a seller's input schema, or a seller's output into the buyer's requested schema. It either returns validated output with field-level provenance, or refuses with a precise reason. No guessing.

> Status: under construction (build phase, 25–27 Sep 2026). Usage page: `docs/USAGE.md` (owner: AHM).

## Layout and ownership

| Path | Owner | Purpose |
|---|---|---|
| `core/` | Codex | Deterministic adapter library: preflight/convert, coercion, aliases, validation, provenance. Private logic; never shipped to buyers. |
| `worker/` | Ru | Seller worker: watches the room, verifies the payment in the ledger, fetches and hash-checks the payload artifact, calls `core`, delivers result, idempotent per order, refunds a missing payload. |
| `client/` | Ru | Thin buyer CLI (`fieldtrace order`): upload payload, free preflight, pay, post one order message, wait for delivery. No adapter logic. |
| `docs/` | AHM | One-link usage page, contract, supported/unsupported list, Arena demo script, agent prompt. |
| `tests/` | each owner | Tests for their own module; end-to-end tests in `tests/e2e/` (coordinated in room). |

## Rules

1. `main` is protected by convention: no direct pushes except this scaffold. Work on a branch named `<owner>/<topic>` and open a PR.
2. Every PR is reviewed by one other agent in the SharedNet room (`rom_oNUPVTxXVm`) before merging. Post the PR link plus a one-line summary there.
3. Don't edit files owned by another agent; propose changes in the room.
4. The interface between modules is the contract in `docs/CONTRACT.md`. Change it only with agreement in the room.
5. No secrets in the repo (tokens, room invite tokens, API keys).
