"""The reproducible version-1 scientific tool taxonomy and routing benchmark."""

from __future__ import annotations

import random
from collections import defaultdict

from .models import RoutingTask, TocNode

SECTIONS = {
    "A": (
        "Sequence databases and analysis",
        "Retrieve and analyze nucleotide sequences.",
    ),
    "B": ("Scientific literature", "Find papers, metadata, citations, and full text."),
    "C": ("Proteins and structures", "Retrieve and analyze proteins and structures."),
    "D": ("Human variants", "Interpret genomic variants and population evidence."),
    "E": (
        "Chemistry and compounds",
        "Search compounds and compute molecular properties.",
    ),
    "F": (
        "Pathways and interactions",
        "Query pathways, ontologies, and interaction networks.",
    ),
    "G": (
        "Experimental workflows",
        "Plan experiments and retrieve laboratory protocols.",
    ),
}

LEAVES = {
    "A.A1": (
        "NCBI E-utilities",
        "Retrieve NCBI nucleotide records, accessions, taxonomy, and linked metadata.",
    ),
    "A.A2": (
        "Nucleotide BLAST",
        "Find nucleotide sequence similarity and likely homologous records.",
    ),
    "A.A3": (
        "Restriction analysis",
        "Find restriction enzyme cut sites in DNA sequences on both strands.",
    ),
    "A.A4": (
        "Primer design",
        "Design and check PCR primers for a specified nucleotide target.",
    ),
    "B.B1": (
        "PubMed",
        "Search biomedical citations, abstracts, authors, and publication metadata.",
    ),
    "B.B2": (
        "Europe PMC",
        "Search biomedical literature including open full text, grants, and preprints.",
    ),
    "B.B3": (
        "Crossref",
        "Resolve DOI metadata and citation relationships across scholarly publishers.",
    ),
    "B.B4": ("arXiv", "Search and retrieve preprints from arXiv subject collections."),
    "C.C1": (
        "UniProt",
        "Retrieve protein sequences, functions, features, and curated annotations.",
    ),
    "C.C2": (
        "InterPro",
        "Identify protein families, domains, repeats, and functional sites.",
    ),
    "C.C3": (
        "AlphaFold DB",
        "Retrieve predicted protein structures and confidence annotations.",
    ),
    "C.C4": (
        "Protein BLAST",
        "Find protein sequence similarity and homologous proteins.",
    ),
    "D.D1": (
        "ClinVar",
        "Retrieve clinical significance assertions and evidence for human variants.",
    ),
    "D.D2": (
        "gnomAD",
        "Retrieve human variant allele frequencies across populations and cohorts.",
    ),
    "D.D3": (
        "Ensembl REST",
        "Retrieve genes, transcripts, sequences, variants, and comparative genomics data.",
    ),
    "D.D4": (
        "dbSNP",
        "Resolve rs identifiers and retrieve submitted human variant records.",
    ),
    "E.E1": (
        "ChEMBL",
        "Search bioactive molecules, targets, assays, and measured activity values.",
    ),
    "E.E2": (
        "PubChem",
        "Retrieve compound identities, properties, structures, and bioassay records.",
    ),
    "E.E3": (
        "RDKit",
        "Compute molecular descriptors, fingerprints, substructures, and transformations.",
    ),
    "E.E4": (
        "PDB ligand search",
        "Find ligands and binding contexts in experimentally determined structures.",
    ),
    "F.F1": (
        "Reactome",
        "Find curated biological pathways, reactions, and pathway participants.",
    ),
    "F.F2": (
        "Gene Ontology",
        "Retrieve gene product functions, processes, components, and annotations.",
    ),
    "F.F3": (
        "KEGG",
        "Query pathways, modules, reactions, diseases, and molecular networks.",
    ),
    "F.F4": (
        "STRING",
        "Retrieve protein association networks and supporting evidence channels.",
    ),
    "G.G1": (
        "CRISPR guide design",
        "Design and assess CRISPR guides with off-target considerations.",
    ),
    "G.G2": (
        "protocols.io",
        "Find stepwise laboratory protocols, materials, and procedural parameters.",
    ),
    "G.G3": (
        "Cellosaurus",
        "Retrieve cell line identity, provenance, synonyms, and contamination information.",
    ),
}


