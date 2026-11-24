#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_spec.py
# Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
# jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree.
# -----------------------------------------------------------------------------
"""Offline pins for --from-spec (20/11): creating a NEW notebook with no twin.

The driver only created from a twin (--source-nb, C#/Rust ports); a new series grain
(CoursIA InformationTheory carnet 08, parent #27077) has no twin and rendered
`notebook-not-found`. --from-spec turns the issue's « Plan des cellules » table into a
harness-made [SPEC] twin, so the structure gate and the verifier keep a reference.

Pinned here: the plan parser is fail-closed, the twin passes `verify_structure_create`
against a matching deliverable, an unusable spec is refused BEFORE any reservation
(zero [CLAIMED] comment, zero worktree, zero token), the CLI guards, and the verifier's
spec-mode prompt. No engine, no MCP session, no GitHub.
"""
import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

pytest.importorskip("mcp")

sys.path.insert(0, str(Path(__file__).resolve().parent))
import nb_coder_driver as D  # noqa: E402
import nb_coder_verify as V  # noqa: E402

GOOD = """## Objet

Créer le carnet 08.

## Plan des cellules

| # | Type | Titre | Contenu |
|---|---|---|---|
| 1 | markdown | Titre | En-tête du carnet, objectifs. |
| 2 | code | Imports | `numpy`, `math` ; graine fixe. |
| 3 | markdown | Canal à accès multiple | Région de capacité, $\\|R\\| \\le C$. |
| 4 | code | Calcul | Affiche C = 1 - H(p) pour p = 0,11. |
| 5 | markdown | Provenance | Pied de provenance. |

## Attendus testables

- C(0,11) ≈ 0,5 bit.
"""


# ---------------------------------------------------------------- parse_spec_cells
def test_parse_good_plan_keeps_order_types_and_unescapes_pipes():
    cells, errors = D.parse_spec_cells(GOOD)
    assert errors == []
    assert [c["cell_type"] for c in cells] == ["markdown", "code", "markdown", "code",
                                              "markdown"]
    assert [c["idx"] for c in cells] == [0, 1, 2, 3, 4]          # re-indexed from 0
    assert cells[2]["titre"] == "Canal à accès multiple"
    assert "$|R| \\le C$" in cells[2]["role"]                    # escaped pipe kept whole
    assert cells[3]["role"].startswith("Affiche C")


def test_parse_stops_at_the_next_section():
    cells, _ = D.parse_spec_cells(GOOD)
    assert not any("Attendus" in c["role"] or "0,5 bit" in c["role"] for c in cells)


@pytest.mark.parametrize("body, needle", [
    ("## Objet\n\nrien", "no « Plan des cellules »"),
    ("## Plan des cellules\n\npas de table\n", "has no table"),
    ("## Plan des cellules\n\n| # | Titre | Contenu |\n|---|---|---|\n| 1 | a | b |\n",
     "no « Type » column"),
    ("## Plan des cellules\n\n| # | Type | Titre |\n|---|---|---|\n"
     "| 1 | markdown | a |\n| 2 | code | b |\n| 3 | markdown | c |\n",
     "no content column"),
    ("## Plan des cellules\n\n| # | Type | Contenu |\n|---|---|---|\n"
     "| 1 | markdown | a |\n| 2 | raw | b |\n| 3 | markdown | c |\n",
     "is not markdown|code"),
    ("## Plan des cellules\n\n| # | Type | Contenu |\n|---|---|---|\n"
     "| 1 | code | a |\n| 2 | code | b |\n| 3 | markdown | c |\n",
     "first plan cell must be markdown"),
    ("## Plan des cellules\n\n| # | Type | Contenu |\n|---|---|---|\n"
     "| 1 | markdown | a |\n| 2 | code | b |\n| 3 | code | c |\n",
     "last plan cell must be markdown"),
    ("## Plan des cellules\n\n| # | Type | Contenu |\n|---|---|---|\n"
     "| 1 | markdown | a |\n| 2 | markdown | b |\n| 3 | markdown | c |\n",
     "no code cell"),
    ("## Plan des cellules\n\n| # | Type | Contenu |\n|---|---|---|\n"
     "| 1 | markdown | a |\n| 3 | code | b |\n| 4 | markdown | c |\n",
     "not contiguous"),
    ("## Plan des cellules\n\n| # | Type | Contenu |\n|---|---|---|\n"
     "| 1 | markdown | a |\n| 2 | code | b | extra |\n| 3 | markdown | c |\n",
     "columns, header has"),
    ("## Plan des cellules\n\n| # | Type | Contenu |\n|---|---|---|\n"
     "| 1 | markdown | a |\n| 2 | code | b |\n",
     "at least 3 required"),
    ("## Plan des cellules\n\n| # | Type | Contenu |\n|---|---|---|\n"
     "| 1 | markdown | a |\n| 2 | code |  |\n| 3 | markdown | c |\n",
     "no title and no content"),
])
def test_parse_is_fail_closed(body, needle):
    cells, errors = D.parse_spec_cells(body)
    assert cells == []
    assert any(needle in e for e in errors), errors


