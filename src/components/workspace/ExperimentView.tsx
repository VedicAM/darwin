/**
 * Renders an experiment: the code the harness ran, its streams, and the files
 * it produced.
 *
 * The framing is deliberate (see the build spec's reproducibility and
 * "don't pretend to be a scientist" principles): this panel shows *computed
 * evidence* only — the exact program, its exit status and timing, and the raw
 * files. It draws no conclusions. The agent's interpretation lives in the
 * transcript on the left; keeping the two apart is the point, so a reader can
 * always trace a claimed result back to the code that produced it.
 */

import type { ExperimentArtifact, ProducedFile } from "@/lib/artifacts/types";
import { ArtifactHeader, FieldLabel, StatLine } from "./primitives";

function CodeBlock({ text }: { text: string }) {
  return (
    <pre className="bg-muted/60 max-h-72 overflow-auto rounded-md px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre">
      {text}
    </pre>
  );
}

function ProducedFileView({ file }: { file: ProducedFile }) {
  const meta = `${file.kind} · ${file.size.toLocaleString()} bytes`;
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate font-mono text-[11px]">{file.name}</span>
        <span className="text-muted-foreground shrink-0 text-[10px]">{meta}</span>
      </div>
      <div className="mt-1">
        {file.truncated ? (
          <p className="text-muted-foreground bg-muted rounded-md px-2.5 py-1.5 text-[11px]">
            Too large to inline — {file.size.toLocaleString()} bytes.
          </p>
        ) : file.kind === "image" && file.content ? (
          <img
            src={file.content}
            alt={file.name}
            className="max-h-96 max-w-full rounded-md border border-border bg-white"
          />
        ) : file.content ? (
          <CodeBlock text={file.content} />
        ) : (
          <p className="text-muted-foreground text-[11px]">No inline content.</p>
        )}
      </div>
    </div>
  );
}

function shortHash(hash?: string): string | undefined {
  return hash ? hash.slice(0, 12) : undefined;
}

export function ExperimentView({ artifact }: { artifact: ExperimentArtifact }) {
  const { code, stdout, stderr, exitCode, timedOut, elapsedMs, provider, files } = artifact;
  const { codeSha256, pythonVersion, depsHash } = artifact;

  const status = timedOut
    ? "killed on deadline"
    : exitCode === 0
      ? "exit 0"
      : `exit ${exitCode}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ArtifactHeader
        title={artifact.title}
        subtitle="Computed evidence — the code that ran and what it produced"
        actions={
          <span
            className={
              "rounded-full px-2 py-0.5 font-mono text-[10px] " +
              (timedOut || (exitCode !== null && exitCode !== 0)
                ? "bg-destructive/12 text-destructive"
                : "bg-muted text-muted-foreground")
            }
          >
            {status}
          </span>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mb-4">
          <StatLine
            stats={[
              { label: "status", value: status },
              { label: "elapsed", value: `${elapsedMs} ms` },
              { label: "files", value: String(files.length) },
              { label: "provider", value: provider },
            ]}
          />
        </div>

        <section className="mb-5">
          <FieldLabel className="mb-1.5">Code</FieldLabel>
          <CodeBlock text={code} />
        </section>

        {stdout.trim() ? (
          <section className="mb-5">
            <FieldLabel className="mb-1.5">stdout</FieldLabel>
            <CodeBlock text={stdout} />
          </section>
        ) : null}

        {stderr.trim() ? (
          <section className="mb-5">
            <FieldLabel className="mb-1.5">stderr</FieldLabel>
            <CodeBlock text={stderr} />
          </section>
        ) : null}

        <section>
          <FieldLabel className="mb-1.5">Produced files</FieldLabel>
          {files.length === 0 ? (
            <p className="text-muted-foreground text-[12px]">The experiment wrote no files.</p>
          ) : (
            <div className="flex flex-col gap-4">
              {files.map((file) => (
                <ProducedFileView key={file.name} file={file} />
              ))}
            </div>
          )}
        </section>

        <section className="mt-6 border-t border-border pt-3">
          <FieldLabel className="mb-1.5">Reproducibility</FieldLabel>
          <StatLine
            stats={[
              ...(codeSha256 ? [{ label: "code", value: shortHash(codeSha256)! }] : []),
              ...(pythonVersion ? [{ label: "python", value: pythonVersion }] : []),
              ...(depsHash
                ? [{ label: "deps", value: shortHash(depsHash)! }]
                : [{ label: "env", value: "bare interpreter (no pinned deps)" }]),
            ]}
          />
        </section>
      </div>
    </div>
  );
}
