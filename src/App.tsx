import { useCallback, useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { ArrowUp, Square } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  getState,
  isActive,
  isLoggable,
  isResponse,
  onExit,
  onRecord,
  onStderr,
  prompt,
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

// Deltas arrive one at a time, so the turn being streamed is the last one. If
// the last turn is not an agent turn, this delta starts a fresh one.
function appendDelta(turns: Turn[], delta: string): Turn[] {
  const last = turns[turns.length - 1];
  if (last?.role !== "agent") return [...turns, { role: "agent", text: delta }];
  return [...turns.slice(0, -1), { ...last, text: last.text + delta }];
}

function Thinking({ inline }: { inline: boolean }) {
  // Cycles thinking. / thinking.. / thinking... The interval only exists while
  // this is mounted, i.e. only while Pi is actually working.
  const [dots, setDots] = useState(1);
  useEffect(() => {
    const id = setInterval(() => setDots((d) => (d % 3) + 1), 420);
    return () => clearInterval(id);
  }, []);

  return (
    <span
      role="status"
      className={cn("text-muted-foreground inline whitespace-nowrap", inline && "ml-1")}
    >
      <span className="sr-only">Pi is working</span>
      <span aria-hidden>thinking{".".repeat(dots)}</span>
    </span>
  );
}

function App() {
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<Status>("connecting");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [stderr, setStderr] = useState<string[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const logId = useRef(0);

  const handleRecord = useCallback((r: PiRecord) => {
    const delta = textDelta(r);
    if (delta !== null) {
      setTurns((prev) => appendDelta(prev, delta));
      setStatus("running");
      return;
    }

    if (isResponse(r)) {
      if (r.command === "get_state" && r.success) {
        const m = r.data?.model as { id?: string; provider?: string } | undefined;
        if (m?.id) setModel(`${m.provider}/${m.id}`);
      }
      if (r.command === "prompt") {
        if (!r.success) setStatus("error");
        else if (r.data?.disposition === "handled") setStatus("settled");
        else setStatus("running");
      }
    }

    // Checked after the active test so a retry or compaction turn flips back to
    // running rather than leaving a stale "settled".
    if (isActive(r)) setStatus("running");
    else if ((TERMINAL_EVENTS as readonly string[]).includes(r.type)) setStatus("settled");

    if (isLoggable(r)) setLog((prev) => [...prev, `${logId.current++} ${summarize(r)}`]);
  }, []);

  const handleStderr = useCallback((line: string) => {
    setStderr((prev) => [...prev.slice(-19), line]);
  }, []);

  const handleExit = useCallback((reason: string) => {
    setStatus("error");
    setStderr((prev) => [...prev, `pi exited: ${reason}`]);
  }, []);

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
        setStderr((prev) => [...prev, `could not reach pi: ${String(err)}`]);
        setStatus("error");
      }
    })();

    return () => {
      disposed = true;
      offs.forEach((off) => off());
    };
  }, [handleRecord, handleStderr, handleExit]);

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
    setStatus("running");
    try {
      await prompt(text);
    } catch (err) {
      setStatus("error");
      setStderr((prev) => [...prev, String(err)]);
    }
  }

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col px-6 py-8">
          <div className="mt-auto">
            {turns.length === 0 ? (
              <p className="text-muted-foreground text-[15px]">
                {ready
                  ? "Ask Pi to read, explain, or search this repository."
                  : "Connecting to Pi…"}
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
                        "leading-relaxed whitespace-pre-wrap",
                        isUser
                          ? // A blue rule instead of a bubble. `self-start` keeps
                            // the rule only as tall as the prompt, so a one-line
                            // question does not get a full-height bar.
                            "text-foreground self-start border-l-2 border-l-blue-500/70 pl-3 text-[14px] dark:border-l-blue-400/70"
                          : "text-foreground text-[15px]",
                      )}
                    >
                      <span className="sr-only">{isUser ? "You said: " : "Pi said: "}</span>
                      {turn.text}
                      {thinking ? <Thinking inline={turn.text.length > 0} /> : null}
                    </div>
                  );
                })}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>
      </div>

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
                placeholder={busy ? "Pi is working…" : "Message Pi"}
                disabled={!ready}
                rows={1}
                className="focus-visible:border-ring min-h-5 flex-1 resize-none rounded-lg border-0 bg-transparent px-3 py-1 focus-visible:ring-0 dark:bg-transparent"
              />
              {/* Always mounted so the transition can run, and always occupying
                  its slot so the textarea never changes width. */}
              <Button
                type={busy ? "button" : "submit"}
                size="icon-sm"
                aria-label={busy ? "Stop Pi" : "Send"}
                tabIndex={action ? 0 : -1}
                onClick={
                  busy
                    ? () => {
                        setStatus("connecting");
                        void stop().catch((err) => setStderr((prev) => [...prev, String(err)]));
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
              {log.length || stderr.length ? (
                <span className="ml-auto shrink-0">
                  {log.length ? `${log.length} events` : ""}
                  {stderr.length ? `${log.length ? " · " : ""}${stderr.length} stderr` : ""}
                </span>
              ) : null}
            </summary>
            <div className="bg-popover text-popover-foreground absolute right-0 bottom-full z-10 mb-2 max-h-64 w-full overflow-y-auto rounded-lg border p-3 font-mono text-[11px] leading-relaxed">
              {log.map((line) => (
                <div key={line}>{line}</div>
              ))}
              {stderr.map((line, i) => (
                <div key={`e${i}`} className="text-destructive">
                  {line}
                </div>
              ))}
            </div>
          </details>
        </div>
      </div>
    </main>
  );
}

export default App;