# ---------------------------------------------------------------- spec_twin
def _write(path: Path, nb: dict) -> Path:
    path.write_text(json.dumps(nb, ensure_ascii=False), encoding="utf-8")
    return path


def test_twin_carries_the_plan_and_the_meta_only(tmp_path):
    cells, _ = D.parse_spec_cells(GOOD)
    meta = {"kernelspec": {"name": "python3", "display_name": "Python 3"},
            "language_info": {"name": "python", "version": "3.11.9"}}
    tw = D.spec_twin(cells, meta)
    assert tw["metadata"] == meta and tw["nbformat"] == 4
    assert [c["id"] for c in tw["cells"]] == [f"spec-{i}" for i in range(5)]
    assert tw["cells"][0]["source"].startswith("[SPEC cellule 0 — markdown] Titre")
    code = tw["cells"][3]
    assert code["outputs"] == [] and code["execution_count"] is None
    assert all(ln.startswith("# ") for ln in code["source"].splitlines())


def test_spec_meta_reads_kernelspec_and_language_info_only(tmp_path):
    p = _write(tmp_path / "m.ipynb", {"cells": [{"cell_type": "code"}], "metadata": {
        "kernelspec": {"name": "python3"}, "language_info": {"name": "python"},
        "papermill": {"duration": 3.2}, "widgets": {}}, "nbformat": 4, "nbformat_minor": 5})
    assert D.spec_meta(p) == {"kernelspec": {"name": "python3"},
                              "language_info": {"name": "python"}}


def test_structure_gate_against_the_twin(tmp_path):
    cells, _ = D.parse_spec_cells(GOOD)
    twin = _write(tmp_path / "twin.ipynb", D.spec_twin(cells, {}))
    built = {"cells": [{"cell_type": c["cell_type"], "metadata": {},
                        "source": "x = 1" if c["cell_type"] == "code" else "# t",
                        **({"outputs": [], "execution_count": None}
                           if c["cell_type"] == "code" else {})} for c in cells],
             "metadata": {}, "nbformat": 4, "nbformat_minor": 5}
    ok = D.verify_structure_create(twin, _write(tmp_path / "ok.ipynb", built))
    assert ok["ok"]
    built["cells"].insert(1, {"cell_type": "markdown", "metadata": {}, "source": "extra"})
    bad = D.verify_structure_create(twin, _write(tmp_path / "bad.ipynb", built))
    assert not bad["ok"] and not bad["counts_ok"]


# ---------------------------------------------------------------- run(): refusal order
def _run_args(tmp_path, **kw):
    base = dict(out_dir=str(tmp_path), repo="D:/repo", issue=27999,
                notebook="Series/New-08.ipynb", source_nb=None, from_spec=True,
                meta_from="Series/Old-01.ipynb", allow_foreign_origin=False,
                lane="lane:a", claim=True, intention="witness", conventions="",
                max_stage=5, worktree=str(tmp_path / "wt"), fresh_worktree=False,
                gate_mode="advisory", gate=None)
    base.update(kw)
    return SimpleNamespace(**base)


def _stub_common(monkeypatch, body):
    monkeypatch.setattr(D, "app_token", lambda repo: "")
    monkeypatch.setattr(D, "read_conventions", lambda p: "")
    monkeypatch.setattr(D, "check_claim", lambda *a: {"rc": 0, "ok": True})
    monkeypatch.setattr(D, "fetch_issue", lambda *a: {
        "title": "N", "state": "open", "labels": [], "body": body})
    monkeypatch.setattr(D.subprocess, "run", lambda *a, **kw:
                        SimpleNamespace(stdout="https://github.com/jsboige/CoursIA.git\n"))


