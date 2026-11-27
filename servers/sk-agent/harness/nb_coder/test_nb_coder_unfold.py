#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Authored here (#1913 feeder port) — no jsboige/vllm original (the lane-local
# original was feeder/unfold.py). This tree is the source of truth.
# Harness base is the vllm re-copy @ 7a09e1caec22441d9402ab25a222206c8905bfe1.
# -----------------------------------------------------------------------------
"""Offline pins for the unfold and its rejection guards (nb_coder_unfold.py, trap 4).

The room is measured on a fake REST; publish/feeder_lines/gh are spies, so a rejected
unfold can be shown to post nothing (no duplicate lot comment, no reopen of delivered work).
"""
import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("nb_coder_unfold", HERE / "nb_coder_unfold.py")
U = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(U)

RUST = "MyIA.AI.Notebooks/Sudoku/S-01-Rust.ipynb"


def gh_make(*, search=None, issues=None, comments=None, rec=None):
    def gh(*a):
        if rec is not None:
            rec.append(tuple(map(str, a)))
        joined = " ".join(map(str, a))
        if "search/issues" in joined:
            if isinstance(search, Exception):
                raise search
            return {"items": [] if search is None else search}
        url = next((str(x) for x in a if "/issues/" in str(x)), "")
        if not url:
            return {}
        num = int(url.split("/issues/")[1].split("/")[0].split("?")[0])
        if "/comments" in url:
            return [{"body": b} for b in (comments or {}).get(num, [])]
        return (issues or {}).get(num, {})
    return gh


def item_publish(kit, key="KEY", lot=5, pli="Alpha page"):
    return {"unfold": {"kind": "publish", "kit": str(kit), "fam": "Fam", "key": key,
                       "lot": lot, "pli": pli}}


def item_reopen(n=9, lot=5, pli="Beta page"):
    return {"issue": n, "unfold": {"kind": "reopen", "lot": lot, "pli": pli}}


class Spy:
    def __init__(self, ret=None):
        self.calls, self.ret = [], ret

    def __call__(self, *a, **k):
        self.calls.append((a, k))
        return self.ret


def test_specs_published_reads_the_kit_index(tmp_path):
    kit = tmp_path / "kit"
    kit.mkdir()
    (kit / "specs.txt").write_text("KEY 123\n", encoding="utf-8")
    assert U.specs_published(kit, "KEY") is True
    assert U.specs_published(kit, "OTHER") is False
    assert U.specs_published(tmp_path / "nokit", "KEY") is False


def test_trap4_a_page_already_in_specs_is_rejected_without_publishing(tmp_path):
    kit = tmp_path / "kit"
    kit.mkdir()
    (kit / "specs.txt").write_text("KEY 123\n", encoding="utf-8")
    rec, logs = [], []
    pub, fl = Spy(U.RunnerResult(0, "", "")), Spy([])
    res = U.do(item_publish(kit), log=logs.append, gh=gh_make(rec=rec), cache={}, now=1.0,
               lane="me:lane", tmpdir=tmp_path, publish=pub, feeder_lines=fl)
    assert res.action == "dropped" and res.reason == "page-already-published"
    assert pub.calls == [] and fl.calls == []          # never re-published: no duplicate comment
    assert not any("PATCH" in c or "POST" in c for c in rec)


def test_trap4_a_reopen_of_a_delivered_leaf_is_dropped(tmp_path):
    rec, logs = [], []
    gh = gh_make(issues={9: {"state": "closed", "body": f"Cible : {RUST}", "comments": 1}},
                 comments={9: ["[DELIVERED] lane other"]}, rec=rec)
    res = U.do(item_reopen(), log=logs.append, gh=gh, cache={}, now=1.0, lane="me:lane",
               tmpdir=tmp_path, tree=set())
    assert res.action == "dropped" and res.reason == "reopen-delivered"
    assert not any("PATCH" in c or "POST" in c for c in rec)


def test_trap4_a_reopen_of_an_open_leaf_is_dropped_no_duplicate_comment(tmp_path):
    rec, logs = [], []
    gh = gh_make(issues={9: {"state": "open", "body": f"Cible : {RUST}"}}, rec=rec)
    res = U.do(item_reopen(), log=logs.append, gh=gh, cache={}, now=1.0, lane="me:lane",
               tmpdir=tmp_path, tree=set())
    assert res.action == "dropped" and res.reason == "reopen-already-open"
    assert not any("PATCH" in c or "POST" in c for c in rec)