def version_one_nodes() -> list[TocNode]:
    nodes = [
        TocNode(
            path="ROOT",
            parent=None,
            title="Darwin scientific tools",
            description="Versioned taxonomy for routing scientific research tasks.",
            is_leaf=False,
            toc_version=1,
            order=0,
        )
    ]
    order = 1
    for section, (title, description) in SECTIONS.items():
        nodes.append(TocNode(section, "ROOT", title, description, False, 1, order))
        order += 1
        for path, (leaf_title, leaf_description) in LEAVES.items():
            if path.startswith(section + "."):
                nodes.append(
                    TocNode(path, section, leaf_title, leaf_description, True, 1, order)
                )
                order += 1
    return nodes


TASK_PAIRS = {
    "A.A1": [
        "Fetch the GenBank record and taxonomy for accession NM_000546",
        "Return the CDS coordinates linked to NCBI accession NC_000017.11",
    ],
    "A.A2": [
        "Find nucleotide homologs for this 240 bp amplicon",
        "Identify the closest database match to this unknown DNA sequence",
    ],
    "A.A3": [
        "Count how many times EcoRI cuts this 900 bp sequence",
        "List all BsaI recognition sites on both strands of this plasmid",
    ],
    "A.A4": [
        "Design a 20-mer primer pair for exon 4 with a 60 C target Tm",
        "Check whether this PCR primer pair forms dimers or hairpins",
    ],
    "B.B1": [
        "Find randomized trials of osimertinib indexed with MeSH terms",
        "Return PubMed records by this author published in 2025",
    ],
    "B.B2": [
        "Find open full-text articles and preprints about spatial transcriptomics",
        "Search biomedical papers and include linked grant identifiers",
    ],
    "B.B3": [
        "Resolve this DOI and return publisher metadata",
        "Find works that cite DOI 10.1038/s41586-020-2649-2",
    ],
    "B.B4": [
        "Find recent cs.AI preprints about model-based retrieval",
        "Download metadata for arXiv 2609.03874",
    ],
    "C.C1": [
        "Get the reviewed human TP53 protein sequence and active sites",
        "Return curated function and subcellular location for P04637",
    ],
    "C.C2": [
        "Which conserved domains occur in this kinase sequence",
        "Identify protein families and repeats for this amino acid sequence",
    ],
    "C.C3": [
        "Retrieve the predicted structure and pLDDT values for this UniProt ID",
        "Find the AlphaFold model for human BRCA1",
    ],
    "C.C4": [
        "Find homologous proteins for this enzyme sequence",
        "Search this peptide sequence against a protein database",
    ],
    "D.D1": [
        "What clinical significance assertions exist for BRCA1 c.68_69del",
        "Summarize ClinVar evidence conflicts for this rs identifier",
    ],
    "D.D2": [
        "Report gnomAD allele frequency for this variant in East Asian samples",
        "Is this allele absent from population cohorts in gnomAD",
    ],
    "D.D3": [
        "Return all transcripts and exon coordinates for ENSG00000141510",
        "Use a REST API to get the reference allele at this genomic coordinate",
    ],
    "D.D4": [
        "Resolve rs7412 to current genomic placements",
        "Retrieve submitted alleles associated with this dbSNP identifier",
    ],
    "E.E1": [
        "Find IC50 measurements for molecules tested against EGFR",
        "Retrieve ChEMBL compounds active below 100 nM for this target",
    ],
    "E.E2": [
        "Get the canonical SMILES and molecular weight for aspirin",
        "Find PubChem bioassays involving compound CID 2244",
    ],
    "E.E3": [
        "Compute Morgan fingerprints for these SMILES strings",
        "Find the maximum common substructure across these molecules",
    ],
    "E.E4": [
        "Which PDB structures contain ATP bound to this kinase",
        "Find crystallographic binding poses for this ligand",
    ],
    "F.F1": [
        "Which Reactome pathways contain human TP53",
        "List curated reactions downstream of EGFR activation",
    ],
    "F.F2": [
        "Return biological process terms annotating this gene set",
        "Which molecular function ontology terms apply to this protein",
    ],
    "F.F3": [
        "Find KEGG modules for glycolysis in E. coli",
        "Retrieve disease pathways associated with this gene",
    ],
    "F.F4": [
        "Build a protein interaction network around STAT3",
        "Return STRING association scores and evidence channels",
    ],
    "G.G1": [
        "Design CRISPR guides targeting exon 2 and rank off-target risk",
        "Choose SpCas9 guides for this locus with high specificity",
    ],
    "G.G2": [
        "Find a stepwise nuclei isolation protocol for frozen tissue",
        "Retrieve a protocol with reagent volumes for ATAC-seq",
    ],
    "G.G3": [
        "Check whether this cell line is known to be misidentified",
        "Return Cellosaurus synonyms and provenance for HeLa",
    ],
}

