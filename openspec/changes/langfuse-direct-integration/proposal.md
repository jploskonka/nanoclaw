## Why

Langfuse traces currently come from OpenRouter's built-in OTEL export. This gives us per-request token counts and costs, but has hard limitations:

- **No sessionId** — always null. Can't group requests into conversations in the Langfuse UI.
- **No custom userId** — OpenRouter generates an opaque hash. We have the real identity (Telegram sender) but can't pass it through.
- **No trace hierarchy** — each API call is a flat, independent trace. A single user message may trigger 5-10 SDK round-trips (tool calls, follow-ups), and they all appear as unrelated "OpenRouter Request" entries.
- **No tool call visibility** — we can't see which tools were called, how long they took, or which ones failed.
- **No environment tagging** — dev and prod traces land in the same project. Splitting requires separate OpenRouter API keys and Langfuse projects.
- **No trace names** — everything is "OpenRouter Request". We want "User message: solve the mission" or at least the group name.

Direct Langfuse integration in the agent-runner solves all of these by wrapping the SDK's `query()` message loop with proper Langfuse traces, generations, and spans.

## What Changes

- Add `langfuse` SDK to `container/agent-runner/package.json`
- Create a Langfuse instrumentation module in `container/agent-runner/src/langfuse.ts`
- Wrap the `query()` message loop in `container/agent-runner/src/index.ts` with Langfuse traces
- Forward `LANGFUSE_*` env vars from NanoClaw app to agent containers via `src/container-runner.ts`
- Pass `userId` and `sessionId` through the `ContainerInput` protocol
- Disable OpenRouter's Langfuse export (done manually in OpenRouter dashboard) to avoid double traces

### Trace structure

Each `runQuery()` call creates one Langfuse trace:

```
Trace: "kuba-private: solve the mission"
  metadata: { groupFolder, chatJid, isMain, model }
  sessionId: <SDK sessionId>
  userId: "Kuba"
  │
  ├── Generation: "query() call 1"
  │   input_tokens, output_tokens, cached_tokens, cost, model
  │
  ├── Span: "Tool: Bash(node solver.mjs)"
  │   duration, input (truncated), output (truncated)
  │
  ├── Generation: "query() call 2"
  │   input_tokens, output_tokens, cost
  │
  └── Span: "Tool: hub_client.verify()"
      duration
```

### Data flow

```
ContainerInput (stdin)
  ├── sessionId     ──→  Langfuse trace.sessionId
  ├── chatJid       ──→  (used to resolve userId)
  ├── groupFolder   ──→  Langfuse trace.name prefix
  └── userId (NEW)  ──→  Langfuse trace.userId

LANGFUSE_* env vars (container env)
  ├── LANGFUSE_SECRET_KEY   ──→  Langfuse SDK auth
  ├── LANGFUSE_PUBLIC_KEY   ──→  Langfuse SDK auth
  └── LANGFUSE_BASEURL      ──→  Langfuse SDK endpoint

SDK query() message stream
  ├── system/init        ──→  trace metadata (model, session)
  ├── assistant          ──→  generation span (token usage from API)
  ├── tool_use_summary   ──→  tool span
  └── result             ──→  trace end, total cost
```

## Capabilities

### New Capabilities
- `langfuse-direct`: Direct Langfuse SDK integration in agent-runner with hierarchical traces

### Modified Capabilities
- `langfuse-observability`: Replace OpenRouter OTEL with direct instrumentation. sessionId, userId, tool spans, env tagging.

## Impact

- `container/agent-runner/package.json` — add `langfuse` dependency
- `container/agent-runner/src/langfuse.ts` — new file: Langfuse client wrapper, trace/span helpers
- `container/agent-runner/src/index.ts` — instrument `runQuery()` message loop
- `src/container-runner.ts` — forward `LANGFUSE_*` env vars + `userId` in ContainerInput
- `src/index.ts` — resolve userId from sender, pass in ContainerInput
- `container/agent-runner/src/index.ts` — accept `userId` in ContainerInput interface

### Manual steps (not code)
- Disable Langfuse integration in OpenRouter dashboard (to avoid double traces)
- Create separate Langfuse projects for dev and prod
- Add Langfuse credentials to OneCLI or compose env vars
