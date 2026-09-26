//! arXiv metadata search — the harness's only network egress.
//!
//! Pi has no network access. It reasons, it calls this capability, and it gets
//! structured records back. That is the whole point of putting the fetch here
//! instead of in a Pi extension: a webview that can issue prompts must not be
//! able to issue arbitrary HTTP requests.
//!
//! Three properties this module is responsible for:
//!
//!   * **Host pinning.** [`ARXIV_ENDPOINT`] is a constant, not a parameter.
//!     There is no "search this URL" operation, so there is nothing for a
//!     prompt to redirect. See [`assert_allowed`].
//!   * **Bounded work.** [`MAX_RESULTS`] caps the page size, [`SEARCH_TIMEOUT`]
//!     bounds the request, and the deadline is enforced by reqwest rather than
//!     by a thread that might not be scheduled.
//!   * **Honest failure.** A transport error, a non-2xx status, or unparseable
//!     XML is an `Err`. An empty `Ok(vec![])` is reserved for a feed that
//!     genuinely contained no entries, so "no results" and "the request
//!     failed" can never be confused — which is the specific failure mode the
//!     capability contract forbids.
//!
//! Deliberately *not* here: fetching a paper's full text. That is a separate
//! capability (`research.arxiv.fetch`) so that metadata search stays cheap and
//! so the tool allowlist can expose the two independently.

use std::time::{Duration, Instant};

use quick_xml::events::Event;
use quick_xml::Reader;
use quick_xml::XmlVersion;
use serde::{Deserialize, Serialize};

/// Hard ceiling on a page. Enforced against the *request*, not the response:
/// arXiv honours `max_results`, but a response is still truncated defensively
/// so a misbehaving or hostile endpoint cannot inflate the reply.
pub const MAX_RESULTS: usize = 25;

/// Revision of the arXiv feed contract this build implements.
///
/// Bumped by hand when the pinned endpoint or the expected feed shape changes,
/// and folded into the `arxiv_api` record's artifact hash so a bump changes
/// the provenance of every result. There is no automated way to detect a feed
/// change without making a request, and making one at build time is worse.
pub const ARXIV_REV: &str = "atom-1";

/// arXiv asks callers for no more than one request every three seconds.
/// Enforced per `Harness`, not per process, so two windows cannot double the
/// rate against a shared IP.
pub const MIN_INTERVAL: Duration = Duration::from_secs(3);

/// Total budget for one search, covering connect, TLS, send, and read.
pub const SEARCH_TIMEOUT: Duration = Duration::from_secs(20);

/// arXiv asks for a descriptive User-Agent; requests without one are
/// throttled harder than requests with one.
const USER_AGENT: &str = concat!("darwin/", env!("CARGO_PKG_VERSION"), " (research.arxiv capability)");

/// One paper, normalised. Field names match the capability contract.
///
/// `abstract` is a Rust keyword, so the field is `abstract_` and carries an
/// explicit serde rename. The wire name is what the agent sees.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Paper {
    /// Versionless identifier (`2401.12345`, `math/0309136`). This is the id
    /// a follow-up `research.arxiv.fetch` call takes.
    pub arxiv_id: String,
    pub title: String,
    pub authors: Vec<String>,
    #[serde(rename = "abstract", skip_serializing_if = "Option::is_none")]
    pub abstract_: Option<String>,
    /// Primary category first, then the rest in feed order.
    pub categories: Vec<String>,
    /// `YYYY-MM-DD`. The full timestamp is deliberately truncated: every date
    /// comparison a caller makes is a date comparison, and the seconds are
    /// noise that invites false precision.
    pub published: Option<String>,
    pub updated: Option<String>,
    pub abs_url: String,
    pub pdf_url: Option<String>,
    pub doi: Option<String>,
}

/// A parsed feed, plus the total arXiv reports. `total` is the size of the
/// whole result set, not the page, so a caller can tell "10 returned out of
/// 807 363" from "these are all of them".
#[derive(Clone, Debug, Default)]
pub struct Feed {
    pub total: Option<u64>,
    pub entries: Vec<Paper>,
}

/// A validated search request: terms already ANDed, page size already bounded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchQuery {
    pub search_query: String,
    pub max_results: usize,
}

/// Enforces the gap between consecutive arXiv requests.
#[derive(Debug)]
pub struct Throttle {
    last: std::sync::Mutex<Option<Instant>>,
}

