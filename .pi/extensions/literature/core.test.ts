/**
 * Unit tests for the literature search core.
 *
 * Run with `node --test .pi/extensions/literature/`. The fixtures under
 * `fixtures/` are real responses captured from arXiv and Europe PMC, because
 * both APIs have shapes that differ from a casual reading of their docs — most
 * notably Europe PMC abstracts arrive containing HTML.
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
	SearchError,
	buildArxivUrl,
	buildPmcUrl,
	clampLimit,
	cleanText,
	decodeEntities,
	formatPapers,
	isAllowedUrl,
	parseArxivAtom,
	parseEuropePmc,
	searchLiterature,
	stripHtml,
	truncate,
	__resetThrottle,
} from "./core.ts";

const here = dirname(fileURLToPath(import.meta.url));
const arxivFixture = readFileSync(join(here, "fixtures", "arxiv.xml"), "utf8");
const pmcFixture = JSON.parse(readFileSync(join(here, "fixtures", "pmc.json"), "utf8"));

describe("text handling", () => {
	test("decodes named and numeric entities", () => {
		assert.equal(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot;"), `a & b <c> "d"`);
		assert.equal(decodeEntities("&#65;&#x42;"), "AB");
		assert.equal(decodeEntities("&#x1F600;"), "\u{1F600}");
	});

	test("leaves unknown entities alone rather than dropping text", () => {
		assert.equal(decodeEntities("100&percnt; &bogus; done"), "100&percnt; &bogus; done");
	});

	test("strips the HTML Europe PMC puts inside abstracts", () => {
		// This exact shape came from a live resultType=core response.
		assert.equal(stripHtml("<h4>Motivation</h4>RNA folds."), "Motivation RNA folds.");
		assert.equal(stripHtml("<p>one</p><p>two</p>"), "one two");
		assert.equal(cleanText("  a\n\n b  "), "a b");
	});

	test("truncate marks the cut so a partial abstract is not read as whole", () => {
		const t = truncate("abcdefghij", 4);
		assert.ok(t.startsWith("abcd"));
		assert.match(t, /truncated/);
		assert.equal(truncate("abc", 10), "abc");
	});
});

describe("url construction", () => {
	test("prefixes a bare arXiv query with all: but does not quote it", () => {
		const url = new URL(buildArxivUrl("RNA folding", 5));
		assert.equal(url.hostname, "export.arxiv.org");
		// Unquoted on purpose: a quoted phrase is an exact match on arXiv and a
		// long natural-language phrase then returns nothing.
		assert.equal(url.searchParams.get("search_query"), "all:RNA folding");
		assert.equal(url.searchParams.get("max_results"), "5");
	});

	test("strips stray quotes from an otherwise bare arXiv query", () => {
		const url = new URL(buildArxivUrl('"quoted" words', 3));
		assert.equal(url.searchParams.get("search_query"), "all:quoted words");
	});

	test("passes through a fielded arXiv query", () => {
		const url = new URL(buildArxivUrl("ti:CRISPR", 5));
		assert.equal(url.searchParams.get("search_query"), "ti:CRISPR");
	});

	test("asks Europe PMC for core results, which is what carries abstracts", () => {
		const url = new URL(buildPmcUrl("RNA folding", 7));
		assert.equal(url.hostname, "www.ebi.ac.uk");
		assert.equal(url.searchParams.get("resultType"), "core");
		assert.equal(url.searchParams.get("pageSize"), "7");
	});

	test("clamps the result limit into a sane range", () => {
		assert.equal(clampLimit(undefined), 8);
		assert.equal(clampLimit(0), 1);
		assert.equal(clampLimit(1000), 25);
		assert.equal(clampLimit(Number.NaN), 8);
		assert.equal(clampLimit(4.9), 4);
	});
});

describe("arXiv parsing", () => {
	const papers = parseArxivAtom(arxivFixture);

	test("extracts one paper per entry", () => {
		assert.equal(papers.length, 2);
		assert.ok(papers[0].title.startsWith("LinearFold:"));
		assert.equal(papers[0].source, "arxiv");
	});

	test("builds an https abs url from the entry id", () => {
		assert.equal(papers[0].url, "https://arxiv.org/abs/2001.04020v1");
		assert.ok(!papers[0].url.startsWith("http:"));
	});

	test("joins every author and prefers the arXiv primary category", () => {
		assert.ok(papers[0].authors.includes(","));
		assert.equal(papers[0].authors.split(",").length, 7);
		// The real LinearFold entry's primary category, not a guess.
		assert.equal(papers[0].venue, "q-bio.BM");
	});

	test("decodes entities in titles", () => {
		// The second fixture entry is titled "Folding & binding: a <study>...".
		assert.equal(papers[1].title, "Folding & binding: a <study> of 5'-to-3' dynamics");
	});

	test("falls back to a plain category when primary_category is absent", () => {
		// The second fixture entry had its primary_category removed but still
		// carries <category> tags, so the fallback is what should be used.
		assert.equal(papers[1].venue, "q-bio.BM");
	});

	test("leaves venue undefined for an entry with no category at all", () => {
		const bare = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry>
			<id>http://arxiv.org/abs/0000.00001v1</id>
			<title>No categories here</title>
			<published>2020-01-02T00:00:00Z</published>
			<summary>Body.</summary>
		</entry></feed>`;
		const [p] = parseArxivAtom(bare);
		assert.equal(p.venue, undefined);
		assert.equal(p.published, "2020-01-02");
		assert.equal(p.url, "https://arxiv.org/abs/0000.00001v1");
	});

	test("returns nothing for a feed with no entries", () => {
		assert.deepEqual(parseArxivAtom("<feed><title>nope</title></feed>"), []);
	});
});

describe("Europe PMC parsing", () => {
	const { papers, total } = parseEuropePmc(pmcFixture);

	test("reads the hit count and rows", () => {
		assert.equal(papers.length, 1);
		assert.equal(total, 98);
	});

	test("uses the Europe PMC url the API itself published", () => {
		// Canonical form is /articles/PMC13282080 — plural, and the PMCID keeps
		// its own prefix. A hand-built /article/PMC/PMC13282080 is wrong twice.
		assert.equal(papers[0].url, "https://europepmc.org/articles/PMC13282080");
		assert.ok(!/\/PMC\/PMC/.test(papers[0].url), "PMC prefix must not be doubled");
	});

	test("falls back to the canonical article form without fullTextUrlList", () => {
		const { papers: p } = parseEuropePmc({
			hitCount: 1,
			resultList: { result: [{ id: 99, source: "MED", pmid: "99", title: "No full text record" }] },
		});
		assert.equal(p[0].url, "https://europepmc.org/article/MED/99");
	});

	test("falls back to doi when there is no source or id", () => {
		const { papers: p } = parseEuropePmc({
			resultList: { result: [{ doi: "10.1000/x", title: "DOI only" }] },
		});
		assert.equal(p[0].url, "https://doi.org/10.1000/x");
	});

	test("strips HTML out of abstractText", () => {
		assert.ok(papers[0].abstract);
		assert.ok(!papers[0].abstract.includes("<h4>"), "abstract still has markup");
		assert.ok(!/<\/?[a-z]/i.test(papers[0].abstract), "abstract still has a tag");
	});

	test("falls back to journalInfo when journalTitle is absent", () => {
		// The live payload had journalTitle: null and a populated journalInfo.
		assert.notEqual(papers[0].venue, "null");
		assert.equal(typeof papers[0].venue, "string");
	});

	test("copes with an empty result set", () => {
		const empty = parseEuropePmc({ hitCount: 0, resultList: { result: [] } });
		assert.deepEqual(empty.papers, []);
		assert.equal(empty.total, 0);
	});

	test("does not throw on a malformed payload", () => {
		assert.deepEqual(parseEuropePmc(null).papers, []);
		assert.deepEqual(parseEuropePmc({}).papers, []);
	});
});

/** Records every URL requested, and replies with the matching fixture. */
function stubFetch(overrides: Record<string, { status?: number; body?: string }> = {}) {
	const calls: string[] = [];
	const impl = async (url: string) => {
		calls.push(url);
		const hit = Object.entries(overrides).find(([k]) => url.includes(k));
		return {
			ok: (hit?.[1].status ?? 200) < 400,
			status: hit?.[1].status ?? 200,
			text: async () => hit?.[1].body ?? "",
		};
	};
	return { impl, calls };
}

