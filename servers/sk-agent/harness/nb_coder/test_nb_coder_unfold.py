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
import json
from pathlib import Path

import pytest

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


class Raiser:
    """A kit runner that fails: records its call, raises ``exc``."""

    def __init__(self, exc):
        self.exc, self.calls = exc, []

    def __call__(self, *a, **k):
        self.calls.append((a, k))
        raise self.exc


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


# ---------------------------------------------------------------- kit failures (review 27/11)
def test_a_kit_that_fails_or_prints_a_banner_is_a_kept_failure(tmp_path):
    kit = tmp_path / "kit"
    kit.mkdir()
    (kit / "specs.txt").write_text("", encoding="utf-8")
    logs = []
    res = U.do(item_publish(kit), log=logs.append, gh=gh_make(), cache={}, now=1.0,
               lane="me:lane", tmpdir=tmp_path, publish=Spy(U.RunnerResult(0, "", "")),
               feeder_lines=Raiser(RuntimeError("rc=1 banner")))
    assert res.action == "failed" and res.reason == "feeder-lines-error"
    assert res.published is True                    # the page IS published: keep resuming
    assert any("unfold-no-queue-line KEY kit-error" in l for l in logs)


def test_a_banner_on_stdout_is_a_kept_failure_not_a_crash(tmp_path):
    # The reviewer's scenario, end to end: publish rc 0, then a kit whose stdout is not one
    # JSON object per line. The json.loads used to escape do() and kill the daemon.
    kit = tmp_path / "kit"
    kit.mkdir()
    (kit / "specs.txt").write_text("", encoding="utf-8")
    (kit / "feeder_lines.py").write_text("print('banner: not a JSON line')\n", encoding="utf-8")
    logs = []
    res = U.do(item_publish(kit), log=logs.append, gh=gh_make(), cache={}, now=1.0,
               lane="me:lane", tmpdir=tmp_path, publish=Spy(U.RunnerResult(0, "", "")))
    assert res.action == "failed" and res.reason == "feeder-lines-error" and res.published
    assert any("kit-error" in l for l in logs)


def test_subprocess_feeder_lines_raises_on_a_nonzero_rc(tmp_path):
    kit = tmp_path / "kit"
    kit.mkdir()
    (kit / "feeder_lines.py").write_text("import sys\nprint('[]')\nsys.exit(3)\n",
                                         encoding="utf-8")
    with pytest.raises(RuntimeError, match="rc=3"):
        U.subprocess_feeder_lines(kit, "Fam")


def test_a_published_page_without_its_queue_line_resumes_instead_of_dropping(tmp_path):
    kit = tmp_path / "kit"
    kit.mkdir()
    (kit / "specs.txt").write_text("KEY 9\n", encoding="utf-8")
    logs = []
    pub = Spy(U.RunnerResult(0, "", ""))
    fl = Spy([{"issue": 9, "notebook": "X/KEY-Rust.ipynb"}])
    gh = gh_make(issues={5: {"body": "- [ ] Alpha page\n"}})
    res = U.do({**item_publish(kit), "published": True}, log=logs.append, gh=gh, cache={},
               now=1.0, lane="me:lane", tmpdir=tmp_path, publish=pub, feeder_lines=fl)
    assert res.action == "fed" and res.out["issue"] == 9
    assert pub.calls == []                          # never republished (trap 4)
    assert fl.calls                                  # only the queue line was re-read
    assert any("unfold-resume-published KEY" in l for l in logs)


def test_a_publish_whose_kit_lost_the_key_publishes_again(tmp_path):
    # Flag set but specs.txt does not list the key: rc 0 lied, the index is the authority.
    kit = tmp_path / "kit"
    kit.mkdir()
    (kit / "specs.txt").write_text("", encoding="utf-8")
    pub = Spy(U.RunnerResult(0, "", ""))
    fl = Spy([{"issue": 9, "notebook": "X/KEY-Rust.ipynb"}])
    res = U.do({**item_publish(kit), "published": True}, log=lambda m: None, gh=gh_make(),
               cache={}, now=1.0, lane="me:lane", tmpdir=tmp_path, publish=pub,
               feeder_lines=fl)
    assert res.action == "fed" and len(pub.calls) == 1