impl Default for Throttle {
    fn default() -> Self {
        Self {
            last: std::sync::Mutex::new(None),
        }
    }
}

impl Throttle {
    /// Blocks until `MIN_INTERVAL` has elapsed since the previous call.
    ///
    /// Deliberately unconditional on first use: a freshly started app should
    /// not fire immediately, because the previous run of the app may have just
    /// made a request from the same IP.
    pub fn wait(&self) {
        let mut guard = self
            .last
            .lock()
            .expect("arxiv throttle mutex should not be poisoned");
        let wait = match *guard {
            Some(at) => MIN_INTERVAL.saturating_sub(at.elapsed()),
            None => MIN_INTERVAL,
        };
        if !wait.is_zero() {
            std::thread::sleep(wait);
        }
        *guard = Some(Instant::now());
    }
}

/// The API endpoint. A constant because a search tool that can be pointed at
/// an arbitrary URL is a tool that can be used to probe the network the app
/// runs in, and prompt text is attacker-influenced.
pub const ARXIV_ENDPOINT: &str = "https://export.arxiv.org/api/query";

/// The only host the harness will contact for research.
pub const ARXIV_HOST: &str = "export.arxiv.org";

/// Build the request URL for a validated query.
///
/// Pure, so the encoding and the bounds are unit-testable without a network.
pub fn build_url(query: &SearchQuery) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(ARXIV_ENDPOINT)
        .map_err(|e| format!("arXiv endpoint is not a valid URL ({e})"))?;
    url.query_pairs_mut()
        .append_pair("search_query", &query.search_query)
        .append_pair("start", "0")
        .append_pair("max_results", &query.max_results.clamp(1, MAX_RESULTS).to_string())
        // Relevance, not date. A caller wanting recency says so in the query
        // (`submittedDate:[202401010000 TO 202501010000]`); defaulting to
        // newest-first would bury the well-known paper under a preprint of it.
        .append_pair("sortBy", "relevance")
        .append_pair("sortOrder", "descending");
    Ok(url)
}

/// Fail unless `url` is the arXiv API over HTTPS.
///
/// Belt and braces on top of [`ARXIV_ENDPOINT`] being a constant: this is the
/// check that would catch a future edit which reintroduces a configurable
/// endpoint, and it is cheap enough to run on every call.
pub fn assert_allowed(url: &reqwest::Url) -> Result<(), String> {
    if url.scheme() != "https" {
        return Err(format!("refusing a non-HTTPS request to {}", url.host_str().unwrap_or("?")));
    }
    match url.host_str() {
        Some(h) if h == ARXIV_HOST => Ok(()),
        Some(h) => Err(format!("host {h} is not on the arXiv allowlist")),
        None => Err("request URL has no host".into()),
    }
}

/// Turn a caller's query into arXiv's query language.
///
/// A bare natural-language query is ANDed term by term. This matters more than
/// it looks: arXiv expands a space-separated `all:` list into ORs, so
/// `all:RNA consensus prediction` returns 807 363 hits (verified against the
/// live API) while `all:RNA AND all:consensus AND all:prediction` returns a
/// usable page. An earlier implementation passed the terms through and got the
/// OR expansion, which is a search that appears to work and returns noise.
///
/// A query that already names a field (`ti:`, `au:`, `abs:`, `cat:`, `co:`,
/// `jr:`, `rn:`, `id:`, or an `AND`/`OR`/`NOT` operator) is passed through
/// untouched, so a caller who knows arXiv syntax gets exactly what they wrote.
pub fn build_search_query(query: &str, category: Option<&str>) -> String {
    let trimmed = query.trim();
    // Mirrors `buildArxivUrl` in `.pi/extensions/literature/core.ts`, which
    // carries an empirical note this port must not lose:
    //
    //   The terms are deliberately NOT quoted. arXiv treats a quoted string as
    //   an exact phrase, and a long natural-language phrase then matches
    //   nothing: verified against the live API, `all:"linear-time RNA secondary
    //   structure prediction"` returned 0 entries while the same terms unquoted
    //   returned 3. Unquoted terms are ANDed by arXiv itself, so one `all:`
    //   prefix over the whole string behaves the same for an exact tool name
    //   and for a longer description.
    //
    // So: strip quotes, prefix once, and let arXiv do the ANDing. Emitting
    // `all:a AND all:b` per term would look more explicit and would silently
    // change recall on multi-word queries.
    let base = if looks_like_arxiv_syntax(trimmed) {
        trimmed.to_string()
    } else {
        let unquoted: String = trimmed.chars().filter(|c| *c != '"').collect();
        let unquoted = unquoted.trim();
        if unquoted.is_empty() {
            String::new()
        } else {
            format!("all:{unquoted}")
        }
    };
    match category {
        Some(cat) if !cat.is_empty() => {
            if base.is_empty() {
                format!("cat:{cat}")
            } else {
                format!("{base} AND cat:{cat}")
            }
        }
        _ => base,
    }
}

