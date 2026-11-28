#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Authored here (#1913 feeder port) — no jsboige/vllm original. The lane-local
# feeder/feeder.py and its feeder.log were the only reference; this tree is the
# source of truth.
# Harness base is the vllm re-copy @ 7a09e1caec22441d9402ab25a222206c8905bfe1.
# -----------------------------------------------------------------------------
"""Offline regression pins for the ported conveyor feeder (nb_coder_feeder.py).

One test per measured trap of the lane-local feeder (#1913), plus the essential loop
behaviour. Everything is offline: the scheduler state, the queue and pending are files in
``tmp_path``; GitHub and git are injected; the clock is a constant.
"""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

HERE = Path(__file__).resolve().parent


def _load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


F = _load("nb_coder_feeder")
S = _load("nb_coder_scheduler")

NOW = 1_000_000.0
OLD = "2026-11-01T00:00:00"       # before NOW, and before any grain's finished
LATE = "2026-11-02T00:00:00"      # after NOW-started lines


def grain(issue, notebook="Dir/N1.ipynb", status="running", retry=0, finished=None,
          verdict=None):
    g = {"issue": issue, "notebook": notebook, "status": status, "retry": retry,
         "finished": finished}
    if verdict is not None:
        g["last_verdict"] = verdict
    return g


def feedable(issue, **kw):
    return {"issue": issue, "state": "open", "delivered_marker": False, "held_by": None,
            "target": f"Dir/N{issue}-Rust.ipynb", "rust_on_main": False,
            "source_on_main": True, "csharp_on_main": False, "title": "t", "last_marker": None}


def make(tmp_path, *, grains=None, queue=None, pending=None, cap=3, breaker=5,
         verdicts=None, verdict_fn=None, gh=None, unfold=None, drift=None,
         bound_s=86400.0, drift_every_s=1e12, tree=None):
    state_dir = tmp_path / "state"
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / "state.json").write_text(
        json.dumps({"version": 1, "grains": {f"#{g['issue']}:{g['notebook']}": g
                                             for g in (grains or [])}}), encoding="utf-8")
    q = tmp_path / "queue.jsonl"
    q.write_text("".join(json.dumps(x, ensure_ascii=False) + "\n" for x in (queue or [])),
                 encoding="utf-8")
    p = tmp_path / "pending.jsonl"
    p.write_text("".join(json.dumps(x, ensure_ascii=False) + "\n" for x in (pending or [])),
                 encoding="utf-8")
    args = F.parse_args(["--pending", str(p), "--queue", str(q), "--state-dir", str(state_dir),
                         "--checkout", str(tmp_path / "repo"), "--lane", "test:lane",
                         "--cap", str(cap), "--breaker", str(breaker),
                         "--bound-s", str(bound_s), "--drift-every-s", str(drift_every_s)])
    calls = []

    def default_verdict(issue, **kw):
        calls.append(issue)
        v = feedable(issue)
        v.update((verdicts or {}).get(issue, {}))
        return v

    feeder = F.Feeder(
        args, gh=gh or (lambda *a: []), tree=set() if tree is None else tree,
        leaf_verdict=verdict_fn or default_verdict, unfold=unfold,
        drift=drift or (lambda: SimpleNamespace(returncode=0, stdout="[]", stderr="")),
        clock=lambda: NOW, sleep=lambda s=0: None)
    return feeder, q, p, calls


def lines(path):
    return [json.loads(l) for l in Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]


def log_text(tmp_path):
    f = tmp_path / "feeder.log"
    return f.read_text(encoding="utf-8") if f.exists() else ""


# ---------------------------------------------------------------- trap 1
def test_trap1_a_known_withdrawn_grain_is_never_refed(tmp_path):
    # "skip already-known": a plain line for a grain the scheduler knows is not re-fed.
    feeder, q, p, _ = make(tmp_path, grains=[grain(1, status="withdrawn", finished=OLD)],
                           pending=[{"issue": 1, "notebook": "Dir/N1.ipynb"}])
    feeder.poll()
    assert lines(q) == []                      # nothing re-fed
    assert lines(p) == []                      # the line was consumed (skip)
    assert "skip already-known 1" in log_text(tmp_path)


