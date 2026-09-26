"""Query the Darwin MongoDB Atlas paper corpus.

Run by the harness (`corpus.rs`), never by Pi. The connection string arrives in
`MONGODB_URI` from the environment the harness constructs — so the credential
lives in Rust and this subprocess, and never in agent-authored code. Reads a
query from `DARWIN_CORPUS_QUERY` and prints one JSON object to stdout:

    {"results": [ {source_id, title, type, authors, arxiv_id, ...}, ... ]}

Matching is term-OR across the fields a source carries, ranked by how many query
terms hit. An empty query returns the whole (small) corpus. The collection is
`darwin_evaluation.sources`, the store the hackathon cluster keeps papers in.
"""

import json
import os
import re
import sys

DB_NAME = "darwin_evaluation"
COLLECTION = "sources"
FIELDS = ["title", "role", "key_points", "authors", "source_id", "type"]


def fail(message: str) -> None:
    print(json.dumps({"error": message}))
    sys.exit(0)  # a clean protocol error, not a crash


try:
    from pymongo import MongoClient
except Exception as exc:  # pragma: no cover - import guard
    fail(f"pymongo is not available in the environment: {exc}")

uri = os.environ.get("MONGODB_URI", "").strip()
if not uri:
    fail("MONGODB_URI is not set; the corpus is not configured")

query = os.environ.get("DARWIN_CORPUS_QUERY", "").strip()
try:
    limit = max(1, min(50, int(os.environ.get("DARWIN_CORPUS_LIMIT", "10"))))
except ValueError:
    limit = 10

terms = [t for t in re.split(r"\s+", query) if t]


def text_of(doc: dict) -> str:
    parts = []
    for f in FIELDS:
        v = doc.get(f)
        if isinstance(v, list):
            parts.extend(str(x) for x in v)
        elif v is not None:
            parts.append(str(v))
    return " \n ".join(parts).lower()


def score(doc: dict) -> int:
    hay = text_of(doc)
    return sum(1 for t in terms if t.lower() in hay)


try:
    client = MongoClient(uri, serverSelectionTimeoutMS=15000)
    col = client[DB_NAME][COLLECTION]
    docs = list(col.find({}, {"embedding": 0}))  # never ship vectors to the agent
except Exception as exc:
    fail(f"could not query the corpus: {exc}")

if terms:
    ranked = sorted(
        ((score(d), d) for d in docs),
        key=lambda pair: pair[0],
        reverse=True,
    )
    matched = [d for s, d in ranked if s > 0][:limit]
    # If nothing matched, fall back to the whole corpus rather than a bare empty
    # result the agent might read as "no papers exist".
    chosen = matched if matched else docs[:limit]
else:
    chosen = docs[:limit]


def present(doc: dict) -> dict:
    arxiv_id = doc.get("arxiv_id")
    key_points = doc.get("key_points") or []
    role = doc.get("role")
    summary_bits = ([role] if role else []) + list(key_points)
    return {
        "source_id": doc.get("source_id"),
        "title": doc.get("title") or "(untitled)",
        "type": doc.get("type"),
        "authors": doc.get("authors") or [],
        "arxiv_id": arxiv_id,
        "published": doc.get("published_date"),
        "role": role,
        "key_points": key_points,
        "summary": " ".join(summary_bits) if summary_bits else None,
        "url": f"https://arxiv.org/abs/{arxiv_id}" if arxiv_id else None,
    }


print(json.dumps({"results": [present(d) for d in chosen]}, default=str))
