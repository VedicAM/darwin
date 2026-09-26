"""Negative Results Registry for Darwin.

The registry treats failures as reusable scientific artifacts. It deliberately
does not choose a vector-match threshold: callers must calibrate that value on
labeled failures before automatic pattern merging is enabled.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Protocol

ALLOWED_FAILURE_KINDS = frozenset(
    {
        "wrong_answer",
        "tool_error",
        "timeout",
        "parse_failure",
        "hallucinated_citation",
        "abandoned",
        "wrong_route",
        "overconfident",
    }
)
ALLOWED_RESOLUTION_STATUSES = frozenset({"open", "resolved", "dead_end"})


class AsyncCollection(Protocol):
    async def find_one(self, filter: Mapping[str, Any]) -> Mapping[str, Any] | None: ...

    async def update_one(
        self,
        filter: Mapping[str, Any],
        update: Mapping[str, Any],
        *,
        upsert: bool = False,
    ) -> Any: ...

    async def insert_one(self, document: Mapping[str, Any]) -> Any: ...

    def aggregate(self, pipeline: Sequence[Mapping[str, Any]]) -> Any: ...


Extractor = Callable[[Mapping[str, Any]], Awaitable[Mapping[str, str]]]
Embedder = Callable[[str], Awaitable[Sequence[float]]]
SameCauseChecker = Callable[[Mapping[str, Any], Mapping[str, Any]], Awaitable[bool]]


@dataclass(frozen=True)
class RegistryConfig:
    vector_index: str = "nrr_vec"
    embedding_dimensions: int = 1024
    similarity_threshold: float | None = None
    recall_k: int = 3
    meta_recall_k: int = 8
    pitfall_token_budget: int = 120

    def __post_init__(self) -> None:
        if self.recall_k < 0 or self.recall_k > 3:
            raise ValueError("recall_k must be between 0 and 3")
        if self.meta_recall_k < 1:
            raise ValueError("meta_recall_k must be positive")
        if self.embedding_dimensions < 1:
            raise ValueError("embedding_dimensions must be positive")
        if (
            self.similarity_threshold is not None
            and not 0 <= self.similarity_threshold <= 1
        ):
            raise ValueError("similarity_threshold must be between 0 and 1")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalise_text(value: str) -> str:
    return re.sub(r"\s+", " ", value.casefold()).strip()


def contains_task_leakage(
    pattern_text: str, task_texts: Sequence[str], minimum: int = 12
) -> bool:
    """Return True when a pattern copies a long substring from a task or option."""
    candidate = _normalise_text(pattern_text)
    if len(candidate) < minimum:
        return False
    candidate_chunks = {
        candidate[start : start + minimum]
        for start in range(len(candidate) - minimum + 1)
    }
    for task_text in task_texts:
        task = _normalise_text(task_text)
        for start in range(len(task) - minimum + 1):
            if task[start : start + minimum] in candidate_chunks:
                return True
    return False


def trim_pitfall_block(lines: Sequence[str], token_budget: int = 120) -> str:
    """Build a compact pitfall block using a conservative token estimate."""
    heading = "KNOWN PITFALLS FOR THIS KIND OF TASK"
    accepted: list[str] = []
    estimated_tokens = len(heading.split()) * 4 / 3
    for line in lines[:3]:
        clean = re.sub(r"\s+", " ", line).strip()
        cost = (len(clean.split()) + 1) * 4 / 3
        if estimated_tokens + cost > token_budget:
            break
        accepted.append(f"- {clean}")
        estimated_tokens += cost
    return "\n".join([heading, *accepted]) if accepted else ""


async def _collect(cursor: Any) -> list[Mapping[str, Any]]:
    if hasattr(cursor, "to_list"):
        return list(await cursor.to_list(length=None))
    if hasattr(cursor, "__aiter__"):
        return [item async for item in cursor]
    return list(cursor)


class DarwinNegativeResultsRegistry:
    """Atlas-backed failure recording, pattern assignment, recall, and resolution."""

    def __init__(
        self,
        *,
        failures: AsyncCollection,
        patterns: AsyncCollection,
        recall_events: AsyncCollection,
        extractor: Extractor,
        embedder: Embedder,
        same_cause_checker: SameCauseChecker,
        config: RegistryConfig | None = None,
    ) -> None:
        self.failures = failures
        self.patterns = patterns
        self.recall_events = recall_events
        self.extractor = extractor
        self.embedder = embedder
        self.same_cause_checker = same_cause_checker
        self.config = config or RegistryConfig()

    async def record_failure(self, trace: Mapping[str, Any]) -> str:
        """Idempotently record one failed trace, then assign a reusable pattern."""
        trace_id = str(trace.get("trace_id", "")).strip()
        kind = str(trace.get("kind", "")).strip()
        if not trace_id:
            raise ValueError("trace_id is required")
        if kind not in ALLOWED_FAILURE_KINDS:
            raise ValueError(f"Unsupported failure kind: {kind}")

        existing = await self.failures.find_one({"trace_id": trace_id})
        if existing:
            return str(existing.get("_id") or existing.get("failure_id"))

        extracted = await self.extractor(trace)
        root_cause = str(extracted.get("root_cause", "")).strip()
        strategy = str(extracted.get("strategy", "")).strip()
        if not root_cause or not strategy:
            raise ValueError(
                "extractor must return one-sentence root_cause and strategy"
            )

        task_texts = [
            str(trace.get("question", "")),
            *map(str, trace.get("options", [])),
        ]
        if contains_task_leakage(f"{root_cause} {strategy}", task_texts):
            raise ValueError("failure summary leaks task or option text")

        embedding = list(await self.embedder(f"{strategy}\n{root_cause}"))
        self._validate_embedding(embedding)
        failure_id = "f-" + hashlib.sha256(trace_id.encode()).hexdigest()[:16]
        document = {
            "_id": failure_id,
            "trace_id": trace_id,
            "genome_id": trace.get("genome_id"),
            "generation": trace.get("generation"),
            "task_id": trace.get("task_id"),
            "subset": trace.get("subset"),
            "subtask": trace.get("subtask"),
            "profile": trace.get("profile"),
            "kind": kind,
            "approach": {
                "route": trace.get("route"),
                "tools_used": list(trace.get("tools_used", [])),
                "skills_used": list(trace.get("skills_used", [])),
                "strategy": strategy,
            },
            "observed": trace.get("observed"),
            "root_cause": root_cause,
            "cost_usd": trace.get("cost_usd"),
            "wall_ms": trace.get("wall_ms"),
            "pattern_id": None,
            "embedding": embedding,
            "created_at": _now(),
            "schema_version": 1,
        }
        await self.failures.update_one(
            {"trace_id": trace_id}, {"$setOnInsert": document}, upsert=True
        )
        await self.assign_pattern(failure_id)
        return failure_id

    async def assign_pattern(self, failure_id: str) -> str:
        """Attach a calibrated match or create a new open pattern."""
        failure = await self.failures.find_one({"_id": failure_id})
        if not failure:
            raise KeyError(f"Failure not found: {failure_id}")
        if failure.get("pattern_id"):
            return str(failure["pattern_id"])

        matches = await self._pattern_search(
            list(failure["embedding"]), str(failure.get("profile") or ""), 5
        )
        selected: Mapping[str, Any] | None = None
        threshold = self.config.similarity_threshold
        if threshold is not None and matches:
            best = matches[0]
            if float(
                best.get("score", 0.0)
            ) >= threshold and await self.same_cause_checker(failure, best):
                selected = best

        if selected is None:
            pattern_id = (
                "fp-"
                + hashlib.sha256(
                    f"{failure.get('profile')}|{failure.get('root_cause')}".encode()
                ).hexdigest()[:12]
            )
            pattern = {
                "_id": pattern_id,
                "title": str(failure["root_cause"])[:120],
                "trigger": str(
                    failure.get("subtask") or failure.get("profile") or "failure"
                ),
                "failed_approach": failure["approach"]["strategy"],
                "why_it_fails": failure["root_cause"],
                "resolution": {"status": "open"},
                "occurrences": 1,
                "first_seen_generation": failure.get("generation"),
                "last_seen_generation": failure.get("generation"),
                "prevented_count": 0,
                "recurred_after_fix": 0,
                "subsets": [failure.get("subset")] if failure.get("subset") else [],
                "profiles": [failure.get("profile")] if failure.get("profile") else [],
                "example_failure_ids": [failure_id],
                "embedding": failure["embedding"],
                "status": "active",
                "created_at": _now(),
                "updated_at": _now(),
                "schema_version": 1,
            }
            await self.patterns.update_one(
                {"_id": pattern_id}, {"$setOnInsert": pattern}, upsert=True
            )
        else:
            pattern_id = str(selected["_id"])
            await self.patterns.update_one(
                {"_id": pattern_id},
                {
                    "$inc": {"occurrences": 1},
                    "$max": {"last_seen_generation": failure.get("generation")},
                    "$addToSet": {
                        "subsets": failure.get("subset"),
                        "profiles": failure.get("profile"),
                        "example_failure_ids": failure_id,
                    },
                    "$set": {"updated_at": _now()},
                },
            )
        await self.failures.update_one(
            {"_id": failure_id}, {"$set": {"pattern_id": pattern_id}}
        )
        return pattern_id

    async def recall_before_attempt(
        self, task: Mapping[str, Any], profile: str, k: int | None = None
    ) -> list[Mapping[str, Any]]:
        """Recall at most three non-leaking pitfalls before reasoning starts."""
        limit = min(3, self.config.recall_k if k is None else k)
        if limit <= 0:
            return []
        task_texts = [str(task.get("question", "")), *map(str, task.get("options", []))]
        query = str(task.get("subtask") or task.get("description") or profile)
        embedding = list(await self.embedder(query))
        self._validate_embedding(embedding)
        matches = await self._pattern_search(embedding, profile, max(limit * 3, limit))
        safe: list[Mapping[str, Any]] = []
        for pattern in matches:
            text = " ".join(
                str(pattern.get(field, ""))
                for field in ("title", "trigger", "failed_approach", "why_it_fails")
            )
            if contains_task_leakage(text, task_texts):
                continue
            safe.append(pattern)
            if len(safe) == limit:
                break
        return safe

    async def recall_for_meta_agent(
        self, subtask: str, k: int | None = None
    ) -> dict[str, list]:
        limit = k or self.config.meta_recall_k
        embedding = list(await self.embedder(subtask))
        self._validate_embedding(embedding)
        matches = await self._pattern_search(embedding, "", limit)
        result = {"open": [], "resolved": [], "dead_end": []}
        for pattern in matches:
            status = pattern.get("resolution", {}).get("status")
            if status in result:
                result[status].append(pattern)
        return result

    async def mark_dead_end(self, pattern_id: str, evidence: str) -> None:
        if not evidence.strip():
            raise ValueError("evidence is required")
        await self.patterns.update_one(
            {"_id": pattern_id},
            {
                "$set": {
                    "resolution": {"status": "dead_end", "evidence": evidence},
                    "updated_at": _now(),
                }
            },
        )

    async def resolve_pattern(
        self,
        pattern_id: str,
        fix_ref: str,
        mutation_id: str,
        gain: float,
        ci: Sequence[float],
    ) -> None:
        if len(ci) != 2 or ci[0] > ci[1]:
            raise ValueError("ci must be [lower, upper]")
        await self.patterns.update_one(
            {"_id": pattern_id},
            {
                "$set": {
                    "resolution": {
                        "status": "resolved",
                        "fix_ref": fix_ref,
                        "fix_mutation_id": mutation_id,
                        "verified_gain": gain,
                        "verified_ci": list(ci),
                    },
                    "updated_at": _now(),
                }
            },
        )

    async def render_pitfalls(self, patterns: Sequence[Mapping[str, Any]]) -> str:
        lines = []
        for pattern in patterns[:3]:
            resolution = pattern.get("resolution", {})
            if resolution.get("status") == "dead_end":
                line = f"Do not attempt {pattern.get('failed_approach')}; it is a measured dead end."
            else:
                fix_ref = resolution.get("fix_ref")
                suffix = f" Use {fix_ref}." if fix_ref else ""
                line = f"{pattern.get('why_it_fails')}.{suffix} (seen {pattern.get('occurrences', 1)}x)"
            lines.append(line)
        return trim_pitfall_block(lines, self.config.pitfall_token_budget)

    async def _pattern_search(
        self, embedding: list[float], profile: str, limit: int
    ) -> list[Mapping[str, Any]]:
        filters: dict[str, Any] = {
            "resolution.status": {"$in": ["open", "resolved", "dead_end"]}
        }
        if profile:
            filters["profiles"] = profile
        pipeline = [
            {
                "$vectorSearch": {
                    "index": self.config.vector_index,
                    "path": "embedding",
                    "queryVector": embedding,
                    "numCandidates": max(limit * 20, 100),
                    "limit": limit,
                    "filter": filters,
                }
            },
            {"$set": {"score": {"$meta": "vectorSearchScore"}}},
        ]
        return await _collect(self.patterns.aggregate(pipeline))

    def _validate_embedding(self, embedding: Sequence[float]) -> None:
        if len(embedding) != self.config.embedding_dimensions:
            raise ValueError(
                f"Expected {self.config.embedding_dimensions}-dimension embedding; got {len(embedding)}"
            )
