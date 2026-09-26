"""Offline, honest replay of a completed Darwin taxonomy-evolution run."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.tree import Tree


def read_json(directory: Path, name: str, default: Any) -> Any:
    path = directory / name
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


class Replay:
    def __init__(self, directory: Path, pause: bool):
        self.directory = directory
        self.pause = pause
        self.console = Console()
        self.toc = read_json(directory, "tool_toc_v1.json", [])
        self.tasks = read_json(directory, "routing_tasks.json", [])
        self.baselines = read_json(directory, "routing_baseline.json", [])
        self.evolution = read_json(directory, "toc_evolution_log.json", [])
        self.knockouts = read_json(directory, "knockouts.json", {})

    def wait(self) -> None:
        if self.pause:
            input("Press Enter to continue…")

    def environment(self) -> None:
        self.console.rule("1. THE ENVIRONMENT")
        self.console.print(
            Panel(
                f"Version 1 contains [bold]{len(self.toc)}[/bold] nodes. A human organized this starting taxonomy.",
                title="Darwin tool environment",
            )
        )
        self.wait()

    def failures(self) -> None:
        self.console.rule("2. THE FAILURES")
        toc_baseline = next(
            (item for item in self.baselines if item.get("method") == "toc"), {}
        )
        failures = [
            item for item in toc_baseline.get("per_task", []) if not item.get("correct")
        ][:3]
        task_by_id = {task["task_id"]: task for task in self.tasks}
        descriptions = {node["path"]: node["description"] for node in self.toc}
        table = Table("task", "predicted", "gold", "confusable descriptions")
        for item in failures:
            task = task_by_id.get(item["task_id"], {})
            predicted = item.get("predicted_leaf")
            gold = item.get("gold_leaf")
            table.add_row(
                task.get("text", item["task_id"]),
                str(predicted),
                str(gold),
                f"{descriptions.get(predicted, 'unknown')}\nvs\n{descriptions.get(gold, 'unknown')}",
            )
        self.console.print(
            table if failures else "No recorded v1 failures are available."
        )
        self.wait()

    def evolution_log(self) -> None:
        self.console.rule("3. THE EVOLUTION")
        table = Table("generation", "failures", "operators", "selection", "champion")
        for entry in self.evolution:
            operators = ", ".join(
                item["operator"] for item in entry.get("proposals", [])
            )
            selection = "; ".join(
                f"{item['fixes']} fixes/{item['breaks']} breaks, p={item['pvalue']:.3f}"
                for item in entry.get("selection", [])
            )
            table.add_row(
                str(entry["generation"]),
                str(entry["failures"]),
                operators,
                selection or "no accepted candidates",
                f"v{entry['champion_after']}",
            )
        self.console.print(
            table if self.evolution else "No completed evolution run is available."
        )
        self.wait()

    def knockout_table(self) -> None:
        self.console.rule("4. THE KNOCKOUTS")
        table = Table("mutation", "operator", "effect", "CI", "class")
        for item in self.knockouts.get("knockouts", []):
            table.add_row(
                item["mutation_id"],
                item["operator"],
                f"{item['effect']:+.3f}",
                f"[{item['ci'][0]:+.3f}, {item['ci'][1]:+.3f}]",
                item["class"],
            )
        self.console.print(
            table
            if self.knockouts.get("knockouts")
            else "No knockout run is available."
        )
        self.console.print(
            f"Pruned champion R@1: {self.knockouts.get('pruned_r_at_1', 'not measured')}"
        )
        self.wait()

    def numbers(self) -> None:
        self.console.rule("5. THE NUMBERS")
        table = Table("method", "version", "R@1", "hallucination")
        for item in self.baselines:
            table.add_row(
                item["method"],
                f"v{item['toc_version']}",
                f"{item['r_at_1']:.3f}",
                f"{item['hallucination_rate']:.3f}",
            )
        final = next(
            (
                entry
                for entry in reversed(self.evolution)
                if entry.get("test_r_at_1") is not None
            ),
            None,
        )
        if final:
            table.add_row(
                "toc-final",
                f"v{final['champion_after']}",
                f"{final['test_r_at_1']:.3f}",
                "see recorded task results",
            )
        self.console.print(
            table if self.baselines else "No routing benchmark run is available."
        )
        self.wait()

    def lineage(self) -> None:
        self.console.rule("6. THE STATE")
        root = Tree("v1 champion")
        by_parent: dict[int, list[dict[str, Any]]] = {}
        for entry in self.evolution:
            by_parent.setdefault(int(entry["champion_before"]), []).append(entry)

        def append(parent_tree: Tree, version: int, seen: set[int]) -> None:
            if version in seen:
                return
            seen.add(version)
            for entry in by_parent.get(version, []):
                child = int(entry["champion_after"])
                if child == version:
                    parent_tree.add(f"generation {entry['generation']}: no promotion")
                else:
                    branch = parent_tree.add(f"v{child} champion (parent v{version})")
                    append(branch, child, seen)

        append(root, 1, set())
        self.console.print(root)
        self.console.print(
            "This is an offline replay of saved run artifacts, not a live run."
        )

    def run(self) -> None:
        self.environment()
        self.failures()
        self.evolution_log()
        self.knockout_table()
        self.numbers()
        self.lineage()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", type=Path, default=Path("evolution/runs"))
    parser.add_argument("--no-pause", action="store_true")
    args = parser.parse_args()
    Replay(args.run_dir, pause=not args.no_pause).run()


if __name__ == "__main__":
    main()