def test_an_unusable_spec_is_refused_before_any_reservation(monkeypatch, tmp_path):
    _stub_common(monkeypatch, "## Objet\n\nPas de plan.")
    monkeypatch.setattr(D, "reserve_claim", lambda *a: (_ for _ in ()).throw(
        AssertionError("an unusable spec must not post a [CLAIMED] comment")))
    monkeypatch.setattr(D, "prepare_worktree", lambda *a: (_ for _ in ()).throw(
        AssertionError("an unusable spec must not prepare a worktree")))
    rec = {"stages": {}, "calls": []}
    got = asyncio.run(D.run(_run_args(tmp_path), rec))
    assert got["verdict"] == "refused-spec-plan-unusable"
    assert got["stages"]["spec_plan"]["errors"]
    assert got["calls"] == []


def test_a_usable_spec_reaches_the_reservation(monkeypatch, tmp_path):
    _stub_common(monkeypatch, GOOD)
    seen = {}

    def fake_reserve(repo, n, lane, intention, nb):
        seen["nb"] = nb
        return {"verdict": "refused-claim-post-failed"}

    monkeypatch.setattr(D, "reserve_claim", fake_reserve)
    rec = {"stages": {}, "calls": []}
    got = asyncio.run(D.run(_run_args(tmp_path), rec))
    assert seen["nb"] == "Series/New-08.ipynb"
    assert got["stages"]["spec_plan"]["cells"] == 5
    assert got["verdict"] == "refused-claim-post-failed"


def _admitted(monkeypatch, tmp_path, wt_files: dict):
    wt = tmp_path / "wt"
    for rel, nb in wt_files.items():
        (wt / rel).parent.mkdir(parents=True, exist_ok=True)
        _write(wt / rel, nb)
    monkeypatch.setattr(D, "reserve_claim", lambda *a: {"verdict": None})
    monkeypatch.setattr(D, "prepare_worktree", lambda *a: {"path": str(wt), "ok": True})
    monkeypatch.setattr(D, "gate_call", lambda *a: {"blocking_refusal": True})


def test_from_spec_refuses_an_existing_target(monkeypatch, tmp_path):
    _stub_common(monkeypatch, GOOD)
    _admitted(monkeypatch, tmp_path, {"Series/New-08.ipynb": {"cells": [], "metadata": {}}})
    got = asyncio.run(D.run(_run_args(tmp_path), {"stages": {}, "calls": []}))
    assert got["verdict"] == "target-already-exists:Series/New-08.ipynb"


def test_from_spec_refuses_a_meta_without_kernelspec(monkeypatch, tmp_path):
    _stub_common(monkeypatch, GOOD)
    _admitted(monkeypatch, tmp_path, {"Series/Old-01.ipynb": {"cells": [], "metadata": {}}})
    got = asyncio.run(D.run(_run_args(tmp_path), {"stages": {}, "calls": []}))
    assert got["verdict"] == "meta-from-no-kernelspec:Series/Old-01.ipynb"


def test_from_spec_writes_the_twin_outside_the_worktree(monkeypatch, tmp_path):
    """Admitted path up to the capacity gate (stubbed blocking): twin in the out dir,
    kernel from --meta-from, kernel cwd = the TARGET's folder (created)."""
    _stub_common(monkeypatch, GOOD)
    _admitted(monkeypatch, tmp_path, {"Series/Old-01.ipynb": {"cells": [], "metadata": {
        "kernelspec": {"name": "python3"}, "language_info": {"name": "python"}}}})
    got = asyncio.run(D.run(_run_args(tmp_path), {"stages": {}, "calls": []}))
    assert got["verdict"] == "deferred-by-capacity-gate"
    twin = Path(got["create_mode"]["spec_twin"])
    assert twin.parent == tmp_path and twin.is_file()
    assert not list((tmp_path / "wt").rglob("spec-twin-*"))
    assert len(json.loads(twin.read_text(encoding="utf-8"))["cells"]) == 5
    assert got["kernel"]["kernel_name"] == "python3"
    assert got["kernel"]["kernel_source"] == "meta-from-kernelspec"
    assert (tmp_path / "wt" / "Series").is_dir()


# ---------------------------------------------------------------- port metadata (20/11)
def _port_args(tmp_path, **kw):
    base = dict(from_spec=False, source_nb="Series/Old-01.ipynb",
                notebook="Series/New-08-Rust.ipynb", meta_from=None)
    base.update(kw)
    return _run_args(tmp_path, **base)


