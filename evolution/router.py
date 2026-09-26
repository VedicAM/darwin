"""Tree-aware router, flat baseline, unconstrained baseline, and scorer."""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import re
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any

from openai import AsyncOpenAI
from rich.console import Console
from rich.table import Table

from .config import Settings
from .models import RouteResult, RoutingTask, ScoreSummary, TocNode
from .storage import DarwinStore


def _tokens(value: str) -> set[str]:
    return {
        token for token in re.findall(r"[a-z0-9]+", value.casefold()) if len(token) > 2
    }


def keyword_route(task_text: str, leaves: list[TocNode]) -> tuple[str, float]:
    """Deterministic lexical baseline used only when vector data is unavailable."""
    query = _tokens(task_text)
    scored: list[tuple[float, str]] = []
    for leaf in leaves:
        title = _tokens(leaf.title)
        description = _tokens(leaf.description)
        overlap = len(query & description) + 2 * len(query & title)
        denominator = math.sqrt(max(1, len(query)) * max(1, len(description | title)))
        scored.append((overlap / denominator, leaf.path))
    score, path = max(scored, key=lambda item: (item[0], item[1]))
    return path, score


def render_tree(nodes: list[TocNode]) -> str:
    children: dict[str | None, list[TocNode]] = {}
    for node in nodes:
        children.setdefault(node.parent, []).append(node)
    for values in children.values():
        values.sort(key=lambda node: (node.order, node.path))
    lines: list[str] = []

    def visit(parent: str | None, depth: int) -> None:
        for node in children.get(parent, []):
            marker = "leaf" if node.is_leaf else "section"
            lines.append(
                f"{'  ' * depth}{marker} {node.path} {node.title} — {node.description}"
            )
            visit(node.path, depth + 1)

    visit(None, 0)
    return "\n".join(lines)


