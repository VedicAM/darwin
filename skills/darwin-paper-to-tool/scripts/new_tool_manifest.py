"""Create and validate a Darwin paper-tool manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


def load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--paper-id", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--summary", required=True)
    parser.add_argument("--entrypoint", required=True)
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--tests", nargs="+", required=True)
    parser.add_argument("--capability", action="append", default=[])
    parser.add_argument("--uncertainty", action="append", default=[])
    parser.add_argument("--toc", action="append", default=[])
    parser.add_argument("--dependency", action="append", default=[])
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    evidence = load_json(args.evidence)
    if not isinstance(evidence, list) or not evidence:
        raise SystemExit("evidence must be a non-empty JSON array")
    for item in evidence:
        if (
            not isinstance(item, dict)
            or not item.get("section")
            or not item.get("claim")
        ):
            raise SystemExit("each evidence item requires section and claim")
        if item.get("classification") not in {
            "paper_stated",
            "implementation_choice",
            "unknown",
        }:
            raise SystemExit("invalid evidence classification")

    artifact_hash = hashlib.sha256(args.artifact.read_bytes()).hexdigest()
    manifest = {
        "paper_id": args.paper_id,
        "name": args.name,
        "summary": args.summary,
        "capabilities": args.capability,
        "evidence": evidence,
        "uncertainties": args.uncertainty,
        "entrypoint": args.entrypoint,
        "tests": args.tests,
        "dependencies": args.dependency,
        "toc_path": args.toc,
        "artifact_sha256": artifact_hash,
        "status": "candidate",
        "schema_version": 1,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
        handle.write("\n")


if __name__ == "__main__":
    main()
