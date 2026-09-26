/**
 * GitHub repository search core.
 *
 * Deliberately free of any Pi import so it can be unit-tested with `node:test`
 * outside the agent runtime. The extension file is a thin wrapper over this.
 *
 * Scope is the public repository-search API and nothing else. This finds
 * candidate implementations; it never clones, builds or runs them. Executing a
 * repository is a separate capability with its own validation, and conflating
 * the two would turn a read-only search into arbitrary code execution.
 *
 * Reads the search endpoint's documented JSON shape. See `fixtures/` for
 * responses captured from the live API.
 */

export interface Repository {
	full_name: string;
	name: string;
	owner: string;
	url: string;
	description?: string;
	default_branch?: string;
	language?: string;
	stars?: number;
	forks?: number;
	open_issues?: number;
	updated_at?: string;
	topics?: string[];
	license?: string;
	archived?: boolean;
	fork?: boolean;
}

/**
 * The only host this module will contact. A search tool that can be pointed
 * anywhere is a tool that can exfiltrate the query string to anywhere, so the
 * allowlist is enforced here rather than left to the call sites.
 */
const ALLOWED_HOSTS = new Set(["api.github.com"]);

/** Unauthenticated search is 10 requests/minute, so pace calls to stay under it. */
const MIN_INTERVAL_MS = 1000;

/** GitHub's search endpoint rejects `per_page` above 100. */
const MAX_RESULTS = 100;
const DEFAULT_MAX_RESULTS = 8;
const TIMEOUT_MS = 20_000;

export class GithubError extends Error {}

// --- text helpers ------------------------------------------------------------

export function collapse(input: string): string {
	return input.replace(/\s+/g, " ").trim();
}

export function truncate(input: string, max: number): string {
	if (input.length <= max) return input;
	return `${input.slice(0, max).trimEnd()}… [truncated]`;
}

// --- query construction -------------------------------------------------------

/**
 * Qualifiers that mean the caller already wrote a real GitHub query. Anything
 * containing one of these is passed through untouched, so the model can always
 * escape the naive translation below by being explicit.
 */
const GITHUB_QUALIFIER =
	/(^|\s)(language|topics?|user|org|repo|in|is|size|stars|forks|created|pushed|license|archived|fork|mirror|good-first-issues|help-wanted):/i;

/**
 * Wording that belongs to the *request*, not to the repository being looked
 * for. "Find an implementation of RNA consensus folding" and "RNA consensus
 * folding" should reach GitHub as the same query.
 *
 * Deliberately conservative: domain words — algorithm, method, folding,
 * sequence, structure — are all preserved, because dropping them changes what
 * is being searched for and a wrong-but-plausible query is worse than a
 * slightly noisy one. `tool`/`tools` is the one domain-ish word treated as
 * request wording, because GitHub ANDs terms and a repo called `tools`
 * otherwise crowds out the one actually implementing the method.
 */
const FILLER = new Set([
	// request framing
	"a", "an", "the", "and", "or", "of", "for", "in", "on", "to", "with", "from",
	"that", "this", "these", "those", "is", "are", "was", "were", "be", "been",
	"by", "as", "at", "it", "its", "i", "we", "you", "me", "my", "our", "their",
	"them", "they", "can", "could", "would", "should", "please", "find", "show",
	"get", "search", "searching", "look", "looking", "locate", "need", "wants",
	"want", "any", "some", "all", "there", "which", "what", "how", "do", "does",
	"did", "have", "has", "had", "about", "into", "than", "then", "so", "if",
	"but", "not", "also", "just", "very", "only", "same", "such", "own", "into",
	"use", "using", "used", "help", "me", "can", "you", "please",
	// meta-nouns: how the request is phrased, never what the repo contains
	"github", "repository", "repositories", "repo", "repos", "codebase",
	"implementation", "implementations", "implement", "implements",
	"implementing", "implemented", "source", "sources", "tool", "tools",
]);

/**
 * Reduce natural language to search terms. Not a query planner: it removes
 * request wording, preserves domain words, and steps aside entirely when the
 * caller used GitHub's own qualifier syntax.
 */
