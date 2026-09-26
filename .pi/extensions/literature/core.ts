/**
 * Literature search core.
 *
 * Deliberately free of any Pi import so it can be unit-tested with `node:test`
 * outside the agent runtime. The extension file is a thin wrapper over this.
 *
 * Scope is arXiv and Europe PMC. Both are keyless, read-only, and appropriate
 * for automated access. A general web-search provider can be added as another
 * entry in `SEARCH_SOURCES` without changing the tool's shape; there is no
 * keyless general web search API, so that needs a provider decision first.
 */

export type SourceId = "arxiv" | "pmc";

export interface Paper {
	source: SourceId;
	title: string;
	authors: string;
	published: string;
	venue?: string;
	doi?: string;
	pmid?: string;
	pmcid?: string;
	url: string;
	abstract?: string;
	openAccess?: boolean;
	citedBy?: number;
}

/**
 * The only hosts this module will contact. A search tool that can be pointed
 * anywhere is a tool that can exfiltrate the query string to anywhere, so the
 * allowlist is enforced here rather than left to the call sites.
 */
const ALLOWED_HOSTS = new Set(["export.arxiv.org", "www.ebi.ac.uk"]);

/** arXiv asks for no more than one request every three seconds. */
const MIN_INTERVAL_MS: Record<SourceId, number> = {
	arxiv: 3000,
	pmc: 250,
};

const MAX_LIMIT = 25;
const DEFAULT_LIMIT = 8;
const TIMEOUT_MS = 20_000;

export class SearchError extends Error {}

// --- text helpers -----------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

export function decodeEntities(input: string): string {
	return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
		if (body.startsWith("#x") || body.startsWith("#X")) {
			const code = Number.parseInt(body.slice(2), 16);
			return Number.isFinite(code) ? safeFromCodePoint(code, whole) : whole;
		}
		if (body.startsWith("#")) {
			const code = Number.parseInt(body.slice(1), 10);
			return Number.isFinite(code) ? safeFromCodePoint(code, whole) : whole;
		}
		return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
	});
}

function safeFromCodePoint(code: number, fallback: string): string {
	if (code < 0 || code > 0x10ffff) return fallback;
	try {
		return String.fromCodePoint(code);
	} catch {
		return fallback;
	}
}

/**
 * Europe PMC returns abstracts containing markup — `<h4>Motivation</h4>` and
 * friends — unlike arXiv, whose `<summary>` is plain text. Verified against a
 * live `resultType=core` response.
 */
export function stripHtml(input: string): string {
	return decodeEntities(
		input
			.replace(/<br\s*\/?>/gi, " ")
			.replace(/<\/(p|div|h[1-6]|li)>/gi, " ")
			.replace(/<[^>]*>/g, ""),
	).trim();
}

export function collapse(input: string): string {
	return input.replace(/\s+/g, " ").trim();
}

export function cleanText(input: string | undefined | null): string {
	if (!input) return "";
	return collapse(stripHtml(input));
}

export function truncate(input: string, max: number): string {
	if (input.length <= max) return input;
	return `${input.slice(0, max).trimEnd()}… [truncated]`;
}

// --- URL construction -------------------------------------------------------

/** arXiv field prefixes that mean the caller already wrote a real query. */
const ARXIV_PREFIX = /^(all|ti|au|abs|cat|co|jr|rn|id):/i;
/** Europe PMC field/operator syntax. */
const PMC_OPERATOR = /(\bAND\b|\bOR\b|\bNOT\b|TITLE\s*:|AUTH\s*:|JOURNAL\s*:|DOI\s*:|\*\s)/;

export function buildArxivUrl(query: string, limit: number): string {
	const trimmed = query.trim();
	// A bare query becomes an all-fields search; one that already names a field
	// is passed through so the model can be precise.
	//
	// The terms are deliberately NOT quoted. arXiv treats a quoted string as an
	// exact phrase, and a long natural-language phrase then matches nothing:
	// verified against the live API, `all:"linear-time RNA secondary structure
	// prediction"` returned 0 entries while the same terms unquoted returned 3.
	// Unquoted terms are ANDed, which behaves sensibly for both an exact tool
	// name and a longer description.
	const search = ARXIV_PREFIX.test(trimmed) ? trimmed : `all:${trimmed.replace(/"/g, "")}`;
	const url = new URL("https://export.arxiv.org/api/query");
	url.searchParams.set("search_query", search);
	url.searchParams.set("start", "0");
	url.searchParams.set("max_results", String(clampLimit(limit)));
	url.searchParams.set("sortBy", "relevance");
	url.searchParams.set("sortOrder", "descending");
	return url.toString();
}

export function buildPmcUrl(query: string, limit: number): string {
	const url = new URL("https://www.ebi.ac.uk/europepmc/webservices/rest/search");
	url.searchParams.set("query", query.trim());
	url.searchParams.set("format", "json");
	url.searchParams.set("pageSize", String(clampLimit(limit)));
	// `core` is what carries abstractText; the default result type omits it.
	url.searchParams.set("resultType", "core");
	return url.toString();
}