_PY = {"cells": [], "metadata": {"kernelspec": {"name": "python3"},
                                 "language_info": {"name": "python"}}}
_CS = {"cells": [], "metadata": {"kernelspec": {"name": ".net-csharp"},
                                 "language_info": {"name": "C#", "version": "9.0.117"}}}
_RS = {"cells": [], "metadata": {"kernelspec": {"name": "rust"},
                                 "language_info": {"name": "Rust", "version": "1.100.0"}}}


def test_port_without_canonical_meta_is_refused_before_the_gate(monkeypatch, tmp_path):
    """A Rust port in a folder with C# siblings only: before, the .NET kernelspec was
    inherited; with none at all, the skeleton carried {} and the language-info gate
    failed after the whole build. Now: refused before the capacity gate and any token."""
    _stub_common(monkeypatch, GOOD)
    _admitted(monkeypatch, tmp_path, {"Series/Old-01.ipynb": _PY,
                                      "Series/Old-02-CSharp.ipynb": _CS})
    monkeypatch.setattr(D, "gate_call", lambda *a: (_ for _ in ()).throw(
        AssertionError("no canonical meta must not reach the capacity gate")))
    got = asyncio.run(D.run(_port_args(tmp_path), {"stages": {}, "calls": []}))
    assert got["verdict"] == "create-no-canonical-meta:Series"
    assert got["calls"] == []


def test_port_inherits_the_sibling_with_the_target_language_tag(monkeypatch, tmp_path):
    _stub_common(monkeypatch, GOOD)
    _admitted(monkeypatch, tmp_path, {"Series/Old-01.ipynb": _PY,
                                      "Series/Old-02-CSharp.ipynb": _CS,
                                      "Series/Old-03-Rust.ipynb": _RS})
    got = asyncio.run(D.run(_port_args(tmp_path), {"stages": {}, "calls": []}))
    assert got["verdict"] == "deferred-by-capacity-gate"
    assert got["kernel"]["kernel_name"] == "rust"                  # not .net-csharp
    assert got["kernel"]["kernel_source"] == "canonical-twin-kernelspec"
    assert "meta_from" not in got["create_mode"]


def test_port_meta_from_overrides_the_sibling(monkeypatch, tmp_path):
    _stub_common(monkeypatch, GOOD)
    _admitted(monkeypatch, tmp_path, {"Series/Old-01.ipynb": _PY,
                                      "Other/First-Rust.ipynb": _RS})
    got = asyncio.run(D.run(_port_args(tmp_path, meta_from="Other/First-Rust.ipynb"),
                            {"stages": {}, "calls": []}))
    assert got["verdict"] == "deferred-by-capacity-gate"
    assert got["kernel"]["kernel_name"] == "rust"
    assert got["kernel"]["kernel_source"] == "meta-from-kernelspec"
    assert got["create_mode"] == {"source": "Series/Old-01.ipynb",
                                  "target": "Series/New-08-Rust.ipynb",
                                  "meta_from": "Other/First-Rust.ipynb"}


@pytest.mark.parametrize("files, meta_from, verdict", [
    ({"Series/Old-01.ipynb": _PY}, "Other/Missing.ipynb", "meta-from-not-found:"),
    ({"Series/Old-01.ipynb": _PY, "Other/Bare.ipynb": {"cells": [], "metadata": {}}},
     "Other/Bare.ipynb", "meta-from-no-kernelspec:Other/Bare.ipynb"),
])
def test_port_meta_from_is_checked(monkeypatch, tmp_path, files, meta_from, verdict):
    _stub_common(monkeypatch, GOOD)
    _admitted(monkeypatch, tmp_path, files)
    got = asyncio.run(D.run(_port_args(tmp_path, meta_from=meta_from),
                            {"stages": {}, "calls": []}))
    assert got["verdict"].startswith(verdict)


def test_series_canonical_meta_follows_the_target_tag(tmp_path):
    (tmp_path / "S").mkdir()
    for rel, nb in {"S/A-01-CSharp.ipynb": _CS, "S/A-02-Rust.ipynb": _RS,
                    "S/A-03.ipynb": _PY}.items():
        _write(tmp_path / rel, nb)
    assert D.series_canonical_meta(tmp_path, "S/A-09-Rust.ipynb")["kernelspec"]["name"] == "rust"
    assert D.series_canonical_meta(tmp_path, "S/A-09-CSharp.ipynb")["kernelspec"]["name"] \
        == ".net-csharp"
    assert D.series_canonical_meta(tmp_path, "S/Lean.ipynb") == {}       # no tag
    assert D.series_canonical_meta(tmp_path, "S/A-09-Lean.ipynb") == {}  # no such sibling