def test_trap1_a_raised_retry_reoffers_a_withdrawn_grain(tmp_path):
    feeder, q, p, _ = make(tmp_path, grains=[grain(1, status="withdrawn", finished=OLD)],
                           pending=[{"issue": 1, "notebook": "Dir/N1.ipynb", "retry": 1}])
    feeder.poll()
    assert [x["retry"] for x in lines(q)] == [1]
    assert "retried 1 retry=1" in log_text(tmp_path)


@pytest.mark.parametrize("status", ["done", "deferred", "running", "pending"])
def test_trap1_a_raised_retry_on_a_non_failed_grain_is_absorbed(tmp_path, status):
    # Only failed/withdrawn are re-offerable. A generation raised on any other status is not
    # a retry — the scheduler absorbs it and this feeder must not pretend otherwise.
    feeder, q, p, _ = make(tmp_path, grains=[grain(1, status=status)],
                           pending=[{"issue": 1, "notebook": "Dir/N1.ipynb", "retry": 9}])
    feeder.poll()
    assert lines(q) == []                      # no queue line written for a done/deferred grain
    assert "skip already-known 1" in log_text(tmp_path)


# ---------------------------------------------------------------- trap 2
def test_trap2_a_retry_readds_a_line_that_left_the_queue(tmp_path):
    # Measured 19:12Z: both retry paths only REPLACED a line, so a grain whose line had left
    # the queue was logged "retried", counted in flight, and never adopted.
    feeder, q, p, _ = make(tmp_path, grains=[grain(1, status="withdrawn", retry=0, finished=OLD)],
                           pending=[{"issue": 1, "notebook": "Dir/N1.ipynb", "retry": 1}])
    feeder.poll()
    qlines = lines(q)
    assert len(qlines) == 1 and qlines[0]["retry"] == 1
    fed = json.loads((tmp_path / "fed_lines.json").read_text(encoding="utf-8"))
    assert [(1, "Dir/N1.ipynb")] == [tuple(k) for k, _ in fed]


def test_trap2_a_retry_replaces_an_existing_line_not_duplicates_it(tmp_path):
    feeder, q, p, _ = make(
        tmp_path, grains=[grain(1, status="failed", retry=0, finished=OLD)],
        queue=[{"issue": 1, "notebook": "Dir/N1.ipynb"}],
        pending=[{"issue": 1, "notebook": "Dir/N1.ipynb", "retry": 1}])
    feeder.poll()
    assert [x["retry"] for x in lines(q)] == [1] and len(lines(q)) == 1


def test_trap2_the_real_scheduler_adopts_the_readded_line(tmp_path):
    # End-to-end proof of the fix: the line the feeder re-adds is one the scheduler requeues.
    feeder, q, p, _ = make(tmp_path, grains=[grain(1, status="withdrawn", retry=0, finished=OLD)],
                           pending=[{"issue": 1, "notebook": "Dir/N1.ipynb", "retry": 1}])
    feeder.poll()
    sched = S.Scheduler(S.parse_args(["--queue", str(q), "--state-dir", str(tmp_path / "sched"),
                                      "--repo", "D:/CoursIA", "--max-active", "2"]),
                        sleep=lambda s=0: None, clock=lambda: 1000.0)
    sched.state["grains"]["#1:Dir/N1.ipynb"] = {"issue": 1, "notebook": "Dir/N1.ipynb",
                                                "status": "withdrawn", "retry": 0}
    sched.merge_queue(*S.load_queue(q))
    g = sched.state["grains"]["#1:Dir/N1.ipynb"]
    assert g["status"] == "pending" and g["retry"] == 1


def test_trap2_auto_retry_restores_a_line_that_left_the_queue(tmp_path):
    # The transient-failure auto-retry needs the same re-add: the grain's line may have left
    # the queue, and fed_lines.json is the memory that lets it come back.
    feeder, q, p, _ = make(tmp_path, grains=[], queue=[],
                           pending=[], verdicts={1: feedable(1)})
    k = (1, "Dir/N1.ipynb")
    feeder.fed = {k}
    feeder.started = {k: OLD}
    feeder.fed_lines = {k: json.dumps({"issue": 1, "notebook": "Dir/N1.ipynb"}) + "\n"}
    st = {k: grain(1, status="failed", finished=LATE, verdict="kernel-start-failed")}
    feeder.end_of_grain_scan(st)
    ql = lines(q)
    assert len(ql) == 1 and ql[0]["retry"] == 1
    assert "retried 1 auto retry=1" in log_text(tmp_path)