export function clampLimit(limit: number | undefined): number {
	if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
	return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

// --- parsing ----------------------------------------------------------------

function tagText(xml: string, tag: string): string {
	const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
	return match ? cleanText(match[1]) : "";
}

/**
 * Parse arXiv's Atom feed. The feed shape is narrow and stable, so targeted
 * extraction beats a general XML parser here, but it is only trustworthy
 * because the output is checked against live feeds in `search.test.ts`.
 */
export function parseArxivAtom(xml: string): Paper[] {
	const entries = xml.match(/<entry>[\s\S]*?<\/entry>/gi) ?? [];
	const papers: Paper[] = [];

	for (const entry of entries) {
		const id = tagText(entry, "id");
		if (!id) continue;
		const absUrl = id.replace(/^http:/, "https:");
		const category =
			entry.match(/<arxiv:primary_category[^>]*term="([^"]+)"/i)?.[1] ??
			entry.match(/<category[^>]*term="([^"]+)"/i)?.[1];

		const authors = [...entry.matchAll(/<author>[\s\S]*?<\/author>/gi)]
			.map((a) => tagText(a[0], "name"))
			.filter(Boolean)
			.join(", ");

		papers.push({
			source: "arxiv",
			title: tagText(entry, "title"),
			authors: authors || "unknown",
			published: (tagText(entry, "published") || tagText(entry, "updated")).slice(0, 10),
			venue: category,
			url: absUrl,
			abstract: tagText(entry, "summary") || undefined,
		});
	}
	return papers;
}

interface PmcResult {
	id?: string | number;
	source?: string;
	pmid?: string;
	pmcid?: string;
	doi?: string;
	title?: string;
	authorString?: string;
	pubYear?: string;
	abstractText?: string;
	isOpenAccess?: string;
	citedByCount?: number;
	journalInfo?: { journal?: { title?: string } };
	fullTextUrlList?: {
		fullTextUrl?: { site?: string; documentStyle?: string; url?: string }[];
	};
}

/**
 * Prefer a URL Europe PMC itself published over one assembled here. The
 * canonical form is `/articles/PMC13282080` — plural `articles`, and the
 * PMCID keeps its own `PMC` prefix — so a hand-built
 * `/article/PMC/PMC13282080` is wrong twice over. The assembled fallbacks
 * below are only used when the API supplies nothing.
 */
function pmcUrl(r: PmcResult): string {
	const fromApi = r.fullTextUrlList?.fullTextUrl?.find(
		(u) => u.site === "Europe_PMC" && u.documentStyle === "html" && u.url,
	);
	if (fromApi?.url) return fromApi.url;

	const id = String(r.id ?? "").trim();
	if (r.source && id) return `https://europepmc.org/article/${r.source}/${id}`;
	if (r.doi) return `https://doi.org/${r.doi}`;
	if (r.pmid) return `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/`;
	return "https://europepmc.org";
}

export function parseEuropePmc(payload: unknown): { papers: Paper[]; total: number } {
	const root = (payload ?? {}) as {
		hitCount?: number;
		resultList?: { result?: PmcResult[] };
	};
	const rows = root.resultList?.result ?? [];
	const total = Number.isFinite(root.hitCount) ? Number(root.hitCount) : rows.length;

	const papers: Paper[] = rows
		.filter((r) => r && (r.title || r.doi || r.pmid))
		.map((r) => ({
			source: "pmc" as const,
			title: cleanText(r.title) || "(untitled)",
			authors: cleanText(r.authorString) || "unknown",
			published: r.pubYear ?? "",
			// journalTitle is often null even when journalInfo is populated.
			venue: cleanText(r.journalInfo?.journal?.title) || undefined,
			doi: r.doi || undefined,
			pmid: r.pmid || undefined,
			pmcid: r.pmcid || undefined,
			url: pmcUrl(r),
			abstract: cleanText(r.abstractText) || undefined,
			openAccess: r.isOpenAccess === "Y",
			citedBy: Number.isFinite(r.citedByCount) ? Number(r.citedByCount) : undefined,
		}));

	return { papers, total };
}

// --- fetching ---------------------------------------------------------------

const lastRequestAt = new Map<SourceId, number>();

/**
 * Whether this module is willing to fetch a URL. Exported so the guard can be
 * tested directly rather than inferred from a call site.
 */
export function isAllowedUrl(rawUrl: string): boolean {
	try {
		const url = new URL(rawUrl);
		return url.protocol === "https:" && ALLOWED_HOSTS.has(url.hostname);
	} catch {
		return false;
	}
}

function assertAllowedHost(rawUrl: string): URL {
	const url = new URL(rawUrl);
	if (url.protocol !== "https:") {
		throw new SearchError(`refusing a non-HTTPS request to ${url.hostname}`);
	}
	if (!ALLOWED_HOSTS.has(url.hostname)) {
		throw new SearchError(`host ${url.hostname} is not on the allowlist`);
	}
	return url;
}

async function throttle(source: SourceId, now: number, sleep: (ms: number) => Promise<void>): Promise<void> {
	const min = MIN_INTERVAL_MS[source];
	const last = lastRequestAt.get(source);
	if (last !== undefined) {
		const wait = min - (now - last);
		if (wait > 0) await sleep(wait);
	}
	lastRequestAt.set(source, now);
}

