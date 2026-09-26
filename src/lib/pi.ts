import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Thin client over the Rust <-> `pi --mode rpc` bridge.
 *
 * Commands go out via `invoke`; everything Pi streams back arrives as a
 * `pi://event` payload holding one raw JSONL record. We forward records
 * unfiltered so the UI can react to record types this spike does not yet know
 * about, rather than silently dropping them.
 */

/** One record as emitted by the Rust stdout reader. */
export type PiRecord = {
  type: string;
  [key: string]: unknown;
};

export type PiResponseData = {
  /** `"handled"` means Pi resolved the prompt without starting a run. */
  disposition?: string;
  [key: string]: unknown;
};

export function prompt(message: string): Promise<void> {
  return invoke<void>("pi_prompt", { message });
}

export function getState(): Promise<void> {
  return invoke<void>("pi_get_state");
}

export function stop(): Promise<void> {
  return invoke<void>("pi_stop");
}

function on<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (e) => handler(e.payload));
}

export const onRecord = (handler: (r: PiRecord) => void) => on<PiRecord>("pi://event", handler);
export const onStderr = (handler: (line: string) => void) => on<string>("pi://stderr", handler);
export const onExit = (handler: (reason: string) => void) => on<string>("pi://exit", handler);

export function isResponse(r: PiRecord): r is PiRecord & {
  type: "response";
  command: string;
  success: boolean;
  data?: PiResponseData;
  error?: string;
} {
  return r.type === "response" && typeof r.command === "string";
}

/** Returns the incremental assistant text for a `message_update`, else null. */
export function textDelta(r: PiRecord): string | null {
  if (r.type !== "message_update") return null;
  const inner = r.assistantMessageEvent as { type?: string; delta?: string } | undefined;
  if (inner?.type === "text_delta" && typeof inner.delta === "string") return inner.delta;
  return null;
}

/**
 * Terminal lifecycle signals. Pi 0.78.1 (verified locally) ends a run with
 * `agent_end` and never emits `agent_settled`; newer versions do. We accept
 * both so the UI settles on this install and stays correct after an upgrade.
 */
export const TERMINAL_EVENTS = ["agent_end", "agent_settled"] as const;

/** Events that mean Pi is actively working, even mid-run. */
export function isActive(r: PiRecord): boolean {
  if (r.type === "agent_start" || r.type === "turn_start") return true;
  return textDelta(r) !== null;
}

/**
 * Whether a record deserves a line in the activity log. Token-level
 * `message_update`s and full `message_start`/`message_end` bodies are dropped
 * (the latter carry whole transcripts and would flood the log); lifecycle and
 * tool records are kept, as is any record type we do not recognise.
 */
export function isLoggable(r: PiRecord): boolean {
  if (r.type === "message_update") {
    const inner = r.assistantMessageEvent as { type?: string } | undefined;
    if (!inner?.type) return false;
    return !inner.type.includes("delta");
  }
  if (r.type === "message_start" || r.type === "message_end") return false;
  if (r.type === "turn_start" || r.type === "turn_end") return false;
  return true;
}

/**
 * Best-effort one-line summary of a non-text record, for the activity log.
 * Shapes below are the ones observed on Pi 0.78.1; anything unrecognised falls
 * through to its type so new activity is visible instead of invisible.
 */
export function summarize(r: PiRecord): string {
  if (isResponse(r)) {
    return r.success
      ? `response: ${r.command} ok${r.data?.disposition ? ` (${r.data.disposition})` : ""}`
      : `response: ${r.command} failed — ${r.error ?? "unknown error"}`;
  }
  if (r.type === "message_update") {
    const inner = r.assistantMessageEvent as { type?: string } | undefined;
    return inner?.type ? `message_update: ${inner.type}` : "message_update";
  }
  if (r.type === "tool_execution_start") {
    const name = typeof r.toolName === "string" ? r.toolName : "tool";
    const args = r.args as Record<string, unknown> | undefined;
    const preview = args ? JSON.stringify(args).slice(0, 80) : "";
    return `→ ${name}${preview ? ` ${preview}` : ""}`;
  }
  if (r.type === "tool_execution_end") {
    const name = typeof r.toolName === "string" ? r.toolName : "tool";
    const result = r.result as { isError?: boolean } | undefined;
    return `← ${name} ${result?.isError ? "failed" : "ok"}`;
  }
  if (r.type === "agent_end") return "agent_end (settled)";
  if (r.type === "agent_settled") return "agent_settled (settled)";
  return r.type;
}
