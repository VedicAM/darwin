/**
 * Literature search tool for Pi.
 *
 * Exposes arXiv and Europe PMC to the agent as a single `literature_search`
 * tool. Both are keyless, read-only APIs appropriate for automated access.
 *
 * This widens what the agent can reach, so the blast radius is kept
 * deliberately small: one read-only tool, two hostnames, and no general web
 * search. Rust still owns every filesystem write and every install; this only
 * performs GETs against public literature APIs. The agent still has no `bash`,
 * `write` or `edit` — see `DEFAULT_TOOLS` in `src-tauri/src/pi.rs`.
 *
 * The search logic lives in `./literature/core.ts` with no Pi imports, so it
 * can be tested with `node --test` without starting the agent.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	SearchError,
	formatPapers,
	searchLiterature,
	type Paper,
	type SourceId,
} from "./literature/core";

const SOURCES = ["arxiv", "pmc"] as const;

export default function literatureSearch(pi: ExtensionAPI) {
	pi.registerTool({
		name: "literature_search",
		label: "Literature Search",
		description: [
			"Search scientific literature and return titles, authors, dates and abstract excerpts.",
			"Covers arXiv (preprints, quantitative biology, cs.LG) and Europe PMC (peer-reviewed life sciences).",
			"Use it to find prior work, check whether a method has been published, or read abstracts.",
			"Field syntax is supported: `ti:` for title and `au:` for author on arXiv;",
			"`TITLE:` and `AUTH:` on Europe PMC. Plain text searches all fields.",
		].join(" "),
		promptSnippet: "literature_search: search arXiv and Europe PMC for papers and abstracts",
		parameters: Type.Object({
			query: Type.String({
				description: "Search query. Plain text, or a fielded query like 'ti:CRISPR'.",
			}),
			source: Type.Optional(
				Type.Union([Type.Literal("arxiv"), Type.Literal("pmc"), Type.Literal("both")], {
					description: "Which index to search. Defaults to both.",
				}),
			),
			limit: Type.Optional(
				Type.Integer({
					description: "Results per source, 1-25. Defaults to 8.",
					minimum: 1,
					maximum: 25,
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const sources: SourceId[] =
				params.source === "arxiv" ? ["arxiv"] : params.source === "pmc" ? ["pmc"] : [...SOURCES];

			const outcome = await searchLiterature({
				query: params.query,
				sources,
				limit: params.limit,
			});

			const text = formatPapers(outcome.papers, {
				perSource: outcome.perSource,
				errors: outcome.errors,
			});

			// `details` is what the TUI renders; the model only sees `content`.
			const details = {
				query: params.query,
				sources,
				papers: outcome.papers as Paper[],
				errors: outcome.errors,
			};

			return { content: [{ type: "text", text }], details };
		},
	});
}

export { SearchError };
