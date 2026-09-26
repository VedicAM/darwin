/**
 * Workspace state: what the agent is doing, and what it produced.
 *
 * Fed from the existing `pi://event` stream — there is no second channel and the
 * Pi protocol is untouched. `tool_execution_start` / `tool_execution_end` are
 * the load-bearing pair: the start opens a workflow step, the end closes it and
 * projects its result into artifacts (`artifacts/project.ts`).
 *
 * Two deliberate choices:
 *
 *  - **Steps are observed, not predicted.** A step exists because a tool was
 *    called and returned, so `completed` always means something really ran. The
 *    cost is that `pending` only appears when a producer declares steps ahead of
 *    time, which no tool does yet; inventing a plan the agent never stated
 *    would be worse than showing the truth.
 *  - **The workflow artifact is derived, not stored.** It is rebuilt from
 *    `steps`/`status` on every render, so it cannot drift out of sync with the
 *    list it is a view of.
 */

import { useCallback, useMemo, useReducer } from "react";
import { isResponse, runError, TERMINAL_EVENTS, type PiRecord } from "@/lib/pi";
import { projectArtifacts } from "@/lib/artifacts/project";
import type {
  Artifact,
  RunStatus,
  WorkflowArtifact,
  WorkflowStep,
} from "@/lib/artifacts/types";

/** Artifacts retained per run. Bounds memory and keeps the tab strip usable. */
const MAX_ARTIFACTS = 48;

export interface WorkspaceState {
  /** Incremented per run; the workflow artifact's id is derived from it. */
  run: number;
  goal?: string;
  status: RunStatus;
  steps: WorkflowStep[];
  /** Oldest first. Never contains the workflow, which is derived. */
  artifacts: Artifact[];
  selectedId: string | null;
  /** True once the user has chosen an artifact. Until then the panel follows
   *  the newest one, which is what you want while a run is streaming. */
  pinned: boolean;
}

export type WorkspaceAction =
  | { kind: "reset"; goal: string }
  | { kind: "agent_start" }
  | { kind: "tool_start"; callId: string; toolName: string; args: Record<string, unknown> }
  | { kind: "tool_progress"; callId: string; text: string }
  | {
      kind: "tool_end";
      callId: string;
      toolName?: string;
      args?: Record<string, unknown>;
      result?: unknown;
      isError: boolean;
      error?: string;
      now: number;
    }
  | { kind: "agent_end" }
  | { kind: "fail"; message: string }
  | { kind: "add"; artifacts: Artifact[] }
  | { kind: "select"; id: string };

export function initialWorkspaceState(): WorkspaceState {
  return {
    run: 0,
    status: "idle",
    steps: [],
    artifacts: [],
    selectedId: workflowId(0),
    pinned: false,
  };
}

function workflowId(run: number): string {
  return `workflow:${run}`;
}

export function workflowArtifact(state: WorkspaceState): WorkflowArtifact {
  return {
    id: workflowId(state.run),
    type: "workflow",
    title: state.goal ?? "Analysis",
    createdAt: 0,
    status: state.status,
    goal: state.goal,
    steps: state.steps,
  };
}

// --- labels -----------------------------------------------------------------

/** Verbs, so the list reads as a sequence of actions rather than a directory
 *  listing. Anything unrecognised is title-cased, which is usually right. */
const TOOL_LABELS: Record<string, string> = {
  read: "Read file",
  ls: "List directory",
  grep: "Search file contents",
  find: "Find files",
  literature_search: "Search literature",
};

function labelFor(toolName: string): string {
  const known = TOOL_LABELS[toolName];
  if (known) return known;
  return toolName
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function firstLine(text: string, max: number): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  return line ? (line.length <= max ? line : `${line.slice(0, max - 1)}…`) : "";
}

/** One line describing what a call was asked to do. */
function detailFor(args: Record<string, unknown>): string | undefined {
  for (const key of ["path", "file_path", "filepath", "file"]) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) {
      return value.length <= 120 ? value : `…${value.slice(-119)}`;
    }
  }
  for (const key of ["command", "query", "pattern", "url", "prompt"]) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return firstLine(value, 120);
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "object") continue;
    parts.push(`${key}=${String(value)}`);
    if (parts.length >= 3) break;
  }
  return parts.length > 0 ? firstLine(parts.join(" "), 120) : undefined;
}

/** Arguments are kept for artifact titles and for the workflow's detail line.
 *  Only primitives survive: a tool's arguments are already held by Pi, and
 *  holding a deep copy here would keep megabytes alive for the whole run. */
function sanitizeArgs(args: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!args) return out;
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") out[key] = value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
  }
  return out;
}

