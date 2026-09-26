/**
 * Tool management for Pi.
 *
 * Exposes the harness's `tool.list` and `tool.install` capabilities so the agent
 * can *acquire its own tools* instead of describing how a human would. This is
 * the point of pairing literature/GitHub discovery with an executable harness:
 * find what's needed, install it, use it.
 *
 * Installs are bounded to the curated, hash-pinned catalog on purpose — the
 * harness rejects any name it does not know. The agent cannot install arbitrary
 * discovered code; that boundary is deliberate (see AGENTS.md). What it *can* do
 * is see which catalog tool provides a capability it needs and install that,
 * then call the matching tool (e.g. install `pylinearfold`, then `fold_rna`).
 *
 * Formatting logic has no Pi imports so it is unit-testable with `node --test`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { callHarness, HarnessError } from "./shared/harness";

interface ToolSummary {
	name: string;
	version: string;
	source: string;
	algorithm: string;
	approximate: boolean;
	capabilities: string[];
	installed: boolean;
	healthy: boolean | null;
}

interface InstallReport {
	tool: string;
	version: string;
	algorithm: string;
	tier: string;
	python_version: string;
	smoke_test: string;
}

interface PipInstallResult {
	packages: string[];
	python_version: string;
	deps_hash: string;
	resolved_count: number;
}

export function formatToolList(tools: ToolSummary[]): string {
	if (tools.length === 0) return "No tools are registered.";
	const lines = tools.map((t) => {
		const state = !t.installed
			? "NOT installed"
			: t.healthy === false
				? "installed but UNHEALTHY"
				: "installed";
		return `- ${t.name}@${t.version} [${state}] — provides: ${t.capabilities.join(", ") || "—"}`;
	});
	return [
		"Registered tools (install one with install_tool before using its capability):",
		...lines,
	].join("\n");
}

export default function manageTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "list_tools",
		label: "List Tools",
		description: [
			"List the computational-biology tools the harness knows about, with their",
			"capabilities and whether each is installed and healthy. Use this to discover what",
			"you can already do and what you must install first — for example, find which tool",
			"provides `fold.mfe` before folding.",
		].join(" "),
		promptSnippet: "list_tools: see which harness tools are available, installed and healthy",
		parameters: Type.Object({}),
		async execute() {
			try {
				const result = (await callHarness({ capability: "tool.list" })) as { tools: ToolSummary[] };
				return {
					content: [{ type: "text", text: formatToolList(result.tools) }],
					details: result,
				};
			} catch (err) {
				throw err instanceof HarnessError ? err : new HarnessError(String(err));
			}
		},
	});

	pi.registerTool({
		name: "install_tool",
		label: "Install Tool",
		description: [
			"Install a curated harness tool by name, downloading its hash-pinned artifacts and",
			"running its known-answer test. Do this yourself when a capability you need has no",
			"installed provider — do not ask the user to click a button. Only catalog tools can",
			"be installed: 'pylinearfold' for RNA folding, or 'experiment-env' for the",
			"numpy/Biopython/matplotlib/pandas stack that run_experiment needs. If the tool is not in",
			"the catalog, say so and use github_search / literature_search to find alternatives.",
			"After a successful install, call the capability's tool (e.g. fold_rna) to use it.",
		].join(" "),
		promptSnippet: "install_tool: install a curated harness tool (e.g. pylinearfold) so its capability works",
		parameters: Type.Object({
			name: Type.String({ description: "Catalog tool name to install, e.g. 'pylinearfold'." }),
		}),
		async execute(_toolCallId, params) {
			try {
				const report = (await callHarness({
					capability: "tool.install",
					name: params.name,
				})) as InstallReport;
				const text =
					`Installed ${report.tool}@${report.version} (${report.tier}, ${report.algorithm}). ` +
					`Python ${report.python_version}. Known-answer test: ${report.smoke_test || "n/a"}. ` +
					`Its capability is now usable — call the matching tool.`;
				return { content: [{ type: "text", text }], details: report };
			} catch (err) {
				throw err instanceof HarnessError ? err : new HarnessError(String(err));
			}
		},
	});

	pi.registerTool({
		name: "pip_install",
		label: "Install Python Packages",
		description: [
			"Install Python packages from PyPI into the experiment environment, so run_experiment",
			"can then import them. THIS is how you acquire a tool you don't have: if an import",
			"fails or a capability is missing (an aligner, a parser, a plotting library), install",
			"the package yourself here and re-run — do not give up, do not ask the user, do not",
			"shell out to binaries that aren't installed. Examples: pyfamsa (multiple sequence",
			"alignment), scikit-bio, dendropy (phylogenetics), pysam, logomaker. Packages persist",
			"across runs, so install once then import. Give real PyPI names/specs like",
			"'pyfamsa' or 'dendropy==5.0.1'.",
		].join(" "),
		promptSnippet: "pip_install: install PyPI packages into the experiment env so you can import them",
		parameters: Type.Object({
			packages: Type.Array(Type.String(), {
				description: "PyPI requirement specs, e.g. ['pyfamsa', 'dendropy==5.0.1']. 1-25 entries.",
				minItems: 1,
				maxItems: 25,
			}),
		}),
		async execute(_toolCallId, params) {
			try {
				const result = (await callHarness(
					{ capability: "pip.install", packages: params.packages },
					// pip resolution + build can be slow; give it room under the bridge's own cap.
					{ timeoutMs: 300_000 },
				)) as PipInstallResult;
				const text =
					`Installed ${result.packages.join(", ")} into the experiment env ` +
					`(Python ${result.python_version}, ${result.resolved_count} packages resolved). ` +
					`Import them in run_experiment now.`;
				return { content: [{ type: "text", text }], details: result };
			} catch (err) {
				throw err instanceof HarnessError ? err : new HarnessError(String(err));
			}
		},
	});
}