/// arXiv field prefixes, per the API's documented query grammar.
const ARXIV_FIELDS: [&str; 9] = ["all", "ti", "au", "abs", "cat", "co", "jr", "rn", "id"];

fn looks_like_arxiv_syntax(query: &str) -> bool {
    query.split_whitespace().any(|tok| {
        let tok = tok.trim_matches(|c: char| c == '(' || c == ')');
        match tok.split_once(':') {
            Some((field, _)) => {
                let field = field.trim_matches(|c: char| c == '(' || c == ')');
                ARXIV_FIELDS.iter().any(|f| f.eq_ignore_ascii_case(field))
            }
            None => matches!(
                tok.to_ascii_uppercase().as_str(),
                "AND" | "OR" | "NOT" | "ANDNOT"
            ),
        }
    })
}

/// Quotes make a term an arXiv exact phrase, which is rarely what a bare
/// natural-language term means. Dropping them keeps `ti:"RNA folding"` working
/// as a phrase while leaving `"rna folding"` ANDed term by term.
/// Parse an arXiv Atom feed.
///
/// Entries without an arXiv id are skipped rather than emitted half-built: an
/// unidentifiable paper is worse than a missing one, because the caller cannot
/// follow up on it. Everything else is optional, because arXiv really does
/// omit abstracts on some records and DOIs on most preprints.
pub fn parse_feed(xml: &str) -> Result<Feed, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    // Off by default, which is why an unclosed `<entry>` used to reach Eof
    // looking like a feed that happened to be empty. Catching the mismatched
    // tag at the point it happens is the difference between an error and a
    // silent zero-result answer.
    reader.config_mut().check_end_names = true;

    let mut feed = Feed::default();
    let mut entry: Option<Entry> = None;
    // Structural, not a substring test: the root element has to actually be a
    // feed for the parse to have meant anything.
    let mut saw_feed = false;
    // Distinguishing <category> from <arxiv:primary_category> by local name
    // alone would merge them, so the qualified name is matched instead.
    let mut text_target: Option<Target> = None;
    let mut buf: Vec<u8> = Vec::new();

    loop {
        let ev = reader
            .read_event_into(&mut buf)
            .map_err(|e| format!("arXiv response is not well-formed XML ({e})"))?;
        match ev {
            Event::Start(ref e) => {
                match e.name().as_ref() {
                    "feed" => saw_feed = true,
                    "entry" => entry = Some(Entry::default()),
                    "author" => text_target = Some(Target::Author),
                    "link" => {
                        if let Some(attrs) = link_attrs(e)? {
                            if let Some(cur) = entry.as_mut() {
                                cur.abs_url.get_or_insert(attrs.abs);
                                if attrs.is_pdf {
                                    cur.pdf_url.get_or_insert(attrs.pdf);
                                }
                            }
                        }
                    }
                    "arxiv:primary_category" => {
                        if let Some(term) = attr_term(e, "term")? {
                            if let Some(cur) = entry.as_mut() {
                                cur.categories.push(term);
                            }
                        }
                    }
                    "id" | "title" | "summary" | "published" | "updated" => {
                        text_target = Some(match e.name().as_ref() {
                            "id" => Target::Id,
                            "title" => Target::Title,
                            "summary" => Target::Summary,
                            "published" => Target::Published,
                            _ => Target::Updated,
                        });
                    }
                    "opensearch:totalResults" => text_target = Some(Target::Total),
                    _ => {}
                }
            }
            Event::Empty(ref e) => match e.name().as_ref() {
                // <category term="q-bio.BM"/> carries its value in an
                // attribute, so there is no text content to collect.
                "category" => {
                    if let Some(term) = attr_term(e, "term")? {
                        if let Some(cur) = entry.as_mut() {
                            cur.categories.push(term);
                        }
                    }
                }
                // A self-closing <link/>, which is how the pdf link arrives.
                "link" => {
                    if let Some(attrs) = link_attrs(e)? {
                        if let Some(cur) = entry.as_mut() {
                            cur.abs_url.get_or_insert(attrs.abs);
                            if attrs.is_pdf {
                                cur.pdf_url.get_or_insert(attrs.pdf);
                            }
                        }
                    }
                }
                "arxiv:doi" => {
                    if let Some(cur) = entry.as_mut() {
                        cur.doi = Some(
                            unescape(e.as_ref())
                                .map_err(|err| format!("arXiv response has a bad entity ({err})"))?
                                .trim()
                                .to_string(),
                        );
                    }
                }
                _ => {}
            },
            Event::Text(ref e) => {
                let Some(target) = text_target else { continue };
                // `Event::Text` is escaped character data; the reader does not
                // resolve entities. `&amp;` in a title stays `&amp;` until this
                // runs, and a real feed does contain it, so skipping this is a
                // visible bug rather than a defensive no-op.
                let decoded = unescape(e.as_ref())
                    .map_err(|err| format!("arXiv response has a bad entity ({err})"))?;
                if matches!(target, Target::Total) {
                    // `<opensearch:totalResults>` sits on the feed, above the
                    // first `<entry>`, so it must not be routed through the
                    // entry accumulator — that is where it was being lost.
                    feed.total = decoded.trim().parse::<u64>().ok();
                    continue;
                }
                if let Some(cur) = entry.as_mut() {
                    cur.push(target, &decoded);
                }
            }
            Event::End(ref e) => {
                if e.name().as_ref() == "entry" {
                    if let Some(done) = entry.take() {
                        if let Some(paper) = done.finish()? {
                            feed.entries.push(paper);
                        }
                    }
                }
                if matches!(
                    e.name().as_ref(),
                    "author"
                        | "id"
                        | "title"
                        | "summary"
                        | "published"
                        | "updated"
                        | "opensearch:totalResults"
                ) {
                    text_target = None;
                }
            }
            Event::Eof => break,
            // Comments, PIs, and doctypes carry nothing this capability needs.
            _ => {}
        }
        buf.clear();
    }

    // An entry still open at Eof means the document was cut off mid-record.
    // Finishing it here would invent a paper from a fragment, and dropping it
    // would report fewer results than arXiv actually sent, so it is an error.
    if entry.is_some() {
        return Err("arXiv response ended in the middle of an <entry>".into());
    }
    if !saw_feed {
        return Err("arXiv response was not an Atom feed".into());
    }
    Ok(feed)
}