function asArgs(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// --- reducer ----------------------------------------------------------------

function stepIndex(steps: WorkflowStep[], callId: string): number {
  return steps.findIndex((step) => step.id === `step:${callId}`);
}

function trimArtifacts(artifacts: Artifact[], selectedId: string | null): {
  artifacts: Artifact[];
  selectedId: string | null;
} {
  if (artifacts.length <= MAX_ARTIFACTS) return { artifacts, selectedId };
  const keep = artifacts.slice(artifacts.length - MAX_ARTIFACTS);
  return {
    artifacts: keep,
    // Never leave the selection pointing at something that is gone.
    selectedId: selectedId && keep.some((a) => a.id === selectedId) ? selectedId : null,
  };
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.kind) {
    case "reset": {
      const run = state.run + 1;
      return {
        run,
        goal: action.goal,
        status: "running",
        steps: [],
        artifacts: [],
        selectedId: workflowId(run),
        pinned: false,
      };
    }

    case "agent_start": {
      if (state.status === "running" && state.steps.length > 0) return state;
      return { ...state, status: "running" };
    }

    case "tool_start": {
      const id = `step:${action.callId}`;
      if (state.steps.some((step) => step.id === id)) return state;
      const step: WorkflowStep = {
        id,
        label: labelFor(action.toolName),
        detail: detailFor(action.args),
        status: "running",
        toolName: action.toolName,
        startedAt: Date.now(),
        args: sanitizeArgs(action.args),
        artifacts: [],
      };
      return { ...state, status: "running", steps: [...state.steps, step] };
    }

    case "tool_progress": {
      const index = stepIndex(state.steps, action.callId);
      if (index < 0) return state;
      const text = firstLine(action.text, 160);
      if (text.length === 0) return state;
      const steps = [...state.steps];
      steps[index] = { ...steps[index], progress: text };
      return { ...state, steps };
    }

    case "tool_end": {
      const id = `step:${action.callId}`;
      const index = stepIndex(state.steps, action.callId);
      const steps = [...state.steps];
      let step: WorkflowStep;
      if (index >= 0) {
        step = { ...steps[index] };
        steps[index] = step;
      } else {
        // The panel can mount mid-run, so a start may never have been seen.
        // Showing a completed step beats hiding the result.
        step = {
          id,
          label: labelFor(action.toolName ?? "tool"),
          status: action.isError ? "failed" : "completed",
          toolName: action.toolName ?? "tool",
          startedAt: action.now,
          args: sanitizeArgs(action.args),
          artifacts: [],
        };
        steps.push(step);
      }
      if (step.status === "running") {
        step.status = action.isError ? "failed" : "completed";
        step.endedAt = action.now;
        step.progress = undefined;
        if (action.error) step.error = action.error;
      }

      const produced = action.isError
        ? []
        : projectArtifacts({
            callId: action.callId,
            toolName: step.toolName,
            args: step.args,
            result: action.result,
            isError: action.isError,
            now: action.now,
          });
      if (produced.length === 0) return { ...state, steps };

      step.artifacts = produced.map((artifact) => artifact.id);
      const merged = [...state.artifacts];
      for (const artifact of produced) {
        const existing = merged.findIndex((a) => a.id === artifact.id);
        if (existing >= 0) merged[existing] = artifact;
        else merged.push(artifact);
      }
      const trimmed = trimArtifacts(merged, state.selectedId);
      return {
        ...state,
        steps,
        artifacts: trimmed.artifacts,
        selectedId: state.pinned ? trimmed.selectedId : null,
      };
    }

    case "agent_end": {
      const steps = state.steps.map((step) =>
        step.status === "running"
          ? { ...step, status: "failed" as const, error: step.error ?? "interrupted" }
          : step,
      );
      const failed = steps.some((step) => step.status === "failed");
      return { ...state, steps, status: failed ? "error" : "settled" };
    }

    case "fail": {
      const steps = state.steps.map((step) =>
        step.status === "running"
          ? { ...step, status: "failed" as const, error: action.message }
          : step,
      );
      return { ...state, steps, status: "error" };
    }

    case "add": {
      // Artifacts produced outside the Pi event stream — by a panel action, or
      // later by a tool the user picks by hand — join the same store and the
      // same selection rules as projected ones.
      if (action.artifacts.length === 0) return state;
      const merged = [...state.artifacts];
      for (const artifact of action.artifacts) {
        const existing = merged.findIndex((a) => a.id === artifact.id);
        if (existing >= 0) merged[existing] = artifact;
        else merged.push(artifact);
      }
      const trimmed = trimArtifacts(merged, state.selectedId);
      return {
        ...state,
        artifacts: trimmed.artifacts,
        selectedId: state.pinned ? trimmed.selectedId : null,
      };
    }

    case "select":
      return { ...state, selectedId: action.id, pinned: true };
  }
}

// --- record bridge ----------------------------------------------------------

