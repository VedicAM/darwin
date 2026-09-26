/**
 * Experiment execution tool for Pi.
 *
 * Exposes the harness's `experiment.run` capability to the agent as a single
 * `run_experiment` tool. The agent writes Python; the *harness* runs it. Pi
 * still has no `bash`, `write` or `edit` — this does not widen Pi's own tools,
 * it delegates execution to Rust over the bridge socket (`shared/harness.ts`),
 * where the code runs in a constructed environment under a wall-clock deadline
 * and only files it produced come back. See `src-tauri/src/experiment.rs`.
 *
 * This is the missing spine of the research loop: literature and tool discovery
 * feed into code, code executes here, and the produced files become workspace
 * artifacts. The agent is expected to separate what it *computed* from how it
 * *interprets* it — the tool returns raw outputs and never a conclusion.
 *
 * The formatting logic has no Pi imports so it is unit-testable with
 * `node --test`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { callHarness, HarnessError } from "./shared/harness";

interface ProducedFile {
	name: string;
	kind: "data" | "table" | "sequence" | "image" | "text";
	size: number;
	content?: string;
	truncated?: boolean;
}

interface ExperimentResult {
	code: string;
	stdout: string;
	stderr: string;
	exit_code?: number;
	timed_out: boolean;
	produced_files: ProducedFile[];
	provider: string;
	elapsed_ms: number;
}

/** Longest stream excerpt shown to the model; the full text is in `details`. */
const EXCERPT = 4000;

function excerpt(text: string): string {
	const t = text.trimEnd();
	return t.length > EXCERPT ? t.slice(0, EXCERPT) + "\n… [truncated; full output in workspace]" : t;
}

/**
 * A text summary for the model. The exhaustive result — including inlined file
 * contents and images — travels in `details` for the workspace, so the model's
 * view stays small.
 */
export function formatResult(r: ExperimentResult): string {
	const lines: string[] = [];
	if (r.timed_out) {
		lines.push(`Experiment KILLED on its deadline after ${r.elapsed_ms}ms. No exit code.`);
	} else {
		lines.push(`Experiment exited ${r.exit_code} in ${r.elapsed_ms}ms (${r.provider}).`);
	}
	if (r.stdout.trim()) lines.push("", "stdout:", excerpt(r.stdout));
	if (r.stderr.trim()) lines.push("", "stderr:", excerpt(r.stderr));
	if (r.produced_files.length) {
		lines.push("", "Produced files:");
		for (const f of r.produced_files) {
			const note = f.truncated ? " (too large to inline)" : "";
			lines.push(`  - ${f.name} [${f.kind}, ${f.size} bytes]${note}`);
			// Inline small non-image files so the agent can reason over the
			// numbers it just computed without a second round-trip.
			if (f.kind !== "image" && f.content && f.content.length <= EXCERPT) {
				lines.push(f.content.split("\n").map((l) => `      ${l}`).join("\n"));
			}
		}
	}
	if (!r.stdout.trim() && !r.stderr.trim() && !r.produced_files.length) {
		lines.push("", "The experiment produced no output and wrote no files.");
	}
	lines.push(
		"",
		"Report what you COMPUTED separately from how you INTERPRET it, and state the " +
			"dataset's limitations. Do not present interpretation as measurement.",
	);
	return lines.join("\n");
}

export default function experimentRun(pi: ExtensionAPI) {
	pi.registerTool({
		name: "run_experiment",
		label: "Run Experiment",
		description: [
			"Execute a Python analysis in the harness sandbox and return its stdout, stderr,",
			"exit code and any files it wrote. Use this to actually run computational biology",
			"analyses — parse sequences, compute conservation, summarise alignments, make plots.",
			"The code runs in a fresh working directory under a wall-clock deadline; write",
			"results to files (result.json, scores.csv, plot.png) and they come back as",
			"workspace artifacts. Read staged inputs from the working directory by name.",
			"numpy, Biopython (import Bio), matplotlib, pandas and pyfamsa come preinstalled once",
			"experiment-env exists (install_tool('experiment-env') if imports fail). For ANY",
			"other library you need, install it yourself with pip_install([...]) from PyPI, then",
			"re-run — do not give up, ask the user, or shell out to binaries. For multiple",
			"sequence alignment use pyfamsa (`from pyfamsa import Aligner, Sequence`); there is NO",
			"mafft/clustalo/muscle binary on PATH and Biopython only does pairwise alignment.",
			"Write results (alignments to .fasta/.aln) to files so they show in the workspace.",
			"This runs code — it does not draw conclusions. Report",
			"what you computed apart from how you interpret it, and name the limitations.",
		].join(" "),
		promptSnippet: "run_experiment: execute a Python analysis and capture its output and files",
		parameters: Type.Object({
			code: Type.String({
				description: "The Python program to run. Reads inputs from and writes results to the working directory.",
			}),
			inputs: Type.Optional(
				Type.Array(
					Type.Object({
						name: Type.String({ description: "A bare filename (no path), staged into the working directory." }),
						contents: Type.String({ description: "UTF-8 file contents." }),
					}),
					{ description: "Files to stage before the run, e.g. FASTA sequences." },
				),
			),
			timeout_s: Type.Optional(
				Type.Integer({
					description: "Wall-clock budget in seconds, 1-300. Defaults to 60.",
					minimum: 1,
					maximum: 300,
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			try {
				const result = (await callHarness(
					{
						capability: "experiment.run",
						code: params.code,
						inputs: params.inputs ?? [],
						timeout_s: params.timeout_s,
					},
					{ signal },
				)) as ExperimentResult;

				return {
					content: [{ type: "text", text: formatResult(result) }],
					// `details` is what the workspace renders; the model sees only `content`.
					details: result,
				};
			} catch (err) {
				// Thrown so the agent can distinguish a refused/failed run from a
				// run that legitimately produced nothing.
				throw err instanceof HarnessError
					? err
					: new HarnessError(err instanceof Error ? err.message : String(err));
			}
		},
	});
}
