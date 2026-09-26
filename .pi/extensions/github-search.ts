/**
 * GitHub repository search tool for Pi.
 *
 * Exposes the public GitHub repository-search API to the agent as a single
 * `github_search` tool. This is the `research.github` capability: it satisfies
 * the Pi-facing half of that contract, and the Rust harness keeps ownership of
 * every install and every execution.
 *
 * Scope is deliberately narrow — find candidate implementations, nothing more.
 * It does not clone, build, install or run anything it finds. Executing a
 * repository is a separate capability with its own validation, and folding that
 * into a search would turn a read-only lookup into arbitrary code execution.
 *
 * This widens what the agent can reach, so the blast radius is kept small: one
 * read-only tool, one hostname, no general web search, and no credentials
 * required. Rust still owns every filesystem write and every install. The agent
 * still has no `bash`, `write` or `edit` — see `DEFAULT_TOOLS` in
 * `src-tauri/src/pi.rs`.
 *
 * A `GITHUB_TOKEN` (or `GH_TOKEN`) is used if present and is never required;
 * unauthenticated search works but is limited to 10 requests/minute.
 *
 * The search logic lives in `./github/core.ts` with no Pi imports, so it can be
 * tested with `node --test` without starting the agent.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	GithubError,
	formatRepositories,
	searchGithub,
	type Repository,
} from "./github/core";

export default function githubSearch(pi: ExtensionAPI) {
	pi.registerTool({
		name: "github_search",
		label: "GitHub Repository Search",
		description: [
			"Find open-source GitHub repositories implementing a biological or computational method.",
			"Returns repository names, descriptions, language, stars, topics and dates.",
			"Use it after reading the literature, to turn a named algorithm, model or tool",
			"(for example RNA consensus folding, covariance models, R-scape, RIBOSUM) into candidate",
			"implementations you could inspect or install.",
			"Plain natural language is fine: request wording is stripped, so",
			"`find an implementation of RNA consensus folding` is searched as",
			"`RNA consensus folding`. GitHub's own qualifiers also work and are passed",
			"through untouched, for example `RNA folding language:python stars:>10`.",
			"This only searches. It does not clone, install or execute anything, and archived",
			"repositories are flagged so they can be skipped.",
		].join(" "),
		promptSnippet:
			"github_search: find open-source GitHub repositories implementing a method or algorithm",
		parameters: Type.Object({
			query: Type.String({
				description:
					"What to look for. Plain natural language, or a qualified query like 'topic:rna language:python'.",
			}),
			max_results: Type.Optional(
				Type.Integer({
					description: "Maximum repositories to return, 1-100. Defaults to 8.",
					minimum: 1,
					maximum: 100,
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			try {
				const outcome = await searchGithub({
					query: params.query,
					maxResults: params.max_results,
					signal,
					env: process.env,
				});

				const text = formatRepositories(outcome.repositories, {
					total: outcome.total,
					query: outcome.effQuery,
				});

				// `details` is what the TUI renders; the model only sees `content`.
				const details = {
					query: params.query,
					effQuery: outcome.effQuery,
					total: outcome.total,
					authenticated: outcome.authenticated,
					repositories: outcome.repositories as Repository[],
				};

				return { content: [{ type: "text", text }], details };
			} catch (err) {
				// Surfaced as a thrown error so the agent can tell "nothing matched"
				// apart from "the request was refused". Collapsing these would make a
				// rate limit look like a genuine absence of implementations.
				throw err instanceof GithubError
					? err
					: new GithubError(err instanceof Error ? err.message : String(err));
			}
		},
	});
}

export { GithubError };
