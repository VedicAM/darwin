"""One-minute pre-demo verification for Darwin's live evolution path."""

from __future__ import annotations

import argparse
import asyncio
from dataclasses import dataclass

from rich.console import Console
from rich.table import Table

from .config import Settings
from .models import MutationProposal
from .router import Router, keyword_route
from .storage import DarwinStore
from .toc_mutations import guard

REQUIRED_COLLECTIONS = {
    "routing_results",
    "routing_tasks",
    "toc_fitness",
    "toc_knockouts",
    "toc_mutations",
    "toc_versions",
    "tool_toc",
}


@dataclass
class Check:
    name: str
    passed: bool
    detail: str


async def run(*, live_model: bool = False) -> list[Check]:
    settings = Settings.from_env(require_model=live_model)
    store = DarwinStore(settings)
    checks: list[Check] = []
    try:
        try:
            store.ping()
            checks.append(Check("MongoDB connection", True, settings.database))
        except Exception as error:  # noqa: BLE001 - smoke test reports every failure
            return [
                Check("MongoDB connection", False, f"{type(error).__name__}: {error}")
            ]

        actual = set(store.db.list_collection_names())
        missing = sorted(REQUIRED_COLLECTIONS - actual)
        checks.append(
            Check(
                "Required collections",
                not missing,
                "all present" if not missing else "missing: " + ", ".join(missing),
            )
        )

        version = store.champion_version()
        nodes = store.nodes(version)
        leaves = [node for node in nodes if node.is_leaf]
        tasks = store.tasks("test")
        if nodes and leaves:
            leaf, _ = keyword_route("retrieve population allele frequency", leaves)
            checks.append(
                Check(
                    "Router returns valid leaf",
                    leaf in {node.path for node in leaves},
                    leaf,
                )
            )
        else:
            checks.append(
                Check("Router returns valid leaf", False, f"v{version} has no nodes")
            )

        evolve_tasks = store.tasks("evolve")
        evidence = tuple(task.task_id for task in evolve_tasks[:2])
        if len(evidence) == 2:
            accepted = MutationProposal(
                "toc_rewrite_description",
                "smoke-test repeated confusion",
                evidence,
                {
                    "path": leaves[0].path,
                    "description": "Retrieve accession records and linked scientific metadata from the designated source",
                },
                "smoke-test only",
            )
            rejected = MutationProposal(
                "toc_rewrite_description",
                "smoke-test copied task",
                evidence,
                {"path": leaves[0].path, "description": evolve_tasks[0].text},
                "smoke-test only",
            )
            accepted_ok, accepted_reasons = guard(accepted, nodes, evolve_tasks)
            rejected_ok, rejected_reasons = guard(rejected, nodes, evolve_tasks)
            checks.append(
                Check(
                    "Guard accepts valid mutation",
                    accepted_ok,
                    ", ".join(accepted_reasons) or "accepted",
                )
            )
            checks.append(
                Check(
                    "Guard rejects leakage",
                    not rejected_ok and "task_text_leakage" in rejected_reasons,
                    ", ".join(rejected_reasons),
                )
            )
        else:
            checks.append(
                Check("Guard accept/reject", False, "fewer than two evolve tasks")
            )

        if tasks and leaves:
            router = Router(settings, store)
            method = "toc" if live_model else "flat"
            summary = await router.score(
                method,
                "test",
                version,
                run_id="pre-demo-smoke",
                tasks=tasks[: min(3, len(tasks))],
            )
            checks.append(
                Check(
                    "Scoring run completes",
                    len(summary.per_task) > 0
                    and all(result.predicted_leaf for result in summary.per_task),
                    f"{method}, n={len(summary.per_task)}, R@1={summary.r_at_1:.3f}",
                )
            )
        else:
            checks.append(
                Check("Scoring run completes", False, "test tasks or leaves missing")
            )
        return checks
    finally:
        store.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--live-model",
        action="store_true",
        help="Use the constrained OpenRouter route instead of the deterministic flat smoke route.",
    )
    args = parser.parse_args()
    checks = asyncio.run(run(live_model=args.live_model))
    table = Table("", "check", "detail", title="Darwin pre-demo smoke test")
    for check in checks:
        table.add_row(
            "[green]✓[/green]" if check.passed else "[red]✗[/red]",
            check.name,
            check.detail,
        )
    Console().print(table)
    raise SystemExit(0 if checks and all(check.passed for check in checks) else 1)


if __name__ == "__main__":
    main()
