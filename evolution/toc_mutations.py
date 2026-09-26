"""Structural taxonomy mutation proposal, guarding, and immutable application."""

from __future__ import annotations

import copy
import json
import re
import uuid
from collections.abc import Iterable
from dataclasses import replace
from typing import Any

from openai import AsyncOpenAI

from .config import Settings
from .models import MutationProposal, RouteResult, RoutingTask, TocNode
from .router import render_tree
from .storage import DarwinStore, utc_now

OPERATORS = {
    "toc_rewrite_description",
    "toc_move",
    "toc_split",
    "toc_merge",
    "toc_insert",
}


def _word_count(value: str) -> int:
    return len(re.findall(r"\b[\w'-]+\b", value))


def _leaks_task(
    description: str, tasks: Iterable[RoutingTask], minimum: int = 12
) -> bool:
    candidate = re.sub(r"\s+", " ", description.casefold())
    chunks = {
        candidate[index : index + minimum]
        for index in range(max(0, len(candidate) - minimum + 1))
    }
    return any(
        re.sub(r"\s+", " ", task.text.casefold())[index : index + minimum] in chunks
        for task in tasks
        for index in range(
            max(0, len(re.sub(r"\s+", " ", task.text.casefold())) - minimum + 1)
        )
    )


def guard(
    proposal: MutationProposal,
    nodes: list[TocNode],
    evolve_tasks: list[RoutingTask],
    dead_end_operators: set[str] | None = None,
) -> tuple[bool, list[str]]:
    """Return a deterministic verdict and every rejection reason."""
    reasons: list[str] = []
    by_path = {node.path: node for node in nodes}
    change = proposal.change
    dead_end_operators = dead_end_operators or set()
    if proposal.operator not in OPERATORS:
        reasons.append("unknown_operator")
    if len(set(proposal.evidence_task_ids)) < 2:
        reasons.append("insufficient_failure_pattern")
    valid_evidence_ids = {task.task_id for task in evolve_tasks}
    if any(task_id not in valid_evidence_ids for task_id in proposal.evidence_task_ids):
        reasons.append("unknown_evidence_task")
    if proposal.operator in dead_end_operators:
        reasons.append("repeats_dead_end")

    referenced: list[str] = []
    if proposal.operator in {"toc_rewrite_description", "toc_split"}:
        referenced.append(str(change.get("path", "")))
    elif proposal.operator == "toc_move":
        referenced.extend(
            [str(change.get("path", "")), str(change.get("new_parent", ""))]
        )
    elif proposal.operator == "toc_merge":
        referenced.extend(str(path) for path in change.get("paths", []))
    elif proposal.operator == "toc_insert":
        referenced.append(str(change.get("parent", "")))
        if change.get("path") in by_path:
            reasons.append("insert_path_exists")
    for path in referenced:
        if path not in by_path:
            reasons.append(f"unknown_path:{path}")

    descriptions = []
    if isinstance(change.get("description"), str):
        descriptions.append(change["description"])
    for child in (
        change.get("children", []) if isinstance(change.get("children"), list) else []
    ):
        if isinstance(child, dict) and isinstance(child.get("description"), str):
            descriptions.append(child["description"])
    for description in descriptions:
        words = _word_count(description)
        if words < 5 or words > 30:
            reasons.append("description_length")
        if _leaks_task(description, evolve_tasks):
            reasons.append("task_text_leakage")

    if proposal.operator == "toc_move" and not reasons:
        path = str(change["path"])
        new_parent = str(change["new_parent"])
        if not by_path[path].is_leaf:
            reasons.append("move_requires_leaf")
        if by_path[new_parent].is_leaf:
            reasons.append("move_parent_is_leaf")
        cursor: str | None = new_parent
        while cursor:
            if cursor == path:
                reasons.append("move_cycle")
                break
            cursor = by_path[cursor].parent if cursor in by_path else None

    if proposal.operator == "toc_merge":
        paths = [by_path[path] for path in change.get("paths", []) if path in by_path]
        calls = sum(node.routed_calls for node in paths)
        correct = sum(node.routed_correct for node in paths)
        if calls and correct / calls >= 0.85:
            reasons.append("merge_high_accuracy_nodes")
        if len(paths) != 2:
            reasons.append("merge_requires_two_paths")
        elif not all(node.is_leaf for node in paths):
            reasons.append("merge_requires_leaves")
        elif paths[0].parent != paths[1].parent:
            reasons.append("merge_requires_shared_parent")

    if proposal.operator == "toc_split":
        children = change.get("children", [])
        if len(children) != 2:
            reasons.append("split_requires_two_children")
        elif change.get("path") in by_path and not by_path[change["path"]].is_leaf:
            reasons.append("split_requires_leaf")
        else:
            child_paths = [child.get("path") for child in children]
            if len(set(child_paths)) != 2 or any(
                not path or path in by_path for path in child_paths
            ):
                reasons.append("split_child_path_invalid")

    if proposal.operator == "toc_insert" and change.get("parent") in by_path:
        if by_path[change["parent"]].is_leaf:
            reasons.append("insert_parent_is_leaf")
        if not change.get("path"):
            reasons.append("insert_path_required")

    return not reasons, sorted(set(reasons))


