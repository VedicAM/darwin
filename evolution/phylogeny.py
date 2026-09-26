"""Render Darwin's version lineage and per-leaf fossil record."""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

from rich.console import Console
from rich.progress_bar import ProgressBar
from rich.tree import Tree

from .config import Settings
from .models import TocNode
from .storage import DarwinStore, utc_now


def affected_paths(proposal: dict[str, Any]) -> set[str]:
    change = proposal.get("change", {})
    paths = {str(path) for path in change.get("paths", []) if path}
    for key in ("path", "parent", "new_parent"):
        if change.get(key):
            paths.add(str(change[key]))
    for child in change.get("children", []):
        if isinstance(child, dict) and child.get("path"):
            paths.add(str(child["path"]))
    return paths


def _shape(node: TocNode | None) -> tuple[Any, ...] | None:
    if node is None:
        return None
    return (node.parent, node.title, node.description, node.is_leaf, node.order)


def collect(store: DarwinStore) -> dict[str, Any]:
    versions = list(store.db.toc_versions.find({}, {"_id": 0}).sort("version", 1))
    mutations = list(store.db.toc_mutations.find().sort("created_at", 1))
    mutation_by_id = {str(row.get("_id")): row for row in mutations}
    fitness_by_version: dict[int, dict[str, Any]] = {}
    for row in store.db.toc_fitness.find({}, {"_id": 0}).sort("generation", 1):
        fitness_by_version[int(row["toc_version"])] = row

    lineage = []
    for version in versions:
        mutation = mutation_by_id.get(str(version.get("mutation_id")), {})
        fitness = fitness_by_version.get(int(version["version"]), {})
        lineage.append(
            {
                "version": int(version["version"]),
                "parent_version": version.get("parent_version"),
                "status": version.get("status", "unknown"),
                "operator": mutation.get("proposal", {}).get("operator", "human"),
                "test_r_at_1": fitness.get("r_at_1"),
                "mutation_id": version.get("mutation_id"),
            }
        )

    champion = store.champion_version()
    initial = {node.path: node for node in store.nodes(1)}
    current = [node for node in store.nodes(champion) if node.is_leaf]
    promoted = [row for row in mutations if row.get("status") == "promoted"]
    fossil_records: dict[str, list[dict[str, Any]]] = {}
    system_authored = 0
    for leaf in current:
        events: list[dict[str, Any]] = []
        origin = "human" if leaf.path in initial else "system"
        events.append(
            {
                "version": 1 if origin == "human" else None,
                "event": "created",
                "author": origin,
            }
        )
        for mutation in mutations:
            proposal = mutation.get("proposal", {})
            if leaf.path not in affected_paths(proposal):
                continue
            selection = mutation.get("selection", {})
            events.append(
                {
                    "version": mutation.get("to_version"),
                    "event": proposal.get("operator", "mutation").replace("toc_", ""),
                    "status": mutation.get("status", "unknown"),
                    "diagnosis": proposal.get("diagnosis"),
                    "net_fixes": int(selection.get("fixes", 0))
                    - int(selection.get("breaks", 0)),
                    "pvalue": selection.get("pvalue"),
                }
            )
        modified = origin == "system" or _shape(initial.get(leaf.path)) != _shape(leaf)
        if not modified:
            modified = any(
                leaf.path in affected_paths(row.get("proposal", {})) for row in promoted
            )
        if modified:
            system_authored += 1
        fossil_records[leaf.path] = events

    total = len(current)
    return {
        "generated_at": utc_now(),
        "champion_version": champion,
        "lineage": lineage,
        "fossil_records": fossil_records,
        "provenance": {
            "current_leaves": total,
            "human_unmodified": total - system_authored,
            "system_created_or_modified": system_authored,
            "system_ratio": system_authored / total if total else 0.0,
        },
    }


def lineage_tree(payload: dict[str, Any]) -> Tree:
    rows = payload["lineage"]
    roots = [row for row in rows if row.get("parent_version") is None]
    children: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if row.get("parent_version") is not None:
            children[int(row["parent_version"])].append(row)

    def label(row: dict[str, Any]) -> str:
        score = row.get("test_r_at_1")
        measured = (
            f" R@1={score:.3f}"
            if isinstance(score, (int, float))
            else " R@1=not measured"
        )
        status = row.get("status", "unknown")
        style = (
            "bold green"
            if status == "champion"
            else "strike dim"
            if status == "rejected"
            else "cyan"
        )
        return f"[{style}]v{row['version']} {status} · {row['operator']}{measured}[/{style}]"

    root_row = (
        roots[0]
        if roots
        else {
            "version": 1,
            "status": "unknown",
            "operator": "human",
            "test_r_at_1": None,
        }
    )
    tree = Tree(label(root_row))

    def append(branch: Tree, version: int, seen: set[int]) -> None:
        if version in seen:
            branch.add("[red]cycle detected[/red]")
            return
        seen = seen | {version}
        for child in sorted(children.get(version, []), key=lambda row: row["version"]):
            node = branch.add(label(child))
            append(node, int(child["version"]), seen)

    append(tree, int(root_row["version"]), set())
    return tree


def print_report(payload: dict[str, Any], console: Console) -> None:
    console.rule("DARWIN PHYLOGENY")
    console.print(lineage_tree(payload))
    console.rule("LEAF FOSSIL RECORD")
    for path, events in payload["fossil_records"].items():
        console.print(f"[bold]{path}[/bold]")
        for event in events:
            version = (
                f"v{event['version']}" if event.get("version") is not None else "later"
            )
            if event["event"] == "created":
                console.print(f"  {version} created ({event['author']})")
            else:
                pvalue = event.get("pvalue")
                ptext = f", p={pvalue:.3g}" if isinstance(pvalue, (int, float)) else ""
                console.print(
                    f"  {version} {event['event']} ({event.get('net_fixes', 0):+d} net{ptext}) "
                    f"[{event.get('status')}] {event.get('diagnosis') or ''}"
                )
    provenance = payload["provenance"]
    console.rule("PROVENANCE")
    console.print(
        ProgressBar(total=1.0, completed=provenance["system_ratio"], width=30),
        f" system-authored/modified {provenance['system_created_or_modified']}/{provenance['current_leaves']} "
        f"({provenance['system_ratio']:.1%})",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output", type=Path, default=Path("evolution/runs/phylogeny.json")
    )
    args = parser.parse_args()
    settings = Settings.from_env()
    store = DarwinStore(settings)
    try:
        payload = collect(store)
    finally:
        store.close()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(payload, indent=2, default=str) + "\n", encoding="utf-8"
    )
    print_report(payload, Console())


if __name__ == "__main__":
    main()
