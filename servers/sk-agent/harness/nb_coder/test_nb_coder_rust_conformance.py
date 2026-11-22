# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_rust_conformance.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Rust conformance entry written at delivery (CoursIA c0018, 21/11).

The coordinator's rule for the Rust ports: each one ships a
`scripts/notebook_tools/rust_conformance.d/<slug>.yaml` entry the repo checker
(`check_rust_conformance.py`) replays, else every PR comes back from review.
These tests pin what the generator writes (one strict-text measure per Python
cell that prints, duration lines matched by presence, C# compared or DECLARED
absent with the measured gap, three-sided `label : value` measures), that the
checker's own extraction reads every measure back, that an existing entry is
never rewritten, and the stage-3 gate that repairs a divergence before the PR.
"""
import importlib.util
import json
import re
from pathlib import Path

import pytest

_HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("nb_coder_integrate_rc",
                                               _HERE / "nb_coder_integrate.py")
nbci = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(nbci)

FAMILY = "MyIA.AI.Notebooks/Demo"
PY = f"{FAMILY}/Demo-01-Thing-Python.ipynb"
RS = f"{FAMILY}/Demo-01-Thing-Rust.ipynb"
CS = f"{FAMILY}/Demo-01-Thing-CSharp.ipynb"


def _stream(text: str) -> dict:
    return {"output_type": "stream", "name": "stdout", "text": text}


def _result(text: str, **extra) -> dict:
    return {"output_type": "execute_result", "execution_count": 1, "metadata": {},
            "data": {"text/plain": text, **extra}}


def _code(outputs: list) -> dict:
    return {"cell_type": "code", "source": "x", "outputs": outputs, "metadata": {},
            "execution_count": 1}


def _md() -> dict:
    return {"cell_type": "markdown", "source": "# t", "metadata": {}}


def _nb(path: Path, cells: list, language: str = "python") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"cells": cells, "nbformat": 4, "nbformat_minor": 5,
                                "metadata": {"kernelspec": {"language": language,
                                                            "name": language}}},
                               ensure_ascii=False, indent=1), encoding="utf-8")
    return path


def _repo(tmp_path: Path, py: list, rs: list, cs: list | None = None) -> Path:
    (tmp_path / nbci.RUST_CONFORMANCE_DIR).mkdir(parents=True)
    _nb(tmp_path / PY, py)
    _nb(tmp_path / RS, rs, "rust")
    if cs is not None:
        _nb(tmp_path / CS, cs, "C#")
    return tmp_path


def _checker_read(text: str, pattern: str):
    """The repo checker's extraction: re.search DOTALL, first group, strip."""
    m = re.search(pattern, text, re.DOTALL)
    return None if not m else (m.group(1) if m.groups() else m.group(0)).strip()


def _assert_checker_reads_back(wt: Path, built: dict) -> None:
    files = {"python": wt / PY, "rust": wt / RS, "csharp": wt / CS}
    for m in built["entry"]["measures"]:
        ref = m["sides"]["python"]
        want = _checker_read(nbci.notebook_outputs(files["python"])[ref["cell"]], ref["pattern"])
        assert want is not None, m["id"]
        for side, spec in m["sides"].items():
            if "absent" in spec:
                continue
            got = _checker_read(nbci.notebook_outputs(files[side])[spec["cell"]], spec["pattern"])
            assert got == want, (m["id"], side, got, want)


# ------------------------------------------------------------- the entry

def test_conforming_port_one_measure_per_printing_cell(tmp_path):
    wt = _repo(tmp_path,
               [_md(), _code([_stream("a = 1\nb = 2\n")]), _code([]), _code([_stream("fin\n")])],
               [_md(), _code([_stream("a = 1\nb = 2\n")]), _code([]), _code([_stream("fin\n")])])
    b = nbci.build_conformance_entry(wt, RS, PY)
    assert [m["id"] for m in b["entry"]["measures"]] == ["c1_text", "c3_text"]
    assert b["divergences"] == [] and b["csharp"] is None
    assert "csharp" not in b["entry"]
    _assert_checker_reads_back(wt, b)