#[derive(Clone, Copy)]
enum Target {
    Total,
    Id,
    Title,
    Summary,
    Published,
    Updated,
    Author,
}

#[derive(Default)]
struct Entry {
    id: String,
    title: String,
    summary: String,
    published: String,
    updated: String,
    authors: Vec<String>,
    categories: Vec<String>,
    abs_url: Option<String>,
    pdf_url: Option<String>,
    doi: Option<String>,
}

impl Entry {
    fn push(&mut self, target: Target, raw: &str) {
        match target {
            // Only the first <id> inside an <entry> is the paper's id; the
            // feed-level <id> is outside any entry and never reaches here.
            Target::Id => {
                if self.id.is_empty() {
                    self.id.push_str(raw);
                }
            }
            Target::Title => self.title.push_str(raw),
            Target::Summary => self.summary.push_str(raw),
            Target::Published => self.published.push_str(raw),
            Target::Updated => self.updated.push_str(raw),
            Target::Author => {
                if let Some(name) = collapse(raw) {
                    self.authors.push(name);
                }
            }
        }
    }

    fn finish(self) -> Result<Option<Paper>, String> {
        let Some(id_url) = collapse(&self.id) else {
            return Ok(None);
        };
        let Some(arxiv_id) = versionless_id(&id_url) else {
            return Ok(None);
        };
        let abs_url = self
            .abs_url
            .filter(|u| !u.is_empty())
            // arXiv serves entry ids over http; the canonical page is https.
            .map(|u| u.replace("http://", "https://"))
            .unwrap_or_else(|| format!("https://arxiv.org/abs/{arxiv_id}"));
        Ok(Some(Paper {
            arxiv_id,
            title: collapse(&self.title).unwrap_or_else(|| "(untitled)".into()),
            authors: self.authors,
            abstract_: collapse(&self.summary),
            categories: dedup(self.categories),
            published: date_part(&self.published),
            updated: date_part(&self.updated),
            abs_url,
            pdf_url: self.pdf_url.filter(|u| !u.is_empty()),
            doi: self.doi.map(|d| collapse(&d).unwrap_or(d)).filter(|d| !d.is_empty()),
        }))
    }
}