# ------------------------------------------- declared kernel = executed kernel (22/11 #27996)
# CoursIA#27996: a Rust port whose --meta-from was the C# twin (the porting reference)
# shipped `.net-csharp` metadata while --kernel-override rust executed every cell — all
# gates green, the maintainer's review red. Fixed at three points: the creation lends its
# metadata from a notebook declaring the REQUIRED kernel, an old draft is aligned before
# the gates, and a kernelspec gate (not repairable by a model turn) refuses the rest.
def test_tag_kernel_maps_only_constrained_tags():
    assert D.tag_kernel("S/A-09-Rust.ipynb") == "rust"
    assert D.tag_kernel("S/A-09-CSharp.ipynb") == ".net-csharp"
    assert D.tag_kernel("S/A-09-Python.ipynb") is None
    assert D.tag_kernel("S/Lean.ipynb") is None and D.tag_kernel("") is None


def test_meta_for_kernel_prefers_the_folder_then_the_tree(tmp_path):
    for rel, nb in {"MyIA.AI.Notebooks/S/A-01-CSharp.ipynb": _CS,
                    "MyIA.AI.Notebooks/Other/B-02-Rust.ipynb": _RS}.items():
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        _write(tmp_path / rel, nb)
    got = D.meta_for_kernel(tmp_path, "MyIA.AI.Notebooks/S/A-09-Rust.ipynb", "rust")
    assert got["kernelspec"]["name"] == "rust"
    assert got["_from"] == "MyIA.AI.Notebooks/Other/B-02-Rust.ipynb"
    _write(tmp_path / "MyIA.AI.Notebooks/S/A-03-Rust.ipynb", _RS)       # folder wins
    assert D.meta_for_kernel(tmp_path, "MyIA.AI.Notebooks/S/A-09-Rust.ipynb",
                             "rust")["_from"] == "MyIA.AI.Notebooks/S/A-03-Rust.ipynb"
    assert D.meta_for_kernel(tmp_path, "MyIA.AI.Notebooks/S/A-09-Lean.ipynb", "lean4") == {}


def test_port_meta_from_of_another_language_lends_no_kernelspec(monkeypatch, tmp_path):
    """The #27996 grain: --meta-from = the C# twin, target -Rust. The skeleton must declare
    `rust` (a Rust sibling's metadata), never `.net-csharp`."""
    _stub_common(monkeypatch, GOOD)
    _admitted(monkeypatch, tmp_path, {"Series/Old-01.ipynb": _PY,
                                      "Series/Old-02-CSharp.ipynb": _CS,
                                      "Series/Old-03-Rust.ipynb": _RS})
    got = asyncio.run(D.run(_port_args(tmp_path, meta_from="Series/Old-02-CSharp.ipynb"),
                            {"stages": {}, "calls": []}))
    assert got["verdict"] == "deferred-by-capacity-gate"
    assert got["kernel"]["kernel_name"] == "rust"
    assert got["kernel"]["kernel_source"] == "canonical-twin-kernelspec"
    assert got["meta_kernel_fix"] == {"meta_kernel": ".net-csharp", "required": "rust",
                                      "replaced_from": "Series/Old-03-Rust.ipynb"}


def test_port_meta_kernel_mismatch_without_donor_is_refused_before_any_token(
        monkeypatch, tmp_path):
    _stub_common(monkeypatch, GOOD)
    _admitted(monkeypatch, tmp_path, {"Series/Old-01.ipynb": _PY,
                                      "Series/Old-02-CSharp.ipynb": _CS})
    monkeypatch.setattr(D, "gate_call", lambda *a: (_ for _ in ()).throw(
        AssertionError("a kernel mismatch must not reach the capacity gate")))
    got = asyncio.run(D.run(_port_args(tmp_path, meta_from="Series/Old-02-CSharp.ipynb"),
                            {"stages": {}, "calls": []}))
    assert got["verdict"] == "create-meta-kernel-mismatch:.net-csharp!=rust"
    assert got["calls"] == []