def test_stray_unit_is_a_divergence_never_smoothed(tmp_path):
    """#27803 cell 6: the Rust loop ends without `;`, evcxr prints `()`."""
    wt = _repo(tmp_path, [_code([_stream("W | coût\n1 | 3\n")])],
               [_code([_stream("W | coût\n1 | 3\n"), _result("()")])])
    b = nbci.build_conformance_entry(wt, RS, PY)
    assert [d["id"] for d in b["divergences"]] == ["c0_text"]
    assert "()" in b["divergences"][0]["text"]
    assert len(b["entry"]["measures"]) == 1      # written anyway: fail-closed


def test_duration_lines_are_presence_anchors(tmp_path):
    """Sudoku-07: two `Temps moyen` lines share one template; the values float."""
    py = "Grille 1\nTemps moyen : 1.25 ms\nGrille 2\nTemps moyen : 0.8 ms\nTotal OK\n"
    rs = "Grille 1\nTemps moyen : 0.031 ms\nGrille 2\nTemps moyen : 12 ms\nTotal OK\n"
    wt = _repo(tmp_path, [_code([_stream(py)])], [_code([_stream(rs)])])
    b = nbci.build_conformance_entry(wt, RS, PY)
    assert [m["id"] for m in b["entry"]["measures"]] == ["c0_seg1", "c0_seg2", "c0_seg3"]
    assert b["divergences"] == []
    _assert_checker_reads_back(wt, b)
    # the second segment must not anchor on the FIRST `Temps moyen` line
    seg2 = b["entry"]["measures"][1]["sides"]["rust"]["pattern"]
    assert _checker_read(rs, seg2) == "Grille 2"


def test_csharp_crlf_declared_absent_with_the_measured_gap(tmp_path):
    wt = _repo(tmp_path, [_code([_stream("x = 1\n")])], [_code([_stream("x = 1\n")])],
               [_code([_stream("x = 1\r\n")])])
    b = nbci.build_conformance_entry(wt, RS, PY)
    cs = b["entry"]["measures"][0]["sides"]["csharp"]
    # `x = 1` alone reads the same on all sides once stripped: compared, not absent
    assert cs.get("cell") == 0
    wt2 = _repo(tmp_path / "two", [_code([_stream("x = 1\ny = 2\n")])],
                [_code([_stream("x = 1\ny = 2\n")])], [_code([_stream("x = 1\r\ny = 2\r\n")])])
    cs2 = nbci.build_conformance_entry(wt2, RS, PY)["entry"]["measures"][0]["sides"]["csharp"]
    assert "CRLF" in cs2["absent"]


def test_csharp_other_structure_and_text_gaps(tmp_path):
    wt = _repo(tmp_path, [_md(), _code([_stream("Stable ? True\n")])],
               [_md(), _code([_stream("Stable ? True\n")])],
               [_code([_stream("Stable ? true\n")])])
    sides = nbci.build_conformance_entry(wt, RS, PY)["entry"]["measures"][0]["sides"]
    assert "pas de cellule de code à l'index 1" in sides["csharp"]["absent"]
    wt2 = _repo(tmp_path / "t", [_code([_stream("Stable ? True\n")])],
                [_code([_stream("Stable ? True\n")])], [_code([_stream("Stable ? true\n")])])
    gap = nbci.build_conformance_entry(wt2, RS, PY)["entry"]["measures"][0]["sides"]["csharp"]
    assert "diffère du texte Python" in gap["absent"] and "true" in gap["absent"]


def test_first_diff_excerpt_shows_the_differing_columns():
    """ChoixSocial-02 c2: the lines part after column 60, so a `[:60]` excerpt
    showed two identical prefixes and the absent motif read as nonsense."""
    py = "Configuration OK : SocialChoice 02 - Mariage Stable (Gale-Shapley)"
    cs = "Configuration OK : SocialChoice 02 - Mariage Stable (Gale-Shapley, twin C# .NET 9)"
    d = nbci._first_diff(py, cs)
    assert ", twin C#" in d and "Shapley)" in d
    a, b = re.findall(r"« (.*?) »", d)
    assert a != b and a.startswith("…") and b.startswith("…")
    assert nbci._first_diff("x = 1", "x = 2") == "ligne 1 : « x = 2 » contre « x = 1 » côté Python"
    assert nbci._first_diff("a\nb", "a") == "ligne 2 : « <fin> » contre « b » côté Python"


