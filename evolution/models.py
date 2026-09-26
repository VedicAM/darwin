"""Shared value objects for taxonomy evolution."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

Split = Literal["evolve", "select", "test"]
Operator = Literal[
    "toc_rewrite_description", "toc_move", "toc_split", "toc_merge", "toc_insert"
]


@dataclass(frozen=True)
class TocNode:
    path: str
    parent: str | None
    title: str
    description: str
    is_leaf: bool
    toc_version: int
    order: int = 0
    routed_calls: int = 0
    routed_correct: int = 0
    embedding: list[float] | None = None

    def to_document(self) -> dict[str, Any]:
        document = asdict(self)
        if self.embedding is None:
            document.pop("embedding")
        return document


@dataclass(frozen=True)
class RoutingTask:
    task_id: str
    text: str
    gold_leaf: str
    section: str
    split: Split
    ambiguous_with: str | None = None
    uncovered: bool = False

    def to_document(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class RouteResult:
    task_id: str
    method: str
    predicted_leaf: str | None
    gold_leaf: str
    correct: bool
    hallucinated: bool
    confidence: float | None
    toc_version: int
    split: str
    fallback: str | None = None
    error: str | None = None

    def to_document(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class ScoreSummary:
    method: str
    split: str
    toc_version: int
    r_at_1: float
    hallucination_rate: float
    per_task: list[RouteResult] = field(default_factory=list)

    def to_document(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["per_task"] = [result.to_document() for result in self.per_task]
        return payload


@dataclass(frozen=True)
class MutationProposal:
    operator: Operator
    diagnosis: str
    evidence_task_ids: tuple[str, ...]
    change: dict[str, Any]
    expected_effect: str

    @classmethod
    def from_document(cls, value: dict[str, Any]) -> MutationProposal:
        return cls(
            operator=value["operator"],
            diagnosis=value["diagnosis"],
            evidence_task_ids=tuple(value.get("evidence_task_ids", [])),
            change=dict(value.get("change", {})),
            expected_effect=value.get("expected_effect", ""),
        )

    def to_document(self) -> dict[str, Any]:
        return {
            "operator": self.operator,
            "diagnosis": self.diagnosis,
            "evidence_task_ids": list(self.evidence_task_ids),
            "change": self.change,
            "expected_effect": self.expected_effect,
        }