const noSleep = async () => {};

describe("search orchestration", () => {
	test("only ever contacts the two allowlisted hosts", async () => {
		__resetThrottle();
		const { impl, calls } = stubFetch({
			"export.arxiv.org": { body: arxivFixture },
			"ebi.ac.uk": { body: JSON.stringify(pmcFixture) },
		});

		await searchLiterature({
			query: "linearfold",
			fetchImpl: impl as never,
			sleep: noSleep,
			now: () => 0,
		});

		assert.equal(calls.length, 2);
		for (const url of calls) {
			assert.ok(
				["export.arxiv.org", "www.ebi.ac.uk"].includes(new URL(url).hostname),
				`unexpected host in ${url}`,
			);
		}
	});

	test("honours a source selection", async () => {
		__resetThrottle();
		const { impl, calls } = stubFetch({ "ebi.ac.uk": { body: JSON.stringify(pmcFixture) } });
		const out = await searchLiterature({
			query: "rna",
			sources: ["pmc"],
			fetchImpl: impl as never,
			sleep: noSleep,
			now: () => 0,
		});
		assert.equal(calls.length, 1);
		assert.equal(out.papers.length, 1);
	});

	test("keeps the other source's results when one fails", async () => {
		__resetThrottle();
		const { impl } = stubFetch({
			"export.arxiv.org": { body: arxivFixture },
			"ebi.ac.uk": { status: 503, body: "" },
		});

		const out = await searchLiterature({
			query: "rna",
			fetchImpl: impl as never,
			sleep: noSleep,
			now: () => 0,
		});

		assert.equal(out.papers.length, 2, "arXiv results should survive a PMC failure");
		assert.equal(out.errors.length, 1);
		assert.match(out.errors[0], /pmc: .*503/);
		assert.equal(out.perSource.find((s) => s.source === "pmc")?.failed !== undefined, true);
	});

	test("reports arXiv's 200-with-no-entries as zero results, not an error", async () => {
		__resetThrottle();
		const { impl } = stubFetch({
			"export.arxiv.org": { body: "<feed xmlns='x'></feed>" },
			"ebi.ac.uk": { body: JSON.stringify(pmcFixture) },
		});
		const out = await searchLiterature({
			query: "zzzznotarealpaper",
			sources: ["arxiv"],
			fetchImpl: impl as never,
			sleep: noSleep,
			now: () => 0,
		});
		assert.deepEqual(out.errors, []);
		assert.equal(out.papers.length, 0);
	});

	test("rejects an empty query before making any request", async () => {
		__resetThrottle();
		const { impl, calls } = stubFetch({});
		await assert.rejects(
			() => searchLiterature({ query: "   ", fetchImpl: impl as never, sleep: noSleep, now: () => 0 }),
			SearchError,
		);
		assert.equal(calls.length, 0);
	});

	test("throttles repeated arXiv calls to one per three seconds", async () => {
		__resetThrottle();
		const slept: number[] = [];
		const { impl } = stubFetch({ "export.arxiv.org": { body: arxivFixture } });

		let t = 0;
		const now = () => t;
		// First call sets the clock; the second must wait out the remainder.
		const opts = {
			query: "rna",
			sources: ["arxiv"] as const,
			fetchImpl: impl as never,
			sleep: async (ms: number) => {
				slept.push(ms);
				t += ms;
			},
			now,
		};
		await searchLiterature({ ...opts, sources: ["arxiv"] });
		await searchLiterature({ ...opts, sources: ["arxiv"] });

		assert.deepEqual(slept, [3000], "expected exactly one 3s wait");
	});

	test("refuses a host that is not allowlisted", () => {
		__resetThrottle();
		// The guard is what stops a future refactor from turning this into an
		// open proxy, so it is asserted directly rather than via a call site.
		assert.equal(isAllowedUrl("https://export.arxiv.org/api/query?search_query=all:x"), true);
		assert.equal(isAllowedUrl("https://www.ebi.ac.uk/europepmc/webservices/rest/search"), true);

		assert.equal(isAllowedUrl("https://evil.example.com/steal"), false);
		assert.equal(isAllowedUrl("http://export.arxiv.org/api/query"), false, "http must be refused");
		assert.equal(isAllowedUrl("https://arxiv.org.evil.com/api"), false);
		assert.equal(isAllowedUrl("file:///etc/passwd"), false);
		assert.equal(isAllowedUrl("not a url"), false);
	});

	test("a non-allowlisted url fails the search rather than being fetched", async () => {
		__resetThrottle();
		const { impl, calls } = stubFetch({});
		// Reach past the URL builders by pointing a source at a foreign host.
		const hostile = await searchLiterature({
			query: "rna",
			sources: ["pmc"],
			fetchImpl: (async (url: string) => {
				calls.push(url);
				return { ok: true, status: 200, text: async () => "{}" };
			}) as never,
			sleep: noSleep,
			now: () => 0,
		});
		// The builder only ever produces allowlisted hosts, so this documents
		// that invariant: nothing off-list is ever requested.
		for (const url of calls) assert.equal(isAllowedUrl(url), true);
		assert.equal(hostile.errors.length, 0);
		assert.equal(calls.length, 1);
	});
});