def test_label_lines_identical_on_three_sides_become_three_sided(tmp_path):
    """#27804: `Couplage … : {…}` lines agree on all sides while the cell's full
    text does not (C# drops accents elsewhere)."""
    py = "Résultat détaillé\nCouplage femmes : {A: 1, B: 2}\nIdentiques : True\n"
    cs = "Resultat detaille\r\nCouplage femmes : {A: 1, B: 2}\r\nIdentiques : True\r\n"
    wt = _repo(tmp_path, [_code([_stream(py)])], [_code([_stream(py)])], [_code([_stream(cs)])])
    b = nbci.build_conformance_entry(wt, RS, PY)
    ids = [m["id"] for m in b["entry"]["measures"]]
    assert ids[0] == "c0_text" and "absent" in b["entry"]["measures"][0]["sides"]["csharp"]
    assert {"c0_couplage_femmes", "c0_identiques"} <= set(ids)
    assert b["three_sided"] == 2
    _assert_checker_reads_back(wt, b)


def test_rich_display_and_addresses_are_not_measured(tmp_path):
    wt = _repo(tmp_path,
               [_code([_stream("n = 3\n"), {"output_type": "display_data", "metadata": {},
                                           "data": {"text/plain": "<Figure size 640x480>",
                                                    "image/png": "iVBOR"}}]),
                _code([_result("<Node object at 0x7f3a2b1c9d00>")])],
               [_code([_stream("n = 3\n")]), _code([_stream("Node\n")])])
    b = nbci.build_conformance_entry(wt, RS, PY)
    assert b["entry"]["measures"] == [] and b["divergences"] == []
    assert len(b["skipped"]) == 2


def test_environment_banners_are_not_measured(tmp_path):
    """#27853 c3 (« Python 3.13.16, stdlib only » vs « Rust, std only ») and
    #27818 c1 (« Z3 version : 4.16.0 »): the runtime, not a result."""
    wt = _repo(tmp_path,
               [_code([_stream("Python 3.13.16, stdlib only\n")]),
                _code([_stream("Dépendances prêtes.\nZ3 version : 4.16.0\n")]),
                _code([_stream("numpy = 2.1.3\n")]),
                _code([_stream("Grille résolue en 3 coups\n")])],
               [_code([_stream("Rust, std only\n")]), _code([]), _code([]),
                _code([_stream("Grille résolue en 3 coups\n")])])
    b = nbci.build_conformance_entry(wt, RS, PY)
    assert [m["id"] for m in b["entry"]["measures"]] == ["c3_text"]
    assert b["divergences"] == []
    assert sum("bannière d'environnement" in s for s in b["skipped"]) == 3


def test_unmeasured_cells_are_written_with_their_motive(tmp_path):
    """CoursIA#27818 review (22/11): the entry must SAY why c1/c13 carry no
    measure -- the generator knew (`skipped`) and wrote nothing. The motives
    go in header comments, and the YAML still loads to the same measures."""
    yaml = pytest.importorskip("yaml")
    wt = _repo(tmp_path,
               [_code([_stream("Dépendances prêtes.\nZ3 version : 4.16.0\n")]),
                _code([_stream("n = 3\n"), {"output_type": "display_data", "metadata": {},
                                           "data": {"text/plain": "<Figure size 640x480>",
                                                    "image/png": "iVBOR"}}]),
                _code([_stream("Grille résolue en 3 coups\n")])],
               [_code([]), _code([_stream("n = 3\n")]),
                _code([_stream("Grille résolue en 3 coups\n")])])
    b = nbci.build_conformance_entry(wt, RS, PY)
    text = nbci.render_conformance_yaml(b)
    assert "# Cellules non mesurées (motif relevé à la génération) :" in text
    assert "#   - c0: bannière d'environnement (versions) côté Python, non mesurée" in text
    assert "#   - c1: sortie riche côté Python (figure/HTML), non mesurée" in text
    assert yaml.safe_load(text)[0]["measures"] == b["entry"]["measures"]


def test_no_unmeasured_block_when_every_cell_is_measured(tmp_path):
    wt = _repo(tmp_path, [_code([_stream("ok\n")])], [_code([_stream("ok\n")])])
    b = nbci.build_conformance_entry(wt, RS, PY)
    assert b["skipped"] == []
    assert "Cellules non mesurées" not in nbci.render_conformance_yaml(b)


