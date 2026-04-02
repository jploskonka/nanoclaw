## Context

NanoClaw runs Claude Agent SDK inside containers. Each group gets an isolated container with its own session (stored in SQLite `sessions` table, keyed by `group_folder`). The agent-runner calls `query()` from the SDK, which manages the full Anthropic API interaction.

Current state:
- **Prompt caching already works**: The SDK sets `cache_control: { type: 'ephemeral' }` on system prompt blocks. OpenRouter passes this through to Anthropic. Production traces show 89% cache hit rate, saving $26.72 out of a hypothetical $35.21. **No changes needed.**
- **No Langfuse code in the codebase**: Langfuse traces come from OpenRouter's built-in OTEL export, configured in the OpenRouter dashboard. OpenRouter constructs userId from its API key hash + session ID. NanoClaw has zero Langfuse instrumentation.
- **Sessions are per-group, forever**: One sessionId per group folder, never reset. All conversations share one eternal session. Context grows to 100K+ tokens with no way to start fresh.
- **No Langfuse sessionId**: Langfuse traces have `sessionId: null`. OpenRouter doesn't pass through NanoClaw's session concept, so conversations can't be grouped in the Langfuse UI.

### Research Findings (2026-04-02)

1. **SDK version**: `@anthropic-ai/claude-agent-sdk@^0.2.76` in `container/agent-runner/package.json`
2. **Prompt caching**: Handled transparently by the SDK. The `query()` options include `systemPrompt` with `type: 'preset'` which the SDK wraps with `cache_control`. No action needed.
3. **Langfuse integration**: NOT from the SDK. OpenRouter's OTEL export sends traces to Langfuse via keys configured in the OpenRouter dashboard. The SDK does not read `LANGFUSE_*` env vars.
4. **Env vars forwarded to containers** (from `container-runner.ts:271-289`): `TZ`, `ANTHROPIC_BASE_URL`, `CLAUDE_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `LLM_MODEL`. No `LANGFUSE_*` vars.
5. **userId in traces**: Constructed by OpenRouter as `user_{hash}_account__session_{sessionId}`. Stable as long as sessionId doesn't change (which it currently never does).

### Key Insight

The original proposal assumed prompt caching was the cost problem. Analysis of 601 traces shows caching is already working well. The real cost driver is **unbounded session growth** — conversations that never reset, causing 100K+ token calls. Even with 89% cache hits, the uncached portion of large contexts is expensive ($0.10-0.14 per call for 80K+ uncached tokens).

## Goals / Non-Goals

**Goals:**
- Add explicit session boundaries so users can start fresh conversations
- Track conversation metadata in SQLite for analytics
- Forward session/user identifiers to Langfuse so conversations can be grouped

**Non-Goals:**
- Prompt caching changes (already working)
- Direct Langfuse SDK integration (OpenRouter handles it)
- Multi-user tracking (groups are 1:1 with users for now)
- Time-based auto-reset (user-initiated is simpler and more predictable)

## Decisions

### 1. Session reset via `/start` and `/new` commands

**Approach**: Intercept `/start` and `/new` in the Telegram handler (alongside existing `chatid` and `ping`). When received:

1. Archive current session to `conversations` table
2. Delete sessionId from `sessions` table
3. Reply with confirmation message
4. Next message creates a fresh session (existing behavior when sessionId is undefined)

```
User sends /start or /new
    │
    ▼
┌─────────────────────────┐
│ Is there an active       │
│ session for this group?  │──── No ──→ Reply "No active session"
└──────────┬──────────────┘
           │ Yes
           ▼
┌─────────────────────────┐
│ Archive to conversations │
│ table (id, group_folder, │
│ session_id, started_at,  │
│ ended_at = now)          │
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐
│ DELETE FROM sessions     │
│ WHERE group_folder = ?   │
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐
│ Close active container   │
│ via queue.closeStdin()   │
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐
│ Reply: "New conversation │
│ started. Context cleared."│
└─────────────────────────┘
```

**Where to intercept**: In `src/channels/telegram.ts` as bot commands (same pattern as `/chatid` and `/ping`). The session reset logic calls back into the orchestrator via a new callback in `TelegramChannelOpts`.

**`/start` dual role**: `/start` is Telegram's standard bot entry point (sent on first contact). For first-contact, there's no session to clear — the "No active session" path handles it naturally. For returning users, it resets the session. This matches user expectations: "I want to start over."

### 2. Conversations table for metadata tracking

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  group_folder TEXT NOT NULL,
  session_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_conv_group ON conversations(group_folder);
```