# ---------------------------------------------------------------- trap 3
def test_trap3_deferred_does_not_count_against_cap(tmp_path):
    feeder, *_ = make(tmp_path, grains=[grain(1, status="deferred"),
                                        grain(2, notebook="Dir/N2.ipynb", status="deferred")])
    st = feeder.read_state()
    assert feeder.count_inflight(st) == 0            # two deferred = zero real grains
    feeder2, *_ = make(tmp_path, grains=[grain(1, status="deferred"),
                                         grain(2, notebook="Dir/N2.ipynb", status="deferred"),
                                         grain(3, notebook="Dir/N3.ipynb", status="running")])
    assert feeder2.count_inflight(feeder2.read_state()) == 1


def test_trap3_a_deferred_pile_does_not_block_a_new_grain(tmp_path):
    # CAP=2 with two deferred grains must still admit one real grain (the local sat at 3/3
    # around one real grain).
    feeder, q, p, _ = make(tmp_path, cap=2,
                           grains=[grain(1, status="deferred"),
                                   grain(2, notebook="Dir/N2.ipynb", status="deferred")],
                           pending=[{"issue": 3, "notebook": "Dir/N3.ipynb"}],
                           verdicts={3: feedable(3)})
    feeder.poll()
    assert [x["issue"] for x in lines(q)] == [3]


# ---------------------------------------------------------------- trap 4 / trap 5 (drop)
def test_trap4_a_delivered_line_is_dropped_not_replayed(tmp_path):
    feeder, q, p, calls = make(tmp_path, pending=[{"issue": 7, "notebook": "Dir/N7.ipynb"}],
                               verdicts={7: {"delivered_marker": True}})
    feeder.poll()
    assert lines(q) == [] and lines(p) == []
    assert "rejected 7 delivered" in log_text(tmp_path)


def test_trap4_a_target_already_on_main_is_dropped(tmp_path):
    feeder, q, p, _ = make(tmp_path, pending=[{"issue": 8, "notebook": "Dir/N8.ipynb"}],
                           verdicts={8: {"rust_on_main": True}})
    feeder.poll()
    assert lines(q) == [] and "rejected 8 target-on-main" in log_text(tmp_path)


def test_trap4_a_held_by_another_lane_line_is_dropped_not_replayed(tmp_path):
    # The line is CONSUMED (measured: lines(p) == []): the log must not say "skip", which an
    # operator reads as "we will come back to it".
    feeder, q, p, _ = make(tmp_path, pending=[{"issue": 9, "notebook": "Dir/N9.ipynb"}],
                           verdicts={9: {"held_by": "myia-po-2028:CoursIA"}})
    feeder.poll()
    assert lines(q) == [] and lines(p) == []
    assert "rejected 9 held-by-another-lane myia-po-2028:CoursIA" in log_text(tmp_path)


def test_trap5_an_unmeasured_verdict_keeps_the_line(tmp_path):
    def boom(issue, **kw):
        raise RuntimeError("gh down")

    feeder, q, p, _ = make(tmp_path, pending=[{"issue": 5, "notebook": "Dir/N5.ipynb"}],
                           verdict_fn=boom)
    feeder.poll()
    assert lines(q) == []                      # never fed on a guess
    assert len(lines(p)) == 1                  # kept for the next poll
    assert "kept-unmeasured 5" in log_text(tmp_path)


def test_trap5_a_line_is_validated_on_live_data_before_feeding(tmp_path):
    feeder, q, p, calls = make(tmp_path, pending=[{"issue": 6, "notebook": "Dir/N6.ipynb"}],
                               verdicts={6: feedable(6)})
    feeder.poll()
    assert calls == [6]                        # the verdict was asked for this very line
    assert [x["issue"] for x in lines(q)] == [6]


# ---------------------------------------------------------------- pending hygiene
def test_a_not_before_line_is_never_handed_to_the_scheduler(tmp_path):
    feeder, q, p, _ = make(tmp_path, pending=[{"issue": 4, "notebook": "Dir/N4.ipynb",
                                               "not_before": "1970-01-01T00:00:00"}],
                           verdicts={4: feedable(4)})
    feeder.poll()
    ql = lines(q)
    assert len(ql) == 1 and "not_before" not in ql[0]