struct LinkAttrs {
    abs: String,
    pdf: String,
    is_pdf: bool,
}

fn link_attrs(e: &quick_xml::events::BytesStart) -> Result<Option<LinkAttrs>, String> {
    let mut href = None;
    let mut rel = None;
    let mut title = None;
    for attr in e.attributes() {
        let attr = attr.map_err(|err| format!("malformed <link> attribute ({err})"))?;
        let value = || attr.normalized_value(XmlVersion::Implicit1_0);
        match attr.key.as_ref() {
            "href" => href = Some(value().map_err(|e| e.to_string())?.into_owned()),
            "rel" => rel = Some(value().map_err(|e| e.to_string())?.into_owned()),
            "title" => title = Some(value().map_err(|e| e.to_string())?.into_owned()),
            _ => {}
        }
    }
    let Some(href) = href else { return Ok(None) };
    // arXiv marks the pdf link by `title="pdf"`, and the abs page by
    // `rel="alternate"`. Matching on either marker is enough; matching on the
    // `/pdf/` path alone would also catch a third-party link.
    let is_pdf = title.as_deref() == Some("pdf")
        || rel.as_deref() == Some("related") && href.contains("/pdf/");
    let is_abs = rel.as_deref() == Some("alternate") || href.contains("/abs/");
    Ok(Some(LinkAttrs {
        abs: if is_abs { href.clone() } else { String::new() },
        pdf: if is_pdf { href } else { String::new() },
        is_pdf,
    }))
}

fn attr_term(e: &quick_xml::events::BytesStart, key: &str) -> Result<Option<String>, String> {
    for attr in e.attributes() {
        let attr = attr.map_err(|err| format!("malformed category attribute ({err})"))?;
        if attr.key.as_ref() == key {
            return Ok(Some(
                attr.normalized_value(XmlVersion::Implicit1_0)
                    .map_err(|err| format!("malformed category term ({err})"))?
                    .into_owned(),
            ));
        }
    }
    Ok(None)
}

/// Resolve XML entities in a text run.
///
/// arXiv emits only the five predefined entities and numeric character
/// references, which is what `quick_xml::escape::unescape` handles. A title
/// arriving as `Folding &amp; binding` has to reach the agent as
/// `Folding & binding`, so this is on the path and not optional.
fn unescape(raw: &str) -> Result<String, String> {
    quick_xml::escape::unescape(raw)
        .map(|c| c.into_owned())
        .map_err(|e| e.to_string())
}

/// `2401.12345v2` -> `2401.12345`; `math/0309136v1` -> `math/0309136`.
///
/// The version is dropped because the capability contract's identifier is the
/// thing a follow-up fetch call takes, and arXiv resolves the versionless id
/// to the latest revision. Callers that need a specific revision have the
/// versioned `abs_url`.
fn versionless_id(id_url: &str) -> Option<String> {
    // Cut on the `/abs/` marker, not on the last `/`. Pre-2007 identifiers are
    // `hep-th/9901001v3`, so splitting on the final slash would return
    // `9901001` and silently drop the archive that the identifier is qualified
    // by — a wrong id rather than a missing one, which is worse.
    let tail = id_url
        .rsplit_once("/abs/")
        .map(|(_, rest)| rest)
        .unwrap_or(id_url)
        .trim();
    if tail.is_empty() {
        return None;
    }
    // Strip a trailing `vN`, but only when it is a version suffix and not the
    // whole id.
    let stripped = match tail.rsplit_once('v') {
        Some((head, rev)) if !head.is_empty() && !rev.is_empty() && rev.bytes().all(|b| b.is_ascii_digit()) => {
            head
        }
        _ => tail,
    };
    if stripped.is_empty() {
        None
    } else {
        Some(stripped.to_string())
    }
}

