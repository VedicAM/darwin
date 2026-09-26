"""Seed the immutable v1 taxonomy and its 60-task routing benchmark."""

from __future__ import annotations

from collections import Counter

from rich.console import Console
from rich.table import Table

from .config import Settings
from .storage import DarwinStore
from .taxonomy import routing_tasks, version_one_nodes


def main() -> None:
    settings = Settings.from_env()
    store = DarwinStore(settings)
    console = Console()
    try:
        store.ping()
        store.ensure_indexes()
        nodes = version_one_nodes()
        tasks = routing_tasks(settings.random_seed)
        inserted_nodes = store.write_nodes(nodes)
        store.set_version_status(1, "champion")
        written_tasks = store.write_tasks(tasks)
        store.save_json("routing_tasks.json", [task.to_document() for task in tasks])
        store.save_json("tool_toc_v1.json", [node.to_document() for node in nodes])

        counts = Counter(task.split for task in tasks)
        table = Table(title="Darwin routing benchmark")
        table.add_column("split")
        table.add_column("tasks", justify="right")
        for split in ("evolve", "select", "test"):
            table.add_row(split, str(counts[split]))
        console.print(table)
        console.print(
            f"[green]{len(nodes)}[/green] taxonomy nodes; {inserted_nodes} newly inserted"
        )
        console.print(
            f"[green]{len(tasks)}[/green] tasks; {written_tasks} inserted or updated"
        )
        ambiguous = [task for task in tasks if task.ambiguous_with]
        uncovered = [task for task in tasks if task.uncovered]
        console.print(f"[yellow]{len(ambiguous)}[/yellow] ambiguous tasks")
        for task in ambiguous:
            console.print(
                f"  {task.task_id}: {task.gold_leaf} vs {task.ambiguous_with}"
            )
        console.print(f"[magenta]{len(uncovered)}[/magenta] uncovered tasks")
        for task in uncovered:
            console.print(f"  {task.task_id}: {task.text}")
    finally:
        store.close()


if __name__ == "__main__":
    main()
