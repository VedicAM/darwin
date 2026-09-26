import unittest
from dataclasses import replace
from io import StringIO

import numpy as np
from rich.console import Console

from evolution.knockouts import classify, paired_bootstrap
from evolution.live_panel import render, replay_snapshots, sparkline
from evolution.models import MutationProposal
from evolution.negative_results import (
    RegistryConfig,
    contains_task_leakage,
    trim_pitfall_block,
)
from evolution.paper_tools import ToolCandidate
from evolution.phylogeny import affected_paths
from evolution.router import keyword_route, render_tree
from evolution.storage import structural_hash
from evolution.taxonomy import routing_tasks, version_one_nodes
from evolution.toc_mutations import apply_to_nodes, guard


class TaxonomyTests(unittest.TestCase):
    def test_seed_counts_are_stable(self):
        tasks = routing_tasks()
        self.assertEqual(len(version_one_nodes()), 35)
        self.assertEqual(len(tasks), 60)
        self.assertEqual(sum(task.ambiguous_with is not None for task in tasks), 10)
        self.assertEqual(sum(task.uncovered for task in tasks), 6)
        self.assertEqual(
            {
                split: sum(task.split == split for task in tasks)
                for split in ("evolve", "select", "test")
            },
            {"evolve": 20, "select": 20, "test": 20},
        )

    def test_tree_renderer_contains_leaf_contract(self):
        tree = render_tree(version_one_nodes())
        self.assertIn("leaf A.A1 NCBI E-utilities", tree)

    def test_keyword_route_returns_a_valid_leaf(self):
        leaves = [node for node in version_one_nodes() if node.is_leaf]
        path, _ = keyword_route("retrieve allele frequency from gnomAD", leaves)
        self.assertEqual(path, "D.D2")

    def test_guard_rejects_leakage(self):
        tasks = routing_tasks()
        evolve = [task for task in tasks if task.split == "evolve"]
        copied = evolve[0].text
        proposal = MutationProposal(
            "toc_rewrite_description",
            "repeated confusion",
            (evolve[0].task_id, evolve[1].task_id),
            {"path": "A.A1", "description": f"Use this exact task text {copied}"},
            "improve routing",
        )
        allowed, reasons = guard(proposal, version_one_nodes(), tasks)
        self.assertFalse(allowed)
        self.assertIn("task_text_leakage", reasons)

    def test_guard_allows_new_insert_path(self):
        tasks = routing_tasks()
        evolve = [task for task in tasks if task.split == "evolve"]
        proposal = MutationProposal(
            "toc_insert",
            "two uncovered alignment failures",
            (evolve[0].task_id, evolve[1].task_id),
            {
                "path": "C.C5",
                "parent": "C",
                "title": "Multiple sequence alignment",
                "description": "Compare several peptide inputs using reproducible dynamic programming algorithms",
            },
            "cover alignment tasks",
        )
        allowed, reasons = guard(proposal, version_one_nodes(), tasks)
        self.assertTrue(allowed, reasons)

    def test_all_five_operators_apply(self):
        nodes = version_one_nodes()
        proposals = [
            MutationProposal(
                "toc_rewrite_description",
                "x",
                ("a", "b"),
                {
                    "path": "A.A1",
                    "description": "Retrieve accession records and linked NCBI metadata precisely",
                },
                "x",
            ),
            MutationProposal(
                "toc_move", "x", ("a", "b"), {"path": "A.A1", "new_parent": "D"}, "x"
            ),
            MutationProposal(
                "toc_split",
                "x",
                ("a", "b"),
                {
                    "path": "A.A1",
                    "children": [
                        {
                            "path": "A.A1.1",
                            "title": "Records",
                            "description": "Retrieve nucleotide records and accession metadata from NCBI",
                        },
                        {
                            "path": "A.A1.2",
                            "title": "Taxonomy",
                            "description": "Retrieve organism taxonomy and linked NCBI lineage records",
                        },
                    ],
                },
                "x",
            ),
            MutationProposal(
                "toc_merge",
                "x",
                ("a", "b"),
                {
                    "paths": ["B.B1", "B.B2"],
                    "path": "B.B1",
                    "title": "Biomedical literature",
                    "description": "Search biomedical citations, full text, grants, and publication metadata",
                },
                "x",
            ),
            MutationProposal(
                "toc_insert",
                "x",
                ("a", "b"),
                {
                    "path": "A.A5",
                    "parent": "A",
                    "title": "Alignment",
                    "description": "Align multiple nucleotide sequences and compute pairwise sequence identity",
                },
                "x",
            ),
        ]
        for index, proposal in enumerate(proposals, start=2):
            result = apply_to_nodes(proposal, nodes, index)
            self.assertTrue(result)
            self.assertTrue(all(node.toc_version == index for node in result))


