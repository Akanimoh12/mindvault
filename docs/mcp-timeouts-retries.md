# MCP Timeouts

Every outbound HTTP call the MindVault MCP server makes runs under a deadline.
Without one, a hung or black-holed connection blocks the tool call forever — and
for a stdio MCP server that means the agent waits indefinitely with nothing to
react to.

Implementation: [`mcp/src/httpTimeout.ts`](../mcp/src/httpTimeout.ts).

## How it works

Each request is issued with an `AbortController`. A timer started alongside the
request aborts it when the budget elapses, which releases the socket rather than
leaving it dangling, and the caller receives a `RequestTimeoutError`.

That error is deliberately distinguishable from a caller-initiated cancellation:
only a budget overrun produces `RequestTimeoutError`. It maps to the `timeout`
category in the [error reference](mcp-error-reference.md), so an agent sees:

```text
MindVault API request failed: Request timed out after 15000ms (http). Raise MINDVAULT_HTTP_TIMEOUT_MS if this endpoint is legitimately slow.
Source: MindVault API · Category: timeout
Next: The request exceeded its configured timeout. Retry, or raise MINDVAULT_HTTP_TIMEOUT_MS for a slow endpoint.
```

If the caller passes its own `AbortSignal`, it is honoured too — aborting either
the caller's signal or the deadline aborts the request.

## Budgets

Budgets differ by service because the work differs: a catalog read should be
quick, while an x402 payment includes on-chain settlement and is legitimately
slow.

| Service   | Env var                        | Default | Covers                                                   |
| --------- | ------------------------------ | ------- | -------------------------------------------------------- |
| `http`    | `MINDVAULT_HTTP_TIMEOUT_MS`    | 15000   | MindVault API and the sponsored-account service          |
| `horizon` | `MINDVAULT_HORIZON_TIMEOUT_MS` | 15000   | Horizon account and balance reads                        |
| `soroban` | `MINDVAULT_SOROBAN_TIMEOUT_MS` | 20000   | Soroban RPC (`mindvault_tx_status`, registry transport)  |
| `payment` | `MINDVAULT_PAYMENT_TIMEOUT_MS` | 45000   | x402 paid fetches for `mindvault_buy` and publish verify |

Rules:

- Values are milliseconds.
- **`0` disables** the deadline for that service.
- A malformed or negative value falls back to the default rather than failing
  startup — a typo must not brick the server.
- Fractional values are floored.

## Checking the active budgets

`mindvault_network_profile` reports them, so an operator diagnosing a slow or
hanging tool does not have to inspect the environment:

```json
{
  "stellarNetwork": "testnet",
  "timeouts": "http=15000ms, horizon=15000ms, soroban=20000ms, payment=45000ms"
}
```

## Tuning

- **Self-hosted or cold-start backend** (a free-tier host can take >15s to wake):
  raise `MINDVAULT_HTTP_TIMEOUT_MS`.
- **Slow or rate-limited RPC provider**: raise `MINDVAULT_SOROBAN_TIMEOUT_MS`.
- **Congested network at settlement time**: raise `MINDVAULT_PAYMENT_TIMEOUT_MS`.
  Do not lower it below the default — aborting mid-settlement gives the agent an
  ambiguous result for a payment that may still land on-chain.

## Coverage

- [`mcp/src/httpTimeout.test.ts`](../mcp/src/httpTimeout.test.ts) — budget
  resolution and the abort path, driven with fake timers
- [`mcp/src/toolTimeouts.test.ts`](../mcp/src/toolTimeouts.test.ts) — real tools
  failing fast against a deliberately slow (never-answering) fetch