def test_a_future_not_before_line_is_kept_and_not_fed(tmp_path):
    feeder, q, p, _ = make(tmp_path, pending=[{"issue": 4, "notebook": "Dir/N4.ipynb",
                                               "not_before": "2099-01-01T00:00:00"}],
                           verdicts={4: feedable(4)})
    feeder.poll()
    assert lines(q) == [] and len(lines(p)) == 1


def test_a_line_with_an_unknown_field_is_dropped_never_queued(tmp_path):
    # A line the scheduler's closed loader would reject must never poison the queue.
    feeder, q, p, _ = make(tmp_path, pending=[{"issue": 4, "notebook": "Dir/N4.ipynb",
                                               "notebok": "typo"}], verdicts={4: feedable(4)})
    feeder.poll()
    assert lines(q) == []
    assert "rejected 4 bad-line" in log_text(tmp_path)


def test_an_unparseable_pending_line_is_dropped(tmp_path):
    feeder, q, p, _ = make(tmp_path, pending=[])
    p.write_text("{not json\n", encoding="utf-8")
    feeder.poll()
    assert lines(p) == []
    assert "rejected unparseable-line" in log_text(tmp_path)


# ---------------------------------------------------------------- loop boundaries
def test_without_a_scheduler_state_the_feeder_waits_and_says_so(tmp_path):
    # The feeder reads what the scheduler knows; with no state it must not guess, and it must
    # not stay silent (the local idled with no trace).
    feeder, q, p, _ = make(tmp_path, pending=[{"issue": 1, "notebook": "Dir/N1.ipynb"}],
                           verdicts={1: feedable(1)})
    (tmp_path / "state" / "state.json").unlink()
    feeder.poll()
    assert lines(q) == [] and len(lines(p)) == 1
    assert "state-unreadable waiting" in log_text(tmp_path)


def test_cap_admits_one_grain_per_poll(tmp_path):
    feeder, q, p, _ = make(tmp_path, cap=1,
                           pending=[{"issue": 1, "notebook": "Dir/N1.ipynb"},
                                    {"issue": 2, "notebook": "Dir/N2.ipynb"}],
                           verdicts={1: feedable(1), 2: feedable(2)})
    feeder.poll()
    assert [x["issue"] for x in lines(q)] == [1]       # one slot, one feed
    assert len(lines(p)) == 1                           # the second waits


def test_a_consumed_line_re_measures_at_once_without_a_poll(tmp_path):
    # The local feeder looped straight on after consuming a pending line ("re-measure before
    # feeding another"); the flag is what lets run() skip the poll sleep and fill the slots.
    feeder, q, p, _ = make(tmp_path, cap=2,
                           pending=[{"issue": 1, "notebook": "Dir/N1.ipynb"},
                                    {"issue": 2, "notebook": "Dir/N2.ipynb"}],
                           verdicts={1: feedable(1), 2: feedable(2)})
    feeder.poll()
    assert feeder._loop_again is True and [x["issue"] for x in lines(q)] == [1]
    feeder.poll()
    assert [x["issue"] for x in lines(q)] == [1, 2]     # filled without a poll gap


def test_pending_empty_and_all_terminal_exits_zero(tmp_path):
    feeder, q, p, _ = make(tmp_path, grains=[grain(1, status="done")], pending=[])
    assert feeder.poll() == 0
    assert "PENDING-EMPTY" in log_text(tmp_path)


def test_breaker_trips_on_consecutive_content_failures(tmp_path):
    feeder, q, p, _ = make(tmp_path, breaker=2, verdicts={1: feedable(1)})
    k = (1, "Dir/N1.ipynb")
    feeder.fed = {k}
    feeder.started = {k: OLD}
    st = {k: grain(1, status="failed", finished=LATE, verdict="gates-failed:rust-conformance")}
    feeder.end_of_grain_scan(st)
    feeder.fed = {k}                      # a second stuck grain
    feeder.started = {k: OLD}
    assert feeder.end_of_grain_scan(st) == 0
    assert "BREAKER-TRIPPED" in log_text(tmp_path)