def test_kernel_override_is_the_required_kernel(monkeypatch, tmp_path):
    """--kernel-override executes; the metadata must name it even on an untagged target."""
    _stub_common(monkeypatch, GOOD)
    _admitted(monkeypatch, tmp_path, {"Series/Old-01.ipynb": _PY,
                                      "Series/Old-03-Rust.ipynb": _RS})
    got = asyncio.run(D.run(_port_args(tmp_path, notebook="Series/New-08.ipynb",
                                       kernel_override="rust"),
                            {"stages": {}, "calls": []}))
    assert got["kernel"]["kernel_name"] == "rust"
    # an untagged target has no canonical sibling meta: the donor is the only source
    assert got["meta_kernel_fix"] == {"meta_kernel": None, "required": "rust",
                                      "replaced_from": "Series/Old-03-Rust.ipynb"}


def _built(tmp_path, meta, name="built.ipynb"):
    return _write(tmp_path / name, {"cells": [], "metadata": meta, "nbformat": 4,
                                    "nbformat_minor": 5})


def test_align_kernelspec_rewrites_a_draft_declaring_another_kernel(tmp_path):
    (tmp_path / "S").mkdir()
    _write(tmp_path / "S/A-03-Rust.ipynb", _RS)
    built = _built(tmp_path, _CS["metadata"])
    got = D.align_kernelspec(built, tmp_path, "S/A-09-Rust.ipynb", "rust")
    assert got == {"from": ".net-csharp", "to": "rust", "donor": "S/A-03-Rust.ipynb",
                   "language_version": "1.100.0"}
    meta = json.loads(built.read_text(encoding="utf-8"))["metadata"]
    assert meta["kernelspec"]["name"] == "rust" and meta["language_info"]["name"] == "Rust"
    assert D.align_kernelspec(built, tmp_path, "S/A-09-Rust.ipynb", "rust") is None  # idempotent


def test_align_kernelspec_never_relabels_outputs_of_another_kernel(tmp_path):
    """Outputs executed on .net-csharp are not Rust outputs: relabeling them would forge the
    deliverable — the gate must refuse instead."""
    (tmp_path / "S").mkdir()
    _write(tmp_path / "S/A-03-Rust.ipynb", _RS)
    built = _built(tmp_path, _CS["metadata"])
    assert D.align_kernelspec(built, tmp_path, "S/A-09-Rust.ipynb", ".net-csharp") is None
    assert json.loads(built.read_text(encoding="utf-8"))["metadata"] == _CS["metadata"]
    assert D.align_kernelspec(built, tmp_path, "S/A-09-Lean.ipynb", "") is None  # no donor


def _ks_gate(gates):
    return [g for g in gates if g["gate"] == "kernelspec"]


def test_kernelspec_gate_refuses_a_declared_kernel_that_did_not_execute(tmp_path):
    src = _built(tmp_path, _PY["metadata"], "src.ipynb")
    bad = _built(tmp_path, _CS["metadata"])
    g = _ks_gate(D.run_gates(src, bad, create_mode=True, canon_version="9.0.117",
                             rel="S/A-09-Rust.ipynb", kernel_name="rust"))
    assert g and not g[0]["ok"]
    assert g[0]["detail"] == {"built": ".net-csharp", "executed": "rust", "tag": "rust"}
    good = _built(tmp_path, _RS["metadata"], "good.ipynb")
    assert _ks_gate(D.run_gates(src, good, create_mode=True, canon_version="1.100.0",
                                rel="S/A-09-Rust.ipynb", kernel_name="rust"))[0]["ok"]
    # correction mode keeps the notebook's own metadata: not this build's business
    assert _ks_gate(D.run_gates(bad, bad, rel="S/A-09-Rust.ipynb", kernel_name="rust")) == []


def test_kernelspec_gate_is_not_routed_to_a_model_repair():
    assert "kernelspec" in D._GATE_NON_REPAIRABLE


# ---------------------------------------------------------------- CLI guards
@pytest.mark.parametrize("extra, needle", [
    (["--from-spec", "--source-nb", "S/T.ipynb", "--meta-from", "S/M.ipynb"], "exclusive"),
    (["--from-spec"], "requires --meta-from"),
    (["--from-spec", "--meta-from", "S/M.ipynb", "--write-mode", "mcp"], "--write-mode json"),
    (["--meta-from", "S/M.ipynb"], "only read in creation mode"),
])
def test_cli_guards(monkeypatch, capsys, extra, needle):
    monkeypatch.setattr(sys, "argv", ["nb_coder_driver.py", "--issue", "1", "--notebook",
                                      "S/N.ipynb", "--repo", "D:/repo", "--max-stage", "0",
                                      *extra])
    with pytest.raises(SystemExit) as e:
        D.main()
    assert e.value.code == 2
    assert needle in capsys.readouterr().err


