#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Authored here (#1913 feeder port) — no jsboige/vllm original (the lane-local
# original was feeder/live_reserve.py). This tree is the source of truth.
# Harness base is the vllm re-copy @ 7a09e1caec22441d9402ab25a222206c8905bfe1.
# -----------------------------------------------------------------------------
"""Offline pins for the fresh-reserve builder (nb_coder_reserve.py, trap 6).

Trap 6 is a hand-written reserve that replayed delivered work days later. The remedy is a
reserve recomputed from live data every cycle: delivered and held leaves never reach pool A,
a full lot keeps its folded pages, and a reserve you cannot date trustworthily is stale.
"""
import importlib.util
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("nb_coder_reserve", HERE / "nb_coder_reserve.py")
R = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(R)


def leaf(n, parent, target):
    return {"number": n, "state": "open",
            "body": f"Parent : #{parent}\nCible : MyIA.AI.Notebooks/{target}"}


LOT5 = {"number": 5, "state": "open", "title": "« Rust std · Sudoku »",
        "body": "- [ ] Alpha page\n- [x] Beta page — **dépliée en #42**\n"}
LOT6 = {"number": 6, "state": "open", "title": "« Rust std · Search »",
        "body": "- [ ] Gamma page\n"}
LEAVES = [leaf(10, 5, "Sudoku/S-01-Rust.ipynb"),      # free, open  -> pool A
          {"number": 11, "state": "closed",
           "body": "Parent : #5\nCible : MyIA.AI.Notebooks/Sudoku/S-02-Rust.ipynb"},  # delivered
          leaf(12, 6, "Search/S-03-Rust.ipynb"),      # held by another lane
          leaf(13, 6, "Search/S-04-Rust.ipynb")]      # free, open -> pool A
COMMENTS = {12: ["[CLAIMED] lane myia-po-2028:CoursIA"]}
TWINS = {"MyIA.AI.Notebooks/Sudoku/S-02-Rust.ipynb"}


def test_parse_plis_splits_folded_and_unfolded():
    p = R.parse_plis(LOT5["body"])
    assert p["folded"] == ["Alpha page"]
    assert p["unfolded"] == {"Beta page": 42}


def test_classify_marks_delivery_by_closed_marker_and_main():
    states = R.classify(LEAVES, COMMENTS, TWINS, "me:lane")
    assert states[11]["delivered"] is True                 # closed
    assert states[10]["delivered"] is False
    assert states[10]["on_main"] is False
    assert states[12]["held_by"] == "myia-po-2028:CoursIA"


def test_classify_a_delivered_marker_is_delivery():
    st = R.classify([leaf(20, 5, "Sudoku/S-09-Rust.ipynb")],
                    {20: ["[DELIVERED] lane other"]}, set(), "me:lane")
    assert st[20]["delivered"] is True


def test_build_reserve_pool_a_excludes_delivered_and_held():
    res = R.build_reserve(lots=[LOT5, LOT6], leaves=LEAVES, comments_by_issue=COMMENTS,
                          twins=TWINS, lane="me:lane", now=1700000000.0)
    assert res["pool_a"] == [10, 13]                       # 11 delivered, 12 held: excluded
    lot5 = next(r for r in res["lots"] if r["lot"] == 5)
    assert lot5["delivered"] == 1
    assert lot5["open_undelivered"] == [10]
    assert lot5["held_by"] == {}
    assert lot5["free_open"] == [10]
    assert lot5["folded"] == ["Alpha page"] and lot5["unfolded"] == 1


def test_build_reserve_pool_b_only_from_lots_with_room():
    res = R.build_reserve(lots=[LOT5, LOT6], leaves=LEAVES, comments_by_issue=COMMENTS,
                          twins=TWINS, lane="me:lane", now=1700000000.0)
    keys = [b["key"] for b in res["pool_b"]]
    assert "Alpha-page" in keys                            # lot 5 has room (1 open < 2)
    assert "Gamma-page" not in keys                        # lot 6 is full (2 open undelivered)
    alpha = next(b for b in res["pool_b"] if b["key"] == "Alpha-page")
    assert alpha["lot"] == 5 and alpha["kit"] is None


def test_reserve_stale_covers_old_future_and_undatable():
    now = 1_700_000_000.0
    assert R.reserve_stale("2026-11-20T00:00:00Z", now) is True          # days old
    assert R.reserve_stale("2020-01-01T00:00:00Z", now) is True          # long past
    assert R.reserve_stale("2099-01-01T00:00:00Z", now) is True          # clock skew -> stale
    fresh = R.datetime.fromtimestamp(now, R.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    assert R.reserve_stale(fresh, now) is False
    assert R.reserve_stale("not-a-date", now) is True


def test_twins_on_main_refuses_an_unreadable_tree():
    class P:
        returncode, stdout, stderr = 1, "", "boom"

    with pytest.raises(R.ReserveUnavailable):
        R.twins_on_main("D:/nowhere", run=lambda *a, **k: P())


def test_search_paginates_until_empty():
    pages = {1: {"items": [{"number": 1}], "total_count": 1}}

    def gh(*a):
        page = 1
        for x in a:
            if str(x).startswith("page="):
                page = int(str(x).split("=")[1])
        return pages.get(page, {"items": [], "total_count": 1})

    slept = []
    out = R.search("q", gh=gh, sleep=slept.append)
    assert out == [{"number": 1}] and slept == []          # one full page = done