/** Exposed for tests: clears the throttle state between cases. */
export function __resetThrottle(): void {
	lastRequestAt.clear();
}

type FetchLike = (input: string, init?: { signal?: AbortSignal }) => Promise<{
	ok: boolean;
	status: number;
	text(): Promise<string>;
}>;

export interface SearchOptions {
	query: string;
	sources?: SourceId[];
	limit?: number;
	fetchImpl?: FetchLike;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	timeoutMs?: number;
}

export interface SearchOutcome {
	papers: Paper[];
	errors: string[];
	perSource: { source: SourceId; reported: number; failed?: string }[];
}

async function fetchSource(
	source: SourceId,
	url: string,
	opts: Required<Pick<SearchOptions, "fetchImpl" | "sleep" | "now">> & { timeoutMs: number },
): Promise<{ papers: Paper[]; total: number }> {
	assertAllowedHost(url);
	await throttle(source, opts.now(), opts.sleep);

	const res = await opts.fetchImpl(url, {
		signal: AbortSignal.timeout(opts.timeoutMs),
	});
	if (!res.ok) {
		throw new SearchError(`${source} returned HTTP ${res.status}`);
	}
	const body = await res.text();

	if (source === "arxiv") {
		// An Atom feed with no entries is arXiv's way of saying "no match";
		// it also returns HTTP 200, so it must not read as an error.
		return { papers: parseArxivAtom(body), total: parseArxivAtom(body).length };
	}
	return parseEuropePmc(JSON.parse(body));
}

export async function searchLiterature(opts: SearchOptions): Promise<SearchOutcome> {
	const query = opts.query.trim();
	if (!query) throw new SearchError("query is empty");

	const limit = clampLimit(opts.limit);
	const sources = opts.sources?.length ? opts.sources : (["arxiv", "pmc"] as SourceId[]);
	const resolved = {
		fetchImpl: opts.fetchImpl ?? ((globalThis.fetch as unknown) as FetchLike),
		sleep: opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))),
		now: opts.now ?? (() => Date.now()),
		timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
	};

	const urlFor: Record<SourceId, string> = {
		arxiv: buildArxivUrl(query, limit),
		pmc: buildPmcUrl(query, limit),
	};

	const papers: Paper[] = [];
	const errors: string[] = [];
	const perSource: SearchOutcome["perSource"] = [];

	for (const source of sources) {
		try {
			const result = await fetchSource(source, urlFor[source], resolved);
			papers.push(...result.papers);
			perSource.push({ source, reported: result.papers.length });
		} catch (err) {
			// One source failing must not lose the other's results.
			const message = err instanceof Error ? err.message : String(err);
			errors.push(`${source}: ${message}`);
			perSource.push({ source, reported: 0, failed: message });
		}
	}

	return { papers, errors, perSource };
}

// --- presentation ------------------------------------------------------------

export interface FormatOptions {
	perSource?: { source: SourceId; reported: number }[];
	errors?: string[];
	abstractChars?: number;
}

const SOURCE_LABEL: Record<SourceId, string> = {
	arxiv: "arXiv",
	pmc: "Europe PMC",
};

export function formatPapers(papers: Paper[], opts: FormatOptions = {}): string {
	if (papers.length === 0) {
		const why = opts.errors?.length ? `\nErrors: ${opts.errors.join("; ")}` : "";
		return `No papers found.${why}`;
	}

	const chunks: string[] = [];
	for (const source of ["arxiv", "pmc"] as SourceId[]) {
		const group = papers.filter((p) => p.source === source);
		if (group.length === 0) continue;

		const header = `${SOURCE_LABEL[source]}: ${group.length} result${group.length === 1 ? "" : "s"}`;
		const body = group
			.map((p, idx) => {
				const lines = [`${idx + 1}. ${p.title}`];
				if (p.authors && p.authors !== "unknown") {
					lines.push(`   Authors: ${truncate(p.authors, 200)}`);
				}
				const meta = [p.published, p.venue].filter(Boolean).join(" · ");
				const tags: string[] = [];
				if (p.doi) tags.push(`doi:${p.doi}`);
				if (p.pmid) tags.push(`pmid:${p.pmid}`);
				if (p.pmcid) tags.push(p.pmcid);
				if (p.openAccess) tags.push("open access");
				if (p.citedBy) tags.push(`cited ${p.citedBy}`);
				if (meta) lines.push(`   ${meta}`);
				if (tags.length) lines.push(`   ${tags.join(" · ")}`);
				if (p.abstract) {
					lines.push(`   Abstract: ${truncate(p.abstract, opts.abstractChars ?? 600)}`);
				}
				lines.push(`   ${p.url}`);
				return lines.join("\n");
			})
			.join("\n\n");

		chunks.push(`${header}\n${body}`);
	}

	if (opts.errors?.length) {
		chunks.push(`Partial failure: ${opts.errors.join("; ")}`);
	}
	return chunks.join("\n\n");
}
