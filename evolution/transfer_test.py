"""Evaluate whether a champion transfers beyond mutation-touched taxonomy leaves."""

from __future__ import annotations

import argparse
import asyncio
import statistics
from typing import Any

from rich.console import Console
from rich.table import Table

from .config import Settings
from .models import RoutingTask, ScoreSummary
from .phylogeny import affected_paths
from .router import Router
from .storage import DarwinStore, utc_now

FRESH_TASKS = {
    "A.A1": "Download the annotated nucleotide record for accession JX869059 and include its organism lineage",
    "A.A2": "Search databases for DNA sequences homologous to this newly assembled contig",
    "A.A3": "Map every SapI cleavage position in this circular cloning vector",
    "A.A4": "Choose PCR oligos flanking this 430-base target while avoiding self-complementarity",
    "B.B1": "Locate MEDLINE-indexed cohort studies on long COVID published by this investigator",
    "B.B2": "Find openly accessible biomedical preprints that acknowledge this grant number",
    "B.B3": "Return the journal and reference list metadata associated with this DOI",
    "B.B4": "List new quantitative-biology manuscripts in the arXiv q-bio.GN category",
    "C.C1": "Retrieve the canonical reviewed enzyme sequence plus catalytic residue annotations",
    "C.C2": "Detect conserved repeats and domain boundaries in this protein chain",
    "C.C3": "Fetch the predicted fold and residue confidence profile for accession Q9Y6K9",
    "C.C4": "Search for remote protein homologs of this uncharacterized bacterial enzyme",
    "D.D1": "Collect clinical laboratory interpretations reported for the variant NM_007294.4:c.5266dup",
    "D.D2": "Compare this allele's frequency across African and Latino population cohorts",
    "D.D3": "Look up the overlapping transcripts and regulatory features at chr7:140453136",
    "D.D4": "Map rs429358 to its current reference-genome coordinates and submitted alleles",
    "E.E1": "Find measured Ki values for inhibitors assayed against cyclin-dependent kinase 2",
    "E.E2": "Retrieve the InChIKey, formula, and exact mass for caffeine",
    "E.E3": "Calculate topological polar surface area for this collection of SMILES",
    "E.E4": "Identify experimentally solved structures containing a heme ligand near this protein domain",
    "F.F1": "List curated signaling reactions connecting RAS activation to ERK phosphorylation",
    "F.F2": "Find cellular-component ontology annotations shared by these mitochondrial genes",
    "F.F3": "Retrieve the bacterial two-component-system module and its constituent reactions",
    "F.F4": "Construct an evidence-weighted association network for the proteins around MYC",
    "G.G1": "Rank candidate Cas9 guides for this enhancer by predicted off-target burden",
    "G.G2": "Find a reproducible tissue-clearing protocol with reagent concentrations and timing",
    "G.G3": "Verify the identity, synonyms, and known contamination warnings for HEK293T",
}


def untouched_transfer_tasks(
    store: DarwinStore, limit: int = 20
) -> tuple[list[RoutingTask], set[str]]:
    touched: set[str] = set()
    for mutation in store.db.toc_mutations.find({"status": "promoted"}):
        touched |= affected_paths(mutation.get("proposal", {}))
    champion = store.champion_version()
    v1_leaves = {node.path for node in store.nodes(1) if node.is_leaf}
    champion_leaves = {node.path for node in store.nodes(champion) if node.is_leaf}
    eligible = sorted((v1_leaves & champion_leaves & FRESH_TASKS.keys()) - touched)
    tasks = [
        RoutingTask(
            task_id=f"transfer-{index:03d}",
            text=FRESH_TASKS[path],
            gold_leaf=path,
            section=path.split(".")[0],
            split="transfer",
        )
        for index, path in enumerate(eligible[:limit], start=1)
    ]
    return tasks, touched


def wrong_tool_cost(store: DarwinStore) -> dict[str, Any]:
    rows = list(
        store.db.routing_results.find(
            {"method": "toc"},
            {"_id": 0, "correct": 1, "elapsed_seconds": 1, "total_tokens": 1},
        )
    )

    def mean(key: str, correct: bool, *, positive: bool = False) -> float | None:
        values = [
            float(row[key])
            for row in rows
            if bool(row.get("correct")) is correct
            and row.get(key) is not None
            and (not positive or float(row[key]) > 0)
        ]
        return statistics.fmean(values) if values else None

    return {
        "method": "toc",
        "right_count": sum(bool(row.get("correct")) for row in rows),
        "wrong_count": sum(not bool(row.get("correct")) for row in rows),
        "right_mean_tokens": mean("total_tokens", True, positive=True),
        "wrong_mean_tokens": mean("total_tokens", False, positive=True),
        "right_mean_seconds": mean("elapsed_seconds", True),
        "wrong_mean_seconds": mean("elapsed_seconds", False),
    }


def summary(summary: ScoreSummary) -> dict[str, Any]:
    return {
        "toc_version": summary.toc_version,
        "r_at_1": summary.r_at_1,
        "hallucination_rate": summary.hallucination_rate,
        "task_count": len(summary.per_task),
    }


async def run(limit: int = 20) -> dict[str, Any]:
    settings = Settings.from_env(require_model=True)
    store = DarwinStore(settings)
    router = Router(settings, store)
    try:
        tasks, touched = untouched_transfer_tasks(store, limit)
        if len(tasks) < limit:
            raise RuntimeError(
                f"only {len(tasks)} untouched eligible leaves remain; cannot honestly construct {limit} transfer tasks"
            )
        champion = store.champion_version()
        initial_score = await router.score(
            "toc", "transfer", 1, run_id="transfer-v1", tasks=tasks
        )
        champion_score = await router.score(
            "toc", "transfer", champion, run_id=f"transfer-v{champion}", tasks=tasks
        )
        payload = {
            "created_at": utc_now(),
            "model": settings.openrouter_model,
            "temperature": 0,
            "task_ids": [task.task_id for task in tasks],
            "gold_leaves": [task.gold_leaf for task in tasks],
            "excluded_mutation_touched_paths": sorted(touched),
            "v1": summary(initial_score),
            "champion": summary(champion_score),
            "wrong_tool_cost": wrong_tool_cost(store),
        }
        store.save_json("transfer_test.json", payload)
        return payload
    finally:
        store.close()


def _number(value: float | None, suffix: str = "") -> str:
    return "not measured" if value is None else f"{value:.3f}{suffix}"


def print_report(payload: dict[str, Any]) -> None:
    table = Table(
        "taxonomy", "R@1", "hallucination", "tasks", title="Untouched-section transfer"
    )
    for label in ("v1", "champion"):
        row = payload[label]
        table.add_row(
            label,
            f"{row['r_at_1']:.3f}",
            f"{row['hallucination_rate']:.3f}",
            str(row["task_count"]),
        )
    console = Console()
    console.print(table)
    cost = payload["wrong_tool_cost"]
    console.print(
        "Wrong vs right route cost (tree-aware): "
        f"tokens {_number(cost['wrong_mean_tokens'])} vs {_number(cost['right_mean_tokens'])}; "
        f"seconds {_number(cost['wrong_mean_seconds'], 's')} vs {_number(cost['right_mean_seconds'], 's')}"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tasks", type=int, default=20)
    args = parser.parse_args()
    payload = asyncio.run(run(args.tasks))
    print_report(payload)


if __name__ == "__main__":
    main()
