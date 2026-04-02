/**
 * Langfuse tracing wrapper for NanoClaw agent-runner.
 * Gracefully degrades to no-ops when LANGFUSE_SECRET_KEY is not set.
 */

import Langfuse, { type LangfuseTraceClient, type LangfuseSpanClient } from 'langfuse';

let langfuse: Langfuse | null = null;

/**
 * Initialize Langfuse client from env vars.
 * Returns true if initialized, false if env vars are missing.
 * The Langfuse constructor reads LANGFUSE_SECRET_KEY, LANGFUSE_PUBLIC_KEY,
 * and LANGFUSE_BASEURL automatically from env.
 */
export function initLangfuse(): boolean {
  if (!process.env.LANGFUSE_SECRET_KEY) {
    return false;
  }
  try {
    langfuse = new Langfuse();
    return true;
  } catch {
    langfuse = null;
    return false;
  }
}

/**
 * Create a new trace. Returns null if Langfuse is not initialized.
 */
export function createTrace(opts: {
  name: string;
  sessionId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}): LangfuseTraceClient | null {
  if (!langfuse) return null;
  try {
    return langfuse.trace({
      name: opts.name,
      sessionId: opts.sessionId ?? undefined,
      userId: opts.userId ?? undefined,
      metadata: opts.metadata,
    });
  } catch {
    return null;
  }
}

/**
 * Start a span on a trace (e.g. for a tool call).
 */
export function startToolSpan(
  trace: LangfuseTraceClient | null,
  name: string,
  input?: string,
): LangfuseSpanClient | null {
  if (!trace) return null;
  try {
    return trace.span({
      name,
      input: input ?? undefined,
    });
  } catch {
    return null;
  }
}

/**
 * End a tool span with output.
 */
export function endToolSpan(
  span: LangfuseSpanClient | null,
  output?: string,
): void {
  if (!span) return;
  try {
    span.end({ output: output ?? undefined });
  } catch {
    // no-op
  }
}

/**
 * Update trace with final result metadata.
 */
export function setTraceResult(
  trace: LangfuseTraceClient | null,
  opts: {
    cost?: number;
    turns?: number;
    duration?: number;
    model?: string;
  },
): void {
  if (!trace) return;
  try {
    trace.update({
      metadata: {
        total_cost_usd: opts.cost,
        num_turns: opts.turns,
        duration_ms: opts.duration,
        model: opts.model,
      },
    });
  } catch {
    // no-op
  }
}

/**
 * Flush pending events with a timeout.
 */
export async function flush(timeoutMs = 5000): Promise<void> {
  if (!langfuse) return;
  try {
    await Promise.race([
      langfuse.flushAsync(),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch {
    // no-op — never block the agent on tracing failures
  }
}