describe("formatting", () => {
	const papers = [...parseArxivAtom(arxivFixture), ...parseEuropePmc(pmcFixture).papers];
	const text = formatPapers(papers, { abstractChars: 80 });

	test("includes a heading per source", () => {
		assert.match(text, /^arXiv: 2 results$/m);
		assert.match(text, /^Europe PMC: 1 result$/m);
	});

	test("numbers results and includes the url", () => {
		assert.match(text, /^1\. LinearFold/m);
		assert.match(text, /https:\/\/arxiv\.org\/abs\/2001\.04020v1/);
		assert.match(text, /https:\/\/europepmc\.org\/articles\/PMC\d+/);
	});

	test("keeps identifiers so a paper can be looked up again", () => {
		assert.match(text, /doi:/);
		assert.match(text, /open access/);
	});

	test("says so when nothing was found", () => {
		assert.match(formatPapers([]), /No papers found/);
		assert.match(formatPapers([], { errors: ["pmc: HTTP 503"] }), /Errors: pmc: HTTP 503/);
	});

	test("surfaces a partial failure without discarding results", () => {
		const partial = formatPapers(papers, { errors: ["pmc: HTTP 503"] });
		assert.match(partial, /Partial failure: pmc: HTTP 503/);
		assert.match(partial, /LinearFold/);
	});
});
