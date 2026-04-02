## Context

NanoClaw's agent-runner (`container/agent-runner/src/index.ts`) iterates over the SDK's `query()` async message stream. Each message has a `type` field: `system` (init, task_notification), `assistant` (text, tool_use blocks), `tool_use_summary`, `tool_progress`, `result`. The runner already logs these for debugging.

Current Langfuse integration is via OpenRouter's OTEL export — zero code in the codebase. This gives flat per-request traces with no session grouping, no custom userId, no tool spans, and no env tagging.

The agent-runner runs inside a Docker container. Env vars are forwarded by `src/container-runner.ts` via `-e` flags on `docker run`. The `ContainerInput` protocol is a JSON blob piped to stdin.

### Key files

- `container/agent-runner/src/index.ts` — the `runQuery()` function and message loop (lines 334-501)
- `container/agent-runner/package.json` — agent-runner dependencies (separate from main NanoClaw)
- `src/container-runner.ts` — `buildContainerArgs()` (lines 264-333) forwards env vars
- `src/index.ts` — `runAgent()` (lines 314-393) builds ContainerInput and calls runContainerAgent

## Goals / Non-Goals

**Goals:**
- One Langfuse trace per `runQuery()` call with sessionId, userId, group name
- Generation spans for each SDK API call with token counts, cost, cache metrics
- Tool spans for tool_use blocks with name, duration, truncated input/output
- Dev/prod separation via different `LANGFUSE_*` env vars
- Graceful degradation: if Langfuse env vars are missing, no traces, no errors

**Non-Goals:**
- Langfuse prompt management (using Langfuse to store/version prompts)
- Langfuse evaluations or scoring
- Replacing the existing stderr logging (keep both)
- Instrumenting the NanoClaw orchestrator (only the agent-runner)

## Decisions

### 1. Langfuse SDK in agent-runner, not orchestrator

The agent-runner sees the actual API calls and tool usage. The orchestrator only sees the final result. Instrumentation belongs where the data is.

**Alternative**: Instrument the orchestrator and infer API calls from container logs. Rejected — lossy, fragile, and the container already has all the data.

### 2. Plain env vars, not OneCLI

Forward `LANGFUSE_SECRET_KEY`, `LANGFUSE_PUBLIC_KEY`, and `LANGFUSE_BASEURL` as container env vars via `container-runner.ts`. The Langfuse SDK reads these automatically.

Langfuse credentials are write-only (can create traces, can't read data or spend money), so the security bar is lower than API keys.

Set them in `deploy/docker-compose.yml` and `deploy/docker-compose.dev.yml` on the app service, so they propagate through container-runner to agent containers. Dev and prod use different values → different Langfuse projects.

### 3. Trace structure: one trace per runQuery(), spans inside

```
runQuery() start
  │
  ├── Create Langfuse trace
  │   name: "{groupFolder}: {prompt first 50 chars}"
  │   sessionId: from ContainerInput
  │   userId: from ContainerInput
  │   metadata: { groupFolder, chatJid, isMain, model }
  │
  ├── SDK message loop:
  │   │
  │   ├── system/init → update trace metadata (model, session)
  │   │
  │   ├── assistant with tool_use blocks → start tool span
  │   │   span name: "Tool: {toolName}"
  │   │   input: tool input (truncated to 500 chars)
  │   │
  │   ├── assistant with text → create generation
  │   │   (token usage comes from the result message, not individual
  │   │    assistant messages — the SDK doesn't expose per-call usage)
  │   │
  │   ├── tool_use_summary → end tool span with output
  │   │
  │   └── result → end trace
  │       total_cost_usd, num_turns, duration_ms
  │
  └── langfuse.flush() before returning
```

**Token tracking limitation**: The Claude Agent SDK's `query()` doesn't expose per-API-call token usage in the message stream. The `result` message has `total_cost_usd`, `num_turns`, `duration_ms` — aggregate stats only. We'll log these on the trace. Individual generation-level token counts would require intercepting the HTTP calls, which we won't do.

**Alternative**: Intercept `fetch()` to capture per-request token usage from response headers. Rejected — fragile, breaks on SDK internals changes, and the aggregate stats are sufficient for cost monitoring.

### 4. userId passed through ContainerInput

Add `userId?: string` to the `ContainerInput` interface in both `container/agent-runner/src/index.ts` and `src/container-runner.ts`.

The orchestrator resolves userId from the sender info already available in the message processing path. For Telegram, `sender_name` from the message (e.g., "Kuba") is good enough. No need for a users table — the sender_name is already stored per-message.

### 5. Separate langfuse.ts module

Create `container/agent-runner/src/langfuse.ts` as a thin wrapper:

```typescript
// Initializes Langfuse client from env vars (LANGFUSE_SECRET_KEY, etc.)
// Returns null if env vars are missing (graceful degradation)
// Exports: createTrace(), createGeneration(), createSpan(), flush()
```

This keeps the instrumentation concerns out of the main index.ts. The `runQuery()` function calls the wrapper at trace boundaries.

### 6. Disable OpenRouter Langfuse after rollout

Once direct integration is verified, disable OpenRouter's Langfuse OTEL export in the OpenRouter dashboard. Otherwise every API call produces two traces (one from OpenRouter, one from our SDK).

**Transition plan**: Deploy direct integration first, verify traces appear correctly, then disable OpenRouter export. Brief overlap period has duplicate traces but no data loss.

## Risks / Trade-offs

**Langfuse SDK adds a dependency** — another package in the agent container image. It's lightweight (~200KB), but it's network I/O on every trace flush. Mitigation: flush async, don't block the response path. The SDK batches by default.

**No per-generation token counts** — we only get aggregate stats from the `result` message. This means we can't see "this specific tool call cost $X." Mitigation: the trace-level cost is still accurate, and tool spans show duration which is the main debugging signal.

**Container startup time** — Langfuse SDK initialization adds a few ms. Negligible compared to the SDK's own startup.

**Env var sprawl** — three new env vars in compose files. Mitigation: they're standard Langfuse variables, well-documented.
