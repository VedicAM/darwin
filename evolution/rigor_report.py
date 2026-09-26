"""Generate a one-screen, evidence-backed rigor report and RIGOR.md."""

from __future__ import annotations

import argparse
import asyncio
import statistics
from collections import Counter
from pathlib import Path
from typing import Any

from rich.console import Console
from rich.table import Table

from .config import Settings
from .router import Router
from .storage import DarwinStore, utc_now

PROMOTION_RULE = (
    "fixes > breaks and "
    "scipy.stats.binomtest(fixes, fixes + breaks, 0.5, alternative='greater').pvalue < 0.1"
)
GUARD_REASON_CATEGORIES = {
    "task_text_leakage",
    "move_cycle",
    "description_length",
    "repeats_dead_end",
    "unknown_path",
}


def reason_category(reason: str) -> str:
    return "unknown_path" if reason.startswith("unknown_path:") else reason


def collect_report(store: DarwinStore) -> dict[str, Any]:
    split_counts = {
        split: store.db.routing_tasks.count_documents({"split": split})
        for split in ("evolve", "select", "test")
    }
    promoted = list(store.db.toc_mutations.find({"status": "promoted"}))
    pvalues = [
        float(row["selection"]["pvalue"])
        for row in promoted
        if row.get("selection", {}).get("pvalue") is not None
    ]
    rejection_reasons: Counter[str] = Counter(
        {key: 0 for key in GUARD_REASON_CATEGORIES}
    )
    for row in store.db.toc_mutations.find({"status": "guard_rejected"}):
        rejection_reasons.update(
            reason_category(reason)
            for reason in row.get("guard", {}).get("reasons", [])
        )
    knockouts = list(store.db.toc_knockouts.find())
    hash_rows = store.verify_version_hashes()
    return {
        "generated_at": utc_now(),
        "split_counts": split_counts,
        "promotion_rule": PROMOTION_RULE,
        "promoted_count": len(promoted),
        "promoted_median_pvalue": statistics.median(pvalues) if pvalues else None,
        "guard_rejections": dict(sorted(rejection_reasons.items())),
        "anti_leakage_rule": "reject any description sharing a normalized substring of 12+ characters with an evolve task",
        "bootstrap": "paired over tasks; 1,000 resamples; percentile 95% CI; seed DARWIN_RANDOM_SEED + mutation index",
        "knockout_ci_excludes_zero": sum(
            bool(row.get("ci"))
            and not (float(row["ci"][0]) <= 0 <= float(row["ci"][1]))
            for row in knockouts
        ),
        "knockout_count": len(knockouts),
        "version_count": len(hash_rows),
        "hashes_present": sum(row["expected"] is not None for row in hash_rows),
        "hashes_verified": sum(row["verified"] for row in hash_rows),
        "hash_failures": [row["version"] for row in hash_rows if not row["verified"]],
        "random_seed": store.settings.random_seed,
        "openrouter_model": store.settings.openrouter_model,
        "reproducibility": None,
    }


async def verify_reproducibility(store: DarwinStore, report: dict[str, Any]) -> None:
    version = store.champion_version()
    tasks = store.tasks("test")
    router = Router(store.settings, store)
    first = await router.score(
        "toc", "test", version, run_id="rigor-repro-a", tasks=tasks
    )
    second = await router.score(
        "toc", "test", version, run_id="rigor-repro-b", tasks=tasks
    )
    first_vector = [result.predicted_leaf for result in first.per_task]
    second_vector = [result.predicted_leaf for result in second.per_task]
    report["reproducibility"] = {
        "version": version,
        "task_count": len(tasks),
        "first_r_at_1": first.r_at_1,
        "second_r_at_1": second.r_at_1,
        "exact_routes_match": first_vector == second_vector,
    }


def _fmt(value: Any, digits: int = 4) -> str:
    return (
        "not measured"
        if value is None
        else f"{value:.{digits}f}"
        if isinstance(value, float)
        else str(value)
    )