class KnockoutTests(unittest.TestCase):
    def test_paired_bootstrap(self):
        champion = np.ones(20)
        knockout = np.zeros(20)
        effect, lower, upper = paired_bootstrap(champion, knockout, samples=100)
        self.assertEqual((effect, lower, upper), (1.0, 1.0, 1.0))
        self.assertEqual(classify(effect, lower, upper), "Essential")


class DemoEvidenceTests(unittest.TestCase):
    def test_structural_hash_ignores_runtime_counters(self):
        nodes = version_one_nodes()
        changed = [
            replace(node, routed_calls=9, routed_correct=7)
            if node.path == "A.A1"
            else node
            for node in nodes
        ]
        self.assertEqual(structural_hash(nodes), structural_hash(changed))

    def test_replay_log_becomes_progressive_snapshots(self):
        frames = replay_snapshots(
            [
                {
                    "generation": 1,
                    "champion_before": 1,
                    "champion_after": 2,
                    "selection": [
                        {
                            "child_version": 2,
                            "mutation_id": "mut-1",
                            "operator": "toc_insert",
                            "fixes": 3,
                            "breaks": 0,
                            "pvalue": 0.05,
                            "promoted": True,
                        }
                    ],
                    "test_r_at_1": 0.8,
                }
            ]
        )
        self.assertEqual(frames[0]["versions"][-1]["status"], "champion")
        self.assertEqual(frames[0]["mutations"][0]["status"], "promoted")

    def test_panel_renders_at_80_by_24(self):
        snapshot = {
            "captured_at": "now",
            "versions": [{"version": 1, "parent_version": None, "status": "champion"}],
            "mutations": [],
            "fitness": [],
            "runs": {},
        }
        stream = StringIO()
        console = Console(file=stream, width=80, height=24, force_terminal=True)
        console.print(render(snapshot))
        self.assertIn("DARWIN", stream.getvalue())

    def test_phylogeny_extracts_affected_paths(self):
        paths = affected_paths(
            {
                "change": {
                    "path": "C.C1",
                    "new_parent": "D",
                    "children": [{"path": "C.C1.1"}],
                }
            }
        )
        self.assertEqual(paths, {"C.C1", "C.C1.1", "D"})

    def test_sparkline_is_deterministic(self):
        self.assertEqual(len(sparkline([0.1, 0.2, 0.3])), 3)


class NegativeResultsTests(unittest.TestCase):
    def test_task_copy_guard(self):
        self.assertTrue(
            contains_task_leakage(
                "Avoid counting GATTACAGATTACA manually",
                ["How many copies of GATTACAGATTACA are present?"],
            )
        )

    def test_recall_is_bounded(self):
        with self.assertRaises(ValueError):
            RegistryConfig(recall_k=4)
        block = trim_pitfall_block(["one", "two", "three", "four"], 120)
        self.assertEqual(block.count("\n- "), 3)

    def test_paper_tool_requires_evidence(self):
        candidate = ToolCandidate(
            paper_id="paper",
            name="candidate",
            summary="summary",
            capabilities=["demo"],
            evidence=[],
            uncertainties=[],
            entrypoint="candidate:run",
            tests=["tests/test_candidate.py"],
        )
        with self.assertRaises(ValueError):
            candidate.validate()


if __name__ == "__main__":
    unittest.main()