@pytest.mark.parametrize("text,banner", [
    ("Python 3.13.16, stdlib only\n", True),
    ("Z3 version : 4.16.0\n", True),
    ("x = 1.5\ny = 2\n", False),                   # a result, not a version
    ("Score : 3.25\n", False),
    ("\n".join(f"ligne {k}" for k in range(8)) + "\nversion 1.2\n", False),  # long cell
])
def test_env_banner_detector(text, banner):
    assert nbci.is_env_banner(text) is banner


@pytest.mark.parametrize("name,ok", [("Demo-01-Thing-Rust.ipynb", True),
                                     ("Demo-01-Thing-CSharp.ipynb", False)])
def test_only_rust_ports_get_an_entry(name, ok):
    assert nbci.is_rust_port(f"{FAMILY}/{name}") is ok


def test_slug_and_file():
    assert nbci.conformance_file("x/Sudoku-07-Norvig-Rust.ipynb").as_posix() == \
        "scripts/notebook_tools/rust_conformance.d/sudoku-07-norvig.yaml"


# ------------------------------------------------------------- render / plan

def test_yaml_roundtrip_is_exact(tmp_path):
    yaml = pytest.importorskip("yaml")
    py = "Grille 1\nTemps : 1.5 ms\nCoût « total » : 7\n"
    wt = _repo(tmp_path, [_code([_stream(py)])], [_code([_stream(py)])],
               [_code([_stream(py.replace("\n", "\r\n"))])])
    b = nbci.build_conformance_entry(wt, RS, PY)
    doc = yaml.safe_load(nbci.render_conformance_yaml(b))
    assert doc[0]["measures"] == b["entry"]["measures"]
    assert doc[0]["python"] == PY and doc[0]["rust"] == RS and doc[0]["csharp"] == CS


def test_plan_writes_once_and_never_rewrites(tmp_path):
    wt = _repo(tmp_path, [_code([_stream("ok\n")])], [_code([_stream("ok\n")])])
    plan = nbci.plan_conformance(wt, RS, PY)
    assert plan["todo"] and nbci.apply_conformance(plan)
    target = wt / nbci.conformance_file(RS)
    target.write_text("# corrigé à la main\n", encoding="utf-8")
    again = nbci.plan_conformance(wt, RS, PY)
    assert again == {"todo": False, "file": nbci.conformance_file(RS).as_posix(),
                     "why": "entry already present"}
    assert not nbci.apply_conformance(again)
    assert target.read_text(encoding="utf-8") == "# corrigé à la main\n"


def test_plan_needs_the_registry_dir_and_a_rust_port(tmp_path):
    _nb(tmp_path / PY, [_code([_stream("ok\n")])])
    _nb(tmp_path / RS, [_code([_stream("ok\n")])], "rust")
    assert nbci.plan_conformance(tmp_path, RS, PY)["todo"] is False
    assert nbci.plan_conformance(tmp_path, CS, PY) == {"todo": False, "why": "not a Rust port"}


def test_guard_replayed_only_when_the_entry_exists(tmp_path, monkeypatch):
    seen = []

    class _P:
        returncode, stdout, stderr = 0, "", ""

    monkeypatch.setattr(nbci.subprocess, "run", lambda cmd, **kw: (seen.append(cmd), _P())[1])
    names = [g["guard"] for g in nbci.replay_guards(tmp_path, RS)]
    assert "rust-conformance" not in names
    (tmp_path / nbci.conformance_file(RS)).parent.mkdir(parents=True)
    (tmp_path / nbci.conformance_file(RS)).write_text("[]\n", encoding="utf-8")
    seen.clear()
    guards = nbci.replay_guards(tmp_path, RS)
    assert guards[-1]["guard"] == "rust-conformance"
    assert seen[-1][1:] == [nbci.CONFORMANCE_CHECKER, "--entry", "demo-01-thing.yaml"]
    assert "rust-conformance" not in [g["guard"] for g in nbci.replay_guards(tmp_path)]


def test_entry_is_owned_by_sync_main(tmp_path):
    assert nbci.conformance_file(RS).as_posix() in nbci.owned_files(tmp_path, RS, PY)
    assert nbci.conformance_file(RS).as_posix() not in nbci.owned_files(tmp_path, CS, PY)