# ---------------------------------------------------------------- verifier prompt
def test_verify_prompt_spec_mode_swaps_reference_and_task():
    issue = {"title": "T", "body": GOOD}
    sp = V.verify_prompt(issue, "SRCVIEW", "BUILTVIEW", {}, "", [{"cell": 0}],
                         [{"cell": 0}], [{"cell": 0, "kind": "edited"}], mode="spec")
    assert "jumeau de spec" in sp and "carnet d'origine (branche main" not in sp
    assert "création depuis une spec" in sp
    assert "Contenu perdu" not in sp
    assert "SRCVIEW" in sp and "BUILTVIEW" in sp
    src = V.verify_prompt(issue, "SRCVIEW", "BUILTVIEW", {}, "")
    assert "carnet d'origine (branche main, RÉFÉRENCE)" in src
    assert "création depuis une spec" not in src
    # the JSON verdict contract is shared by both modes
    tail = src[src.index("## Périmètre"):]
    assert tail == sp[sp.index("## Périmètre"):]


def _executed_nb(tmp_path: Path, big: int = 0) -> Path:
    cells = [
        {"cell_type": "markdown", "metadata": {}, "source": ["# T"]},
        {"cell_type": "code", "metadata": {}, "execution_count": 1, "source": ["print(42)"],
         "outputs": [{"output_type": "stream", "name": "stdout", "text": ["H = 1.0000 bit\n"]}]},
        {"cell_type": "code", "metadata": {}, "execution_count": 2, "source": ["x"],
         "outputs": [{"output_type": "execute_result", "execution_count": 2, "metadata": {},
                      "data": {"text/plain": ["'Z' * big"]}}] if not big else
         [{"output_type": "stream", "name": "stdout", "text": ["Z" * big]}]},
    ]
    nb = {"cells": cells, "nbformat": 4, "nbformat_minor": 5,
          "metadata": {"kernelspec": {"name": "python3", "display_name": "Python 3"},
                       "language_info": {"name": "python", "version": "3.13.16"}}}
    p = tmp_path / "built.ipynb"
    p.write_text(json.dumps(nb), encoding="utf-8")
    return p


def test_spec_mode_shows_the_deliverable_outputs(tmp_path):
    """IT08 #27460 (20/11): the verifier rejected a fully executed notebook as "no output
    visible" because build_view shows sources only and spec mode dropped every output annex."""
    built = _executed_nb(tmp_path)
    annex = V.built_outputs_annex(built)
    assert annex["kernelspec"] == "python3" and annex["language_version"] == "3.13.16"
    assert [r["cell"] for r in annex["cells"]] == [1, 2]
    assert annex["cells"][0]["execution_count"] == 1
    assert annex["cells"][0]["text"] == "H = 1.0000 bit\n"
    issue = {"title": "T", "body": GOOD}
    sp = V.verify_prompt(issue, "SRCVIEW", "BUILTVIEW", {}, "", mode="spec",
                         built_outputs=annex)
    assert "Annexe sorties du LIVRABLE" in sp and "H = 1.0000 bit" in sp
    assert '"execution_count": 1' in sp and "3.13.16" in sp
    # source mode never carries it, even if passed by mistake
    src = V.verify_prompt(issue, "SRCVIEW", "BUILTVIEW", {}, "", built_outputs=annex)
    assert "Annexe sorties du LIVRABLE" not in src


def test_spec_outputs_annex_declares_its_cut(tmp_path):
    built = _executed_nb(tmp_path, big=V.CELL_TEXT_CAP + 500)
    row = V.built_outputs_annex(built)["cells"][1]
    assert row["bytes"] == V.CELL_TEXT_CAP + 500
    assert row["text"].startswith("Z" * V.CELL_TEXT_CAP)
    assert row["text"].endswith("[tronqué : 500 caractères non affichés]")