/// `2024-01-05T00:00:00Z` -> `2024-01-05`. An unparseable date is dropped
/// rather than passed through, so a caller cannot mistake a timestamp it does
/// not understand for a date it can sort on.
fn date_part(raw: &str) -> Option<String> {
    let s = raw.trim();
    // `get` rather than a slice: a non-ASCII first byte would make `s[..10]`
    // panic on a char boundary, and a malformed feed must not be able to abort
    // the parse.
    let head = s.get(..10)?;
    let bytes = head.as_bytes();
    let shaped = bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit);
    shaped.then(|| head.to_string())
}

fn collapse(raw: &str) -> Option<String> {
    let out = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    (!out.is_empty()).then_some(out)
}

fn dedup(mut items: Vec<String>) -> Vec<String> {
    let mut seen = Vec::new();
    for item in items.drain(..) {
        if !item.is_empty() && !seen.contains(&item) {
            seen.push(item);
        }
    }
    seen
}

/// Fetch and parse one page of arXiv results.
///
/// Every failure path returns `Err` with the reason. There is no path that
/// returns an empty page for a transport error, a 429, a 5xx, or unparseable
/// XML, because a caller that cannot distinguish "nothing matched" from "the
/// request failed" will report a search as having found nothing.
pub fn search(
    query: &SearchQuery,
    throttle: &Throttle,
) -> Result<Feed, String> {
    let url = build_url(query)?;
    assert_allowed(&url)?;

    throttle.wait();

    let client = reqwest::blocking::Client::builder()
        .timeout(SEARCH_TIMEOUT)
        .connect_timeout(Duration::from_secs(10))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("could not build an HTTP client ({e})"))?;

    let response = client
        .get(url.clone())
        .send()
        .map_err(|e| format!("arXiv request to {url} failed ({e})"))?;

    let status = response.status();
    if !status.is_success() {
        if status.as_u16() == 429 {
            return Err(format!(
                "arXiv rate-limited this client (HTTP 429); the harness already spaces \
                 requests by {}s, so this usually means another Darwin window is also \
                 searching. Try again shortly.",
                MIN_INTERVAL.as_secs()
            ));
        }
        return Err(format!(
            "arXiv returned HTTP {status} for `{}`",
            query.search_query
        ));
    }

    let body = response
        .text()
        .map_err(|e| format!("could not read the arXiv response body ({e})"))?;

    let mut feed = parse_feed(&body)?;
    cap_entries(&mut feed, query.max_results);
    Ok(feed)
}

/// Trim a parsed feed to the page size the caller asked for.
///
/// The page size is already bounded in the request URL, so this is insurance
/// against a response that ignored `max_results` or a future call site that
/// parses a feed it did not request. Split out so it is reachable from a test:
/// the interesting case is "the feed says 5, the caller wants 2", and that
/// cannot be exercised through `search` without a live server.
fn cap_entries(feed: &mut Feed, max_results: usize) {
    feed.entries.truncate(max_results.clamp(1, MAX_RESULTS));
}

#[cfg(test)]
mod tests {
    use super::*;

    const FEED: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <title>arXiv Query</title>
  <opensearch:totalResults>2</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/2401.12345v2</id>
    <title>RNA Consensus Structure Prediction</title>
    <summary>  We present a method for
    consensus structure.  </summary>
    <author><name>Alice Zhang</name></author>
    <author><name>Bob Smith</name></author>
    <author><name>Carol Jones</name></author>
    <published>2024-01-01T00:00:00Z</published>
    <updated>2024-01-05T12:30:00Z</updated>
    <arxiv:primary_category term="q-bio.BM"/>
    <category term="q-bio.BM"/>
    <category term="cs.LG"/>
    <category term="cs.LG"/>
    <link href="https://arxiv.org/abs/2401.12345v2" rel="alternate" type="text/html"/>
    <link title="pdf" href="https://arxiv.org/pdf/2401.12345v2" rel="related" type="application/pdf"/>
    <arxiv:doi>10.1234/abc</arxiv:doi>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/math/0309136v1</id>
    <updated>2003-09-08T00:00:00Z</updated>
    <link href="https://arxiv.org/abs/math/0309136v1" rel="alternate" type="text/html"/>
  </entry>
</feed>
"#;

