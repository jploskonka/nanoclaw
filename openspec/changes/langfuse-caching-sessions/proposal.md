## Why

Two problems discovered while analyzing Vi's production Langfuse traces (601 API calls, $8.49 over 3 days):

### 1. Unbounded Session Growth (Primary Cost Driver)

All conversations in a Telegram group share ONE sessionId, stored in SQLite `sessions` table, keyed by `group_folder`. The session persists across `/start` commands, clear history, and container restarts. Conversation context grows unboundedly — calls start at ~45K input tokens and grow to 124K+ as the session accumulates.

Token distribution across 601 calls:
- 50-80K tokens: 212 calls, $3.41
- 80-100K tokens: 68 calls, $1.28
- 100K+ tokens: 60 calls, $2.08

The top 12 most expensive calls each cost $0.10-0.14 — all with 80K+ uncached tokens from sessions that were never reset.

Prompt caching IS working (89% hit rate, saving $26.72), but even cached calls are expensive when the context is 100K+ tokens.

### 2. No Session Tracking in Langfuse

Langfuse traces have `sessionId: null` — OpenRouter doesn't set it. All traces appear as independent requests with no way to group them into conversations. The userId is a hash of the OpenRouter API key + session: `user_6f11b8c3...session_e01fe6e7...`, which is stable but opaque.

Root cause: Langfuse integration comes from OpenRouter's built-in OTEL export, not from the SDK or NanoClaw. OpenRouter constructs userId from its own metadata and doesn't pass through NanoClaw's session concept.

## What Changes

### Session Boundaries
- Add `/new` command in Telegram to reset the session (clear sessionId from DB)
- `/start` also resets the session (standard Telegram bot entry point)
- Record conversation metadata in a `conversations` table before clearing

### Langfuse Session Tracking
- Forward `LANGFUSE_SESSION_ID` env var to agent containers, set to current sessionId
- Forward `LANGFUSE_USER_ID` env var, set to a stable identifier derived from the Telegram sender

## Capabilities

### New Capabilities
- `session-management`: Explicit session boundaries via Telegram commands, per-conversation sessionIds

### Modified Capabilities
- `langfuse-observability`: Per-conversation sessionId, stable userId forwarded to containers
- `nanoclaw-telegram`: `/start` and `/new` as session reset commands

## Impact

- `src/index.ts` — session reset logic, conversations table tracking
- `src/channels/telegram.ts` — /start and /new command handlers
- `src/db.ts` — conversations table, clearSession function
- `src/container-runner.ts` — forward LANGFUSE_SESSION_ID and LANGFUSE_USER_ID to containers