/** Records the workspace cares about. Everything else — token deltas, whole
 *  transcripts — is dropped here, before it reaches the reducer, because those
 *  arrive thousands of times per run and the panel only redraws on structure. */
export function workspaceAction(record: PiRecord): WorkspaceAction | null {
  if (record.type === "agent_start") return { kind: "agent_start" };
  if ((TERMINAL_EVENTS as readonly string[]).includes(record.type)) return { kind: "agent_end" };

  if (record.type === "tool_execution_start") {
    const callId = typeof record.toolCallId === "string" ? record.toolCallId : null;
    if (!callId) return null;
    return {
      kind: "tool_start",
      callId,
      toolName: typeof record.toolName === "string" ? record.toolName : "tool",
      args: asArgs(record.args),
    };
  }

  if (record.type === "tool_execution_update") {
    const callId = typeof record.toolCallId === "string" ? record.toolCallId : null;
    if (!callId) return null;
    return { kind: "tool_progress", callId, text: progressText(record.partialResult) };
  }

  if (record.type === "tool_execution_end") {
    const callId = typeof record.toolCallId === "string" ? record.toolCallId : null;
    if (!callId) return null;
    const result = record.result;
    const isError = record.isError === true;
    return {
      kind: "tool_end",
      callId,
      toolName: typeof record.toolName === "string" ? record.toolName : undefined,
      result: isRecordValue(result) ? result : undefined,
      isError,
      error: isError ? toolErrorText(result) : undefined,
      now: Date.now(),
    };
  }

  if (record.type === "extension_error") {
    const message = record.error ?? record.message;
    return {
      kind: "fail",
      message: typeof message === "string" ? message : "a Pi extension threw an error",
    };
  }

  // Model-side and RPC failures both belong here: the run ended and produced
  // nothing, and the panel should not sit on a spinner forever.
  const failure = runError(record);
  if (failure) return { kind: "fail", message: failure };
  if (isResponse(record) && !record.success) {
    return { kind: "fail", message: `pi ${record.command} failed: ${record.error ?? "unknown error"}` };
  }
  return null;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolErrorText(result: unknown): string | undefined {
  if (!isRecordValue(result)) return undefined;
  for (const key of ["error", "message"]) {
    const value = result[key];
    if (typeof value === "string" && value.length > 0) return firstLine(value, 200);
  }
  const content = result.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (isRecordValue(block) && typeof block.text === "string" && block.text.trim().length > 0) {
        return firstLine(block.text, 200);
      }
    }
  }
  return undefined;
}

/** Last line of a tool's streamed output, for the running step. */
function progressText(partial: unknown): string {
  if (!isRecordValue(partial)) return "";
  const content = partial.content;
  if (!Array.isArray(content)) return "";
  const text = content
    .filter(isRecordValue)
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("\n");
  return text;
}

// --- hook -------------------------------------------------------------------

export interface Workspace {
  state: WorkspaceState;
  workflow: WorkflowArtifact;
  /** The workflow first, then artifacts oldest to newest. */
  items: Artifact[];
  selected: Artifact | null;
  running: WorkflowStep | null;
  failed: number;
  select: (id: string) => void;
  addArtifact: (artifact: Artifact) => void;
  startRun: (goal: string) => void;
  feed: (record: PiRecord) => void;
}

export function useWorkspace(): Workspace {
  const [state, dispatch] = useReducer(workspaceReducer, undefined, initialWorkspaceState);

  const workflow = useMemo(() => workflowArtifact(state), [state]);
  const items = useMemo(() => [workflow, ...state.artifacts], [workflow, state.artifacts]);

  // Follow the newest artifact until the user picks one. Computed rather than
  // stored in an effect: the same answer comes out of every render, so the tab
  // strip and the body can never disagree about what is selected.
  const selected = useMemo(() => {
    if (state.pinned && state.selectedId) {
      const pinned = items.find((item) => item.id === state.selectedId);
      if (pinned) return pinned;
    }
    return items[items.length - 1] ?? workflow;
  }, [items, state.pinned, state.selectedId, workflow]);

  const running = useMemo(
    () => [...state.steps].reverse().find((step) => step.status === "running") ?? null,
    [state.steps],
  );

  const failed = useMemo(
    () => state.steps.filter((step) => step.status === "failed").length,
    [state.steps],
  );

  const select = useCallback((id: string) => {
    dispatch({ kind: "select", id });
  }, []);

  return {
    state,
    workflow,
    items,
    selected,
    running,
    failed,
    select,
    addArtifact: useCallback((artifact: Artifact) => {
      dispatch({ kind: "add", artifacts: [artifact] });
    }, []),
    startRun: useCallback((goal: string) => dispatch({ kind: "reset", goal }), []),
    feed: useCallback((record: PiRecord) => {
      const action = workspaceAction(record);
      if (action) dispatch(action);
    }, []),
  };
}
