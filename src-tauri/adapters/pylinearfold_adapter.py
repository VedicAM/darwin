"""LinearFold adapter: fold.mfe and fold.ensemble.

One JSON request on stdin, one JSON response on the last line of stdout.
Diagnostics go to stderr so they can never be mistaken for the response.

Provenance is read from the environment, which the Rust side constructs. An
adapter that hardcoded its own tool name would be able to misreport which
implementation produced a number, which is the one thing this harness exists to
prevent.
"""

import json
import os
import sys


def fail(message):
    print(json.dumps({"status": "error", "error": message}))
    sys.exit(0)


def load_request():
    raw = sys.stdin.read()
    if not raw.strip():
        fail("empty request")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        fail(f"request was not valid JSON: {exc}")


def context():
    return {
        "tool": os.environ.get("DARWIN_TOOL", "unknown"),
        "tool_version": os.environ.get("DARWIN_TOOL_VERSION", "unknown"),
        "artifact_sha256": os.environ.get("DARWIN_ARTIFACT_SHA256", "unknown"),
        "adapter_sha256": os.environ.get("DARWIN_ADAPTER_SHA256", "unknown"),
        "algorithm": os.environ.get("DARWIN_ALGORITHM", "unknown"),
        "energy_model": os.environ.get("DARWIN_ENERGY_MODEL", "Turner2004"),
    }


def import_binding():
    try:
        import pylinearfold
    except Exception as exc:  # noqa: BLE001 - surfaced to the caller verbatim
        fail(f"could not import pylinearfold: {exc}")
    return pylinearfold


def normalize(sequence):
    """Uppercase and convert T to U, mirroring the Rust-side normalisation.

    The harness already normalises before dispatch, so this is normally a
    no-op. It is here so the adapter is correct when driven directly, and so a
    DNA input cannot be rejected purely for using T.
    """
    return sequence.strip().upper().replace("T", "U")


def validate(sequence):
    if not sequence:
        fail("sequence is empty")
    bad = set(sequence) - set("ACGUN")
    if bad:
        fail(f"sequence contains invalid characters: {sorted(bad)}")


def do_fold(lf, sequence, beamsize):
    try:
        out = lf.fold(sequence, beamsize=beamsize, verbose=False)
    except Exception as exc:  # noqa: BLE001
        fail(f"linearfold.fold failed: {exc}")
    structure = out["structure"]
    if len(structure) != len(sequence):
        fail(
            f"structure length {len(structure)} does not match "
            f"sequence length {len(sequence)}"
        )
    return {"structure": structure, "free_energy": out["free_energy"]}


def extract_pairs(probabilities):
    """Normalise LinearFold's `probabilities` into a list of pair dicts.

    The binding returns a numpy structured array with fields (i, j, prob), and
    the indices are already 0-based. This was checked against the real wheel:
    for a 14-mer the rows run i=0..13 and every row is complementary under
    0-based indexing and none are under 1-based. An earlier draft of this
    adapter treated the value as a dict of "i-j" string keys and subtracted one
    from each index, which would have silently produced wrong base pairs.
    """
    pairs = []
    if probabilities is None:
        return pairs

    rows = probabilities
    # A structured ndarray, or anything else that yields (i, j, prob) rows.
    if hasattr(rows, "dtype") and getattr(rows.dtype, "names", None):
        for row in rows:
            i, j, p = int(row["i"]), int(row["j"]), float(row["prob"])
            pairs.append({"i": i, "j": j, "probability": p})
        return pairs

    if isinstance(rows, dict):
        # Defensive: a future binding release may hand back a mapping.
        for key, value in rows.items():
            try:
                i, j = (int(part) for part in str(key).split("-"))
            except ValueError:
                continue
            pairs.append({"i": i, "j": j, "probability": float(value)})
        return pairs

    for row in rows:
        try:
            i, j, p = int(row[0]), int(row[1]), float(row[2])
        except (TypeError, ValueError, IndexError):
            continue
        pairs.append({"i": i, "j": j, "probability": p})
    return pairs


def do_partition(lf, sequence, beamsize, cutoff, max_pairs):
    # `partition` reports the ensemble free energy, which is a different
    # quantity from the minimum free energy. Reporting the ensemble value as
    # `free_energy` and then also calling it the MFE conflates the two, so the
    # MFE is folded separately and returned under its own key.
    try:
        out = lf.partition(sequence, beamsize=beamsize, cutoff=cutoff, verbose=False)
    except Exception as exc:  # noqa: BLE001
        fail(f"linearfold.partition failed: {exc}")
    try:
        mfe = lf.fold(sequence, beamsize=beamsize, verbose=False)["free_energy"]
    except Exception as exc:  # noqa: BLE001
        fail(f"linearfold.fold failed: {exc}")

    pairs = extract_pairs(out.get("probabilities"))
    pairs = [p for p in pairs if p["probability"] > cutoff]
    # `max_pairs` is a cap, not a filter: return the most probable first.
    pairs.sort(key=lambda p: p["probability"], reverse=True)
    if max_pairs:
        pairs = pairs[:max_pairs]

    return {
        "structure": out["structure"],
        "mfe": mfe,
        "ensemble_free_energy": out["free_energy"],
        "base_pairs": pairs,
    }


def main():
    request = load_request()
    capability = request.get("capability")
    fold = request.get("fold") or {}

    sequence = normalize(fold.get("sequence", ""))
    beamsize = int(fold.get("beamsize", 100))
    cutoff = float(fold.get("cutoff", 1e-5))
    max_pairs = int(fold.get("max_pairs", 50))

    if beamsize < 1:
        fail(f"beamsize must be >= 1, got {beamsize}")

    validate(sequence)
    lf = import_binding()

    if capability == "fold.mfe":
        result = do_fold(lf, sequence, beamsize)
    elif capability == "fold.ensemble":
        result = do_partition(lf, sequence, beamsize, cutoff, max_pairs)
    else:
        fail(f"unsupported capability: {capability!r}")

    result["sequence"] = sequence
    result["context"] = context()
    print(json.dumps({"status": "ok", "result": result}))


if __name__ == "__main__":
    main()
