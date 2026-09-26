/**
 * RNA folding tool for Pi.
 *
 * Exposes the harness's `fold.mfe` / `fold.ensemble` capabilities to the agent
 * as a single `fold_rna` tool. Pi does not fold — the *harness* does, in a
 * hash-pinned managed venv (currently LinearFold). This tool sends a capability
 * request over the bridge socket (`shared/harness.ts`) and returns the
 * structure and free energy, so the agent can answer "fold this sequence"
 * directly instead of describing the payload it would need to send.
 *
 * If no tool is installed for the capability, the harness says so explicitly
 * ("no installed tool provides `fold.mfe`; run the installer first"). That is
 * surfaced as a thrown error rather than an empty result, and the agent is told
 * — in this tool's description — to fall back to `github_search` /
 * `literature_search` to find an implementation when that happens, rather than
 * inventing a structure.
 *
 * Formatting logic has no Pi imports so it is unit-testable with `node --test`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { callHarness, HarnessError } from "./shared/harness";

interface BasePair {
	i: number;
	j: number;
	probability: number;
}

interface FoldResult {
	sequence: string;
	structure: string;
	mfe: number;
	ensemble_free_energy?: number;
	base_pairs?: BasePair[];
	provider: string;
	elapsed_ms: number;
}

/** A text summary for the model. The full result travels in `details` so the
 *  workspace renders the structure diagram. */
export function formatFold(r: FoldResult): string {
	const lines = [
		`Folded ${r.sequence.length} nt with ${r.provider} in ${r.elapsed_ms}ms.`,
		"",
		`sequence:  ${r.sequence}`,
		`structure: ${r.structure}`,
		`MFE:       ${r.mfe} kcal/mol`,
	];
	if (r.ensemble_free_energy !== undefined) {
		lines.push(`ensemble free energy: ${r.ensemble_free_energy} kcal/mol`);
	}
	if (r.base_pairs?.length) {
		lines.push("", `${r.base_pairs.length} base pairs above the probability cutoff.`);
	}
	lines.push(
		"",
		"This is a computed prediction from a single tool, not a measured structure. " +
			"State that when you report it.",
	);
	return lines.join("\n");
}

export default function foldRna(pi: ExtensionAPI) {
	pi.registerTool({
		name: "fold_rna",
		label: "Fold RNA",
		description: [
			"Predict the secondary structure of an RNA (or DNA, folded as RNA) sequence and",
			"return dot-bracket notation plus the minimum free energy. Use this whenever asked",
			"to fold a sequence, get its structure, or compare structures across sequences —",
			"call it once per sequence. `mode: \"ensemble\"` also returns base-pair probabilities.",
			"The harness runs the actual folder (LinearFold) in a managed environment; you do",
			"not need to describe a payload, just call this tool. If it reports that no tool is",
			"installed for the capability, do NOT stop and do NOT invent a structure: call",
			"install_tool('pylinearfold') yourself, then call fold_rna again. Only if the needed",
			"tool is absent from the catalog should you fall back to github_search /",
			"literature_search to find an alternative.",
		].join(" "),
		promptSnippet: "fold_rna: predict RNA secondary structure (dot-bracket + MFE) via the harness",
		parameters: Type.Object({
			sequence: Type.String({
				description: "The nucleotide sequence to fold. A/C/G/U/T/N; T is folded as U.",
			}),
			mode: Type.Optional(
				Type.Union([Type.Literal("mfe"), Type.Literal("ensemble")], {
					description:
						"'mfe' (default) returns the minimum-free-energy structure; 'ensemble' also returns base-pair probabilities.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const capability = params.mode === "ensemble" ? "fold.ensemble" : "fold.mfe";
			try {
				const result = (await callHarness(
					{ capability, sequence: params.sequence },
					{ signal },
				)) as FoldResult;
				return {
					content: [{ type: "text", text: formatFold(result) }],
					details: result,
				};
			} catch (err) {
				throw err instanceof HarnessError
					? err
					: new HarnessError(err instanceof Error ? err.message : String(err));
			}
		},
	});
}
