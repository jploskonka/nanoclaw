## 1. Langfuse SDK dependency

- [x] 1.1 Add `langfuse` to `container/agent-runner/package.json` dependencies
- [x] 1.2 Run `npm install` in `container/agent-runner/` to update lockfile

## 2. Langfuse wrapper module

- [x] 2.1 Create `container/agent-runner/src/langfuse.ts` with:
  - `initLangfuse()` — creates Langfuse client from env vars, returns null if not configured
  - `TracingContext` class or object that wraps trace/span/generation creation
  - `createTrace(opts: { name, sessionId, userId, metadata })` — creates a new trace
  - `startToolSpan(trace, name, input)` — creates a span for a tool call
  - `endToolSpan(span, output)` — ends a tool span
  - `setTraceResult(trace, opts: { cost, turns, duration })` — sets final trace metadata
  - `flush()` — flushes pending events, with timeout
  - All methods are no-ops if Langfuse is not initialized (graceful degradation)

## 3. Instrument the message loop

- [x] 3.1 In `container/agent-runner/src/index.ts`, import langfuse module and initialize at startup
- [x] 3.2 In `runQuery()`, create a Langfuse trace at the start with name, sessionId, userId from ContainerInput
- [x] 3.3 In the message loop, instrument:
  - `system/init` → update trace metadata with model name
  - `assistant` with `tool_use` blocks → start a tool span per tool call (name + truncated input)
  - `tool_use_summary` → end the corresponding tool span
  - `result` → set trace result metadata (total_cost_usd, num_turns, duration_ms), end trace
- [x] 3.4 Call `flush()` before `runQuery()` returns (with a reasonable timeout like 5s)

## 4. ContainerInput: add userId

- [x] 4.1 Add `userId?: string` to `ContainerInput` interface in `container/agent-runner/src/index.ts`
- [x] 4.2 Add `userId?: string` to `ContainerInput` interface in `src/container-runner.ts`
- [x] 4.3 In `src/index.ts` `runAgent()`, pass `userId` derived from the last message's `sender_name` in the ContainerInput

## 5. Forward Langfuse env vars to containers

- [x] 5.1 In `src/container-runner.ts` `buildContainerArgs()`, forward `LANGFUSE_SECRET_KEY`, `LANGFUSE_PUBLIC_KEY`, and `LANGFUSE_BASEURL` if set in host env

## 6. Compose config

- [ ] 6.1 Add `LANGFUSE_SECRET_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_BASEURL` to `deploy/docker-compose.yml` app service environment (values from `.env`)
- [ ] 6.2 Add same vars to `deploy/docker-compose.dev.yml` app service environment (values from `.env.dev` or `.env`)
- [ ] 6.3 Document the new env vars in `deploy/.env.example`

## 7. Build and verify

- [x] 7.1 Run `npm run build` in project root to verify NanoClaw TypeScript compilation
- [x] 7.2 Run `cd container/agent-runner && npx tsc --noEmit` to verify agent-runner compilation
- [x] 7.3 Run `npm test` in project root — all tests must pass