export function buildSearchQuery(query: string): string {
	const trimmed = query.trim();
	if (GITHUB_QUALIFIER.test(trimmed)) return trimmed;

	const terms = trimmed
		// Possessives such as "paper's" are noise in a term search.
		.replace(/['’]s\b/gi, "")
		.split(/[\s,;]+/)
		.map((t) => t.replace(/^[^\w.+#-]+|[^\w.+#-]+$/g, ""))
		.filter((t) => t.length > 1 && !FILLER.has(t.toLowerCase()));

	if (terms.length === 0) {
		throw new GithubError(
			`query ${JSON.stringify(query)} has no searchable terms left after removing request wording`,
		);
	}
	return terms.join(" ");
}

export function buildGithubUrl(query: string, maxResults: number): string {
	const url = new URL("https://api.github.com/search/repositories");
	url.searchParams.set("q", buildSearchQuery(query));
	url.searchParams.set("per_page", String(clampMaxResults(maxResults)));
	return url.toString();
}

export function clampMaxResults(maxResults: number | undefined): number {
	if (!Number.isFinite(maxResults)) return DEFAULT_MAX_RESULTS;
	return Math.min(MAX_RESULTS, Math.max(1, Math.floor(maxResults as number)));
}

// --- parsing -----------------------------------------------------------------

interface GithubItem {
	full_name?: unknown;
	name?: unknown;
	owner?: { login?: unknown } | null;
	description?: unknown;
	html_url?: unknown;
	default_branch?: unknown;
	language?: unknown;
	stargazers_count?: unknown;
	forks_count?: unknown;
	open_issues_count?: unknown;
	updated_at?: unknown;
	topics?: unknown;
	license?: { spdx_id?: unknown } | null;
	archived?: unknown;
	fork?: unknown;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? collapse(value) : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

/**
 * Map one search item, or `undefined` if it cannot be identified. Fields GitHub
 * did not send are left absent rather than defaulted — an invented `language:
 * "unknown"` is indistinguishable from a real answer once it reaches the model.
 */
function toRepository(item: GithubItem): Repository | undefined {
	const fullName = optionalString(item.full_name);
	if (!fullName) return undefined;

	// `owner.login` is authoritative. Splitting `full_name` is a derivation of
	// the same string, not new information, so it is a safe fallback.
	const owner =
		optionalString(item.owner?.login) ?? optionalString(fullName.split("/")[0]) ?? "";

	const topics = Array.isArray(item.topics)
		? item.topics.filter((t): t is string => typeof t === "string" && t.trim() !== "")
		: [];

	const repo: Repository = {
		full_name: fullName,
		name: optionalString(item.name) ?? fullName.split("/")[1] ?? fullName,
		owner,
		// `html_url` is always present in practice; omit rather than guess if not.
		url: optionalString(item.html_url) ?? "",
	};

	const description = optionalString(item.description);
	if (description !== undefined) repo.description = description;
	const defaultBranch = optionalString(item.default_branch);
	if (defaultBranch !== undefined) repo.default_branch = defaultBranch;
	const language = optionalString(item.language);
	if (language !== undefined) repo.language = language;

	const stars = optionalNumber(item.stargazers_count);
	if (stars !== undefined) repo.stars = stars;
	const forks = optionalNumber(item.forks_count);
	if (forks !== undefined) repo.forks = forks;
	const openIssues = optionalNumber(item.open_issues_count);
	if (openIssues !== undefined) repo.open_issues = openIssues;

	const updatedAt = optionalString(item.updated_at);
	if (updatedAt !== undefined) repo.updated_at = updatedAt;
	if (topics.length > 0) repo.topics = topics;

	const license = optionalString(item.license?.spdx_id);
	if (license !== undefined) repo.license = license;

	const archived = optionalBoolean(item.archived);
	if (archived !== undefined) repo.archived = archived;
	const fork = optionalBoolean(item.fork);
	if (fork !== undefined) repo.fork = fork;

	return repo;
}

/**
 * Parse a search response. A body that is not the documented shape is an error,
 * not an empty result: "GitHub changed its response" and "nothing matched" are
 * very different answers for the agent.
 */
export function parseGithubSearch(payload: unknown): { repositories: Repository[]; total: number } {
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
		throw new GithubError("malformed GitHub response: expected a JSON object");
	}
	const root = payload as { total_count?: unknown; items?: unknown };
	if (!Array.isArray(root.items)) {
		throw new GithubError("malformed GitHub response: `items` is missing or not an array");
	}

	const repositories = (root.items as GithubItem[])
		.map(toRepository)
		.filter((r): r is Repository => r !== undefined);

	const total = optionalNumber(root.total_count) ?? repositories.length;
	return { repositories, total };
}

// --- fetching ----------------------------------------------------------------

const lastRequestAt = { at: undefined as number | undefined };

/** Exposed for tests: clears the throttle state between cases. */
export function __resetThrottle(): void {
	lastRequestAt.at = undefined;
}

type FetchLike = (
	input: string,
	init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{
	ok: boolean;
	status: number;
	text(): Promise<string>;
	headers?: { get(name: string): string | null };
}>;

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
		throw new GithubError(`refusing a non-HTTPS request to ${url.hostname}`);
	}
	if (!ALLOWED_HOSTS.has(url.hostname)) {
		throw new GithubError(`host ${url.hostname} is not on the allowlist`);
	}
	return url;
}

async function throttle(now: () => number, sleep: (ms: number) => Promise<void>): Promise<void> {
	if (lastRequestAt.at !== undefined) {
		const wait = MIN_INTERVAL_MS - (now() - lastRequestAt.at);
		if (wait > 0) await sleep(wait);
	}
	// Stamped after the sleep, not before: stamping the pre-sleep reading
	// measures the gap from the start of the wait, which lets the next call
	// through immediately and burns the unauthenticated budget in seconds.
	lastRequestAt.at = now();
}

/** `GITHUB_TOKEN` first, then `GH_TOKEN`. Never logged, never returned. */
export function resolveToken(env: Record<string, string | undefined>): string | undefined {
	const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
	return token && token.trim() ? token.trim() : undefined;
}

export interface SearchOptions {
	query: string;
	maxResults?: number;
	fetchImpl?: FetchLike;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	timeoutMs?: number;
	env?: Record<string, string | undefined>;
	/** Caller-side cancellation, combined with `timeoutMs`. */
	signal?: AbortSignal;
}

export interface SearchOutcome {
	repositories: Repository[];
	total: number;
	/** The query actually sent, after filler removal. */
	effQuery: string;
	/** Whether a token was sent. The token itself is never included. */
	authenticated: boolean;
}

/**
 * Turn a non-2xx response into a specific error. Every branch here must stay a
 * throw: collapsing any of them into an empty result would tell the agent a
 * repository does not exist when in fact the request was rejected.
 */
function httpError(
	status: number,
	headers: { get(name: string): string | null } | undefined,
	body: string,
	authenticated: boolean,
): GithubError {
	const get = (name: string) => headers?.get(name) ?? null;
	// GitHub's own message is the most useful part when present.
	let detail = "";
	try {
		const parsed = JSON.parse(body) as { message?: unknown };
		if (typeof parsed?.message === "string") detail = `: ${parsed.message}`;
	} catch {
		// Non-JSON error body; the status alone will have to do.
	}

	if (status === 401) {
		return new GithubError(
			"GitHub rejected the credentials (HTTP 401); GITHUB_TOKEN is set but invalid",
		);
	}

	if (status === 403 || status === 429) {
		const remaining = get("x-ratelimit-remaining");
		const reset = get("x-ratelimit-reset");
		if (remaining === "0" || status === 429) {
			const when = reset ? formatReset(reset) : "shortly";
			const limit = authenticated ? "the authenticated" : "the unauthenticated (10/minute)";
			return new GithubError(
				`GitHub rate limit reached for ${limit} search rate; resets ${when}${detail}`,
			);
		}
		return new GithubError(
			`GitHub refused the request (HTTP 403)${detail}. This is usually secondary rate limiting or a blocked user agent.`,
		);
	}

	if (status === 422) {
		return new GithubError(
			`GitHub rejected the query as invalid (HTTP 422)${detail}`,
		);
	}

	return new GithubError(`GitHub returned HTTP ${status}${detail}`);
}

function formatReset(epochSeconds: string): string {
	const ms = Number(epochSeconds) * 1000;
	if (!Number.isFinite(ms)) return "shortly";
	const delta = Math.round((ms - Date.now()) / 1000);
	if (delta <= 0) return "shortly";
	if (delta < 90) return `in ${delta}s`;
	return `in ${Math.round(delta / 60)}m`;
}

export async function searchGithub(opts: SearchOptions): Promise<SearchOutcome> {
	const query = opts.query.trim();
	if (!query) throw new GithubError("query is empty");

	// Throws on a query with no searchable terms, before any request is made.
	const url = buildGithubUrl(query, opts.maxResults ?? DEFAULT_MAX_RESULTS);
	const effQuery = new URL(url).searchParams.get("q") ?? query;

	const env = opts.env ?? {};
	const token = resolveToken(env);
	const authenticated = token !== undefined;

	const resolved = {
		fetchImpl: opts.fetchImpl ?? ((globalThis.fetch as unknown) as FetchLike),
		sleep: opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))),
		now: opts.now ?? (() => Date.now()),
		timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
	};

	assertAllowedHost(url);
	await throttle(resolved.now, resolved.sleep);

	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "darwin-research-harness",
	};
	if (token) headers.Authorization = `Bearer ${token}`;

	// Honour both the deadline and the caller's cancellation, so an abandoned
	// tool call cannot leave a request hanging.
	const timeout = AbortSignal.timeout(resolved.timeoutMs);
	const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

	const res = await resolved.fetchImpl(url, { signal, headers });
	const body = await res.text();

	if (!res.ok) throw httpError(res.status, res.headers, body, authenticated);

	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch (err) {
		throw new GithubError(
			`malformed GitHub response: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// GitHub answers a rejected-but-200 query with `message` and no `items`;
	// parseGithubSearch turns that into a malformed-response error rather than
	// a silent zero.
	const { repositories, total } = parseGithubSearch(payload);
	return { repositories, total, effQuery, authenticated };
}

// --- presentation ------------------------------------------------------------

export interface FormatOptions {
	total?: number;
	query?: string;
}

export function formatRepositories(repos: Repository[], opts: FormatOptions = {}): string {
	if (repos.length === 0) {
		const total = opts.total === undefined ? "" : ` (GitHub reported ${opts.total} total)`;
		return `No repositories found${total}.`;
	}

	const chunks = repos.map((r, idx) => {
		const lines = [`${idx + 1}. ${r.full_name}`];
		if (r.description) lines.push(`   ${truncate(r.description, 300)}`);

		const meta: string[] = [];
		if (r.language) meta.push(r.language);
		if (r.stars !== undefined) meta.push(`${r.stars} stars`);
		if (r.forks !== undefined) meta.push(`${r.forks} forks`);
		if (r.updated_at) meta.push(`updated ${r.updated_at.slice(0, 10)}`);
		if (r.default_branch) meta.push(`branch ${r.default_branch}`);
		if (r.license) meta.push(r.license);
		if (meta.length) lines.push(`   ${meta.join(" · ")}`);

		const flags: string[] = [];
		if (r.archived) flags.push("archived");
		if (r.fork) flags.push("fork");
		if (r.topics?.length) flags.push(`topics: ${r.topics.join(", ")}`);
		if (flags.length) lines.push(`   ${flags.join(" · ")}`);

		lines.push(`   ${r.url}`);
		return lines.join("\n");
	});

	const header =
		opts.total !== undefined && opts.total > repos.length
			? `${repos.length} of ${opts.total} matching repositories`
			: `${repos.length} repositor${repos.length === 1 ? "y" : "ies"}`;

	return `${header}\n${chunks.join("\n\n")}`;
}