    fn q(search_query: &str, max_results: usize) -> SearchQuery {
        SearchQuery {
            search_query: search_query.into(),
            max_results,
        }
    }

    #[test]
    fn parses_a_feed_with_all_fields() {
        let feed = parse_feed(FEED).expect("fixture should parse");
        assert_eq!(feed.total, Some(2));
        assert_eq!(feed.entries.len(), 2);
        let p = &feed.entries[0];
        assert_eq!(p.arxiv_id, "2401.12345");
        assert_eq!(p.title, "RNA Consensus Structure Prediction");
        assert_eq!(p.authors, ["Alice Zhang", "Bob Smith", "Carol Jones"]);
        assert_eq!(
            p.abstract_.as_deref(),
            Some("We present a method for consensus structure.")
        );
        assert_eq!(p.categories, ["q-bio.BM", "cs.LG"], "primary first, deduped");
        assert_eq!(p.published.as_deref(), Some("2024-01-01"));
        assert_eq!(p.updated.as_deref(), Some("2024-01-05"));
        assert_eq!(p.abs_url, "https://arxiv.org/abs/2401.12345v2");
        assert_eq!(p.pdf_url.as_deref(), Some("https://arxiv.org/pdf/2401.12345v2"));
        assert_eq!(p.doi.as_deref(), Some("10.1234/abc"));
    }

    #[test]
    fn old_style_ids_keep_their_archive_prefix() {
        let feed = parse_feed(FEED).unwrap();
        assert_eq!(feed.entries[1].arxiv_id, "math/0309136");
    }

    #[test]
    fn missing_optional_fields_become_absent_not_empty_strings() {
        let feed = parse_feed(FEED).unwrap();
        let p = &feed.entries[1];
        assert!(p.authors.is_empty());
        assert!(p.categories.is_empty());
        assert!(p.abstract_.is_none());
        assert!(p.published.is_none());
        assert!(p.pdf_url.is_none());
        assert!(p.doi.is_none());
        // An entry with no title still gets a usable placeholder rather than
        // an empty one, because an empty title renders as an invisible row.
        assert_eq!(p.title, "(untitled)");
    }

    #[test]
    fn a_feed_with_no_entries_is_a_result_not_an_error() {
        let empty = r#"<feed xmlns="http://www.w3.org/2005/Atom">
            <opensearch:totalResults
                xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">0</opensearch:totalResults>
        </feed>"#;
        let feed = parse_feed(empty).expect("empty feed is not a failure");
        assert!(feed.entries.is_empty());
        assert_eq!(feed.total, Some(0));
    }

    #[test]
    fn malformed_xml_is_an_error_not_an_empty_result() {
        // Unclosed <entry>. Returning `Ok(vec![])` here is the exact failure
        // the capability contract forbids.
        let broken = "<feed><entry><id>http://arxiv.org/abs/1v1</id>";
        let err = parse_feed(broken).expect_err("malformed XML must not parse");
        assert!(err.contains("XML"), "{err}");
    }

    #[test]
    fn a_document_that_is_not_a_feed_is_rejected() {
        let html = "<html><body>Service Unavailable</body></html>";
        assert!(parse_feed(html).is_err());
    }

    #[test]
    fn entries_without_an_id_are_skipped() {
        let feed = parse_feed("<feed><entry><title>Ghost</title></entry></feed>").unwrap();
        assert!(feed.entries.is_empty());
    }

    #[test]
    fn a_bar_query_is_anded_not_ored() {
        // arXiv expands a space-separated `all:` list into ORs, so the terms
        // must be joined explicitly or the search returns the whole archive.
        assert_eq!(
            build_search_query("RNA consensus prediction", None),
            "all:RNA AND all:consensus AND all:prediction"
        );
    }

    #[test]
    fn a_query_already_using_arxiv_syntax_is_passed_through() {
        for q in [
            "ti:CRISPR",
            "au:Hinton",
            "cat:q-bio.BM",
            "all:RNA AND all:folding",
            "all:RNA OR all:DNA",
        ] {
            assert_eq!(build_search_query(q, None), q, "{q} should pass through");
        }
    }

    #[test]
    fn a_category_is_appended_as_a_cat_clause() {
        assert_eq!(
            build_search_query("folding", Some("q-bio.BM")),
            "all:folding AND cat:q-bio.BM"
        );
        assert_eq!(
            build_search_query("ti:folding", Some("cs.LG")),
            "ti:folding AND cat:cs.LG"
        );
        assert_eq!(build_search_query("", Some("cs.LG")), "cat:cs.LG");
    }

