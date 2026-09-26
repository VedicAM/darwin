import { useCallback, useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { ArrowUp, Square, TriangleAlert, X } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/components/Markdown";
import { Workspace } from "@/components/workspace/Workspace";
import { useWorkspace } from "@/lib/workspace";
import { looksLikeFasta, sequencesFromText } from "@/lib/artifacts/from-sequence";
import type { RawRecord } from "@/lib/sequence";
import {
  getState,
  isActive,
  isLoggable,
  isResponse,
  onExit,
  onRecord,
  onStderr,
  prompt,
  runError,
  stop,
  summarize,
  textDelta,
  TERMINAL_EVENTS,
  type PiRecord,
} from "@/lib/pi";

type Status = "connecting" | "idle" | "running" | "settled" | "error";

const STATUS_LABEL: Record<Status, string> = {
  connecting: "connecting",
  idle: "idle",
  running: "running",
  settled: "settled",
  error: "error",
};

const DOT: Record<Status, string> = {
  connecting: "bg-muted-foreground/40",
  idle: "bg-muted-foreground/40",
  running: "bg-primary animate-pulse",
  settled: "bg-muted-foreground/40",
  error: "bg-destructive",
};

type Turn = { role: "user" | "agent"; text: string };

/** How many errors stay on screen. Older ones scroll off the top. */
const MAX_ERRORS = 4;

/**
 * Pi's `error` field is only typed as `string`, but a rejection may carry a
 * structured payload instead, so stringify anything unexpected rather than
 * rendering "[object Object]".
 */
function describeError(err: unknown): string {
  if (typeof err === "string") return err;
  if (err === undefined || err === null) return "unknown error";
  try {
    return JSON.stringify(err);
  } catch {
    // Circular or BigInt-laden payloads cannot be stringified. Note the binding
    // is required: a bare `catch` would leave `err` as the original value, and
    // `String()` on a plain object yields a useless "[object Object]".
    const tag = Object.prototype.toString.call(err).slice(8, -1);
    return `${tag} value could not be serialised`;
  }
}

// Deltas arrive one at a time, so the turn being streamed is the last one. If
// the last turn is not an agent turn, this delta starts a fresh one.
function appendDelta(turns: Turn[], delta: string): Turn[] {
  const last = turns[turns.length - 1];
  if (last?.role !== "agent") return [...turns, { role: "agent", text: delta }];
  return [...turns.slice(0, -1), { ...last, text: last.text + delta }];
}

function Thinking() {
  // No visible affordance on purpose: the pulsing status dot, the stop button's
  // shimmer and the composer placeholder already signal that Pi is working, so
  // the transcript stays quiet. This remains as an sr-only live region so
  // screen readers still hear the transition into and out of the busy state.
  return (
    <span role="status" className="sr-only">
      Darwin is working
    </span>
  );
}

function App() {
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<Status>("connecting");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const logId = useRef(0);
  // The scientific workspace is fed from the same records the transcript reads,
  // so there is exactly one event stream and no way for the two views to
  // disagree about what the agent did.
  const workspace = useWorkspace();
  // `workspace` is a fresh object every render; only `feed` is stable, and only
  // `feed` may be a listener dependency. Depending on the object would tear the
  // Pi listeners down and back up on every keystroke.
  const { feed: feedWorkspace, addArtifact } = workspace;
  // True while a file is dragged over the window, so the drop overlay shows.
  const [dragging, setDragging] = useState(false);

  // Every failure worth showing the user, newest last. Kept separate from the
  // activity log because a collapsed <details> is not somewhere an error can hide.
  const pushError = useCallback((msg: string) => {
    setErrors((prev) => [...prev.slice(-(MAX_ERRORS - 1)), msg]);
    setStatus("error");
  }, []);

  // --- FASTA drag-and-drop -------------------------------------------------
  // The webview receives real DOM drop events because the window sets
  // `dragDropEnabled: false` (otherwise Tauri swallows the drop and hands back
  // paths, not contents). A dropped FASTA is parsed client-side: it renders in
  // the workspace immediately, and its sequences are appended to the composer
  // so the next prompt ("fold this") reaches Pi with the sequence inline.

  /** Cap on how much sequence text is poured into the composer. A genomic FASTA
   *  is megabytes; a prompt is not, so the composer gets a bounded excerpt while
   *  the full parse still shows in the workspace. */
  const MAX_COMPOSER_CHARS = 6000;

  const toFasta = (records: RawRecord[]): string =>
    records
      .map((r) => `>${r.name}${r.description ? ` ${r.description}` : ""}\n${r.sequence}`)
      .join("\n");

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      const fastas = files.filter((f) => looksLikeFasta(f.name));
      if (fastas.length === 0) {
        pushError("Drop a FASTA file (.fasta, .fa, .fna, .aln).");
        return;
      }

      const snippets: string[] = [];
      for (const file of fastas) {
        let text: string;
        try {
          text = await file.text();
        } catch (err) {
          pushError(`could not read ${file.name}: ${describeError(err)}`);
          continue;
        }
        const parsed = sequencesFromText(file.name, text);
        if (!parsed) {
          pushError(`${file.name} did not contain readable sequences.`);
          continue;
        }
        addArtifact(parsed.artifact);
        snippets.push(toFasta(parsed.records));
      }

      if (snippets.length > 0) {
        const block = snippets.join("\n");
        const capped =
          block.length > MAX_COMPOSER_CHARS
            ? `${block.slice(0, MAX_COMPOSER_CHARS)}\n… [truncated; full sequences loaded in the workspace]`
            : block;
        setInput((prev) => (prev.trim() ? `${prev}\n\n${capped}` : capped));
      }
    },
    [pushError, addArtifact],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) {
      e.preventDefault();
      setDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear when the pointer actually leaves the window, not when it
    // crosses between child elements (which also fire dragleave).
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
  }, []);

  const handleRecord = useCallback(
    (r: PiRecord) => {
      const delta = textDelta(r);
      if (delta !== null) {
        setTurns((prev) => appendDelta(prev, delta));
        setStatus("running");
        feedWorkspace(r);
        return;
      }

      // A model-side failure (rate limit, bad key) arrives as a `message_end`
      // with stopReason "error" and no text_delta, so it must be checked before
      // anything else or the run just ends in silence.
      const failure = runError(r);
      if (failure !== null) pushError(failure);

      if (isResponse(r)) {
        if (r.command === "get_state" && r.success) {
          const m = r.data?.model as { id?: string; provider?: string } | undefined;
          if (m?.id) setModel(`${m.provider}/${m.id}`);
        }
        // A failed command carries the reason in `error`; it used to be dropped
        // on the floor here, leaving only a red status dot.
        if (!r.success) pushError(`pi ${r.command} failed: ${describeError(r.error)}`);
        if (r.command === "prompt") {
          if (r.success && r.data?.disposition === "handled") setStatus("settled");
          else if (r.success) setStatus("running");
        }
      }

      // Checked after the active test so a retry or compaction turn flips back to
      // running rather than leaving a stale "settled".
      if (isActive(r)) setStatus("running");
      else if ((TERMINAL_EVENTS as readonly string[]).includes(r.type)) setStatus("settled");

      if (isLoggable(r)) setLog((prev) => [...prev, `${logId.current++} ${summarize(r)}`]);
      feedWorkspace(r);
    },
    [pushError, feedWorkspace],
  );

  const handleStderr = useCallback(
    (line: string) => {
      // Pi writes diagnostics to stderr; per AGENTS.md stdout is protocol only,
      // so anything arriving here is a diagnostic, not a record.
      pushError(line);
    },
    [pushError],
  );

  const handleExit = useCallback(
    (reason: string) => {
      pushError(`pi exited: ${reason}`);
    },
    [pushError],
  );

  useEffect(() => {
    let disposed = false;
    const offs: UnlistenFn[] = [];

    void (async () => {
      // Listeners MUST be attached before any prompt is sent: Pi can finish a
      // fast reply before `invoke` even returns, so a late listener misses it.
      offs.push(await onRecord(handleRecord));
      offs.push(await onStderr(handleStderr));
      offs.push(await onExit(handleExit));
      if (disposed) return;
      setReady(true);
      setStatus("idle");
      try {
        await getState();
      } catch (err) {
        pushError(`could not reach pi: ${describeError(err)}`);
      }
    })();

    return () => {
      disposed = true;
      offs.forEach((off) => off());
    };
  }, [handleRecord, handleStderr, handleExit, pushError]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [turns, log.length]);

  const busy = status === "running";
  const canSend = ready && !busy && input.trim().length > 0;
  const action = busy || canSend;

  async function send() {
    const text = input.trim();
    if (!text || !canSend) return;
    setInput("");
    // The empty agent turn is pushed up front so the thinking indicator can
    // render under the prompt before the first token arrives.
    setTurns((prev) => [...prev, { role: "user", text }, { role: "agent", text: "" }]);
    setLog([]);
    // A fresh run should not inherit the previous run's errors.
    setErrors([]);
    setStatus("running");
    // One run, one workspace: artifacts from the last analysis are dropped so
    // the panel describes the run in front of the user, not a pile of every run
    // so far.
    workspace.startRun(text);
    try {
      await prompt(text);
    } catch (err) {
      pushError(describeError(err));
    }
  }

  return (
    // Two panes split by a 1px rule: Pi on the left, the scientific workspace on
    // the right. min-w-0 on each pane lets it shrink so the rule stays put
    // instead of being shoved off-screen by wide content.
    <main
      className="relative flex h-screen overflow-hidden bg-background text-foreground"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drop overlay: shown only while a file is dragged over the window. It is
          pointer-events-none so it never intercepts the drop it is describing. */}
      {dragging ? (
        <div className="bg-background/85 border-primary/60 pointer-events-none absolute inset-3 z-50 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed backdrop-blur-sm">
          <p className="text-foreground text-sm font-medium">Drop FASTA to load</p>
          <p className="text-muted-foreground text-xs">.fasta · .fa · .fna · .aln</p>
        </div>
      ) : null}
      {/* titleBarStyle Overlay floats the traffic lights over the webview, so
          the top strip is a drag handle and the panes pad below it. pt-12 keeps
          the first line clear of the lights, which sit roughly 12px from the
          top-left corner. This strip lives on <main> rather than in a pane so
          it spans both of them, and z-10 is load-bearing: the panes are
          positioned flex siblings, so an earlier absolute sibling would
          otherwise paint underneath the left pane and swallow the drag. */}
      <div
        data-tauri-drag-region
        className="absolute inset-x-0 top-0 z-10 h-9"
      />
      <section
        aria-label="Pi conversation"
        className="flex min-w-0 flex-1 flex-col"
      >
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col px-6 pt-12 pb-8">
            <div className="mt-auto">
              {turns.length === 0 ? (
                <p className="text-muted-foreground text-[15px]">
                  {ready
                    ? "Ask Darwin to analyze your sequence."
                    : "Connecting to Darwin..."}
                </p>
              ) : (
                <div className="flex flex-col gap-5">
                  {turns.map((turn, i) => {
                    const isUser = turn.role === "user";
                    const thinking = !isUser && busy && i === turns.length - 1;
                    // A turn is pushed empty on send; drop it if it never produced
                    // any text and the run is over, so a failed prompt leaves no gap.
                    if (!isUser && !turn.text && !thinking) return null;
                    return (
                      <div
                        key={i}
                        className={cn(
                          "leading-relaxed",
                          isUser
                            ? // A blue rule instead of a bubble. `self-start` keeps
                              // the rule only as tall as the prompt, so a one-line
                              // question does not get a full-height bar. User text
                              // stays literal (whitespace preserved, not parsed).
                              "text-foreground self-start border-l-2 border-l-blue-500/70 pl-3 text-[14px] whitespace-pre-wrap dark:border-l-blue-400/70"
                            : "text-foreground text-[15px]",
                        )}
                      >
                        <span className="sr-only">{isUser ? "You said: " : "Darwin said: "}</span>
                        {/* Agent output is markdown; the user's own prompt is not
                            parsed, so a question containing `*` or `#` renders as
                            typed. */}
                        {isUser ? (
                          turn.text
                        ) : (
                          <Markdown text={turn.text} className="flex flex-col gap-3" />
                        )}
                        {thinking ? <Thinking /> : null}
                      </div>
                    );
                  })}
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          </div>
        </div>

        {errors.length > 0 ? (
          <div className="shrink-0">
            <div className="mx-auto w-full max-w-2xl px-6 pt-3">
              <div
                role="alert"
                aria-live="assertive"
                className="border-destructive/40 bg-destructive/8 text-destructive flex items-start gap-2 rounded-lg border px-3 py-2"
              >
                <TriangleAlert aria-hidden className="mt-px size-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  {errors.map((line, i) => (
                    <p
                      key={i}
                      className="font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap"
                    >
                      {line}
                    </p>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setErrors([])}
                  aria-label="Dismiss errors"
                  className="hover:bg-destructive/15 -mt-0.5 -mr-1 shrink-0 rounded-sm p-1 transition-colors"
                >
                  <X aria-hidden className="size-3.5" />
                </button>
              </div>
            </div>
          </div>
        ) : null}

        <div className="shrink-0">
          <div className="mx-auto w-full max-w-2xl px-6 pt-2 pb-4">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              {/* No horizontal padding here on purpose: it lives on the Textarea
                  below so that one is full-bleed and its selection highlight
                  shares this box's corner radius, rather than being a hard
                  rectangle that collides with the curve. The button supplies its
                  own right inset. Textarea padding must also exceed the radius
                  (--radius, 10px) or the curve clips the first glyph. */}
              <div className="focus-within:border-ring focus-within:ring-ring/50 flex items-center gap-2 rounded-lg border border-input py-1.5 transition-colors focus-within:ring-3">
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  placeholder={
                    busy ? "Darwin is working..." : "Visualize this protein sequence for me"
                  }
                  disabled={!ready}
                  rows={1}
                  className="focus-visible:border-ring min-h-5 flex-1 resize-none rounded-lg border-0 bg-transparent px-3 py-1 focus-visible:ring-0 dark:bg-transparent"
                />
                {/* Always mounted so the transition can run, and always occupying
                    its slot so the textarea never changes width. */}
                <Button
                  type={busy ? "button" : "submit"}
                  size="icon-sm"
                  aria-label={busy ? "Stop Darwin" : "Send"}
                  tabIndex={action ? 0 : -1}
                  onClick={
                    busy
                      ? () => {
                          setStatus("connecting");
                          void stop().catch((err) => pushError(describeError(err)));
                        }
                      : undefined
                  }
                  className={cn(
                    // `scale` is a standalone CSS property in Tailwind v4, not
                    // `transform`, so it must be listed here or the size snaps
                    // while only the opacity fades.
                    "relative mr-3 shrink-0 overflow-hidden rounded-lg duration-200 ease-out transition-[opacity,scale]",
                    action ? "scale-100 opacity-100" : "pointer-events-none scale-75 opacity-0",
                  )}
                >
                  {/* Idle animation while waiting on the model. */}
                  {busy ? (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-0 overflow-hidden rounded-lg"
                    >
                      <span className="from-transparent via-primary/25 animate-wait absolute inset-y-0 -left-1/2 w-1/2 bg-linear-to-r to-transparent" />
                    </span>
                  ) : null}
                  <span className="relative">
                    <span
                      key={busy ? "stop" : "send"}
                      className="starting:scale-75 starting:opacity-0 duration-200 transition-[opacity,scale]"
                    >
                      {busy ? <Square className="fill-current" /> : <ArrowUp />}
                    </span>
                  </span>
                </Button>
              </div>
            </form>

            <details className="group relative mt-3">
              <summary className="text-muted-foreground flex cursor-pointer list-none items-center gap-2 text-xs select-none [&::-webkit-details-marker]:hidden">
                <span className={`size-1.5 rounded-full ${DOT[status]}`} />
                <span>{STATUS_LABEL[status]}</span>
                {model ? <span className="truncate">{model}</span> : null}
                {log.length || errors.length ? (
                  <span className="ml-auto shrink-0">
                    {log.length ? `${log.length} events` : ""}
                    {errors.length ? `${log.length ? " · " : ""}${errors.length} errors` : ""}
                  </span>
                ) : null}
              </summary>
              <div className="bg-popover text-popover-foreground absolute right-0 bottom-full z-10 mb-2 max-h-64 w-full overflow-y-auto rounded-lg border p-3 font-mono text-[11px] leading-relaxed">
                {log.map((line) => (
                  <div key={line}>{line}</div>
                ))}
              </div>
            </details>
          </div>
        </div>
      </section>

      {/* Decorative divider; --border is the theme subtle grey. */}
      <div aria-hidden="true" className="bg-border w-px shrink-0" />

      <Workspace
        artifacts={workspace.items}
        selected={workspace.selected}
        workflow={workspace.workflow}
        hasRun={workspace.state.run > 0}
        onSelect={workspace.select}
        onAdd={workspace.addArtifact}
      />
    </main>
  );
}

export default App;