async def propose(
    failures: list[RouteResult],
    failure_tasks: list[RoutingTask],
    nodes: list[TocNode],
    history: list[dict[str, Any]],
    settings: Settings,
) -> list[MutationProposal]:
    if not settings.openrouter_api_key:
        raise RuntimeError("OPENROUTER_API_KEY is required to propose mutations")
    by_path = {node.path: node for node in nodes}
    task_by_id = {task.task_id: task for task in failure_tasks}
    failure_rows = [
        {
            "task_id": failure.task_id,
            "task_text": task_by_id.get(failure.task_id).text
            if failure.task_id in task_by_id
            else None,
            "predicted_leaf": failure.predicted_leaf,
            "predicted_description": by_path.get(failure.predicted_leaf).description
            if failure.predicted_leaf in by_path
            else None,
            "gold_leaf": failure.gold_leaf,
            "gold_description": by_path.get(failure.gold_leaf).description
            if failure.gold_leaf in by_path
            else None,
        }
        for failure in failures
        if not failure.correct
    ]
    client = AsyncOpenAI(
        api_key=settings.openrouter_api_key,
        base_url="https://openrouter.ai/api/v1",
        default_headers={"X-Title": "Darwin taxonomy evolution"},
    )
    prompt = {
        "taxonomy": render_tree(nodes),
        "routing_failures": failure_rows,
        "node_feedback": [
            {
                "path": node.path,
                "routed_calls": node.routed_calls,
                "routed_correct": node.routed_correct,
            }
            for node in nodes
            if node.is_leaf
        ],
        "recent_history": history[-10:],
    }
    response = await client.chat.completions.create(
        model=settings.openrouter_model,
        temperature=0,
        messages=[
            {
                "role": "system",
                "content": (
                    "Diagnose repeated taxonomy routing failures and return exactly three JSON proposals using "
                    "three different operators from toc_rewrite_description, toc_move, toc_split, toc_merge, "
                    "toc_insert. Each pattern needs at least two cited task ids. Never copy task text into a "
                    "description. Descriptions must contain 5-30 words. Prefer structural changes when coverage "
                    "is missing. Return an object with a proposals array; each proposal has operator, diagnosis, "
                    "evidence_task_ids, change, and expected_effect."
                ),
            },
            {"role": "user", "content": json.dumps(prompt)},
        ],
        response_format={"type": "json_object"},
    )
    payload = json.loads(response.choices[0].message.content or "{}")
    proposals = [
        MutationProposal.from_document(item) for item in payload.get("proposals", [])
    ]
    if len(proposals) != 3 or len({proposal.operator for proposal in proposals}) != 3:
        raise ValueError("proposer must return exactly three different operators")
    return proposals


def apply_to_nodes(
    proposal: MutationProposal, nodes: list[TocNode], new_version: int
) -> list[TocNode]:
    """Apply one already-guarded mutation to an in-memory copy."""
    copied = [
        replace(node, toc_version=new_version, routed_calls=0, routed_correct=0)
        for node in copy.deepcopy(nodes)
    ]
    by_path = {node.path: node for node in copied}
    change = proposal.change
    if proposal.operator == "toc_rewrite_description":
        path = change["path"]
        by_path[path] = replace(by_path[path], description=change["description"])
    elif proposal.operator == "toc_move":
        path = change["path"]
        by_path[path] = replace(by_path[path], parent=change["new_parent"])
    elif proposal.operator == "toc_split":
        path = change["path"]
        by_path[path] = replace(by_path[path], is_leaf=False)
        next_order = max(node.order for node in copied) + 1
        for offset, child in enumerate(change["children"]):
            child_path = child.get("path") or f"{path}.{offset + 1}"
            by_path[child_path] = TocNode(
                path=child_path,
                parent=path,
                title=child["title"],
                description=child["description"],
                is_leaf=True,
                toc_version=new_version,
                order=next_order + offset,
            )
    elif proposal.operator == "toc_merge":
        first, second = change["paths"]
        parent = by_path[first].parent
        merged_order = min(by_path[first].order, by_path[second].order)
        del by_path[first]
        del by_path[second]
        target_path = change.get("path") or first
        by_path[target_path] = TocNode(
            path=target_path,
            parent=parent,
            title=change["title"],
            description=change["description"],
            is_leaf=True,
            toc_version=new_version,
            order=merged_order,
        )
    elif proposal.operator == "toc_insert":
        path = change["path"]
        by_path[path] = TocNode(
            path=path,
            parent=change["parent"],
            title=change["title"],
            description=change["description"],
            is_leaf=True,
            toc_version=new_version,
            order=max(node.order for node in copied) + 1,
        )
    else:
        raise ValueError(f"unsupported operator: {proposal.operator}")
    return sorted(by_path.values(), key=lambda node: (node.order, node.path))


def apply(
    store: DarwinStore, proposal: MutationProposal, from_version: int
) -> tuple[int, str]:
    nodes = store.nodes(from_version)
    new_version = store.next_version()
    mutation_id = "mut-" + uuid.uuid4().hex[:12]
    new_nodes = apply_to_nodes(proposal, nodes, new_version)
    store.write_nodes(new_nodes)
    store.set_version_status(
        new_version,
        "pending",
        parent_version=from_version,
        mutation_id=mutation_id,
    )
    store.db.toc_mutations.insert_one(
        {
            "_id": mutation_id,
            "from_version": from_version,
            "to_version": new_version,
            "proposal": proposal.to_document(),
            "guard": {"accepted": True, "reasons": []},
            "status": "pending",
            "created_at": utc_now(),
        }
    )
    return new_version, mutation_id