def test_a_qualification_pause_stops_the_feeder_for_the_operator(tmp_path):
    feeder, q, p, _ = make(tmp_path)
    k = (1, "Dir/N1.ipynb")
    feeder.fed = {k}
    feeder.started = {k: OLD}
    st = {k: grain(1, status="failed", finished=LATE,
                   verdict="refused-claim-not-qualified:RELACHEE")}
    assert feeder.end_of_grain_scan(st) == 4
    assert "QUALIFICATION-PAUSED 1" in log_text(tmp_path)


def test_a_foreign_ended_grain_is_not_a_defect(tmp_path):
    feeder, q, p, _ = make(tmp_path)
    k = (1, "Dir/N1.ipynb")
    feeder.fed = {k}
    feeder.started = {k: OLD}
    st = {k: grain(1, status="failed", finished=LATE,
                   verdict="refused-claim-held-by-another-lane")}
    assert feeder.end_of_grain_scan(st) is None
    assert feeder.fed == set()            # dropped from watching, not a content failure
    assert feeder.streak == 0
    assert "foreign-ended 1" in log_text(tmp_path)


def test_scheduler_line_strips_feeder_only_fields_and_refuses_unknown():
    assert "not_before" not in F.scheduler_line({"issue": 1, "notebook": "Dir/N1.ipynb",
                                                 "not_before": "x"})
    with pytest.raises(ValueError):
        F.scheduler_line({"issue": 1, "notebook": "Dir/N1.ipynb", "bogus": 1})


# ---------------------------------------------------------------- trap 6
def test_trap6_a_stale_reserve_line_that_is_now_delivered_is_dropped(tmp_path):
    # A reserve built days earlier must be rebuilt, never trusted: its delivered lines are
    # dropped on live data before any feed, so the stale reserve is harmless.
    R = _load("nb_coder_reserve")
    assert R.reserve_stale("2026-11-20T00:00:00Z", NOW)            # days old -> stale
    assert not R.reserve_stale("1970-01-12T13:46:40Z", NOW)        # built "now" -> fresh
    assert R.reserve_stale("not-a-date", NOW)                      # undatable -> stale
    feeder, q, p, _ = make(tmp_path, pending=[{"issue": 11, "notebook": "Dir/N11.ipynb"}],
                           verdicts={11: {"delivered_marker": True}})
    feeder.poll()
    assert lines(q) == [] and lines(p) == []      # stale reserve line dropped, never replayed


# ---------------------------------------------------------------- unfold (review 27/11)
def test_trap5_an_unreadable_tree_keeps_an_unfold_line_and_the_daemon_survives(tmp_path):
    class NoCall:
        def do(self, *a, **k):
            raise AssertionError("unfold.do must not be reached without the tree")

        def has_room(self, *a, **k):
            return True

    def boom():
        raise RuntimeError("git ls-tree origin/main down")

    feeder, q, p, _ = make(tmp_path, pending=[{"issue": 12, "notebook": "Dir/N12-Rust.ipynb",
                                               "unfold": {"kind": "reopen", "lot": 5,
                                                          "pli": "Alpha page"}}],
                           unfold=NoCall(), tree=boom)
    assert feeder.poll() is None                    # an exception here used to kill the daemon
    assert lines(q) == [] and len(lines(p)) == 1    # kept, re-measured next poll
    assert "unfold-unmeasured" in log_text(tmp_path)