**Lifecycle**:
- Created when `/start` or `/new` archives the current session (the "ended" conversation)
- `started_at` = when the session was first seen (from `sessions` table or first message timestamp)
- `ended_at` = now (when the user resets)
- No message_count or user_id columns — keep it minimal. Langfuse has the details.

**DB migration**: Add table in `createSchema()` in `src/db.ts` using `CREATE TABLE IF NOT EXISTS` (same pattern as all other tables).

### 3. Forward Langfuse identifiers to containers

Add to `buildContainerArgs()` in `src/container-runner.ts`:

```typescript
// Forward Langfuse session tracking
if (process.env.LANGFUSE_SESSION_ID) {
  args.push('-e', `LANGFUSE_SESSION_ID=${process.env.LANGFUSE_SESSION_ID}`);
}
if (process.env.LANGFUSE_USER_ID) {
  args.push('-e', `LANGFUSE_USER_ID=${process.env.LANGFUSE_USER_ID}`);
}
```

**But wait** — Langfuse traces come from OpenRouter's OTEL export, not from the SDK reading env vars. So `LANGFUSE_SESSION_ID` as a container env var won't reach OpenRouter's trace pipeline.

**Alternative approach**: OpenRouter supports `X-Title` header (shown in activity dashboard) and custom metadata via request headers. The SDK's `query()` call goes through `ANTHROPIC_BASE_URL` (OpenRouter). Check if OpenRouter's OTEL export includes request-level metadata that could carry sessionId.

**Pragmatic decision**: The session ID is already embedded in OpenRouter's auto-generated userId (`user_...session_{sessionId}`). When we reset sessions, the new sessionId will produce a new userId hash. This gives us conversation separation in Langfuse without any env var forwarding. The grouping isn't as clean as explicit `sessionId`, but it works immediately.

**Phase 2 (future)**: If cleaner Langfuse grouping is needed, add explicit Langfuse SDK instrumentation in the agent-runner (wrapping the SDK's query calls). This would give full control over sessionId, userId, and trace metadata. But it's a larger change and not needed for the immediate goal of "stop burning money."

### 4. Close active container on session reset

When `/start` or `/new` is received, the active container (if any) must be closed. Otherwise:
- The container keeps its old session context
- The next message would pipe into the old container via IPC
- The session wouldn't actually reset until the container times out

Use `queue.closeStdin(chatJid)` which writes the `_close` sentinel to the IPC directory. The agent-runner polls for this and exits gracefully.

### 5. Expose session reset as a callback, not direct DB access

The Telegram handler shouldn't import DB functions directly. Instead, add a `onSessionReset` callback to `TelegramChannelOpts`:

```typescript
interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onSessionReset: (chatJid: string) => { cleared: boolean; message: string };
}
```

The orchestrator (`src/index.ts`) implements this callback with the actual session clearing logic.

## Risks / Trade-offs

**Accidental session reset** — User sends `/start` and loses context mid-conversation. Mitigation: the reply message makes it clear what happened. The PreCompact hook already archives transcripts to `conversations/` directory, so history is preserved.

**Container race condition** — User sends `/start` while a container is processing. The `closeStdin()` signal may not be processed immediately. Mitigation: the sentinel file approach is reliable (container polls every 500ms), and the session is already cleared in DB, so even if the old container produces one more output, the next message will start a fresh session.

**OpenRouter userId changes** — Resetting the session changes the userId hash in OpenRouter's traces (since sessionId is part of the hash). This means the same person appears as different users in Langfuse after a reset. This is acceptable for now — we're trading user correlation for conversation separation, and conversation separation is more valuable for debugging.