class Router:
    def __init__(self, settings: Settings, store: DarwinStore):
        self.settings = settings
        self.store = store
        self._node_cache: dict[int, list[TocNode]] = {}
        self.client = (
            AsyncOpenAI(
                api_key=settings.openrouter_api_key,
                base_url="https://openrouter.ai/api/v1",
                default_headers={"X-Title": "Darwin taxonomy evolution"},
            )
            if settings.openrouter_api_key
            else None
        )

    async def route_toc(
        self, task_text: str, toc_version: int
    ) -> tuple[str, float | None]:
        nodes = self._nodes(toc_version)
        leaves = [node.path for node in nodes if node.is_leaf]
        if not leaves:
            raise RuntimeError(f"taxonomy version {toc_version} has no leaves")
        client = self._require_client()
        response = await client.chat.completions.create(
            model=self.settings.openrouter_model,
            temperature=0,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Pick the single best tool section for the research task. "
                        "Use the full hierarchy for context. Return JSON only.\n\n"
                        + render_tree(nodes)
                    ),
                },
                {"role": "user", "content": task_text},
            ],
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "darwin_tool_route",
                    "strict": True,
                    "schema": {
                        "type": "object",
                        "properties": {
                            "leaf": {"type": "string", "enum": leaves},
                            "confidence": {
                                "type": "number",
                                "minimum": 0,
                                "maximum": 1,
                            },
                        },
                        "required": ["leaf", "confidence"],
                        "additionalProperties": False,
                    },
                },
            },
        )
        payload = json.loads(response.choices[0].message.content or "{}")
        return str(payload["leaf"]), float(payload["confidence"])

    async def route_unconstrained(
        self, task_text: str, toc_version: int
    ) -> tuple[str, float | None]:
        nodes = self._nodes(toc_version)
        client = self._require_client()
        response = await client.chat.completions.create(
            model=self.settings.openrouter_model,
            temperature=0,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Pick the single best leaf id for the research task. Return only the leaf id.\n\n"
                        + render_tree(nodes)
                    ),
                },
                {"role": "user", "content": task_text},
            ],
        )
        return (response.choices[0].message.content or "").strip(), None

    async def route_flat(
        self, task_text: str, toc_version: int
    ) -> tuple[str, float, str]:
        leaves = [node for node in self._nodes(toc_version) if node.is_leaf]
        if not leaves:
            raise RuntimeError(f"taxonomy version {toc_version} has no leaves")
        vector_fallback: str | None = None
        if all(leaf.embedding for leaf in leaves) and self.client:
            try:
                embedding_model = os.environ.get(
                    "OPENROUTER_EMBEDDING_MODEL", "openai/text-embedding-3-small"
                )
                response = await self.client.embeddings.create(
                    model=embedding_model, input=task_text
                )
                query_vector = response.data[0].embedding
                documents = list(
                    self.store.db.tool_toc.aggregate(
                        [
                            {
                                "$vectorSearch": {
                                    "index": "tool_toc_vec",
                                    "path": "embedding",
                                    "queryVector": query_vector,
                                    "numCandidates": 100,
                                    "limit": 1,
                                    "filter": {
                                        "toc_version": toc_version,
                                        "is_leaf": True,
                                    },
                                }
                            },
                            {
                                "$project": {
                                    "_id": 0,
                                    "path": 1,
                                    "score": {"$meta": "vectorSearchScore"},
                                }
                            },
                        ]
                    )
                )
                if documents:
                    return (
                        str(documents[0]["path"]),
                        float(documents[0]["score"]),
                        "vector",
                    )
            except Exception as error:  # noqa: BLE001 - vector availability is optional
                vector_fallback = type(error).__name__
        leaf, score = keyword_route(task_text, leaves)
        fallback = "keyword_overlap"
        if vector_fallback:
            fallback += f":{vector_fallback}"
        return leaf, score, fallback

    async def score(
        self,
        method: str,
        split: str,
        toc_version: int,
        *,
        run_id: str | None = None,
        tasks: list[RoutingTask] | None = None,
    ) -> ScoreSummary:
        selected_tasks = tasks if tasks is not None else self.store.tasks(split)
        valid_leaves = {node.path for node in self._nodes(toc_version) if node.is_leaf}
        semaphore = asyncio.Semaphore(self.settings.concurrency)
        routes: dict[str, Callable[[str], Awaitable[tuple[Any, ...]]]] = {
            "toc": lambda text: self.route_toc(text, toc_version),
            "unconstrained": lambda text: self.route_unconstrained(text, toc_version),
            "flat": lambda text: self.route_flat(text, toc_version),
        }
        if method not in routes:
            raise ValueError(f"unknown routing method: {method}")

        async def one(task: RoutingTask) -> RouteResult:
            async with semaphore:
                try:
                    value = await routes[method](task.text)
                    predicted = str(value[0])
                    confidence = float(value[1]) if value[1] is not None else None
                    fallback = str(value[2]) if len(value) > 2 else None
                    hallucinated = predicted not in valid_leaves
                    return RouteResult(
                        task_id=task.task_id,
                        method=method,
                        predicted_leaf=predicted,
                        gold_leaf=task.gold_leaf,
                        correct=not hallucinated and predicted == task.gold_leaf,
                        hallucinated=hallucinated,
                        confidence=confidence,
                        toc_version=toc_version,
                        split=split,
                        fallback=fallback,
                    )
                except Exception as error:  # noqa: BLE001 - score records per-task failures
                    return RouteResult(
                        task_id=task.task_id,
                        method=method,
                        predicted_leaf=None,
                        gold_leaf=task.gold_leaf,
                        correct=False,
                        hallucinated=True,
                        confidence=None,
                        toc_version=toc_version,
                        split=split,
                        error=f"{type(error).__name__}: {error}",
                    )

        per_task = list(await asyncio.gather(*(one(task) for task in selected_tasks)))
        total = len(per_task)
        summary = ScoreSummary(
            method=method,
            split=split,
            toc_version=toc_version,
            r_at_1=sum(result.correct for result in per_task) / total if total else 0.0,
            hallucination_rate=sum(result.hallucinated for result in per_task) / total
            if total
            else 0.0,
            per_task=per_task,
        )
        identifier = run_id or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        self.store.write_results(identifier, per_task)
        self.store.increment_feedback(toc_version, per_task)
        return summary

    def _require_client(self) -> AsyncOpenAI:
        if not self.client:
            raise RuntimeError("OPENROUTER_API_KEY is required for this routing method")
        return self.client

    def _nodes(self, version: int) -> list[TocNode]:
        if version not in self._node_cache:
            self._node_cache[version] = self.store.nodes(version)
        return self._node_cache[version]


async def run_baselines(version: int) -> list[ScoreSummary]:
    settings = Settings.from_env(require_model=True)
    store = DarwinStore(settings)
    router = Router(settings, store)
    try:
        run_id = datetime.now(timezone.utc).strftime("baseline-%Y%m%dT%H%M%SZ")
        summaries = []
        for method in ("flat", "unconstrained", "toc"):
            summaries.append(await router.score(method, "test", version, run_id=run_id))
        store.save_json(
            "routing_baseline.json", [summary.to_document() for summary in summaries]
        )
        return summaries
    finally:
        store.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", type=int, default=1)
    args = parser.parse_args()
    summaries = asyncio.run(run_baselines(args.version))
    table = Table(title=f"Routing baselines — taxonomy v{args.version}")
    table.add_column("method")
    table.add_column("R@1", justify="right")
    table.add_column("hallucination", justify="right")
    for summary in summaries:
        table.add_row(
            summary.method,
            f"{summary.r_at_1:.3f}",
            f"{summary.hallucination_rate:.3f}",
        )
    Console().print(table)


if __name__ == "__main__":
    main()
