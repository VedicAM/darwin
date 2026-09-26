"""Paired knockout screen for mutations in the champion lineage."""

from __future__ import annotations

import argparse
import asyncio
from dataclasses import replace
from typing import Any

import numpy as np
from rich.console import Console
from rich.table import Table

from .config import Settings
from .models import RouteResult, TocNode
from .router import Router
from .storage import DarwinStore, utc_now


def correctness(results: list[RouteResult]) -> np.ndarray:
    return np.asarray([float(result.correct) for result in results], dtype=float)


def paired_bootstrap(
    champion: np.ndarray, knockout: np.ndarray, *, samples: int = 1000, seed: int = 2609
) -> tuple[float, float, float]:
    if champion.shape != knockout.shape or champion.size == 0:
        raise ValueError("paired non-empty result arrays are required")
    delta = champion - knockout
    effect = float(delta.mean())
    rng = np.random.default_rng(seed)
    indices = rng.integers(0, delta.size, size=(samples, delta.size))
    bootstrapped = delta[indices].mean(axis=1)
    lower, upper = np.quantile(bootstrapped, [0.025, 0.975])
    return effect, float(lower), float(upper)


def classify(effect: float, lower: float, upper: float) -> str:
    if lower > 0 and effect >= 0.03:
        return "Essential"
    if effect > 0 and lower <= 0 <= upper:
        return "Contributing"
    if effect < 0:
        return "Harmful"
    return "Hitchhiker"


def lineage(
    store: DarwinStore, champion_version: int, cap: int = 8
) -> list[dict[str, Any]]:
    values = []
    version = champion_version
    while version > 1 and len(values) < cap:
        node = store.db.toc_versions.find_one({"version": version})
        if not node or not node.get("parent_version"):
            break
        if node.get("mutation_id"):
            mutation = store.db.toc_mutations.find_one({"_id": node["mutation_id"]})
            if mutation:
                values.append(mutation)
        version = int(node["parent_version"])
    return values


def revert_mutation(
    store: DarwinStore,
    champion_nodes: list[TocNode],
    mutation: dict[str, Any],
    new_version: int,
) -> list[TocNode]:
    before = {node.path: node for node in store.nodes(int(mutation["from_version"]))}
    after = {node.path: node for node in store.nodes(int(mutation["to_version"]))}
    candidate = {
        node.path: replace(
            node, toc_version=new_version, routed_calls=0, routed_correct=0
        )
        for node in champion_nodes
    }

    def shape(node: TocNode | None) -> tuple[Any, ...] | None:
        if node is None:
            return None
        return (node.parent, node.title, node.description, node.is_leaf, node.order)

    changed_paths = {
        path
        for path in before.keys() | after.keys()
        if shape(before.get(path)) != shape(after.get(path))
    }
    for path in changed_paths:
        if path in before:
            candidate[path] = replace(
                before[path], toc_version=new_version, routed_calls=0, routed_correct=0
            )
        else:
            candidate.pop(path, None)
    return sorted(candidate.values(), key=lambda node: (node.order, node.path))


async def run(cap: int = 8) -> dict[str, Any]:
    settings = Settings.from_env(require_model=True)
    store = DarwinStore(settings)
    router = Router(settings, store)
    console = Console()
    try:
        champion_version = store.champion_version()
        champion_nodes = store.nodes(champion_version)
        mutations = lineage(store, champion_version, cap)
        tasks = sorted(store.tasks("test"), key=lambda task: task.task_id)[:40]
        champion = await router.score(
            "toc", "test", champion_version, run_id="knockout-champion", tasks=tasks
        )
        champion_vector = correctness(champion.per_task)
        rows: list[dict[str, Any]] = []
        revert_for_pruned: list[dict[str, Any]] = []
        for index, mutation in enumerate(mutations):
            version = store.next_version()
            nodes = revert_mutation(store, champion_nodes, mutation, version)
            store.write_nodes(nodes)
            store.set_version_status(
                version,
                "knockout",
                parent_version=champion_version,
                mutation_id=mutation["_id"],
            )
            score = await router.score(
                "toc", "test", version, run_id=f"knockout-{index}", tasks=tasks
            )
            effect, lower, upper = paired_bootstrap(
                champion_vector,
                correctness(score.per_task),
                seed=settings.random_seed + index,
            )
            category = classify(effect, lower, upper)
            row = {
                "mutation_id": mutation["_id"],
                "operator": mutation["proposal"]["operator"],
                "knockout_version": version,
                "effect": effect,
                "ci": [lower, upper],
                "class": category,
            }
            rows.append(row)
            if category in {"Hitchhiker", "Harmful"}:
                revert_for_pruned.append(mutation)
            store.db.toc_knockouts.update_one(
                {"champion_version": champion_version, "mutation_id": mutation["_id"]},
                {
                    "$set": row
                    | {"champion_version": champion_version, "created_at": utc_now()}
                },
                upsert=True,
            )

        pruned_nodes = champion_nodes
        pruned_version: int | None = None
        pruned_score: float | None = None
        for mutation in revert_for_pruned:
            temporary_version = (
                store.next_version() if pruned_version is None else pruned_version
            )
            pruned_nodes = revert_mutation(
                store, pruned_nodes, mutation, temporary_version
            )
            pruned_version = temporary_version
        if pruned_version is not None:
            store.write_nodes(pruned_nodes)
            store.set_version_status(
                pruned_version, "pruned", parent_version=champion_version
            )
            result = await router.score(
                "toc", "test", pruned_version, run_id="knockout-pruned", tasks=tasks
            )
            pruned_score = result.r_at_1

        payload = {
            "champion_version": champion_version,
            "champion_r_at_1": champion.r_at_1,
            "task_count": len(tasks),
            "knockouts": rows,
            "pruned_version": pruned_version,
            "pruned_r_at_1": pruned_score,
            "created_at": utc_now(),
        }
        store.save_json("knockouts.json", payload)
        table = Table("mutation", "operator", "effect", "95% CI", "class")
        for row in rows:
            table.add_row(
                row["mutation_id"],
                row["operator"],
                f"{row['effect']:+.3f}",
                f"[{row['ci'][0]:+.3f}, {row['ci'][1]:+.3f}]",
                row["class"],
            )
        console.print(table)
        if pruned_score is not None:
            console.print(f"Pruned champion v{pruned_version}: R@1 {pruned_score:.3f}")
        return payload
    finally:
        store.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cap", type=int, default=8)
    args = parser.parse_args()
    asyncio.run(run(args.cap))


if __name__ == "__main__":
    main()