def render_table(report: dict[str, Any]) -> Table:
    table = Table("evidence", "observed", title="Darwin rigor report", expand=True)
    counts = report["split_counts"]
    table.add_row(
        "PROTOCOL",
        f"evolve={counts['evolve']}, select={counts['select']}, test={counts['test']}; proposer→evolve, promotion→select, report→test",
    )
    table.add_row("PROMOTION", report["promotion_rule"])
    table.add_row(
        "PROMOTED p",
        f"n={report['promoted_count']}; median={_fmt(report['promoted_median_pvalue'])}",
    )
    reasons = report["guard_rejections"]
    table.add_row(
        "GUARD",
        ", ".join(f"{key}={value}" for key, value in reasons.items())
        or "no recorded rejections",
    )
    table.add_row("ANTI-LEAKAGE", report["anti_leakage_rule"])
    table.add_row(
        "KNOCKOUTS",
        f"{report['bootstrap']}; CI excludes 0: {report['knockout_ci_excludes_zero']}/{report['knockout_count']}",
    )
    table.add_row(
        "IMMUTABILITY",
        f"structural hashes verified: {report['hashes_verified']}/{report['version_count']}; failures={report['hash_failures'] or 'none'}",
    )
    repro = report.get("reproducibility")
    table.add_row(
        "REPRODUCIBILITY",
        (
            f"temperature=0; v{repro['version']}; R@1={repro['first_r_at_1']:.3f}/{repro['second_r_at_1']:.3f}; exact routes match={repro['exact_routes_match']}"
            if repro
            else "not measured — run with OPENROUTER_API_KEY or --verify-routing"
        ),
    )
    table.add_row(
        "SEED / MODEL", f"seed={report['random_seed']}; {report['openrouter_model']}"
    )
    return table


def markdown(report: dict[str, Any]) -> str:
    counts = report["split_counts"]
    reasons = report["guard_rejections"]
    repro = report.get("reproducibility")
    reproduction = (
        f"Champion v{repro['version']} produced R@1 {repro['first_r_at_1']:.3f} and {repro['second_r_at_1']:.3f}; exact route vectors matched: `{repro['exact_routes_match']}`."
        if repro
        else "Not measured in this report. Re-run `python -m evolution.rigor_report --verify-routing` with `OPENROUTER_API_KEY` set."
    )
    guard_rows = (
        "\n".join(f"| `{key}` | {value} |" for key, value in reasons.items())
        or "| — | 0 |"
    )
    return f"""# Darwin rigor report

Generated from recorded Atlas evidence at `{report["generated_at"]}`. Missing measurements are labeled; no showcase result is hardcoded.

## Protocol

| Split | Tasks | Role |
| --- | ---: | --- |
| `evolve` | {counts["evolve"]} | visible to the proposer |
| `select` | {counts["select"]} | decides promotion |
| `test` | {counts["test"]} | reported only; never selects mutations |

Promotion rule: `{report["promotion_rule"]}`. Promoted mutations: {report["promoted_count"]}; observed median promoted p-value: {_fmt(report["promoted_median_pvalue"])}.

## Guard

| Rejection reason | Count |
| --- | ---: |
{guard_rows}

Anti-leakage rule: {report["anti_leakage_rule"]}.

## Statistics

Knockout confidence intervals are {report["bootstrap"]}. The interval excludes zero for {report["knockout_ci_excludes_zero"]} of {report["knockout_count"]} recorded knockouts.

## Immutability

Darwin recomputed and verified {report["hashes_verified"]} of {report["version_count"]} stored structural SHA-256 hashes. Failed or missing versions: `{report["hash_failures"] or "none"}`. Routing counters and embeddings are operational metadata and are excluded from the structural hash.

## Reproducibility

Seed: `{report["random_seed"]}`. Model: `{report["openrouter_model"]}`. {reproduction}
"""


async def run(output: Path, verify: bool) -> dict[str, Any]:
    settings = Settings.from_env(require_model=verify)
    store = DarwinStore(settings)
    try:
        report = collect_report(store)
        if verify:
            await verify_reproducibility(store, report)
        output.write_text(markdown(report), encoding="utf-8")
        store.save_json("rigor_report.json", report)
        Console().print(render_table(report))
        Console().print(f"Wrote [bold]{output}[/bold]")
        return report
    finally:
        store.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("RIGOR.md"))
    parser.add_argument("--verify-routing", action="store_true")
    args = parser.parse_args()
    asyncio.run(run(args.output, args.verify_routing))


if __name__ == "__main__":
    main()
