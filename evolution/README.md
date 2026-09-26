# Darwin taxonomy evolution

This package evolves Darwin's scientific-tool Table of Contents from measured
routing outcomes. The starting taxonomy has 35 nodes and the benchmark has 60
tasks split into 20 `evolve`, 20 `select`, and 20 untouched `test` tasks.

The model sees failures only from `evolve`. Candidate mutations are accepted or
rejected on `select` with a paired one-sided binomial test. `test` is sampled
every third generation and is never used for promotion. Every taxonomy version
is immutable and linked to its parent in MongoDB.

## Setup

```bash
python3 -m venv .venv-evolution
. .venv-evolution/bin/activate
pip install -r evolution/requirements.txt
export MONGODB_URI='mongodb+srv://…'
export OPENROUTER_API_KEY='…'
```

The default database is `darwin_evaluation`. Override it with
`DARWIN_DATABASE`. No secret is committed or written to run artifacts.

## Run

```bash
python -m evolution.eval_routing
python -m evolution.router --version 1
python -m evolution.evolve_loop --generations 2
python -m evolution.knockouts
python -m evolution.demo --no-pause
```

Use `python -m evolution.evolve_loop --continuous` only when you intend to run
unattended. All run artifacts are atomically written beneath `evolution/runs/`
for an honest offline replay.

If `tool_toc` has no embeddings or its vector index is unavailable, the flat
baseline reports and uses the deterministic `keyword_overlap` fallback. The
tree-aware and unconstrained methods require OpenRouter. Benchmark scores are
never seeded or fabricated.

`negative_results.py` implements Darwin's idempotent Negative Results Registry,
including leakage checks, dead ends, bounded pitfall recall, and calibrated
vector matching. `paper_tools.py` registers paper-derived tool candidates and
prevents promotion until tests and review are recorded. The reusable workflow
for producing those candidates is versioned in
`skills/darwin-paper-to-tool/`.