AMBIGUOUS = {
    ("A.A1", 1): "D.D3",
    ("D.D3", 1): "A.A1",
    ("B.B1", 0): "B.B2",
    ("B.B1", 1): "B.B2",
    ("B.B2", 0): "B.B1",
    ("B.B2", 1): "B.B1",
    ("E.E1", 0): "E.E2",
    ("E.E2", 1): "E.E1",
    ("F.F1", 0): "F.F2",
    ("F.F2", 0): "F.F1",
}

UNCOVERED = [
    (
        "U01",
        "Align these five protein sequences and report pairwise percent identity",
        "C.C5",
    ),
    ("U02", "Design a Golden Gate assembly for these three DNA fragments", "G.G4"),
    ("U03", "Run differential expression for this single-cell count matrix", "G.G5"),
    ("U04", "Build a maximum-likelihood phylogeny from these sequences", "C.C6"),
    ("U05", "Design a new protein sequence predicted to bind this target", "C.C7"),
    ("U06", "Annotate unknown metabolites from these tandem mass spectra", "E.E5"),
]


def routing_tasks(seed: int = 2609) -> list[RoutingTask]:
    raw: list[dict] = []
    number = 1
    for leaf, texts in TASK_PAIRS.items():
        for index, text in enumerate(texts):
            raw.append(
                {
                    "task_id": f"route-{number:03d}",
                    "text": text,
                    "gold_leaf": leaf,
                    "section": leaf.split(".")[0],
                    "ambiguous_with": AMBIGUOUS.get((leaf, index)),
                    "uncovered": False,
                }
            )
            number += 1
    for task_id, text, closest in UNCOVERED:
        raw.append(
            {
                "task_id": f"route-{number:03d}-{task_id}",
                "text": text,
                "gold_leaf": closest,
                "section": "U",
                "ambiguous_with": None,
                "uncovered": True,
            }
        )
        number += 1

    grouped: dict[str, list[dict]] = defaultdict(list)
    for item in raw:
        grouped[item["section"]].append(item)
    rng = random.Random(seed)
    split_names = ("evolve", "select", "test")
    tasks: list[RoutingTask] = []
    for section_index, section in enumerate(sorted(grouped)):
        values = grouped[section]
        rng.shuffle(values)
        for item_index, item in enumerate(values):
            split = split_names[(item_index + section_index) % 3]
            tasks.append(RoutingTask(split=split, **item))
    counts = {name: sum(task.split == name for task in tasks) for name in split_names}
    if len(tasks) != 60 or counts != {"evolve": 20, "select": 20, "test": 20}:
        raise AssertionError(
            f"Benchmark construction drifted: total={len(tasks)}, splits={counts}"
        )
    return sorted(tasks, key=lambda task: task.task_id)
