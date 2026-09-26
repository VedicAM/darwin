/**
 * Unit tests for the GitHub search core.
 *
 * Run with `node --test .pi/extensions/github/core.test.ts`. The fixtures under
 * `fixtures/` are trimmed responses captured from the live API, because the
 * search payload is wider than the fields this tool reads and it is worth
 * pinning the real shape — including the fields that come back empty.
 *
 * No test runner is configured for this repo, so this uses Node's built-in
 * `node:test` rather than adding a dependency.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";

import {
	GithubError,
	buildGithubUrl,
	buildSearchQuery,
	clampMaxResults,
	formatRepositories,
	isAllowedUrl,
	parseGithubSearch,
	resolveToken,
	searchGithub,
	__resetThrottle,
} from "./core.ts";

const here = dirname(fileURLToPath(import.meta.url));
const searchFixture = JSON.parse(readFileSync(join(here, "fixtures", "search.json"), "utf8"));
const emptyFixture = JSON.parse(readFileSync(join(here, "fixtures", "search-empty.json"), "utf8"));

/** Records every URL requested, and replies with the matching canned response. */
function stubFetch(
	overrides: Record<string, { status?: number; body?: string; headers?: Record<string, string> }> = {},
) {
	const calls: { url: string; headers?: Record<string, string> }[] = [];
	const impl = async (url: string, init?: { headers?: Record<string, string> }) => {
		calls.push({ url, headers: init?.headers });
		const hit = Object.entries(overrides).find(([k]) => url.includes(k));
		const status = hit?.[1].status ?? 200;
		const headers = new Map(
			Object.entries(hit?.[1].headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
		);
		return {
			ok: status < 400,
			status,
			text: async () => hit?.[1].body ?? "",
			headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
		};
	};
	return { impl, calls };
}

const noSleep = async () => {};

describe("query translation", () => {
	test("drops request wording but keeps domain terms", () => {
		assert.equal(
			buildSearchQuery("Find an implementation of RNA consensus folding"),
			"RNA consensus folding",
		);
		assert.equal(
			buildSearchQuery("Find a Python implementation of RNA consensus folding"),
			"Python RNA consensus folding",
		);
		// "algorithm" and "method" are domain words, not request wording.
		assert.equal(
			buildSearchQuery("Find tools for RNA covariance analysis"),
			"RNA covariance analysis",
		);
		assert.equal(buildSearchQuery("algorithm"), "algorithm");
	});

	test("passes an explicitly qualified query through untouched", () => {
		const q = "RNA folding language:python stars:>10";
		assert.equal(buildSearchQuery(q), q);
		assert.equal(buildSearchQuery("topic:rna-structure in:name"), "topic:rna-structure in:name");
	});

	test("rejects a query with nothing left to search for", () => {
		assert.throws(() => buildSearchQuery("find an implementation of it"), GithubError);
		assert.throws(() => buildSearchQuery("the repository"), GithubError);
	});

	test("strips possessives and collapses punctuation", () => {
		assert.equal(buildSearchQuery("repos implementing this paper's method"), "paper method");
		assert.equal(buildSearchQuery("  RNA, folding;  consensus "), "RNA folding consensus");
	});
});

describe("url construction", () => {
	test("targets the repository search endpoint over https", () => {
		const url = new URL(buildGithubUrl("RNA folding", 5));
		assert.equal(url.hostname, "api.github.com");
		assert.equal(url.protocol, "https:");
		assert.equal(url.pathname, "/search/repositories");
		assert.equal(url.searchParams.get("q"), "RNA folding");
		assert.equal(url.searchParams.get("per_page"), "5");
	});

	test("clamps the result count into the range the API accepts", () => {
		assert.equal(clampMaxResults(undefined), 8);
		assert.equal(clampMaxResults(0), 1);
		assert.equal(clampMaxResults(-4), 1);
		assert.equal(clampMaxResults(1000), 100);
		assert.equal(clampMaxResults(7.9), 7);
		assert.equal(clampMaxResults(Number.NaN), 8);

		const url = new URL(buildGithubUrl("rna", 5000));
		assert.equal(url.searchParams.get("per_page"), "100");
	});

	test("only ever contacts the allowlisted host", () => {
		assert.equal(isAllowedUrl("https://api.github.com/search/repositories?q=rna"), true);
		assert.equal(isAllowedUrl("http://api.github.com/search/repositories?q=rna"), false);
		assert.equal(isAllowedUrl("https://api.github.com.evil.com/x"), false);
		assert.equal(isAllowedUrl("https://github.com/x"), false);
		assert.equal(isAllowedUrl("not a url"), false);
	});
});

describe("parsing", () => {
	test("reads the fields it surfaces from a real response", () => {
		const { repositories, total } = parseGithubSearch(searchFixture);
		assert.equal(total, 14);
		assert.equal(repositories.length, 2);

		const [first] = repositories;
		assert.equal(first.full_name, "LinearFold/LinearFold");
		assert.equal(first.name, "LinearFold");
		assert.equal(first.owner, "LinearFold");
		assert.equal(first.url, "https://github.com/LinearFold/LinearFold");
		assert.equal(first.default_branch, "master");
		assert.equal(first.language, "C++");
		assert.equal(first.stars, 200);
		assert.equal(first.forks, 54);
		assert.equal(first.open_issues, 10);
		assert.equal(first.updated_at, "2026-09-01T04:08:56Z");
		assert.equal(first.archived, false);
		assert.equal(first.fork, false);

		// The captured response carries an empty topic list, so `topics` is
		// absent rather than present-and-empty.
		assert.equal("topics" in first, false);
	});

	test("keeps topics when GitHub sends them", () => {
		const { repositories } = parseGithubSearch({
			total_count: 1,
			items: [
				{
					full_name: "o/r",
					name: "r",
					owner: { login: "o" },
					html_url: "https://github.com/o/r",
					topics: ["bioinformatics", "rna", ""],
				},
			],
		});
		assert.deepEqual(repositories[0].topics, ["bioinformatics", "rna"]);
	});

	test("omits fields GitHub did not send instead of inventing them", () => {
		// Synthetic: the captured fixtures happened to have no sparse rows, so
		// the null-heavy shape is written out here instead of captured.
		const { repositories } = parseGithubSearch({
			total_count: 1,
			items: [
				{
					full_name: "o/sparse",
					name: "sparse",
					owner: { login: "o" },
					html_url: "https://github.com/o/sparse",
					description: null,
					language: null,
					topics: [],
					license: null,
					stars: null,
				},
			],
		});

		const repo = repositories[0];
		assert.equal(repo.full_name, "o/sparse");
		for (const key of [
			"description",
			"language",
			"license",
			"topics",
			"stars",
			"forks",
			"open_issues",
			"updated_at",
			"default_branch",
		]) {
			assert.equal(key in repo, false, `${key} should have been omitted, not defaulted`);
		}
	});

	test("derives owner and name from full_name when they are absent", () => {
		const { repositories } = parseGithubSearch({
			items: [{ full_name: "LinearFold/LinearFold" }],
		});
		assert.equal(repositories[0].owner, "LinearFold");
		assert.equal(repositories[0].name, "LinearFold");
		assert.equal(repositories[0].url, "");
	});

	test("reports an empty result set as zero, not an error", () => {
		const { repositories, total } = parseGithubSearch(emptyFixture);
		assert.deepEqual(repositories, []);
		assert.equal(total, 0);
	});

	test("skips items that cannot be identified", () => {
		const { repositories, total } = parseGithubSearch({
			total_count: 9,
			items: [{ name: "nameless" }, { full_name: "o/r", html_url: "https://github.com/o/r" }],
		});
		assert.equal(repositories.length, 1);
		// `total` still reports what GitHub said, which is not the item count.
		assert.equal(total, 9);
	});

	test("rejects a payload that is not the documented shape", () => {
		assert.throws(() => parseGithubSearch(null), GithubError);
		assert.throws(() => parseGithubSearch([]), GithubError);
		assert.throws(() => parseGithubSearch("nope"), GithubError);
		assert.throws(() => parseGithubSearch({}), GithubError);
		assert.throws(() => parseGithubSearch({ total_count: 3, items: {} }), GithubError);
		// A 200 carrying only `message` is GitHub rejecting the query, and must
		// not read as "no matches".
		assert.throws(() => parseGithubSearch({ message: "Validation Failed" }), GithubError);
	});
});

describe("token handling", () => {
	test("reads either conventional variable and ignores blanks", () => {
		assert.equal(resolveToken({ GITHUB_TOKEN: "a" }), "a");
		assert.equal(resolveToken({ GH_TOKEN: "b" }), "b");
		// GITHUB_TOKEN wins when both are set.
		assert.equal(resolveToken({ GITHUB_TOKEN: "a", GH_TOKEN: "b" }), "a");
		assert.equal(resolveToken({ GITHUB_TOKEN: "   " }), undefined);
		assert.equal(resolveToken({}), undefined);
	});
});

describe("search orchestration", () => {
	test("sends the translated query and returns structured repositories", async () => {
		__resetThrottle();
		const { impl, calls } = stubFetch({ "api.github.com": { body: JSON.stringify(searchFixture) } });

		const out = await searchGithub({
			query: "Find an implementation of RNA consensus folding",
			fetchImpl: impl as never,
			sleep: noSleep,
			now: () => 0,
			env: {},
		});

		assert.equal(out.repositories.length, 2);
		assert.equal(out.total, 14);
		assert.equal(out.effQuery, "RNA consensus folding");
		assert.equal(out.authenticated, false);
		assert.equal(calls.length, 1);
		assert.equal(new URL(calls[0].url).hostname, "api.github.com");
		assert.equal(calls[0].headers?.Authorization, undefined);
	});

	test("sends a bearer token when one is configured, and never echoes it", async () => {
		__resetThrottle();
		const { impl, calls } = stubFetch({ "api.github.com": { body: JSON.stringify(searchFixture) } });

		const out = await searchGithub({
			query: "rna",
			fetchImpl: impl as never,
			sleep: noSleep,
			now: () => 0,
			env: { GITHUB_TOKEN: "ghp_secret" },
		});

		assert.equal(out.authenticated, true);
		assert.equal(calls[0].headers?.Authorization, "Bearer ghp_secret");
		assert.equal(JSON.stringify(out).includes("ghp_secret"), false);
	});

	test("surfaces a rate-limited search as an error, not as zero results", async () => {
		__resetThrottle();
		const { impl } = stubFetch({
			"api.github.com": {
				status: 403,
				body: JSON.stringify({ message: "API rate limit exceeded" }),
				headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000000000" },
			},
		});

		await assert.rejects(
			() =>
				searchGithub({
					query: "rna",
					fetchImpl: impl as never,
					sleep: noSleep,
					now: () => 0,
				}),
			(err: Error) => {
				assert.ok(err instanceof GithubError);
				assert.match(err.message, /rate limit/i);
				assert.match(err.message, /unauthenticated/);
				return true;
			},
		);
	});

	test("treats 429 as a rate limit and names the authenticated allowance", async () => {
		__resetThrottle();
		const { impl } = stubFetch({
			"api.github.com": { status: 429, body: "", headers: {} },
		});

		await assert.rejects(
			() =>
				searchGithub({
					query: "rna",
					fetchImpl: impl as never,
					sleep: noSleep,
					now: () => 0,
					env: { GITHUB_TOKEN: "t" },
				}),
			(err: Error) => {
				assert.match(err.message, /rate limit/i);
				assert.match(err.message, /authenticated/);
				return true;
			},
		);
	});

	test("distinguishes a 403 that is not a rate limit", async () => {
		__resetThrottle();
		const { impl } = stubFetch({
			"api.github.com": {
				status: 403,
				body: JSON.stringify({ message: "secondary rate limit" }),
				headers: { "x-ratelimit-remaining": "42" },
			},
		});

		await assert.rejects(
			() =>
				searchGithub({
					query: "rna",
					fetchImpl: impl as never,
					sleep: noSleep,
					now: () => 0,
				}),
			(err: Error) => {
				assert.match(err.message, /HTTP 403/);
				assert.equal(/rate limit reached/i.test(err.message), false);
				return true;
			},
		);
	});

	test("reports a rejected query as invalid rather than as no matches", async () => {
		__resetThrottle();
		const { impl } = stubFetch({
			"api.github.com": {
				status: 422,
				body: JSON.stringify({ message: "Validation Failed", errors: [{ code: "custom" }] }),
			},
		});

		await assert.rejects(
			() =>
				searchGithub({
					query: "rna",
					fetchImpl: impl as never,
					sleep: noSleep,
					now: () => 0,
				}),
			(err: Error) => {
				assert.match(err.message, /invalid/i);
				assert.match(err.message, /Validation Failed/);
				return true;
			},
		);
	});

	test("reports bad credentials distinctly from other 401s", async () => {
		__resetThrottle();
		const { impl } = stubFetch({ "api.github.com": { status: 401, body: "{}" } });

		await assert.rejects(
			() =>
				searchGithub({
					query: "rna",
					fetchImpl: impl as never,
					sleep: noSleep,
					now: () => 0,
					env: { GITHUB_TOKEN: "bad" },
				}),
			(err: Error) => {
				assert.match(err.message, /credentials/i);
				assert.equal(err.message.includes("bad"), false, "must not echo the token");
				return true;
			},
		);
	});

	test("reports a server failure as an error", async () => {
		__resetThrottle();
		const { impl } = stubFetch({
			"api.github.com": { status: 502, body: "<html>bad gateway</html>" },
		});

		await assert.rejects(
			() =>
				searchGithub({
					query: "rna",
					fetchImpl: impl as never,
					sleep: noSleep,
					now: () => 0,
				}),
			(err: Error) => {
				assert.match(err.message, /HTTP 502/);
				return true;
			},
		);
	});

	test("reports a malformed body as an error", async () => {
		__resetThrottle();
		const { impl } = stubFetch({ "api.github.com": { body: "{not json" } });

		await assert.rejects(
			() =>
				searchGithub({
					query: "rna",
					fetchImpl: impl as never,
					sleep: noSleep,
					now: () => 0,
				}),
			(err: Error) => {
				assert.match(err.message, /malformed/i);
				return true;
			},
		);
	});

	test("returns an empty list for a genuine zero-result search", async () => {
		__resetThrottle();
		const { impl } = stubFetch({
			"api.github.com": { body: JSON.stringify(emptyFixture) },
		});

		const out = await searchGithub({
			query: "RIBOSUM",
			fetchImpl: impl as never,
			sleep: noSleep,
			now: () => 0,
		});

		assert.deepEqual(out.repositories, []);
		assert.equal(out.total, 0);
	});

	test("rejects an empty query before making any request", async () => {
		__resetThrottle();
		const { impl, calls } = stubFetch({});
		await assert.rejects(
			() =>
				searchGithub({
					query: "   ",
					fetchImpl: impl as never,
					sleep: noSleep,
					now: () => 0,
				}),
			GithubError,
		);
		assert.equal(calls.length, 0);
	});

	test("rejects a filler-only query before making any request", async () => {
		__resetThrottle();
		const { impl, calls } = stubFetch({});
		await assert.rejects(
			() =>
				searchGithub({
					query: "show me the repositories",
					fetchImpl: impl as never,
					sleep: noSleep,
					now: () => 0,
				}),
			GithubError,
		);
		assert.equal(calls.length, 0);
	});

	test("spaces out repeated calls so the unauthenticated budget survives", async () => {
		__resetThrottle();
		const slept: number[] = [];
		const { impl } = stubFetch({ "api.github.com": { body: JSON.stringify(searchFixture) } });

		let t = 0;
		const opts = {
			query: "rna",
			fetchImpl: impl as never,
			sleep: async (ms: number) => {
				slept.push(ms);
				t += ms;
			},
			now: () => t,
		};
		await searchGithub(opts);
		await searchGithub(opts);
		await searchGithub(opts);

		assert.deepEqual(slept, [1000, 1000], "expected a 1s gap between each call");
	});
});

describe("presentation", () => {
	test("renders the fields an agent needs to judge a candidate", () => {
		const { repositories, total } = parseGithubSearch(searchFixture);
		const text = formatRepositories(repositories, { total });

		assert.match(text, /LinearFold\/LinearFold/);
		assert.match(text, /C\+\+/);
		assert.match(text, /200 stars/);
		assert.match(text, /https:\/\/github\.com\/LinearFold\/LinearFold/);
		// 2 shown of 14 matched.
		assert.match(text, /2 of 14/);
	});

	test("says so plainly when nothing matched", () => {
		assert.match(formatRepositories([], { total: 0 }), /No repositories found/);
	});

	test("does not print an empty topic or metadata line", () => {
		const text = formatRepositories([
			{ full_name: "o/r", name: "r", owner: "o", url: "https://github.com/o/r" },
		]);
		assert.equal(text.includes("topics:"), false);
		assert.equal(text.includes("undefined"), false);
	});
});