# ---------------------------------------------------------------- hand-edited pending (review 28/11, A)
@pytest.mark.parametrize("line, why", [
    # Measured by the reviewer: valid JSON, no notebook -> KeyError raised OUT of poll(),
    # no log line, the process dead.
    ({"issue": 9}, "missing field(s) ['notebook']"),
    ({"notebook": "Dir/N1.ipynb"}, "missing field(s) ['issue']"),
    ({"issue": "abc", "notebook": "Dir/N1.ipynb"}, "issue must be a positive integer"),
    # Rules the scheduler's closed loader applies to the whole file: one such line in the
    # queue takes the conveyor down, so it must not be fed.
    ({"issue": 9, "notebook": "C:/abs/N9.ipynb"}, "notebook must be repo-relative"),
    ({"issue": 9, "notebook": "Dir/N9.ipynb", "claim_late": True, "claim": False},
     "claim_late defers claim: claim false contradicts it"),
    # Never due, never logged: the feeder could not reach PENDING-EMPTY.
    ({"issue": 12, "unfold": {"kind": "reopen", "pli": "Alpha page"}}, "unfold needs an integer lot"),
    ({"issue": 12, "unfold": "reopen"}, "unfold needs an integer lot"),
    # A reopen queues the leaf itself: without its notebook the leaf would be reopened and
    # the comment would announce a grain that never enters the queue.
    ({"issue": 12, "unfold": {"kind": "reopen", "lot": 5, "pli": "Alpha page"}},
     "missing field(s) ['notebook']"),
])
def test_a_shapeless_pending_line_is_rejected_at_the_entrance(tmp_path, line, why):
    # pending.jsonl is hand-edited (INVOCATION.md §7.2). The check is the scheduler's own
    # loader, applied before any live read and before any write.
    feeder, q, p, calls = make(tmp_path, pending=[line, {"issue": 3, "notebook": "Dir/N3.ipynb"}],
                               verdicts={3: feedable(3)})
    assert feeder.poll() is None                    # this used to kill the daemon
    assert lines(p) == []                           # dropped, and the sound line behind it consumed
    assert [x["issue"] for x in lines(q)] == [3]    # the sound line behind it was fed
    assert calls == [3]                             # the shapeless one never reached a live read
    head = f"rejected {line.get('issue', '?')} bad-line "
    rejected = [l.split("Z ", 1)[1] for l in log_text(tmp_path).splitlines()
                if f"Z {head}" in l]
    assert len(rejected) == 1 and rejected[0].startswith(head + why)


def test_the_queue_the_feeder_writes_is_one_the_scheduler_loads(tmp_path):
    # The invariant from the entrance to the queue: what the feeder writes, the closed
    # loader accepts. Measured on the file itself, with the real loader.
    good = [{"issue": 3, "notebook": "Dir/N3.ipynb"}, {"issue": 4, "notebook": "Dir/N4.ipynb"}]
    feeder, q, p, _ = make(tmp_path, pending=[
        {"issue": 9}, {"issue": 5, "notebook": "C:/abs/N5.ipynb"}, *good],
        verdicts={3: feedable(3), 4: feedable(4)}, cap=5)
    feeder.poll()
    feeder.poll()
    assert [x["issue"] for x in lines(q)] == [3, 4]
    items, _ = S.load_queue(q)                      # QueueError here = the conveyor is down
    assert [x["issue"] for x in items] == [3, 4]


def test_scheduler_line_refuses_what_the_scheduler_refuses():
    # The rules are the loader's, not a second list: a missing field is refused, and the
    # message is the loader's own without its line-number prefix.
    with pytest.raises(ValueError, match=r"missing field\(s\) \['notebook'\]"):
        F.scheduler_line({"issue": 1})
    with pytest.raises(ValueError) as exc:
        F.scheduler_line({"issue": 1, "notebook": "Dir/N1.ipynb", "bogus": 1})
    assert exc.exconly() == "ValueError: unknown field(s) ['bogus']"


class ReopenSeat:
    """A fake GitHub holding ONE folded leaf (#9, of lot #5) and recording every write.
    ``fail_state_once`` makes the first state change raise, as a secondary rate limit does."""

    def __init__(self, *, fail_state_once=False):
        self.open, self.comments, self.rec = False, [], []
        self.fail_state_once, self.ticked = fail_state_once, False

    def __call__(self, *a):
        a = tuple(map(str, a))
        self.rec.append(a)
        j = " ".join(a)
        if "search/issues" in j:
            return {"items": []}
        if "/comments" in j:
            if "POST" in j:
                body = json.loads(Path(a[a.index("--input") + 1]).read_text(encoding="utf-8"))
                self.comments.append(body["body"])
                return {}
            return [{"body": b} for b in self.comments]
        if "issues/5" in j:
            if "PATCH" in j:
                self.ticked = True                # the lot: the fold is ticked
            return {"body": "- [ ] Beta page\n"}
        if "issues/9" in j:
            if "PATCH" in j:
                if self.fail_state_once:
                    self.fail_state_once = False
                    raise RuntimeError("gh api: secondary rate limit hit")
                self.open = True
                return {}
            return {"state": "open" if self.open else "closed",
                    "body": "Cible : MyIA.AI.Notebooks/Dir/N9-Rust.ipynb",
                    "comments": len(self.comments)}
        return {}

    def writes(self):
        """(verb, path) of every write on the leaf or the fold, in order."""
        out = []
        for a in self.rec:
            if len(a) < 3 or a[0] != "-X" or a[1] not in ("POST", "PATCH"):
                continue
            out.append((a[1], a[2].split("CoursIA/")[-1]))
        return out


