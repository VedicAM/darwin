"""Compact live/replay dashboard for Darwin's taxonomy evolution."""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from rich.console import Console, Group
from rich.layout import Layout
from rich.live import Live
from rich.panel import Panel
from rich.table import Table
from rich.text import Text
from rich.tree import Tree

from .config import Settings
from .storage import DarwinStore, utc_now

BLOCKS = "▁▂▃▄▅▆▇█"


def sparkline(values: list[float]) -> str:
    if not values:
        return "not measured"
    low, high = min(values), max(values)
    if high == low:
        return BLOCKS[len(BLOCKS) // 2] * len(values)
    return "".join(
        BLOCKS[round((value - low) / (high - low) * (len(BLOCKS) - 1))]
        for value in values
    )


def _latest_runs(store: DarwinStore) -> dict[str, dict[str, Any]]:
    groups: dict[tuple[str, str, int], list[dict[str, Any]]] = {}
    cursor = (
        store.db.routing_results.find({"split": "test"}, {"_id": 0})
        .sort("created_at", -1)
        .limit(5000)
    )
    for row in cursor:
        key = (
            str(row.get("method")),
            str(row.get("run_id")),
            int(row.get("toc_version", 0)),
        )
        groups.setdefault(key, []).append(row)
    latest: dict[str, dict[str, Any]] = {}
    for (method, run_id, version), rows in groups.items():
        if method in latest:
            continue
        latest[method] = {
            "run_id": run_id,
            "toc_version": version,
            "r_at_1": sum(bool(row.get("correct")) for row in rows) / len(rows),
            "hallucination_rate": sum(bool(row.get("hallucinated")) for row in rows)
            / len(rows),
        }
    return latest


def snapshot_from_store(store: DarwinStore) -> dict[str, Any]:
    versions = list(
        store.db.toc_versions.find({}, {"_id": 0}).sort("version", 1).limit(50)
    )
    mutations = list(store.db.toc_mutations.find().sort("created_at", -1).limit(12))
    fitness = list(
        store.db.toc_fitness.find({}, {"_id": 0}).sort("generation", 1).limit(100)
    )
    for mutation in mutations:
        mutation["_id"] = str(mutation.get("_id", ""))
    return {
        "captured_at": utc_now(),
        "versions": versions,
        "mutations": mutations,
        "fitness": fitness,
        "runs": _latest_runs(store),
    }


def replay_snapshots(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, dict) and "versions" in payload:
        return [payload]
    if isinstance(payload, dict) and isinstance(payload.get("snapshots"), list):
        return payload["snapshots"]
    if not isinstance(payload, list):
        raise TypeError("replay must be a snapshot, snapshots array, or evolution log")
    snapshots: list[dict[str, Any]] = []
    versions: dict[int, dict[str, Any]] = {
        1: {"version": 1, "parent_version": None, "status": "champion"}
    }
    mutations: list[dict[str, Any]] = []
    fitness: list[dict[str, Any]] = []
    for entry in payload:
        parent = int(entry.get("champion_before", 1))
        champion = int(entry.get("champion_after", parent))
        if champion != parent:
            versions[parent]["status"] = "superseded"
            versions[champion] = {
                "version": champion,
                "parent_version": parent,
                "status": "champion",
            }
        for selection in entry.get("selection", []):
            child = int(selection["child_version"])
            versions.setdefault(
                child,
                {
                    "version": child,
                    "parent_version": parent,
                    "status": "champion" if selection.get("promoted") else "rejected",
                },
            )
            mutations.insert(
                0,
                {
                    "_id": selection.get("mutation_id", "replay"),
                    "from_version": parent,
                    "to_version": child,
                    "status": "promoted"
                    if selection.get("promoted")
                    else "selection_failed",
                    "proposal": {
                        "operator": selection.get("operator"),
                        "diagnosis": "saved replay",
                    },
                    "guard": {"accepted": True, "reasons": []},
                    "selection": selection,
                },
            )
        if entry.get("test_r_at_1") is not None:
            fitness.append(
                {
                    "generation": entry.get("generation"),
                    "toc_version": champion,
                    "r_at_1": entry["test_r_at_1"],
                    "hallucination_rate": entry.get("hallucination_rate"),
                }
            )
        snapshots.append(
            {
                "captured_at": entry.get("created_at", "replay"),
                "versions": sorted(versions.values(), key=lambda row: row["version"]),
                "mutations": mutations[:12],
                "fitness": list(fitness),
                "runs": {},
            }
        )
    return snapshots or [{"versions": [], "mutations": [], "fitness": [], "runs": {}}]


def _lineage(snapshot: dict[str, Any]) -> Tree | Text:
    versions = snapshot.get("versions", [])
    if not versions:
        return Text("No versions recorded", style="dim")

    def label(row: dict[str, Any]) -> Text:
        version = row.get("version", "?")
        status = str(row.get("status", "unknown"))
        value = Text(f"v{version}  {status}")
        if status == "champion":
            value.stylize("bold green")
        elif status in {"rejected", "guard_rejected"}:
            value.stylize("strike dim")
        else:
            value.stylize("cyan")
        return value

    roots = [row for row in versions if row.get("parent_version") is None]
    root = roots[0] if roots else versions[0]
    tree = Tree(label(root))
    children: dict[int, list[dict[str, Any]]] = {}
    for row in versions:
        parent = row.get("parent_version")
        if parent is not None:
            children.setdefault(int(parent), []).append(row)

    def append(branch: Tree, version: int, seen: set[int]) -> None:
        if version in seen:
            return
        seen = seen | {version}
        for child in sorted(
            children.get(version, []), key=lambda row: row.get("version", 0)
        )[-5:]:
            child_branch = branch.add(label(child))
            append(child_branch, int(child.get("version", 0)), seen)

    append(tree, int(root.get("version", 1)), set())
    return tree


def _feed(snapshot: dict[str, Any]) -> Table:
    table = Table.grid(expand=True)
    table.add_column(ratio=1, overflow="fold")
    mutations = snapshot.get("mutations", [])[:5]
    if not mutations:
        table.add_row("[dim]No mutations recorded[/dim]")
        return table
    for row in mutations:
        proposal = row.get("proposal", {})
        selection = row.get("selection", {})
        guard = row.get("guard", {})
        verdict = row.get("status") or (
            "accepted" if guard.get("accepted") else "rejected"
        )
        pvalue = selection.get("pvalue")
        score = f"{selection.get('fixes', 0)}/{selection.get('breaks', 0)}" + (
            f" p={pvalue:.3g}" if isinstance(pvalue, (int, float)) else ""
        )
        diagnosis = str(proposal.get("diagnosis", ""))[:58]
        table.add_row(
            f"[bold]{proposal.get('operator', '?')}[/bold] [{verdict}] {score}\n[dim]{diagnosis}[/dim]"
        )
    return table


def _scoreboard(snapshot: dict[str, Any]) -> Group:
    fitness = snapshot.get("fitness", [])
    scores = [float(row["r_at_1"]) for row in fitness if row.get("r_at_1") is not None]
    latest = fitness[-1] if fitness else {}
    flat = snapshot.get("runs", {}).get("flat", {})
    lines = [
        Text(
            f"test R@1  {sparkline(scores)}  {scores[-1]:.3f}"
            if scores
            else "test R@1  not measured"
        ),
        Text(
            f"halluc.  {latest['hallucination_rate']:.3f}"
            if latest.get("hallucination_rate") is not None
            else "halluc.  not measured"
        ),
        Text(
            f"flat ref. ───────── {flat['r_at_1']:.3f}"
            if flat.get("r_at_1") is not None
            else "flat ref. not measured",
            style="yellow",
        ),
    ]
    return Group(*lines)


def _discoveries(snapshot: dict[str, Any]) -> Table:
    table = Table.grid(expand=True)
    table.add_column(overflow="fold")
    promoted = [
        row for row in snapshot.get("mutations", []) if row.get("status") == "promoted"
    ][:5]
    if not promoted:
        table.add_row("[dim]No promoted discoveries yet[/dim]")
        return table
    for row in promoted:
        proposal = row.get("proposal", {})
        selection = row.get("selection", {})
        net = int(selection.get("fixes", 0)) - int(selection.get("breaks", 0))
        table.add_row(
            f"• {proposal.get('operator', 'mutation').replace('toc_', '').replace('_', ' ')}: "
            f"{str(proposal.get('diagnosis', ''))[:70]} ([green]{net:+d} net[/green])"
        )
    return table


def render(snapshot: dict[str, Any], *, offline: bool = False) -> Layout:
    layout = Layout()
    status = "OFFLINE — cached " if offline else "LIVE — "
    captured = str(snapshot.get("captured_at", "unknown"))
    layout.split_column(Layout(name="header", size=1), Layout(name="body"))
    layout["header"].update(
        Text(
            f"DARWIN  {status}{captured}",
            style="bold yellow" if offline else "bold green",
        )
    )
    layout["body"].split_column(Layout(name="top"), Layout(name="bottom"))
    layout["top"].split_row(Layout(name="lineage"), Layout(name="feed"))
    layout["bottom"].split_row(Layout(name="scoreboard"), Layout(name="discoveries"))
    layout["lineage"].update(
        Panel(_lineage(snapshot), title="LINEAGE", border_style="cyan")
    )
    layout["feed"].update(
        Panel(_feed(snapshot), title="LIVE FEED", border_style="magenta")
    )
    layout["scoreboard"].update(
        Panel(_scoreboard(snapshot), title="SCOREBOARD", border_style="green")
    )
    layout["discoveries"].update(
        Panel(_discoveries(snapshot), title="DISCOVERIES", border_style="yellow")
    )
    return layout


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--replay", type=Path)
    parser.add_argument("--speed", type=float, default=4.0)
    parser.add_argument("--poll", type=float, default=2.0)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    console = Console()
    if args.replay:
        frames = replay_snapshots(json.loads(args.replay.read_text(encoding="utf-8")))
        with Live(render(frames[0]), console=console, refresh_per_second=8) as live:
            for frame in frames:
                live.update(render(frame))
                if not args.once:
                    time.sleep(max(0.05, 1.0 / args.speed))
        return

    settings = Settings.from_env()
    cache = settings.output_dir / "live_snapshot.json"
    store = DarwinStore(settings)
    last: dict[str, Any] = {
        "captured_at": "never",
        "versions": [],
        "mutations": [],
        "fitness": [],
        "runs": {},
    }
    with Live(
        render(last, offline=True), console=console, refresh_per_second=4
    ) as live:
        while True:
            offline = False
            try:
                store.ping()
                last = snapshot_from_store(store)
                cache.parent.mkdir(parents=True, exist_ok=True)
                cache.write_text(
                    json.dumps(last, indent=2, default=str) + "\n", encoding="utf-8"
                )
            except Exception:  # noqa: BLE001 - dashboard must survive connectivity loss
                offline = True
                if cache.exists():
                    last = json.loads(cache.read_text(encoding="utf-8"))
                    last["captured_at"] = (
                        f"{last.get('captured_at', 'unknown')} (last update)"
                    )
                else:
                    last["captured_at"] = (
                        datetime.now().astimezone().strftime("%H:%M:%S")
                    )
            live.update(render(last, offline=offline))
            if args.once:
                break
            time.sleep(max(0.2, args.poll))
    store.close()


if __name__ == "__main__":
    main()