# ------------------------------------------------------------- driver gate

def _driver():
    pytest.importorskip("mcp")
    spec = importlib.util.spec_from_file_location("nbcd_rconf", _HERE / "nb_coder_driver.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_gate_routes_a_divergence_to_the_repair_loop(tmp_path):
    nbcd = _driver()
    src = _nb(tmp_path / "twin.ipynb", [_code([_stream("a\nb\n")])])
    built = _nb(tmp_path / "built.ipynb", [_code([_stream("a\nB\n")])], "rust")
    g = nbcd.rust_conformance_gate(src, built)
    assert g["gate"] == "rust-conformance" and g["ok"] is False
    assert g["detail"]["cells"] == [0]
    rec = {"gates": [g]}
    f = nbcd.gate_repair_findings(rec)
    assert len(f) == 1 and f[0]["cell"] == 0 and "jumeau Python" in f[0]["detail"]
    assert "« B » contre « b »" in f[0]["detail"]


def test_gate_silent_without_a_python_twin(tmp_path):
    nbcd = _driver()
    cs = _nb(tmp_path / "twin.ipynb", [_code([_stream("a\n")])], "C#")
    built = _nb(tmp_path / "built.ipynb", [_code([_stream("b\n")])], "rust")
    assert nbcd.rust_conformance_gate(cs, built) is None


def test_run_gates_adds_it_for_a_rust_creation_only(tmp_path):
    nbcd = _driver()
    src = _nb(tmp_path / "twin.ipynb", [_code([_stream("a\n")])])
    built = _nb(tmp_path / "built.ipynb", [_code([_stream("a\n")])], "rust")
    names = [g["gate"] for g in nbcd.run_gates(src, built, create_mode=True, rel=RS)]
    assert names.count("rust-conformance") == 1
    assert "rust-conformance" not in [g["gate"] for g in
                                      nbcd.run_gates(src, built, create_mode=True, rel=CS)]
    assert "rust-conformance" not in [g["gate"] for g in nbcd.run_gates(src, built, rel=RS)]


def test_pr_body_says_the_entry_and_its_divergences():
    nbcd = _driver()
    body = nbcd.integration_pr_lines({
        "readme": "Rust", "nav": "list",
        "conformance": {"todo": True, "file": "scripts/notebook_tools/rust_conformance.d/x.yaml",
                        "measures": 7, "three_sided": 2, "csharp": CS,
                        "divergences": [{"id": "c6_text", "cell": 6, "text": "ligne 10"}]}})
    assert "`scripts/notebook_tools/rust_conformance.d/x.yaml` écrite : 7 mesures, dont 2" in body
    assert "Divergence mesurée c6_text" in body
    present = nbcd.integration_pr_lines({"conformance": {
        "todo": False, "file": "f.yaml", "why": "entry already present"}})
    assert "`f.yaml` : entry already present" in present


def test_integration_commit_message_names_only_what_was_written():
    """A retrofit on an already-integrated PR writes only the conformance entry;
    its commit must not claim a README row and a nav edge (CoursIA#27858)."""
    nb = "D/X-Rust.ipynb"
    conf = {"todo": True, "file": "scripts/notebook_tools/rust_conformance.d/x.yaml", "measures": 22}
    only_conf = {"notebook": nb, "source_nb": "D/X-Python.ipynb",
                 "readme": {"todo": False}, "conformance": conf, "touched": [conf["file"]]}
    msg = nbci.integration_commit_message(only_conf, "lane:x")
    title = msg.splitlines()[0]
    assert title == "Chore(integration): entrée rust_conformance pour X-Rust"
    assert "README" not in msg and "check-nav-chain" not in msg and "22 mesure(s)" in msg
    full = dict(only_conf, readme={"todo": True, "file": "D/README.md"},
                touched=["D/X-Python.ipynb", "D/README.md", conf["file"]])
    title = nbci.integration_commit_message(full, "lane:x").splitlines()[0]
    assert title == "Chore(integration): ligne README + arête nav + entrée rust_conformance pour X-Rust"
    assert "Lane: lane:x" in nbci.integration_commit_message(full, "lane:x")