def test_spec_outputs_annex_declares_a_figure(tmp_path):
    """Spec mode drops the diff annex (a [SPEC] twin has no outputs): a creation that draws
    a figure must still show it to the critic, beside the text, never inside the cut."""
    cells = json.loads(_executed_nb(tmp_path).read_text(encoding="utf-8"))["cells"]
    cells[1]["outputs"] = [{"output_type": "stream", "name": "stdout",
                            "text": "Z" * (V.CELL_TEXT_CAP + 500)},
                           {"output_type": "display_data",
                            "data": {"image/svg+xml": "<svg width='10' height='20'>"
                                                      "<text>converge</text></svg>"}}]
    p = tmp_path / "fig.ipynb"
    p.write_text(json.dumps({"cells": cells, "metadata": {}, "nbformat": 4,
                             "nbformat_minor": 5}), encoding="utf-8")
    row = V.built_outputs_annex(p)["cells"][0]      # the first CODE cell is cells[1]
    assert row["cell"] == 1
    assert "nontext" in row and "image/svg+xml" in row["nontext"][0]
    assert "«converge»" in row["nontext"][0]
    # The cut is still declared on the TEXT (which carries the inline marker, hence 538 and
    # not 500 hidden): the witness is simply no longer dependent on that text.
    full = V.cell_output_text(cells[1])
    assert row["bytes"] == len(full)
    assert row["text"].endswith(f"[tronqué : {len(full) - V.CELL_TEXT_CAP} caractères non affichés]")
    assert "affichage non textuel" not in row["text"]


def test_short_desc_names_a_spec_creation():
    """CoursIA#27481 (20/11): a from-spec creation was titled '<stem> — edit' because its
    plan carries 'cells', not 'plan', and _short_desc only knew edit gestures."""
    args = SimpleNamespace(notebook="InformationTheory/IT-08-Channel-Capacity.ipynb")
    plan = {"cells": [{"type": "markdown"}, {"type": "code"}, {"type": "code"}],
            "expectations": [], "risques": []}
    cm = {"spec_twin": "x.md", "target": "IT-08.ipynb", "meta_from": "m.ipynb"}
    d = D._short_desc(args, plan, cm)
    assert d == "IT-08-Channel-Capacity — création depuis spec (3 cellules)"
    assert "edit" not in d


def test_short_desc_names_a_port_with_its_source():
    args = SimpleNamespace(notebook="GameTheory/GT-03-Nash-CSharp.ipynb")
    cm = {"source": "GameTheory/GT-03-Nash-Python.ipynb", "target": "GT-03-Nash-CSharp.ipynb"}
    d = D._short_desc(args, {"cells": [{"type": "code"}]}, cm)
    assert d == "GT-03-Nash-CSharp — portage depuis GT-03-Nash-Python (1 cellules)"
    # no cell list → no count, still a creation label
    assert D._short_desc(args, {}, cm) == "GT-03-Nash-CSharp — portage depuis GT-03-Nash-Python"


def test_short_desc_edit_mode_unchanged():
    args = SimpleNamespace(notebook="a/B.ipynb")
    one = {"plan": [{"geste": "edit", "cell": 4, "but": "corrige la borne"}]}
    assert D._short_desc(args, one) == "B cell 4 — corrige la borne"
    assert D._short_desc(args, one, None) == "B cell 4 — corrige la borne"
    two = {"plan": [{"geste": "edit", "cell": 1}, {"geste": "insert", "cell": 2}]}
    assert D._short_desc(args, two) == "B — 2 gestes (edit,insert)"
    assert D._short_desc(args, {}) == "B — edit"


def test_kernelspec_gate_checks_the_executed_kernel_on_an_untagged_target(tmp_path):
    """No language tag to compare with: the executed kernel alone must match the metadata."""
    src = _built(tmp_path, _PY["metadata"], "src.ipynb")
    built = _built(tmp_path, _PY["metadata"])
    g = _ks_gate(D.run_gates(src, built, create_mode=True, rel="S/A-09.ipynb",
                             kernel_name="rust"))
    assert g and not g[0]["ok"] and g[0]["detail"]["tag"] is None
    assert _ks_gate(D.run_gates(src, built, create_mode=True, rel="S/A-09.ipynb",
                                kernel_name="python3"))[0]["ok"]


def test_kernelspec_gate_refuses_a_coherent_pair_that_is_not_the_tag(tmp_path):
    """Declared == executed, but a -Rust target executed on .net-csharp is not a Rust port."""
    src = _built(tmp_path, _PY["metadata"], "src.ipynb")
    built = _built(tmp_path, _CS["metadata"])
    g = _ks_gate(D.run_gates(src, built, create_mode=True, rel="S/A-09-Rust.ipynb",
                             kernel_name=".net-csharp"))
    assert g and not g[0]["ok"] and g[0]["detail"]["tag"] == "rust"
