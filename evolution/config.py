"""Runtime configuration loaded exclusively from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    mongodb_uri: str
    database: str = "darwin_evaluation"
    openrouter_api_key: str | None = None
    openrouter_model: str = "openai/gpt-4.1-mini"
    output_dir: Path = Path("evolution/runs")
    random_seed: int = 2609
    concurrency: int = 16

    @classmethod
    def from_env(cls, *, require_model: bool = False) -> Settings:
        mongodb_uri = os.getenv("MONGODB_URI", "").strip()
        if not mongodb_uri:
            raise RuntimeError("MONGODB_URI is required")
        key = os.getenv("OPENROUTER_API_KEY", "").strip() or None
        if require_model and not key:
            raise RuntimeError("OPENROUTER_API_KEY is required for model routing")
        return cls(
            mongodb_uri=mongodb_uri,
            database=os.getenv("DARWIN_DATABASE", "darwin_evaluation"),
            openrouter_api_key=key,
            openrouter_model=os.getenv("OPENROUTER_MODEL", "openai/gpt-4.1-mini"),
            output_dir=Path(os.getenv("DARWIN_RUN_DIR", "evolution/runs")),
            random_seed=int(os.getenv("DARWIN_RANDOM_SEED", "2609")),
            concurrency=int(os.getenv("DARWIN_ROUTING_CONCURRENCY", "16")),
        )
