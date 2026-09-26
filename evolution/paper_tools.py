"""Registration primitives for paper-derived Darwin tools."""

from __future__ import annotations

import hashlib
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Protocol


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


@dataclass(frozen=True)
class ToolCandidate:
    paper_id: str
    name: str
    summary: str
    capabilities: Sequence[str]
    evidence: Sequence[Mapping[str, str]]
    uncertainties: Sequence[str]
    entrypoint: str
    tests: Sequence[str]
    dependencies: Sequence[str] = field(default_factory=tuple)
    toc_path: Sequence[str] = field(default_factory=tuple)

    def validate(self) -> None:
        if not self.paper_id or not self.name or not self.entrypoint:
            raise ValueError("paper_id, name, and entrypoint are required")
        if not self.evidence:
            raise ValueError("at least one paper evidence citation is required")
        for item in self.evidence:
            if not item.get("section") or not item.get("claim"):
                raise ValueError("each evidence item needs section and claim")
        if not self.tests:
            raise ValueError("paper-derived tools require executable tests")


class PaperToolRegistry:
    """Register, execute, and promote paper-derived tools without overstating fidelity."""

    def __init__(self, tools: AsyncCollection, runs: AsyncCollection) -> None:
        self.tools = tools
        self.runs = runs

    async def register_candidate(
        self, candidate: ToolCandidate, artifact_sha256: str
    ) -> str:
        candidate.validate()
        tool_id = (
            "pt-"
            + hashlib.sha256(
                f"{candidate.paper_id}|{candidate.name}|{artifact_sha256}".encode()
            ).hexdigest()[:16]
        )
        now = datetime.now(timezone.utc).isoformat()
        document = {
            "_id": tool_id,
            **asdict(candidate),
            "artifact_sha256": artifact_sha256,
            "status": "candidate",
            "validation": {"tests_passed": 0, "tests_failed": 0, "reviewed": False},
            "created_at": now,
            "updated_at": now,
            "schema_version": 1,
        }
        await self.tools.update_one(
            {"_id": tool_id}, {"$setOnInsert": document}, upsert=True
        )
        return tool_id

    async def record_run(
        self,
        *,
        tool_id: str,
        task_id: str,
        status: str,
        metrics: Mapping[str, Any],
        failure_id: str | None = None,
    ) -> str:
        if status not in {"passed", "failed", "abandoned"}:
            raise ValueError("status must be passed, failed, or abandoned")
        run_id = (
            "ptr-"
            + hashlib.sha256(f"{tool_id}|{task_id}|{metrics}".encode()).hexdigest()[:16]
        )
        await self.runs.update_one(
            {"_id": run_id},
            {
                "$setOnInsert": {
                    "_id": run_id,
                    "tool_id": tool_id,
                    "task_id": task_id,
                    "status": status,
                    "metrics": dict(metrics),
                    "failure_id": failure_id,
                    "created_at": datetime.now(timezone.utc).isoformat(),
                }
            },
            upsert=True,
        )
        return run_id

    async def promote(self, tool_id: str, evidence: Mapping[str, Any]) -> None:
        """Promote only after tests and review are explicitly recorded."""
        tool = await self.tools.find_one({"_id": tool_id})
        if not tool:
            raise KeyError(tool_id)
        validation = tool.get("validation", {})
        if validation.get("tests_failed", 0) or not validation.get("tests_passed", 0):
            raise ValueError("tool cannot be promoted without passing tests")
        if not validation.get("reviewed"):
            raise ValueError("tool cannot be promoted before review")
        await self.tools.update_one(
            {"_id": tool_id},
            {
                "$set": {
                    "status": "active",
                    "promotion_evidence": dict(evidence),
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            },
        )