# ---------------------------------------------------------------- a reopen in two writes (review 28/11, B)
class Seat:
    """A fake GitHub holding ONE folded leaf (#9, of lot #5) and recording every call.
    ``fail_state_once`` makes the first state change raise, as a secondary rate limit does."""

    def __init__(self, *, state="closed", comments=(), fail_state_once=False):
        self.state, self.comments, self.rec = state, list(comments), []
        self.fail_state_once = fail_state_once

    def __call__(self, *a):
        a = tuple(map(str, a))
        self.rec.append(a)
        j = " ".join(a)
        if "search/issues" in j:
            return {"items": []}
        if "/comments" in j:
            if "POST" in j:
                payload = Path(a[a.index("--input") + 1]).read_text(encoding="utf-8")
                self.comments.append(json.loads(payload)["body"])
                return {}
            return [{"body": b} for b in self.comments]
        if "issues/5" in j:
            return {"body": "- [ ] Beta page\n"}
        if "issues/9" in j:
            if "PATCH" in j:
                if self.fail_state_once:
                    self.fail_state_once = False
                    raise RuntimeError("gh api: secondary rate limit hit")
                self.state = "open"
                return {}
            return {"state": self.state, "body": f"Cible : {RUST}",
                    "comments": len(self.comments)}
        return {}

    def writes(self):
        """Every write on the leaf and the fold, in order."""
        out = []
        for c in self.rec:
            if len(c) < 3:                       # a bare read: gh("repos/<repo>/issues/<n>")
                continue
            if c[1] == "POST" and "/comments" in c[2]:
                out.append("comment")
            elif c[1] == "PATCH" and "issues/9" in c[2]:
                out.append("state")
            elif c[1] == "PATCH" and "issues/5" in c[2]:
                out.append("fold")
        return out


def reopen_comment(lane):
    return ("**Redépliée (c0021)** — le lot #5 est repassé sous 2 feuilles ouvertes non livrées "
            "(mesure REST : aucune). La page et son script de rejeu ci-dessus restent valables ; "
            f"prise par le tapis nb_coder de la lane {lane}.")


def run(seat, tmp_path):
    return U.do(item_reopen(), log=lambda m: None, gh=seat, cache={}, now=1.0, lane="me:lane",
                tmpdir=tmp_path, tree=set())


def test_a_reopen_writes_its_comment_before_it_changes_the_state(tmp_path):
    # Review 28/11, defect B. The state used to go first: a failure on the comment then left
    # an OPEN leaf with no comment, and the resume read it as a leaf another lane reopened.
    seat = Seat()
    assert run(seat, tmp_path).action == "fed"
    assert seat.writes() == ["comment", "state", "fold"]
    assert seat.comments == [reopen_comment("me:lane")]     # byte-identical to the earlier form


def test_a_reopen_cut_after_its_comment_is_resumed_without_a_second_comment(tmp_path):
    seat = Seat(fail_state_once=True)
    with pytest.raises(RuntimeError, match="secondary rate limit"):
        run(seat, tmp_path)
    # Nothing is hidden: the leaf is still closed and carries our comment, so the cut shows.
    assert seat.state == "closed" and seat.comments == [reopen_comment("me:lane")]
    assert seat.writes() == ["comment", "state"]
    res = run(seat, tmp_path)                              # the next poll
    assert res.action == "fed" and res.out["issue"] == 9
    assert seat.state == "open" and len(seat.comments) == 1
    assert seat.writes() == ["comment", "state", "state", "fold"]


def test_an_open_leaf_with_another_lanes_reopen_comment_is_dropped(tmp_path):
    seat = Seat(state="open", comments=[reopen_comment("other:lane")])
    res = run(seat, tmp_path)
    assert res.action == "dropped" and res.reason == "reopen-already-open"
    assert seat.writes() == [] and len(seat.comments) == 1


def test_an_open_leaf_with_our_reopen_comment_is_resumed_with_no_write_on_it(tmp_path):
    # Our reopen is finished (the daemon died before consuming the line): nothing is posted
    # twice, the line is fed and the scheduler's own known-grain rule does the rest.
    seat = Seat(state="open", comments=[reopen_comment("me:lane")])
    res = run(seat, tmp_path)
    assert res.action == "fed" and res.out == {"issue": 9}
    assert [w for w in seat.writes() if w != "fold"] == []
    assert len(seat.comments) == 1


def test_a_leaf_we_reopened_that_another_lane_claimed_since_is_not_taken(tmp_path):
    seat = Seat(state="open", comments=[reopen_comment("me:lane"), "[CLAIMED] lane other:lane"])
    res = run(seat, tmp_path)
    assert res.action == "dropped" and res.reason == "reopen-held-by-another-lane"
    assert seat.writes() == []