def test_trap4_a_reopen_of_a_leaf_held_by_another_lane_is_dropped(tmp_path):
    logs = []
    gh = gh_make(issues={9: {"state": "closed", "body": f"Cible : {RUST}", "comments": 1}},
                 comments={9: ["[CLAIMED] lane myia-po-2028:CoursIA"]})
    res = U.do(item_reopen(), log=logs.append, gh=gh, cache={}, now=1.0, lane="me:lane",
               tmpdir=tmp_path, tree=set())
    assert res.action == "dropped" and res.reason == "reopen-held-by-another-lane"


def test_trap4_a_reopen_whose_target_is_on_main_is_dropped(tmp_path):
    logs = []
    gh = gh_make(issues={9: {"state": "closed", "body": f"Cible : {RUST}"}})
    res = U.do(item_reopen(), log=logs.append, gh=gh, cache={}, now=1.0, lane="me:lane",
               tmpdir=tmp_path, tree={RUST})
    assert res.action == "dropped" and res.reason == "reopen-target-on-main"


def test_a_reopen_of_a_folded_leaf_reopens_it_and_ticks_the_fold(tmp_path):
    rec = []
    gh = gh_make(issues={9: {"state": "closed", "body": f"Cible : {RUST}"},
                         5: {"body": "- [ ] Beta page\n"}}, rec=rec)
    res = U.do(item_reopen(), log=lambda m: None, gh=gh, cache={}, now=1.0, lane="me:lane",
               tmpdir=tmp_path, tree=set())
    assert res.action == "fed" and res.out["issue"] == 9 and "unfold" not in res.out
    assert any("PATCH" in c and "issues/9" in " ".join(c) for c in rec)   # state=open
    assert any("POST" in c and "issues/9" in " ".join(c) for c in rec)    # the reopen comment
    assert any("PATCH" in c and "issues/5" in " ".join(c) for c in rec)   # the fold ticked


def test_a_full_lot_defers_and_keeps_the_item(tmp_path):
    logs = []
    search = [{"number": 1, "comments": 0, "body": "Parent : #5"},
              {"number": 2, "comments": 0, "body": "Parent : #5"}]
    res = U.do(item_reopen(), log=logs.append, gh=gh_make(search=search), cache={}, now=1.0,
               lane="me:lane", tmpdir=tmp_path)
    assert res.action == "deferred" and res.reason == "lot-full"


def test_publish_appends_the_feeder_line_and_ticks_the_fold(tmp_path):
    kit = tmp_path / "kit"
    kit.mkdir()
    (kit / "specs.txt").write_text("", encoding="utf-8")
    rec, logs = [], []
    pub = Spy(U.RunnerResult(0, "published", ""))
    fl = Spy([{"issue": 9, "notebook": "X/KEY-Rust.ipynb"}])
    gh = gh_make(issues={5: {"body": "- [ ] Alpha page\n"}}, rec=rec)
    res = U.do(item_publish(kit), log=logs.append, gh=gh, cache={}, now=1.0, lane="me:lane",
               tmpdir=tmp_path, publish=pub, feeder_lines=fl)
    assert res.action == "fed" and res.out["issue"] == 9
    assert pub.calls and fl.calls
    assert any("PATCH" in c and "issues/5" in " ".join(c) for c in rec)   # fold ticked


def test_an_unknown_kind_is_dropped(tmp_path):
    res = U.do({"unfold": {"kind": "wat", "lot": 5}}, log=lambda m: None,
               gh=gh_make(), cache={}, now=1.0, lane="me:lane", tmpdir=tmp_path)
    assert res.action == "dropped" and "unknown-kind" in res.reason


def test_an_unreadable_lot_is_deferred(tmp_path):
    res = U.do(item_reopen(), log=lambda m: None, gh=gh_make(search=RuntimeError("down")),
               cache={}, now=1.0, lane="me:lane", tmpdir=tmp_path)
    assert res.action == "deferred" and res.reason == "unmeasured"


def test_has_room_fails_closed_and_caches():
    calls = []

    def gh(*a):
        calls.append(a)
        raise RuntimeError("down")

    assert U.has_room({"lot": 5}, gh=gh, cache={}, now=1.0) is False
    # within the TTL a cached, room-known lot is not re-measured
    cache = {5: (1.0, [1])}
    assert U.has_room({"lot": 5}, gh=lambda *a: {}, cache=cache, now=1.5) is True