def test_a_reopen_cut_between_its_two_writes_is_finished_never_dropped(tmp_path):
    # Review 28/11, defect B, replayed through the daemon. Measured by the reviewer with the
    # state change first: poll#1 kept the line, poll#2 read the leaf as 'already-open' and
    # dropped it — a leaf reopened with no comment, no fold tick and no grain, all silent.
    U = _load("nb_coder_unfold")
    seat = ReopenSeat(fail_state_once=True)
    feeder, q, p, _ = make(tmp_path, gh=seat, unfold=U, pending=[
        {"issue": 9, "notebook": "Dir/N9-Rust.ipynb",
         "unfold": {"kind": "reopen", "lot": 5, "pli": "Beta page"}}])
    assert feeder.poll() is None                    # the cut: kept, nothing decided on a guess
    assert len(lines(p)) == 1 and seat.ticked is False
    assert seat.open is False and len(seat.comments) == 1    # closed, but carrying our mark
    assert "unfold-unmeasured 9" in log_text(tmp_path)
    assert seat.writes() == [("POST", "issues/9/comments"), ("PATCH", "issues/9")]
    assert feeder.poll() is None                    # the resume
    assert [x["issue"] for x in lines(q)] == [9] and lines(p) == []
    assert seat.open is True and seat.ticked is True
    assert len(seat.comments) == 1                  # the mark was found: no second comment
    assert seat.writes()[2:] == [("PATCH", "issues/9"), ("PATCH", "issues/5")]
    assert "reopen-already-open" not in log_text(tmp_path)
    assert "unfold-reopen-comment 9" in log_text(tmp_path)


def test_a_published_page_whose_line_never_came_is_resumed_not_dropped(tmp_path):
    # Reviews 27/11: publish rc 0, then no queue line -> the next poll used to read the page
    # as "already published" and drop a grain that was published but never queued.
    U = _load("nb_coder_unfold")
    kit = tmp_path / "kit"
    kit.mkdir()
    (kit / "specs.txt").write_text("", encoding="utf-8")
    rows = []

    def pub(k, fam, key):                           # the kit records the publish
        with open(Path(k) / "specs.txt", "a", encoding="utf-8") as fh:
            fh.write(f"{key} 9\n")
        return U.RunnerResult(0, "published", "")

    class Kit:
        def has_room(self, u, **kw):
            return U.has_room(u, **kw)

        def do(self, item, **kw):
            return U.do(item, publish=pub, feeder_lines=lambda k, f: list(rows), **kw)

    feeder, q, p, _ = make(tmp_path, gh=lambda *a: {"items": []}, unfold=Kit(), pending=[
        {"unfold": {"kind": "publish", "kit": str(kit), "fam": "Fam", "key": "KEY",
                    "lot": 5, "pli": "Alpha page"}}])
    feeder.poll()
    assert lines(q) == []
    assert len(lines(p)) == 1 and lines(p)[0].get("published") is True
    assert "unfold-no-queue-line KEY" in log_text(tmp_path)
    rows.append({"issue": 9, "notebook": "X/KEY-Rust.ipynb"})     # the kit caught up
    feeder.poll()
    assert [x["issue"] for x in lines(q)] == [9] and lines(p) == []
    assert "unfold-resume-published KEY" in log_text(tmp_path)
    assert "fed 9 unfolded" in log_text(tmp_path)


def test_no_lane_refuses_before_any_side_effect(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("NBCODER_LANE", raising=False)
    code = F.main(["--pending", str(tmp_path / "pending.jsonl"),
                   "--queue", str(tmp_path / "queue.jsonl"),
                   "--state-dir", str(tmp_path / "state"),
                   "--checkout", str(tmp_path / "repo")])
    assert code == 2 and "refused: no lane" in capsys.readouterr().err
    assert not (tmp_path / "feeder.log").exists()   # nothing was measured, nothing written
