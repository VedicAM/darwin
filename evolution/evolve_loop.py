"""Autonomous held-out taxonomy evolution with immutable lineage."""

from __future__ import annotations

import argparse
import asyncio
import json
from dataclasses import dataclass
from typing import Any

from rich.console import Console
from rich.table import Table
from scipy.stats import binomtest

from .config import Settings
from .models import MutationProposal, ScoreSummary
from .router import Router
from .storage import DarwinStore, utc_now
from .toc_mutations import apply, guard, propose


@dataclass(frozen=True)
class SelectionResult:
    child_version: int
    mutation_id: str
    proposal: MutationProposal
    fixes: int
    breaks: int
    pvalue: float
    score: float

    @property
    def promotes(self) -> bool:
        return self.fixes > self.breaks and self.pvalue < 0.1


def paired_comparison(
    champion: ScoreSummary, child: ScoreSummary
) -> tuple[int, int, float]:
    champion_by_id = {result.task_id: result for result in champion.per_task}
    child_by_id = {result.task_id: result for result in child.per_task}
    shared = sorted(champion_by_id.keys() & child_by_id.keys())
    fixes = sum(
        not champion_by_id[task_id].correct and child_by_id[task_id].correct
        for task_id in shared
    )
    breaks = sum(
        champion_by_id[task_id].correct and not child_by_id[task_id].correct
        for task_id in shared
    )
    discordant = fixes + breaks
    pvalue = (
        float(binomtest(fixes, discordant, 0.5, alternative="greater").pvalue)
        if discordant
        else 1.0
    )
    return fixes, breaks, pvalue


