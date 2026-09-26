"""MongoDB persistence and append-only JSON run artifacts."""

from __future__ import annotations

import json
from collections.abc import Iterable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pymongo import ASCENDING, DESCENDING, MongoClient, UpdateOne

from .config import Settings
from .models import RouteResult, RoutingTask, TocNode


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class DarwinStore:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.client = MongoClient(
            settings.mongodb_uri,
            appname="darwin-taxonomy-evolution",
            serverSelectionTimeoutMS=10_000,
            connectTimeoutMS=10_000,
            retryWrites=True,
        )
        self.db = self.client[settings.database]

    def ensure_indexes(self) -> None:
        self.db.tool_toc.create_index(
            [("toc_version", ASCENDING), ("path", ASCENDING)], unique=True
        )
        self.db.tool_toc.create_index(
            [("toc_version", ASCENDING), ("parent", ASCENDING), ("order", ASCENDING)]
        )
        self.db.routing_tasks.create_index("task_id", unique=True)
        self.db.routing_tasks.create_index(
            [("split", ASCENDING), ("section", ASCENDING)]
        )
        self.db.routing_results.create_index(
            [("run_id", ASCENDING), ("task_id", ASCENDING), ("method", ASCENDING)],
            unique=True,
        )
        self.db.toc_mutations.create_index(
            [("from_version", ASCENDING), ("created_at", DESCENDING)]
        )
        self.db.toc_fitness.create_index(
            [("toc_version", ASCENDING), ("generation", ASCENDING)]
        )
        self.db.toc_knockouts.create_index(
            [("champion_version", ASCENDING), ("mutation_id", ASCENDING)]
        )

    def ping(self) -> None:
        self.client.admin.command("ping")

    def nodes(self, version: int, *, leaves_only: bool = False) -> list[TocNode]:
        query: dict[str, Any] = {"toc_version": version}
        if leaves_only:
            query["is_leaf"] = True
        documents = list(
            self.db.tool_toc.find(query, {"_id": 0}).sort("order", ASCENDING)
        )
        return [TocNode(**document) for document in documents]

    def write_nodes(self, nodes: Iterable[TocNode]) -> int:
        documents = [node.to_document() for node in nodes]
        if not documents:
            return 0
        operations = [
            UpdateOne(
                {"toc_version": doc["toc_version"], "path": doc["path"]},
                {"$setOnInsert": doc},
                upsert=True,
            )
            for doc in documents
        ]
        result = self.db.tool_toc.bulk_write(operations, ordered=False)
        return result.upserted_count

    def write_tasks(self, tasks: Iterable[RoutingTask]) -> int:
        operations = [
            UpdateOne(
                {"task_id": task.task_id},
                {"$set": task.to_document()},
                upsert=True,
            )
            for task in tasks
        ]
        if not operations:
            return 0
        result = self.db.routing_tasks.bulk_write(operations, ordered=False)
        return result.upserted_count + result.modified_count

    def tasks(self, split: str) -> list[RoutingTask]:
        return [
            RoutingTask(**document)
            for document in self.db.routing_tasks.find(
                {"split": split}, {"_id": 0}
            ).sort("task_id", ASCENDING)
        ]

    def write_results(self, run_id: str, results: Iterable[RouteResult]) -> None:
        operations = []
        for result in results:
            document = result.to_document() | {
                "run_id": run_id,
                "created_at": utc_now(),
            }
            operations.append(
                UpdateOne(
                    {
                        "run_id": run_id,
                        "task_id": result.task_id,
                        "method": result.method,
                    },
                    {"$set": document},
                    upsert=True,
                )
            )
        if operations:
            self.db.routing_results.bulk_write(operations, ordered=False)

    def increment_feedback(self, version: int, results: Iterable[RouteResult]) -> None:
        for result in results:
            if result.predicted_leaf is None or result.hallucinated:
                continue
            increments = {"routed_calls": 1, "routed_correct": int(result.correct)}
            self.db.tool_toc.update_one(
                {"toc_version": version, "path": result.predicted_leaf},
                {"$inc": increments},
            )

    def champion_version(self) -> int:
        document = self.db.toc_versions.find_one(
            {"status": "champion"}, sort=[("version", DESCENDING)]
        )
        return int(document["version"]) if document else 1

    def set_version_status(
        self,
        version: int,
        status: str,
        *,
        parent_version: int | None = None,
        mutation_id: str | None = None,
    ) -> None:
        if status == "champion":
            self.db.toc_versions.update_many(
                {"status": "champion", "version": {"$ne": version}},
                {"$set": {"status": "superseded", "updated_at": utc_now()}},
            )
        self.db.toc_versions.update_one(
            {"version": version},
            {
                "$set": {
                    "status": status,
                    "parent_version": parent_version,
                    "mutation_id": mutation_id,
                    "updated_at": utc_now(),
                },
                "$setOnInsert": {"created_at": utc_now()},
            },
            upsert=True,
        )

    def next_version(self) -> int:
        document = self.db.toc_versions.find_one(sort=[("version", DESCENDING)])
        return int(document["version"]) + 1 if document else 1

    def save_json(self, name: str, payload: Any) -> Path:
        self.settings.output_dir.mkdir(parents=True, exist_ok=True)
        destination = self.settings.output_dir / name
        temporary = destination.with_suffix(destination.suffix + ".tmp")
        temporary.write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        temporary.replace(destination)
        return destination

    def close(self) -> None:
        self.client.close()
