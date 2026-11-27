#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Authored here (#1913 feeder port) — no jsboige/vllm original (the lane-local
# original was feeder/check_leaf.py). This tree is the source of truth.
# Harness base is the vllm re-copy @ 7a09e1caec22441d9402ab25a222206c8905bfe1.
# -----------------------------------------------------------------------------
"""Offline pins for the pre-feed leaf validation (nb_coder_leaf_check.py, trap 5).

The verdict is the live picture of one leaf; reject_reason turns it into the closed set of
DROP reasons (trap 4). GitHub is a fake, origin/main is a set of paths.
"""
import importlib.util
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("nb_coder_leaf_check", HERE / "nb_coder_leaf_check.py")
L = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(L)

RUST = "MyIA.AI.Notebooks/Sudoku/S-01-Rust.ipynb"
PY = "MyIA.AI.Notebooks/Sudoku/S-01-Python.ipynb"


def gh_factory(issue, comments=()):
    def gh(path, *a):
        if "/comments" in path:
            return [{"body": b} for b in comments]
        return issue
    return gh


def issue(state="open", body=f"Cible : {RUST}"):
    return {"number": 1, "title": "Sudoku port", "state": state, "body": body, "comments": 1}


def test_a_free_leaf_is_feedable():
    v = L.leaf_verdict(1, gh=gh_factory(issue()), tree={PY}, lane="me:lane")
    assert v["feedable"] is True and v["target"] == RUST and v["source_on_main"] is True
    assert L.reject_reason(v) is None


def test_a_delivered_marker_rejects():
    v = L.leaf_verdict(1, gh=gh_factory(issue(), ["[DELIVERED] lane other"]), tree={PY},
                       lane="me:lane")
    assert L.reject_reason(v) == "delivered"


def test_a_foreign_claim_rejects():
    v = L.leaf_verdict(1, gh=gh_factory(issue(), ["[CLAIMED] lane other"]), tree={PY},
                       lane="me:lane")
    assert v["held_by"] == "other" and L.reject_reason(v) == "held-by-another-lane"


def test_a_released_marker_frees_the_leaf():
    v = L.leaf_verdict(1, gh=gh_factory(issue(), ["[CLAIMED] lane other", "[RELEASED] lane other"]),
                       tree={PY}, lane="me:lane")
    assert v["held_by"] is None and L.reject_reason(v) is None


def test_our_own_claim_never_blocks_us():
    v = L.leaf_verdict(1, gh=gh_factory(issue(), ["[CLAIMED] lane me:lane"]), tree={PY},
                       lane="me:lane")
    assert v["held_by"] is None


def test_the_target_already_on_main_rejects():
    v = L.leaf_verdict(1, gh=gh_factory(issue()), tree={PY, RUST}, lane="me:lane")
    assert v["rust_on_main"] is True and L.reject_reason(v) == "target-on-main"


def test_a_missing_source_twin_rejects_a_port_grain():
    v = L.leaf_verdict(1, gh=gh_factory(issue()), tree=set(), lane="me:lane")
    assert v["source_on_main"] is False and L.reject_reason(v) == "source-absent"


def test_a_from_spec_grain_needs_no_source_twin():
    v = L.leaf_verdict(1, gh=gh_factory(issue()), tree=set(), lane="me:lane")
    assert L.reject_reason(v, {"from_spec": True}) is None


def test_a_closed_issue_rejects():
    v = L.leaf_verdict(1, gh=gh_factory(issue(state="closed")), tree={PY}, lane="me:lane")
    assert L.reject_reason(v) == "closed"


def test_a_body_without_a_rust_target_rejects():
    v = L.leaf_verdict(1, gh=gh_factory(issue(body="no path here")), tree={PY}, lane="me:lane")
    assert v["target"] is None and L.reject_reason(v) == "no-target"


def test_the_last_marker_wins():
    marks = L.parse_marks(["[CLAIMED] lane a", "[RELEASED] lane a", "[CLAIMED] lane b"])
    assert L.holder_of(marks, "me:lane") == "b"
    assert L.delivered_of(L.parse_marks(["[DELIVERED] lane a"])) is True


def test_an_unreadable_gh_raises_live_data_unavailable():
    def gh(path, *a):
        raise L.LiveDataUnavailable("boom")

    with pytest.raises(L.LiveDataUnavailable):
        L.leaf_verdict(1, gh=gh, tree={PY}, lane="me:lane")