class EvolutionLoop:
    def __init__(self, settings: Settings, store: DarwinStore):
        self.settings = settings
        self.store = store
        self.router = Router(settings, store)
        self.console = Console()
        log_path = settings.output_dir / "toc_evolution_log.json"
        self.log: list[dict[str, Any]] = (
            json.loads(log_path.read_text(encoding="utf-8"))
            if log_path.exists()
            else []
        )

    async def generation(self, generation: int) -> dict[str, Any]:
        champion_version = self.store.champion_version()
        evolve = await self.router.score(
            "toc", "evolve", champion_version, run_id=f"g{generation}-evolve"
        )
        failures = [result for result in evolve.per_task if not result.correct]
        history = list(
            self.store.db.toc_mutations.find(
                {"status": {"$in": ["promoted", "selection_failed", "guard_rejected"]}},
                {"_id": 0},
            )
            .sort("created_at", -1)
            .limit(10)
        )
        proposals = await propose(
            failures,
            self.store.tasks("evolve"),
            self.store.nodes(champion_version),
            list(reversed(history)),
            self.settings,
        )
        rejected_counts = list(
            self.store.db.toc_mutations.aggregate(
                [
                    {"$match": {"status": "selection_failed"}},
                    {"$group": {"_id": "$proposal.operator", "count": {"$sum": 1}}},
                    {"$match": {"count": {"$gte": 2}}},
                ]
            )
        )
        dead_end_operators = {row["_id"] for row in rejected_counts}
        evolve_tasks = self.store.tasks("evolve")
        accepted: list[MutationProposal] = []
        guard_rows = []
        for proposal in proposals:
            allowed, reasons = guard(
                proposal,
                self.store.nodes(champion_version),
                evolve_tasks,
                dead_end_operators,
            )
            guard_rows.append(
                {"operator": proposal.operator, "accepted": allowed, "reasons": reasons}
            )
            if allowed:
                accepted.append(proposal)
            else:
                self.store.db.toc_mutations.insert_one(
                    {
                        "from_version": champion_version,
                        "proposal": proposal.to_document(),
                        "guard": {"accepted": False, "reasons": reasons},
                        "status": "guard_rejected",
                        "created_at": utc_now(),
                    }
                )

        champion_select = await self.router.score(
            "toc", "select", champion_version, run_id=f"g{generation}-select-parent"
        )
        selections: list[SelectionResult] = []
        for index, proposal in enumerate(accepted):
            child_version, mutation_id = apply(self.store, proposal, champion_version)
            child = await self.router.score(
                "toc",
                "select",
                child_version,
                run_id=f"g{generation}-select-child-{index}",
            )
            fixes, breaks, pvalue = paired_comparison(champion_select, child)
            selections.append(
                SelectionResult(
                    child_version,
                    mutation_id,
                    proposal,
                    fixes,
                    breaks,
                    pvalue,
                    child.r_at_1,
                )
            )

        promotable = [selection for selection in selections if selection.promotes]
        winner = max(
            promotable,
            key=lambda value: (value.fixes - value.breaks, value.score, -value.pvalue),
            default=None,
        )
        for selection in selections:
            status = (
                "promoted"
                if winner and selection.mutation_id == winner.mutation_id
                else "selection_failed"
            )
            self.store.set_version_status(
                selection.child_version,
                "champion" if status == "promoted" else "rejected",
                parent_version=champion_version,
                mutation_id=selection.mutation_id,
            )
            self.store.db.toc_mutations.update_one(
                {"_id": selection.mutation_id},
                {
                    "$set": {
                        "status": status,
                        "selection": {
                            "fixes": selection.fixes,
                            "breaks": selection.breaks,
                            "pvalue": selection.pvalue,
                            "r_at_1": selection.score,
                        },
                        "updated_at": utc_now(),
                    }
                },
            )

        current_champion = self.store.champion_version()
        test_score: float | None = None
        if generation % 3 == 0:
            test = await self.router.score(
                "toc", "test", current_champion, run_id=f"g{generation}-test"
            )
            test_score = test.r_at_1
            self.store.db.toc_fitness.insert_one(
                {
                    "generation": generation,
                    "toc_version": current_champion,
                    "r_at_1": test.r_at_1,
                    "hallucination_rate": test.hallucination_rate,
                    "created_at": utc_now(),
                }
            )

        entry = {
            "generation": generation,
            "champion_before": champion_version,
            "champion_after": current_champion,
            "failures": len(failures),
            "proposals": [proposal.to_document() for proposal in proposals],
            "guard": guard_rows,
            "selection": [
                {
                    "child_version": item.child_version,
                    "mutation_id": item.mutation_id,
                    "operator": item.proposal.operator,
                    "fixes": item.fixes,
                    "breaks": item.breaks,
                    "pvalue": item.pvalue,
                    "r_at_1": item.score,
                    "promoted": bool(winner and item.mutation_id == winner.mutation_id),
                }
                for item in selections
            ],
            "test_r_at_1": test_score,
            "created_at": utc_now(),
        }
        self.log.append(entry)
        self.store.save_json("toc_evolution_log.json", self.log)
        self._print_generation(entry)
        return entry

    def _print_generation(self, entry: dict[str, Any]) -> None:
        self.console.rule(f"Generation {entry['generation']}")
        self.console.print(f"Failures found: [bold]{entry['failures']}[/bold]")
        guard_table = Table("operator", "guard", "reason")
        for row in entry["guard"]:
            guard_table.add_row(
                row["operator"],
                "ACCEPT" if row["accepted"] else "REJECT",
                ", ".join(row["reasons"]) or "—",
            )
        self.console.print(guard_table)
        selection_table = Table("operator", "fixes", "breaks", "p", "verdict")
        for row in entry["selection"]:
            selection_table.add_row(
                row["operator"],
                str(row["fixes"]),
                str(row["breaks"]),
                f"{row['pvalue']:.4f}",
                "PROMOTED" if row["promoted"] else "REJECTED",
            )
        self.console.print(selection_table)
        score = entry["test_r_at_1"]
        self.console.print(
            f"Champion v{entry['champion_after']}"
            + (
                f"; test R@1 {score:.3f}"
                if score is not None
                else "; test not sampled this generation"
            )
        )


async def run(generations: int, continuous: bool) -> None:
    settings = Settings.from_env(require_model=True)
    store = DarwinStore(settings)
    loop = EvolutionLoop(settings, store)
    try:
        generation = 1
        while continuous or generation <= generations:
            await loop.generation(generation)
            generation += 1
    finally:
        store.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--generations", type=int, default=2)
    parser.add_argument("--continuous", action="store_true")
    args = parser.parse_args()
    asyncio.run(run(args.generations, args.continuous))


if __name__ == "__main__":
    main()