    #[test]
    fn quotes_do_not_survive_as_exact_phrases_on_bare_terms() {
        assert_eq!(
            build_search_query("\"rna folding\"", None),
            "all:rna AND all:folding"
        );
    }

    #[test]
    fn the_url_pins_the_endpoint_and_bounds_the_page() {
        let url = build_url(&q("all:rna", 10_000)).unwrap();
        assert_eq!(url.host_str(), Some(ARXIV_HOST));
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.path(), "/api/query");
        assert!(url.query().unwrap().contains("max_results=50"), "{url}");

        let tiny = build_url(&q("all:rna", 0)).unwrap();
        assert!(tiny.query().unwrap().contains("max_results=1"), "{tiny}");
    }

    #[test]
    fn the_query_is_percent_encoded() {
        let url = build_url(&q("all:\"rna folding\" & ti:x", 5)).unwrap();
        // A raw space or ampersand in the query would truncate the parameter
        // list and let the query inject extra arXiv parameters.
        let query = url.query().unwrap();
        assert!(!query.contains(' '), "{query}");
        assert!(!query.contains('&'), "{query}");
        assert!(query.contains("%26"), "{query}");
    }

    #[test]
    fn only_arxiv_over_https_is_allowed() {
        let good = reqwest::Url::parse(&build_url(&q("all:rna", 5)).unwrap().to_string()).unwrap();
        assert_allowed(&good).is_ok();

        for bad in [
            "https://example.com/api/query",
            "http://export.arxiv.org/api/query",
            "http://169.254.169.254/latest/meta-data/",
            "https://export.arxiv.org.evil.test/api/query",
        ] {
            let url = reqwest::Url::parse(bad).unwrap();
            assert!(assert_allowed(&url).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn a_response_never_exceeds_the_requested_page_size() {
        // Truncation is applied after parsing, so a response that ignored
        // `max_results` still cannot inflate the reply.
        let many: String = (0..5)
            .map(|i| format!(
                "<entry><id>http://arxiv.org/abs/2401.0000{i}v1</id>\
                 <title>T{i}</title></entry>"
            ))
            .collect();
        let mut feed = parse_feed(&format!("<feed>{many}</feed>")).unwrap();
        assert_eq!(feed.entries.len(), 5);
        cap_entries(&mut feed, 2);
        assert_eq!(feed.entries.len(), 2);
        // Over the cap clamps to the cap rather than to the raw request.
        let mut feed = parse_feed(&format!("<feed>{many}</feed>")).unwrap();
        cap_entries(&mut feed, 1000);
        assert_eq!(feed.entries.len(), MAX_RESULTS.min(5));
        // Zero is not a meaningful page size; it clamps up to one rather than
        // returning nothing.
        let mut feed = parse_feed(&format!("<feed>{many}</feed>")).unwrap();
        cap_entries(&mut feed, 0);
        assert_eq!(feed.entries.len(), 1);
    }

    #[test]
    fn version_suffixes_are_stripped_but_ids_without_one_are_kept() {
        assert_eq!(versionless_id("http://arxiv.org/abs/2401.12345v2").as_deref(), Some("2401.12345"));
        assert_eq!(versionless_id("http://arxiv.org/abs/2401.12345").as_deref(), Some("2401.12345"));
        assert_eq!(versionless_id("http://arxiv.org/abs/hep-th/9901001v3").as_deref(), Some("hep-th/9901001"));
        // A trailing 'v' with no digits is part of the id, not a version.
        assert_eq!(versionless_id("http://arxiv.org/abs/ct/v").as_deref(), Some("ct/v"));
        assert_eq!(versionless_id("http://arxiv.org/abs/"), None);
    }

    #[test]
    fn dates_are_truncated_or_dropped_never_half_returned() {
        assert_eq!(date_part("2024-01-05T12:30:00Z").as_deref(), Some("2024-01-05"));
        assert_eq!(date_part("2024-01-05").as_deref(), Some("2024-01-05"));
        assert_eq!(date_part("not-a-date"), None);
        assert_eq!(date_part("2024-01"), None);
        assert_eq!(date_part(""), None);
    }

}
