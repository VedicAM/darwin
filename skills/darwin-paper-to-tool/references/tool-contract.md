# Darwin paper-tool contract

## Stage artifacts

1. `paper_map.json`: source identity, content hash, ToC, section identifiers,
   figures, tables, equations, and appendices.
2. `evidence_ledger.json`: one row per implementation claim with `section`,
   `claim`, `classification`, and optional `uncertainty`.
3. `implementation_plan.json`: scope, entrypoint, component list, dependencies,
   interfaces, datasets, metrics, and resource assumptions.
4. Candidate source and tests.
5. `paper_tool.json`: registry manifest created by the bundled script.
6. `validation.json`: exact commands, environment, results, known deviations,
   and reproduction level.

## Registry fields

`paper_tools` stores:

- `_id`: deterministic `pt-*` identifier.
- `paper_id`, `name`, `summary`, `capabilities`, and `toc_path`.
- `evidence`: section-scoped claims; no unsupported claims.
- `uncertainties`: unresolved details or implementation choices.
- `entrypoint`, `dependencies`, `tests`, and artifact SHA-256.
- `status`: `candidate`, `active`, `rejected`, or `dead_end`.
- `validation`: passing and failing test counts plus review state.

`paper_tool_runs` stores each evaluation run. Failed or abandoned runs should
reference a `failure_id` from Darwin's `failures` collection.

## Promotion rules

- Candidate generation is not validation.
- At least one executable test must pass and no required test may fail.
- A reviewer must confirm that the evidence ledger supports the implementation.
- Unknown paper details remain explicit; they are not converted into claimed
  paper settings.
- Performance claims require comparison on the paper's stated metric and setup,
  or must be labeled non-comparable.

## Provenance

This workflow is inspired by the planning to analysis to coding to evaluation
pipeline in [going-doer/Paper2Code](https://github.com/going-doer/Paper2Code),
reviewed at commit `ba9169978043d5799c8d4f4a0963e6b66a24c2e1` under Apache-2.0. No upstream
source code is bundled in this skill.
