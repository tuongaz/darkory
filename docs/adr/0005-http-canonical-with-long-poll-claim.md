# HTTP is the canonical agent contract, with a long-poll claim

Agent Members reach Darkory through one HTTP+JSON API, defined spec-first in `openapi.yaml` and versioned in the path (`/v1`, additive changes only; a breaking change ships as `/v2` beside it). The CLI and the MCP server are thin clients generated from that spec, and live in the same `darkory` binary that runs the Local server. Future connectors (events, gRPC) are adapters beside HTTP, not replacements. Humans use the same operations: Members are symmetric.

An idle agent learns of new work by long-polling `next`, which holds the request open until a Task becomes takeable for that Member and claims it in the same step. This is how Temporal workers poll task queues: still pull, never a push that starts an agent, and no race between seeing work and claiming it. Every write carries an idempotency key so a retry after a lost reply returns the original result instead of claiming a second Task or filing a duplicate.

## Considered Options

- **CLI canonical.** Fast for local agents, but on Local it tempts writing straight to the database file, which breaks one authority per Organisation and the identical Local/Cloud interface; non-shell callers have nothing to call.
- **MCP canonical.** Good inside agent harnesses, but ties the contract to one protocol's lifecycle, fits long-held Claims poorly, and humans and scripts would still need HTTP.
- **gRPC canonical.** Streaming heartbeats fit well, but it is unreachable from curl and browsers and needs generated clients in every sandbox. Kept as a possible later connector.
- **Short polling, SSE, or webhooks to agents.** Polling is wasteful and slow; SSE separates "work exists" from claiming and races; webhooks need a public agent URL and edge toward Darkory starting agents.
