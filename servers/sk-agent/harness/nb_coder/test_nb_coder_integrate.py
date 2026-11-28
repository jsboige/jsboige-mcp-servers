# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_integrate.py
# Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
# jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree.
# -----------------------------------------------------------------------------
"""Regression pins for the stage-5 repo integration (21/11).

The integration reproduces, deterministically, the remedies the Hermes reviewer
asked for on every port PR (measured: CoursIA#27829/#27835 failing exactly
readme-notebook-coverage + check-nav-chain orphan_entry, lot-1 #27803/04/05
fixed by hand, po-2028's 14 C# port PRs for the reseal order): README row on
the twin's own line mirroring the folder's label convention, inbound nav edge
in the twin's Navigation cell, twin-parity reseal last. These tests pin the
convention shapes measured in the repo, the markdown-only guarantee, the
idempotence, and the --sync-main conflict resolution.
"""
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "nb_coder_integrate",
    Path(__file__).resolve().parent / "nb_coder_integrate.py")
nbci = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(nbci)


def _nb(path: Path, cells: list) -> Path:
    """Repo-format notebook: indent=1, ensure_ascii=False, LF lines, no
    trailing newline, source fields as line lists (measured on CoursIA
    origin/main). `newline=""` keeps Windows from translating to CRLF."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"cells": cells, "metadata": {}, "nbformat": 4,
                                "nbformat_minor": 5}, ensure_ascii=False,
                               indent=1), encoding="utf-8", newline="")
    return path


def _md(src: str) -> dict:
    return {"cell_type": "markdown", "source": src.splitlines(keepends=True),
            "metadata": {}, "id": "md"}


def _code(src: str) -> dict:
    return {"cell_type": "code", "source": src.splitlines(keepends=True),
            "outputs": [], "metadata": {}, "execution_count": 1, "id": "code"}


def _readme(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="")
    return path


NAV_BAR = ("**Navigation** : [<< Sudoku-06](Sudoku-06.ipynb) | "
           "[Index](README.md) | [Sudoku-08 >>](Sudoku-08.ipynb) | "
           "[twin C#](Serie-07-Norvig-CSharp.ipynb)\n")


# ------------------------------------------------------------- README shapes

def test_readme_row_bare_language_table_cell():
    """Sudoku shape (lot 1, #27805): `[C#](…) · [Python](…)` -> `· [Rust](…)`
    appended right after the LAST twin link, before the next table cell."""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        repo = Path(td)
        _readme(repo / "MyIA.AI.Notebooks/Serie/README.md",
                "| 07 | Norvig — [C#](Serie-07-Norvig-CSharp.ipynb) · "
                "[Python](Serie-07-Norvig-Python.ipynb) | description |\n")
        action = nbci.plan_readme_row(
            repo, "MyIA.AI.Notebooks/Serie/Serie-07-Norvig-Rust.ipynb",
            "MyIA.AI.Notebooks/Serie/Serie-07-Norvig-Python.ipynb")
        assert action["todo"] and action["label"] == "Rust"
        nbci.apply_readme_row(action)
        line = (repo / "MyIA.AI.Notebooks/Serie/README.md").read_text(
            encoding="utf-8").splitlines()[0]
        assert line == ("| 07 | Norvig — [C#](Serie-07-Norvig-CSharp.ipynb) · "
                        "[Python](Serie-07-Norvig-Python.ipynb) · "
                        "[Rust](Serie-07-Norvig-Rust.ipynb) | description |")


def test_readme_row_jumeau_label_table_cell():
    """SocialChoice shape (lot 1, #27804): `· [jumeau C#](…)` -> `jumeau Rust`."""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        repo = Path(td)
        _readme(repo / "MyIA.AI.Notebooks/Serie/README.md",
                "| 02 | [Titre](Serie-02-Python.ipynb) · "
                "[jumeau C#](Serie-02-CSharp.ipynb) | desc |\n")
        action = nbci.plan_readme_row(
            repo, "MyIA.AI.Notebooks/Serie/Serie-02-Rust.ipynb",
            "MyIA.AI.Notebooks/Serie/Serie-02-Python.ipynb")
        assert action["label"] == "jumeau Rust"
        assert action["insert"] == " · [jumeau Rust](Serie-02-Rust.ipynb)"


def test_readme_row_plus_group_takes_bare_label():
    """Part1-Foundations shape (lot 1, #27803): inside a `(+ …)` group the
    label is the bare language even next to a `[jumeau C#]` sibling."""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        repo = Path(td)
        _readme(repo / "MyIA.AI.Notebooks/Serie/README.md",
                "- **[3d Weighted A\\*](Serie-03d.ipynb)** "
                "(+ [jumeau C#](Serie-03d-CSharp.ipynb)) — description\n")
        action = nbci.plan_readme_row(
            repo, "MyIA.AI.Notebooks/Serie/Serie-03d-Rust.ipynb",
            "MyIA.AI.Notebooks/Serie/Serie-03d.ipynb")
        assert action["label"] == "Rust"
        nbci.apply_readme_row(action)
        line = (repo / "MyIA.AI.Notebooks/Serie/README.md").read_text(
            encoding="utf-8").splitlines()[0]
        assert "(+ [jumeau C#](Serie-03d-CSharp.ipynb) · [Rust](Serie-03d-Rust.ipynb))" in line


def test_mirror_label_version_and_titled_shapes():
    """po-2028 folders: `[Version C#]` -> `Version Rust`; Complexity-style
    `[X C#]` -> `X Rust`."""
    assert nbci.mirror_label("Version C#", "Rust", False) == "Version Rust"
    assert nbci.mirror_label("Complexity-06 C#", "Rust", False) == "Complexity-06 Rust"
    assert nbci.mirror_label("jumeau C#", "C#", False) == "jumeau C#"
    assert nbci.mirror_label("Python", "Rust", False) == "Rust"
    assert nbci.mirror_label("whatever", "Rust", False) == "jumeau Rust"
    assert nbci.mirror_label("jumeau C#", "Rust", True) == "Rust"  # (+ ...) group


def test_readme_row_idempotent_when_name_present():
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        repo = Path(td)
        _readme(repo / "MyIA.AI.Notebooks/Serie/README.md",
                "| 07 | [C#](a-CSharp.ipynb) · [Rust](Serie-07-Rust.ipynb) |\n")
        action = nbci.plan_readme_row(
            repo, "MyIA.AI.Notebooks/Serie/Serie-07-Rust.ipynb",
            "MyIA.AI.Notebooks/Serie/Serie-07-Python.ipynb")
        assert not action["todo"]


def test_readme_row_no_twin_line_reported_not_forced():
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        repo = Path(td)
        _readme(repo / "MyIA.AI.Notebooks/Serie/README.md",
                "| 01 | unrelated |\n")
        action = nbci.plan_readme_row(
            repo, "MyIA.AI.Notebooks/Serie/Serie-07-Rust.ipynb",
            "MyIA.AI.Notebooks/Serie/Serie-07-Python.ipynb")
        assert not action["todo"] and "no README line" in action["why"]


# ---------------------------------------------------------------- nav shapes

def test_nav_bar_extended_with_mirrored_twin_label():
    """ChoixSocial shape (lot 1, #27804): `| [twin C#](…)` -> `| [twin Rust](…)`
    appended at the end of the bar."""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        twin = _nb(Path(td) / "Serie-02-Python.ipynb",
                   [_md(NAV_BAR.replace("Serie-07", "Serie-02")
                        .replace("Sudoku", "ChoixSocial")),
                    _code("x = 1\n")])
        action = nbci.plan_nav_link(twin, "Serie-02-Rust.ipynb")
        assert action["todo"] and action["how"] == "extended-nav-bar"
        assert action["label"] == "twin Rust"
        nbci.apply_nav_link(action)
        nb = json.loads(twin.read_text(encoding="utf-8"))
        assert nb["cells"][0]["source"][0].endswith(
            " | [twin C#](Serie-02-Norvig-CSharp.ipynb) | [twin Rust](Serie-02-Rust.ipynb)\n")


def test_nav_bar_duplicated_in_two_cells_both_extended():
    """The bar duplicated at the end of the notebook (cells 0 and 27 on
    #27804): every copy is extended."""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        bar = NAV_BAR.replace("Serie-07", "Serie-02").replace("Sudoku", "ChoixSocial")
        twin = _nb(Path(td) / "Serie-02-Python.ipynb", [_md(bar), _code("x=1\n"), _md(bar)])
        action = nbci.plan_nav_link(twin, "Serie-02-Rust.ipynb")
        assert action["cells"] == [0, 2]
        nbci.apply_nav_link(action)
        nb = json.loads(twin.read_text(encoding="utf-8"))
        for i in (0, 2):
            assert nb["cells"][i]["source"][0].endswith(
                " | [twin Rust](Serie-02-Rust.ipynb)\n")


def test_nav_appended_under_navigation_cell():
    """Sudoku-07 shape (lot 1, #27805): no bar, but a `## Navigation` cell ->
    `**Jumeau Rust** : [stem](name)` appended at its end."""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        cell0 = ("## Navigation\n\n"
                 "| [Sudoku-05-PSO](Sudoku-05-PSO.ipynb) | [Sudoku-07](Sudoku-07.ipynb) |\n")
        twin = _nb(Path(td) / "Serie-07-Python.ipynb", [_md(cell0), _code("x=1\n")])
        action = nbci.plan_nav_link(twin, "Serie-07-Rust.ipynb")
        assert action["todo"] and action["how"] == "appended-under-navigation-cell"
        nbci.apply_nav_link(action)
        nb = json.loads(twin.read_text(encoding="utf-8"))
        text = "".join(nb["cells"][0]["source"])
        assert text.endswith("\n**Jumeau Rust** : [Serie-07-Rust](Serie-07-Rust.ipynb)\n")


def test_nav_minimal_bar_when_no_navigation():
    """Search-03d shape (lot 1, #27803): twin had no navigation at all -> a
    minimal `**Navigation** :` bar is prepended to the first markdown cell and
    REPORTED (the series may want the full prev|index|next bar)."""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        twin = _nb(Path(td) / "Serie-03d.ipynb",
                   [_md("# Titre\n\nIntro.\n"), _code("x=1\n")])
        action = nbci.plan_nav_link(twin, "Serie-03d-Rust.ipynb")
        assert action["todo"] and action["how"] == "added-minimal-nav-bar"
        assert action["note"]
        nbci.apply_nav_link(action)
        nb = json.loads(twin.read_text(encoding="utf-8"))
        assert "".join(nb["cells"][0]["source"]).startswith(
            "**Navigation** : [jumeau Rust](Serie-03d-Rust.ipynb)\n\n# Titre")


PONTS_CELL = (
    "## 5. Ponts avec le reste de la série\n\n"
    "| Direction | Lien | Relation |\n"
    "|-----------|------|----------|\n"
    "| ← Fondations | [Search-3 — Informed](../P1/Search-03-Informed.ipynb) | A\\\\*, heuristiques |\n"
    "| ↔ Search-03b | [Search-03b — PDB](Search-03b-PatternDatabases.ipynb) | Autre voie |\n"
    "| → Partie 4 | [Métaheuristiques](../P4/README.md) | abandon de l'optimalité |\n"
    "\n**Référence fondatrice** : Harvey & Ginsberg (1995).\n")


def test_nav_table_row_gets_a_new_row_not_an_extra_cell():
    """Search-03c shape (CoursIA#27829): the only nav-marked .ipynb line is a
    body row of a 3-column Markdown table. Widening it (` | [jumeau Rust](…)`)
    gave the row 5 cells under a 3-cell header; the edge must be a whole new
    row, after the table's last row, with the header's column count."""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        twin = _nb(Path(td) / "Search-03c-LDS.ipynb", [_md(PONTS_CELL), _code("x=1\n")])
        action = nbci.plan_nav_link(twin, "Search-03c-LDS-Rust.ipynb")
        assert action["todo"] and action["how"] == "added-nav-table-row"
        nbci.apply_nav_link(action)
        nb = json.loads(twin.read_text(encoding="utf-8"))
        lines = "".join(nb["cells"][0]["source"]).splitlines()
        new = "| → Jumeau Rust | [Search-03c-LDS-Rust](Search-03c-LDS-Rust.ipynb) | même carnet, porté en Rust |"
        assert lines[lines.index("| → Partie 4 | [Métaheuristiques](../P4/README.md) | abandon de l'optimalité |") + 1] == new
        # every original row untouched, and every table row keeps 3 cells
        for row in PONTS_CELL.splitlines():
            assert row in lines
        assert all(len(nbci._split_row(l)) == 3 for l in lines if l.startswith("|"))
        # the repo guard reads it as an edge, so a second run is a no-op
        assert not nbci.plan_nav_link(twin, "Search-03c-LDS-Rust.ipynb")["todo"]


def test_nav_table_row_at_cell_end_keeps_the_no_trailing_newline():
    """A table that closes the cell (no trailing newline) gets its row on a
    new line and the cell still ends without one."""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        cell = ("| Direction | Lien |\n|---|---|\n"
                "| ← Avant | [Serie-02](Serie-02.ipynb) |")
        twin = _nb(Path(td) / "Serie-03.ipynb", [_md(cell)])
        action = nbci.plan_nav_link(twin, "Serie-03-Rust.ipynb")
        nbci.apply_nav_link(action)
        text = "".join(json.loads(twin.read_text(encoding="utf-8"))["cells"][0]["source"])
        assert text == cell + "\n| → Jumeau Rust | [Serie-03-Rust](Serie-03-Rust.ipynb) |"


def test_lone_pipe_nav_bar_is_still_extended():
    """A pipe-delimited bar with no separator row is not a table: it keeps the
    lot-1 extend-the-bar shape."""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        bar = "| [<< Serie-06](Serie-06.ipynb) | [Serie-08 >>](Serie-08.ipynb) |\n"
        twin = _nb(Path(td) / "Serie-07-Python.ipynb", [_md(bar)])
        action = nbci.plan_nav_link(twin, "Serie-07-Rust.ipynb")
        assert action["how"] == "extended-nav-bar"


def test_nav_idempotent_when_edge_exists():
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        bar = NAV_BAR + " | [jumeau Rust](Serie-07-Rust.ipynb)\n"
        twin = _nb(Path(td) / "Serie-07-Python.ipynb", [_md(bar), _code("x=1\n")])
        action = nbci.plan_nav_link(twin, "Serie-07-Rust.ipynb")
        assert not action["todo"]


def test_nav_markdown_only_and_byte_faithful():
    """The twin edit never touches code cells, outputs or cell metadata, and
    preserves the repo's byte formatting (indent=1, list sources, no trailing
    newline) for every unchanged byte."""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "Serie-02-Python.ipynb"
        cells = [_md(NAV_BAR.replace("Serie-07", "Serie-02")),
                 _code("# terrain pondéré\nx = [1, 2]\n"),
                 _md("## Navigation\n\n| [a](a.ipynb) |\n")]
        _nb(path, cells)
        before_raw = path.read_bytes()
        action = nbci.plan_nav_link(path, "Serie-02-Rust.ipynb")
        nbci.apply_nav_link(action)
        after = json.loads(path.read_text(encoding="utf-8"))
        nbci.assert_markdown_only(json.loads(before_raw)["cells"],
                                  after["cells"], path.name)
        # code cell strictly untouched
        assert after["cells"][1] == json.loads(before_raw)["cells"][1]
        # byte-faithful format: same indent, no trailing newline
        raw = path.read_bytes().decode("utf-8")
        assert raw == json.dumps(after, ensure_ascii=False, indent=1)
        assert not raw.endswith("\n")


# ------------------------------------------------------------- hot cells

def _mdid(src: str, cid: str) -> dict:
    cell = _md(src)
    cell["id"] = cid
    return cell


HOT_BAR = ("# Serie-03 — Titre\n\n"
           "**Navigation** : [Index](README.md) | "
           "[Version C#](Serie-03-CSharp.ipynb) | "
           "[03c — Zoo](Serie-03c-Zoo-Navigation-Python.ipynb)\n\nIntro.\n")
PLUS_LOIN = ("## Pour aller plus loin\n\n"
             "- **Carnet suivant** : [Serie-04 — Suite](Serie-04-Python.ipynb) "
             "— la suite, en prose.\n"
             "- **Dans la même série** : [Serie-03c — Zoo]"
             "(Serie-03c-Zoo-Navigation-Python.ipynb) — prose.\n")


def test_hot_bar_skipped_edge_goes_to_non_hot_list():
    """CoursIA#27855: the only bar sits in a HOT cell (deposited translation)
    -> never edited; the edge becomes a sibling list item, with the `→`
    marker the guard reads, after the « Carnet suivant » item of the non-hot
    « Pour aller plus loin » cell, labelled from the twin's own
    `[Version C#]` link."""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        twin = _nb(Path(td) / "Serie-03-Python.ipynb",
                   [_mdid(HOT_BAR, "intro"), _code("x=1\n"),
                    _mdid(PLUS_LOIN, "plus-loin")])
        before = json.loads(twin.read_text(encoding="utf-8"))
        action = nbci.plan_nav_link(twin, "Serie-03-Rust.ipynb", {"intro"})
        assert action["todo"] and action["how"] == "added-nav-list-item"
        assert action["cells"] == [2] and action["hot_skipped"] == [0]
        assert action["label"] == "Version Rust"
        nbci.apply_nav_link(action)
        after = json.loads(twin.read_text(encoding="utf-8"))
        assert after["cells"][0] == before["cells"][0]      # hot cell untouched
        lines = "".join(after["cells"][2]["source"]).splitlines()
        assert lines[3] == ("- **Version Rust** → [Serie-03-Rust](Serie-03-Rust.ipynb)"
                            " — le même carnet, porté en Rust.")
        assert lines[4].startswith("- **Dans la même série**")
        # the guard sees the edge: a second plan is a no-op
        assert not nbci.plan_nav_link(twin, "Serie-03-Rust.ipynb", {"intro"})["todo"]


def test_link_url_word_navigation_is_not_a_bar_marker():
    """A prose line whose only « navigation » is inside a link TARGET
    (`…-Zoo-Navigation-Python.ipynb`) is not a nav bar (#27855 measured)."""
    cells = [_mdid("- **Dans la même série** : [Zoo]"
                   "(Serie-03c-Zoo-Navigation-Python.ipynb) — prose.\n", "a")]
    assert nbci._nav_bar_cells(cells) == {}
    cells = [_mdid("**Navigation** : [Index](README.md) | [a](a.ipynb)\n", "b")]
    assert nbci._nav_bar_cells(cells) == {0: 0}


def test_every_markdown_cell_hot_is_declared_not_edited():
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        twin = _nb(Path(td) / "Serie-03-Python.ipynb",
                   [_mdid(HOT_BAR, "intro"), _code("x=1\n")])
        raw = twin.read_bytes()
        action = nbci.plan_nav_link(twin, "Serie-03-Rust.ipynb", {"intro"})
        assert not action["todo"] and action["hot_skipped"] == [0]
        assert "deposited translation" in action["why"]
        assert not nbci.apply_nav_link(action)
        assert twin.read_bytes() == raw


CSV_HEADER = ("notebook,cell_id,cell_type,src_lang,src_hash,text_fr,text_en,"
              "text_es,text_ar,text_fa,text_zh,text_ru,text_pt,translate_policy\n")


def test_hot_cell_ids_reads_deposited_rows_of_this_notebook():
    """Hot = a row for THIS notebook with a non-empty text_<target lang>;
    a pivot-only row (text_fr alone) is not hot; another notebook's
    translated row is not ours; TARGET_LANGS is read from the repo."""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        repo = Path(td)
        nb_rel = "MyIA.AI.Notebooks/Serie/Serie-03-Python.ipynb"
        _readme(repo / "translations/serie/serie.csv", CSV_HEADER +
                f"{nb_rel},intro,markdown,fr,h1,Titre,Title,,,,,,,\n"
                f"{nb_rel},pivot,markdown,fr,h2,Seul,,,,,,,,\n"
                f"{nb_rel},ru-only,markdown,fr,h3,Texte,,,,,,Текст,,\n"
                "MyIA.AI.Notebooks/Autre/X.ipynb,other,markdown,fr,h4,A,B,,,,,,,\n")
        assert nbci.hot_cell_ids(repo, nb_rel) == {"intro", "ru-only"}
        _readme(repo / "scripts/translation/check_perimeter.py",
                'TARGET_LANGS = ["en"]\n')
        assert nbci.target_langs(repo) == ("en",)
        assert nbci.hot_cell_ids(repo, nb_rel) == {"intro"}
        assert nbci.hot_cell_ids(repo, "MyIA.AI.Notebooks/None.ipynb") == set()


def test_plan_only_wires_the_repo_hot_set():
    """integrate()/plan_only() read the hot set from the worktree's own
    translations CSVs -- the wiring #27855 lacked."""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        repo = Path(td)
        nb_rel = "MyIA.AI.Notebooks/Serie/Serie-03-Python.ipynb"
        _nb(repo / nb_rel, [_mdid(HOT_BAR, "intro"), _code("x=1\n"),
                            _mdid(PLUS_LOIN, "plus-loin")])
        _readme(repo / "translations/serie/serie.csv", CSV_HEADER +
                f"{nb_rel},intro,markdown,fr,h1,Titre,Title,,,,,,,\n")
        plan = nbci.plan_only(repo, "MyIA.AI.Notebooks/Serie/Serie-03-Rust.ipynb",
                              nb_rel)
        assert plan["nav"]["cells"] == [2] and plan["nav"]["hot_skipped"] == [0]


# ---------------------------------------------------------------- registry

def test_find_twin_pair_by_python_member():
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        d = Path(td) / "scripts" / "notebook_tools" / "twin_pairs.d"
        d.mkdir(parents=True)
        (d / "serie-07-norvig.yaml").write_text(
            "- name: \"Sudoku-07 Norvig\"\n"
            "  family: Sudoku\n"
            "  python: MyIA.AI.Notebooks/Sudoku/Serie-07-Norvig-Python.ipynb\n"
            "  csharp: MyIA.AI.Notebooks/Sudoku/Serie-07-Norvig-CSharp.ipynb\n"
            "  parity_level: semantic\n", encoding="utf-8")
        pair = nbci.find_twin_pair(Path(td),
                                   "MyIA.AI.Notebooks/Sudoku/Serie-07-Norvig-Python.ipynb")
        assert pair == "Sudoku-07 Norvig"
        assert nbci.find_twin_pair(Path(td), "MyIA.AI.Notebooks/Sudoku/other.ipynb") is None


def _parity_level_line(text: str) -> str:
    """Value of the entry's single `parity_level:` field -- a field, never a
    word of the entry's prose."""
    lines = [ln.strip() for ln in text.splitlines()
             if ln.strip().startswith("parity_level:")]
    assert len(lines) == 1, lines
    return lines[0].split(":", 1)[1].strip()


def test_register_pair_csharp_only_and_honest():
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        wt = Path(td)
        d = wt / "scripts" / "notebook_tools" / "twin_pairs.d"
        d.mkdir(parents=True)
        # Rust is not a schema member: registration refused (lot-1 measured)
        rust = nbci.register_pair(wt, "N/S-Python.ipynb", "N/S-Rust.ipynb", "lane")
        assert not rust["registered"]
        cs = nbci.register_pair(wt, "N/S-Python.ipynb", "N/S-CSharp.ipynb", "lane",
                                facts={"kernel": ".net-csharp",
                                       "executed_cells": 12, "verdict": "approve"})
        assert cs["registered"] and cs["pair"] == "S C#"
        text = (wt / cs["file"]).read_text(encoding="utf-8")
        assert _parity_level_line(text) == "semantic"
        assert "bridge_verdict" not in text  # no fabricated SOTA judgment
        assert "firsthand" not in text
        assert ".net-csharp" in text and "approve" in text
        # second registration is refused (idempotent)
        assert not nbci.register_pair(wt, "N/S-Python.ipynb", "N/S-CSharp.ipynb",
                                      "lane")["registered"]
        assert "Execution reelle sur kernel .net-csharp" in text


def test_register_pair_is_semantic_never_native_both():
    """CoursIA#28196 (25/11), after Integrales-01 (23/11): Hermes contested the
    generator's `parity_level: native-both` on two deliveries, a review round
    each. The registry schema reserves that level for a pair whose EACH side
    does the notebook's work through a NAMED external engine ("un cote qui
    reimplemente le sujet du notebook a la main n'est PAS natif"); a
    hand-written C# port is `semantic`. The record says why, and spells
    neither identifier: a registry-wide grep for a level or for a verdict
    must only ever hit a field."""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        wt = Path(td)
        (wt / "scripts" / "notebook_tools" / "twin_pairs.d").mkdir(parents=True)
        cs = nbci.register_pair(wt, "N/S-Python.ipynb", "N/S-CSharp.ipynb", "lane",
                                facts={"kernel": ".net-csharp",
                                       "executed_cells": 12, "verdict": "approve"})
        text = (wt / cs["file"]).read_text(encoding="utf-8")
        assert _parity_level_line(text) == "semantic"
        assert "native-both" not in text and "bridge_verdict" not in text
        assert "Parite semantic" in text and "laisse a la review" in text
        assert text.isascii()


def test_register_pair_never_upgrades_a_read_kernel_to_an_execution():
    """#28332: with no recorded execution the registry names the kernel that was
    READ, and does not print the measured wording. ASCII, as the schema expects."""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        wt = Path(td)
        (wt / "scripts" / "notebook_tools" / "twin_pairs.d").mkdir(parents=True)
        cs = nbci.register_pair(wt, "N/S-Python.ipynb", "N/S-CSharp.ipynb", "lane",
                                facts={"kernel": "rust", "kernel_read": True,
                                       "executed_cells": 0, "verdict": "approve"})
        assert cs["registered"]
        text = (wt / cs["file"]).read_text(encoding="utf-8")
        assert "Execution reelle" not in text
        assert "Kernel lu (execution non enregistree) rust" in text
        assert text.isascii()


# ---------------------------------------------------------------- sync-main

def _git_repo(td: Path) -> Path:
    def g(*args):
        subprocess.run(["git", "-C", str(td), *args], check=True,
                       capture_output=True, text=True, encoding="utf-8")
    g("init", "-q", "-b", "main")
    g("config", "user.name", "t")
    g("config", "user.email", "t@t.invalid")
    return td


def _commit_all(td: Path):
    subprocess.run(["git", "-C", str(td), "add", "-A"], check=True,
                   capture_output=True)
    subprocess.run(["git", "-C", str(td), "-c", "user.name=t",
                    "-c", "user.email=t@t.invalid", "commit", "-q", "-m", "c"],
                   check=True, capture_output=True)


def test_sync_main_resolves_owned_conflicts_from_main():
    """Two grains edit adjacent README lines: the second PR to merge conflicts.
    --sync-main takes origin/main's side of the OWNED files (README, twin,
    registry) and leaves the merge ready for the caller to re-integrate."""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        wt = _git_repo(Path(td))
        readme = wt / "MyIA.AI.Notebooks" / "Serie" / "README.md"
        readme.parent.mkdir(parents=True)
        base = "| 01 | A — [C#](A-CSharp.ipynb) · [Python](A-Python.ipynb) |\n" \
               "| 02 | B — [C#](B-CSharp.ipynb) · [Python](B-Python.ipynb) |\n"
        readme.write_text(base, encoding="utf-8")
        _commit_all(wt)
        # origin/main moves ahead: another grain's Rust row landed on line 02
        readme.write_text(base.replace(
            "[Python](B-Python.ipynb) |",
            "[Python](B-Python.ipynb) · [Rust](B-Rust.ipynb) |"), encoding="utf-8")
        _commit_all(wt)
        subprocess.run(["git", "-C", str(wt), "update-ref",
                        "refs/remotes/origin/main", "main"], check=True,
                       capture_output=True)
        # our branch started BEFORE that merge and edited the same region
        subprocess.run(["git", "-C", str(wt), "checkout", "-q", "-b", "pr",
                        "HEAD~1"], check=True, capture_output=True)
        readme.write_text(base.replace(
            "[Python](A-Python.ipynb) |",
            "[Python](A-Python.ipynb) · [Rust](A-Rust.ipynb) |"), encoding="utf-8")
        _commit_all(wt)
        owned = ["MyIA.AI.Notebooks/Serie/README.md"]
        result = nbci.merge_owned_conflicts(wt, owned)
        assert result["merged"] and result.get("resolved_theirs") == owned
        # origin/main's line won; ours is gone until the (idempotent) re-run
        text = readme.read_text(encoding="utf-8")
        assert "[Rust](B-Rust.ipynb)" in text and "[Rust](A-Rust.ipynb)" not in text


def test_sync_main_aborts_on_foreign_conflict():
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        wt = _git_repo(Path(td))
        f = wt / "code.py"
        f.write_text("base\n", encoding="utf-8")
        _commit_all(wt)
        f.write_text("main side\n", encoding="utf-8")
        _commit_all(wt)
        subprocess.run(["git", "-C", str(wt), "update-ref",
                        "refs/remotes/origin/main", "main"], check=True,
                       capture_output=True)
        subprocess.run(["git", "-C", str(wt), "checkout", "-q", "-b", "pr",
                        "HEAD~1"], check=True, capture_output=True)
        f.write_text("pr side\n", encoding="utf-8")
        _commit_all(wt)
        result = nbci.merge_owned_conflicts(wt, ["MyIA.AI.Notebooks/Serie/README.md"])
        assert not result["merged"] and result["aborted"]
        assert result["conflicts"] == ["code.py"]
        # abort left no merge in progress and our side intact
        p = subprocess.run(["git", "-C", str(wt), "rev-parse", "-q",
                            "--verify", "MERGE_HEAD"],
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
        assert p.returncode != 0
        assert f.read_text(encoding="utf-8") == "pr side\n"


def test_sync_main_clean_merge():
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        wt = _git_repo(Path(td))
        (wt / "a.txt").write_text("base\n", encoding="utf-8")
        _commit_all(wt)
        (wt / "b.txt").write_text("main\n", encoding="utf-8")
        _commit_all(wt)
        subprocess.run(["git", "-C", str(wt), "update-ref",
                        "refs/remotes/origin/main", "main"], check=True,
                       capture_output=True)
        subprocess.run(["git", "-C", str(wt), "checkout", "-q", "-b", "pr",
                        "HEAD~1"], check=True, capture_output=True)
        (wt / "a.txt").write_text("pr\n", encoding="utf-8")
        _commit_all(wt)
        result = nbci.merge_owned_conflicts(wt, ["MyIA.AI.Notebooks/Serie/README.md"])
        assert result["merged"] and not result.get("resolved_theirs")
        assert (wt / "a.txt").read_text(encoding="utf-8") == "pr\n"
        assert (wt / "b.txt").read_text(encoding="utf-8") == "main\n"


# ---------------------------------------------------------------- integrate

def test_integrate_idempotent_second_run_writes_nothing():
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        repo = Path(td)
        _readme(repo / "MyIA.AI.Notebooks/Serie/README.md",
                "| 02 | [Titre](Serie-02-Python.ipynb) · "
                "[jumeau C#](Serie-02-CSharp.ipynb) | desc |\n")
        _nb(repo / "MyIA.AI.Notebooks/Serie/Serie-02-Python.ipynb",
            [_md(NAV_BAR.replace("Serie-07", "Serie-02")), _code("x=1\n")])
        first = nbci.integrate(repo, "MyIA.AI.Notebooks/Serie/Serie-02-Rust.ipynb",
                               "MyIA.AI.Notebooks/Serie/Serie-02-Python.ipynb")
        assert first["touched"] == ["MyIA.AI.Notebooks/Serie/Serie-02-Python.ipynb",
                                    "MyIA.AI.Notebooks/Serie/README.md"]
        snapshot = {p: p.read_bytes() for p in repo.rglob("*") if p.is_file()}
        second = nbci.integrate(repo, "MyIA.AI.Notebooks/Serie/Serie-02-Rust.ipynb",
                                "MyIA.AI.Notebooks/Serie/Serie-02-Python.ipynb")
        assert second["touched"] == []
        assert {p: p.read_bytes() for p in repo.rglob("*") if p.is_file()} == snapshot


# ------------------------------------------------------------- back link

ARG_BAR = ("[← Dung_AF_Semantics](Argumentation-03-Dung-AF-Semantics-Python.ipynb) | "
           "[↑ ArgumentAnalysis](README.md) | "
           "[Ranking_Semantics →](Argumentation-03c-Ranking-Semantics-Python.ipynb)\n")
SERIE = "MyIA.AI.Notebooks/Serie"


def _pair(repo: Path, rust_cell0: str, python_cell0: str = ARG_BAR,
          stem: str = "Serie-03b") -> tuple[str, str]:
    """A source twin and the port the driver built from it (cell 0 copied)."""
    src = f"{SERIE}/{stem}-Python.ipynb"
    new = f"{SERIE}/{stem}-Rust.ipynb"
    _nb(repo / src, [_md(python_cell0), _code("x = 1\n")])
    _nb(repo / new, [_md(rust_cell0), _code("let x = 1;\n")])
    return new, src


def test_back_link_extends_the_copied_bar_with_the_python_twin():
    """CoursIA#27905 (22/11): the Rust port copied the twin's bar
    `← | ↑ | →`, which cannot name the twin itself; the coordinator's review
    asked for the link back. The integration extends the port's bar, writes
    markdown only, reports the notebook as touched, and is idempotent."""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        repo = Path(td)
        new, src = _pair(repo, ARG_BAR)
        before = json.loads((repo / new).read_text(encoding="utf-8"))
        first = nbci.integrate(repo, new, src)
        assert first["back"]["todo"] and first["back"]["how"] == "extended-nav-bar"
        assert new in first["touched"]
        after = json.loads((repo / new).read_text(encoding="utf-8"))
        assert after["cells"][0]["source"][0] == (
            ARG_BAR.rstrip("\n") + " | [jumeau Python](Serie-03b-Python.ipynb)\n")
        assert after["cells"][1] == before["cells"][1]       # code cell untouched
        assert "lien retour" in nbci.integration_commit_message(first, "l:w")
        second = nbci.integrate(repo, new, src)
        assert not second["back"]["todo"] and new not in second["touched"]


def test_back_link_on_a_crlf_port_keeps_its_line_endings():
    """CoursIA#28003/#28004/#28018 (22/11): the driver writes the built port
    with Path.write_text, CRLF on Windows. The round-trip check compared it
    with an LF re-dump, failed at byte 1, and the PR shipped without the back
    link, the README row nor the nav edge. A CRLF port now round-trips, gets
    its back link, and stays CRLF (git's eol=lf normalises it at add)."""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        repo = Path(td)
        new, src = _pair(repo, ARG_BAR)
        lf = (repo / new).read_bytes()
        assert b"\r\n" not in lf
        (repo / new).write_bytes(lf.replace(b"\n", b"\r\n"))
        raw = (repo / new).read_bytes().decode("utf-8")
        fmt = nbci.detect_nb_format(raw)
        assert fmt["newline"] == "\r\n"
        assert nbci.dump_nb(json.loads(raw), fmt) == raw
        first = nbci.integrate(repo, new, src)
        assert first["back"]["todo"] and new in first["touched"]
        after = (repo / new).read_bytes()
        assert b"Serie-03b-Python.ipynb" in after
        assert after.count(b"\n") == after.count(b"\r\n")   # no bare LF left
        assert (repo / src).read_bytes().count(b"\r\n") == 0  # LF twin stays LF


def test_a_whitespace_only_reformat_is_normalised_and_declared():
    """CoursIA#28242 (23/11): the built port carried ONE model-emitted
    ``"outputs": [`` + ``]`` where the dumper writes ``[]``; the round-trip
    refused, the README row and the nav edges were never applied, and the
    PR's guards went red. A difference that is ONLY insignificant whitespace
    keeps the data byte-exact, so it is normalised and reported instead."""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        repo = Path(td)
        new, src = _pair(repo, ARG_BAR)
        raw = (repo / new).read_bytes().decode("utf-8")
        expanded = raw.replace('   "outputs": [],',
                               '   "outputs": [\n   ],', 1)
        assert expanded != raw                       # the fixture really carries it
        (repo / new).write_bytes(expanded.encode("utf-8"))
        first = nbci.integrate(repo, new, src)
        assert first["back"]["todo"] and new in first["touched"]
        assert first["back"].get("normalized") is True
        after = (repo / new).read_bytes().decode("utf-8")
        assert '"outputs": [\n   ]' not in after     # canonical shape restored
        assert "Serie-03b-Python.ipynb" in after     # the link did land
        second = nbci.integrate(repo, new, src)
        assert not second["back"].get("normalized")  # byte-exact now, nothing to say


def test_a_non_whitespace_serialisation_difference_still_refuses():
    """The tolerance above is whitespace ONLY. The dumper cannot reproduce an
    escaped solidus (`\\/` parses to `/`, which json re-emits bare), and that
    is a real serialisation choice -- not ours to silently rewrite. The loud
    refusal stays for everything the whitespace test does not explain."""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        repo = Path(td)
        new, src = _pair(repo, ARG_BAR)
        raw = (repo / new).read_bytes().decode("utf-8")
        escaped = raw.replace("let x = 1;", "let x = 1; \\/\\/ c", 1)
        assert escaped != raw
        (repo / new).write_bytes(escaped.encode("utf-8"))
        try:
            nbci.integrate(repo, new, src)
        except ValueError as exc:
            assert "byte-faithful round-trip failed" in str(exc)
        else:                                        # pragma: no cover
            raise AssertionError("a non-whitespace difference must keep the refusal")


def test_back_link_mirrors_the_bar_twin_label():
    """po-2028 folders: the copied bar carries `[Version C#](…)` -> the link
    back reads `Version Python`, the folder's word."""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        repo = Path(td)
        bar = ("**Navigation** : [<< Prev](Serie-02-Python.ipynb) | "
               "[Version C#](Serie-03b-CSharp.ipynb)\n")
        new, src = _pair(repo, bar, bar)
        plan = nbci.plan_back_link(repo, new, src)
        assert plan["todo"] and plan["label"] == "Version Python"


def test_back_link_to_an_unsuffixed_original_names_python():
    """ANALYSE shape: the original carries no suffix (`ANALYSE-08-X.ipynb`);
    a port that already names it `[ANALYSE-08 (Python)](…)` in its
    `| Index | … |` row is left alone, one without gets `jumeau Python`."""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        repo = Path(td)
        src = f"{SERIE}/ANALYSE-08-X.ipynb"
        new = f"{SERIE}/ANALYSE-08-X-Rust.ipynb"
        _nb(repo / src, [_md("# Titre\n"), _code("x = 1\n")])
        _nb(repo / new, [_md("| Index | [ANALYSE-08 (Python)](ANALYSE-08-X.ipynb) |\n"),
                         _code("let x = 1;\n")])
        plan = nbci.plan_back_link(repo, new, src)
        assert not plan["todo"] and "by its language" in plan["why"]
        _nb(repo / new, [_md("**Navigation** : [<< Prev](ANALYSE-07.ipynb)\n"),
                         _code("let x = 1;\n")])
        plan = nbci.plan_back_link(repo, new, src)
        assert plan["todo"] and plan["label"] == "jumeau Python"


def test_back_link_list_item_says_origin_not_port():
    """A prose list host gets `— le carnet d'origine, en Python.`: the source
    twin is the original, not a port."""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        repo = Path(td)
        cell = "## Pour aller plus loin\n\n- [Suite](Serie-04-Python.ipynb) — la suite.\n"
        new, src = _pair(repo, cell, cell)
        nbci.apply_nav_link(nbci.plan_back_link(repo, new, src))
        text = "".join(json.loads((repo / new).read_text(encoding="utf-8"))
                       ["cells"][0]["source"])
        assert "[Serie-03b-Python](Serie-03b-Python.ipynb) — le carnet d'origine, en Python." in text
        assert "porté en" not in text


def test_a_prose_paragraph_with_an_arrow_is_not_a_bar():
    """CoursIA#27905 cell 18 (22/11): « **Agrégation d'audiences → choix
    social** : … [Tweety-9](…) … » holds an arrow and a notebook link; the
    inbound edge glued ` | [jumeau Rust](…)` onto its last sentence. Only the
    real bar of cell 0 is extended, in both directions."""
    import tempfile
    prose = ("**Agrégation d'audiences → choix social** : si chaque individu a sa "
             "propre audience, comment décider ? C'est le pont vers "
             "[Tweety-9 (préférences)](../Tweety/Tweety-09-Preferences-Python.ipynb).\n")
    with tempfile.TemporaryDirectory() as td:
        repo = Path(td)
        src = f"{SERIE}/Serie-03b-Python.ipynb"
        new = f"{SERIE}/Serie-03b-Rust.ipynb"
        for rel in (src, new):
            _nb(repo / rel, [_md(ARG_BAR), _code("x = 1\n"), _md(prose)])
        inbound = nbci.plan_nav_link(repo / src, new)
        back = nbci.plan_back_link(repo, new, src)
        assert inbound["cells"] == [0] and back["cells"] == [0]
        nbci.apply_nav_link(inbound)
        nbci.apply_nav_link(back)
        for rel in (src, new):
            cells = json.loads((repo / rel).read_text(encoding="utf-8"))["cells"]
            assert "".join(cells[2]["source"]) == prose


def test_a_long_headed_nav_line_gets_a_sibling_line_not_a_tail():
    """Repo measure (22/11): the word bound alone dropped GameTheory-09c's
    « **Navigation** : [..] — engagement crédible · [..] » bar. A long line
    that opens on a nav label stays a bar; its twin goes on a sibling
    paragraph (same blockquote), never glued onto its last sentence."""
    import tempfile
    head = ("> **Carnet suivant** : [Serie-04-Python](Serie-04-Python.ipynb) — "
            "la même construction, appliquée cette fois aux préférences partielles.")
    with tempfile.TemporaryDirectory() as td:
        repo = Path(td)
        src = f"{SERIE}/Serie-03b-Python.ipynb"
        new = f"{SERIE}/Serie-03b-Rust.ipynb"
        _nb(repo / src, [_md("# T\n"), _md(head)])
        plan = nbci.plan_nav_link(repo / src, new)
        assert plan["how"] == "added-nav-sibling-line" and plan["cells"] == [1]
        nbci.apply_nav_link(plan)
        text = "".join(json.loads((repo / src).read_text(encoding="utf-8"))["cells"][1]["source"])
        assert text.startswith(head + "\n>\n> **")
        assert "→ [Serie-03b-Rust](Serie-03b-Rust.ipynb) — le même carnet, porté en Rust." in text
        assert not nbci.plan_nav_link(repo / src, new)["todo"]   # idempotent
    assert not nbci._is_prose_line("**Navigation** : [Version C#](a.ipynb) | "
                                   "[b](b.ipynb) — engagement crédible · [c](c.ipynb) — "
                                   "sécurité, patrouilles et défense en profondeur")
    assert nbci._is_prose_line("> **Acquis et parenté** : expérience B — suppose A, la "
                               "convention donnée de [x](x.ipynb) → dont le répertoire")


def test_back_link_skipped_when_the_twin_lives_elsewhere():
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        repo = Path(td)
        _nb(repo / "A/X-Python.ipynb", [_md("# T\n")])
        _nb(repo / "B/X-Rust.ipynb", [_md(ARG_BAR)])
        plan = nbci.plan_back_link(repo, "B/X-Rust.ipynb", "A/X-Python.ipynb")
        assert not plan["todo"] and "another folder" in plan["why"]
        assert not nbci.plan_back_link(repo, "B/Y-Rust.ipynb", "B/Y-Python.ipynb")["todo"]
        # a source name that does not resolve gets no (dead) link
        plan = nbci.plan_back_link(repo, "B/X-Rust.ipynb", "B/X-Python.ipynb")
        assert not plan["todo"] and "dead" in plan["why"]


# ------------------------------------------------------------- format detection

BS = chr(92)   # a literal backslash, spelled out: no escape-sequence ambiguity
LATEX_UP = BS + "uparrow"            # the LaTeX command, one backslash
JSON_UP = BS + BS + "uparrow"        # how json.dumps stores it


def test_latex_backslash_u_is_not_an_ascii_escape():
    """CoursIA#27900 (22/11): a LaTeX up-arrow in a markdown cell is an escaped
    backslash + 'uparrow' in the JSON text. The old substring test read it as
    an ensure_ascii file, the round-trip check refused, and the port PR
    shipped with no README row and no nav edge."""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "Serie-02-Python.ipynb"
        cells = [_md(NAV_BAR.replace("Serie-07", "Serie-02")),
                 _md("Croissance $f(n) " + LATEX_UP + "$ très rapide.\n"),
                 _code("x = 1\n"),
                 _md("## Navigation\n\n| [a](a.ipynb) |\n")]
        _nb(path, cells)
        raw = path.read_bytes().decode("utf-8")
        assert BS + "u" in raw and JSON_UP in raw   # the trap itself
        assert nbci.detect_nb_format(raw)["ensure_ascii"] is False
        action = nbci.plan_nav_link(path, "Serie-02-Rust.ipynb")
        nbci.apply_nav_link(action)                 # raised before the fix
        after = path.read_bytes().decode("utf-8")
        assert "Serie-02-Rust.ipynb" in after
        assert "très" in after and JSON_UP in after


def test_apply_nb_accepts_a_whitespace_only_difference(tmp_path):
    """CoursIA#28242 (23/11, fournée o15): a model-emitted ``"outputs": [\\n   ]``
    where the dumper writes ``[]`` carries the SAME parsed object, yet the old
    round-trip guard refused it — and the refusal cost the README row and the nav
    edge, i.e. the guards the integration exists to satisfy. A difference that
    survives whitespace stripping is real and keeps the refusal."""
    nb = {"cells": [_md("t\n"), _code("print(1)\n")], "metadata": {},
          "nbformat": 4, "nbformat_minor": 5}
    canonical = json.dumps(nb, ensure_ascii=False, indent=1)
    fmt = nbci.detect_nb_format(canonical)
    assert nbci.dump_nb(json.loads(canonical), fmt) == canonical

    loose = canonical.replace('"outputs": []', '"outputs": [\n   ]', 1)
    assert loose != canonical
    path = tmp_path / "T.ipynb"
    path.write_text(loose, encoding="utf-8")
    assert nbci.apply_nb(path, nb, fmt, loose) is True       # normalised, declared
    assert path.read_text(encoding="utf-8") == nbci.dump_nb(nb, fmt)

    # a divergence that survives whitespace stripping: a duplicated key is
    # canonicalised away by the dump, so the text is NOT the same object.
    dup = canonical.replace('"metadata": {}', '"metadata": {"a": 1, "a": 2}', 1)
    assert dup != canonical
    path.write_text(dup, encoding="utf-8")
    try:
        nbci.apply_nb(path, nb, fmt, dup)
    except ValueError:
        pass
    else:
        raise AssertionError("a divergence that survives stripping must still refuse")


def test_format_detection_round_trips_both_encodings():
    """Raw non-ASCII + control-char escapes (ANSI colours in outputs) is
    ensure_ascii=False; a pure-ASCII file with real backslash-u escapes is
    True. Both must reproduce their own bytes, which is what apply_nb checks."""
    code = _code("print('x')\n")
    code["outputs"] = [{"output_type": "stream", "name": "stdout",
                        "text": [chr(27) + "[31mrouge" + chr(27) + "[0m é\n"]}]
    nb = {"cells": [_md("Été $" + LATEX_UP + "$\n"), code], "metadata": {},
          "nbformat": 4, "nbformat_minor": 5}
    for ensure_ascii in (False, True):
        raw = json.dumps(nb, ensure_ascii=ensure_ascii, indent=1)
        fmt = nbci.detect_nb_format(raw)
        assert fmt["ensure_ascii"] is ensure_ascii
        assert nbci.dump_nb(json.loads(raw), fmt) == raw


# ------------------------------------------------------------- sync-main commit

README_REL = "MyIA.AI.Notebooks/Serie/README.md"


def _fake_integration(monkeypatch, wt: Path, write: bool = True):
    def fake_integrate(worktree, notebook, source_nb):
        touched = []
        if write:
            p = Path(worktree) / README_REL
            p.write_text(p.read_text(encoding="utf-8") + "| X-Rust |\n",
                         encoding="utf-8", newline="")
            touched = [README_REL]
        return {"notebook": "MyIA.AI.Notebooks/Serie/X-Rust.ipynb",
                "source_nb": "MyIA.AI.Notebooks/Serie/X-Python.ipynb",
                "readme": {"todo": write, "file": README_REL}, "touched": touched}
    monkeypatch.setattr(nbci, "integrate", fake_integrate)
    monkeypatch.setattr(nbci, "owned_files", lambda *a: [README_REL])
    monkeypatch.setattr(nbci, "replay_guards", lambda *a, **k: [])
    seen = {}

    def fake_reseal(worktree, *a, **k):
        seen["head_readme"] = subprocess.run(
            ["git", "-C", str(worktree), "show", f"HEAD:{README_REL}"],
            capture_output=True, text=True, encoding="utf-8").stdout
        return {"reseal": {"skipped": "fake"}}
    monkeypatch.setattr(nbci, "_reseal_after", fake_reseal)
    return seen


def _pr_branch_behind_main(td: Path, conflict: bool) -> Path:
    wt = _git_repo(td)
    (wt / README_REL).parent.mkdir(parents=True)
    (wt / README_REL).write_text("| base |\n", encoding="utf-8", newline="")
    _commit_all(wt)
    if conflict:
        (wt / README_REL).write_text("| base |\n| main row |\n", encoding="utf-8", newline="")
    else:
        (wt / "other.txt").write_text("main\n", encoding="utf-8")
    _commit_all(wt)
    subprocess.run(["git", "-C", str(wt), "update-ref", "refs/remotes/origin/main", "main"],
                   check=True, capture_output=True)
    subprocess.run(["git", "-C", str(wt), "checkout", "-q", "-b", "pr", "HEAD~1"],
                   check=True, capture_output=True)
    if conflict:
        (wt / README_REL).write_text("| base |\n| pr row |\n", encoding="utf-8", newline="")
    else:
        (wt / "nb.txt").write_text("pr\n", encoding="utf-8")
    _commit_all(wt)
    return wt


def _status(wt: Path) -> str:
    return subprocess.run(["git", "-C", str(wt), "status", "--porcelain"],
                          capture_output=True, text=True, encoding="utf-8", errors="replace").stdout


def _head_subject(wt: Path) -> str:
    return subprocess.run(["git", "-C", str(wt), "log", "-1", "--format=%s"],
                          capture_output=True, text=True, encoding="utf-8").stdout.strip()


def test_sync_main_clean_merge_commits_the_integration(tmp_path, monkeypatch):
    """CoursIA#27900: on a CLEAN merge the old `commit --no-edit` failed (no
    message to reuse), the integration stayed staged and the reseal read a HEAD
    without it. The integration must be at HEAD before the reseal runs."""
    wt = _pr_branch_behind_main(tmp_path, conflict=False)
    seen = _fake_integration(monkeypatch, wt)
    out = nbci.sync_main(wt, "MyIA.AI.Notebooks/Serie/X-Rust.ipynb",
                         "MyIA.AI.Notebooks/Serie/X-Python.ipynb", "lane:x")
    assert out["merge"]["merged"] and not out.get("commit_error")
    assert _status(wt) == ""
    assert _head_subject(wt).startswith("Chore(integration): ligne README pour X-Rust")
    assert "| X-Rust |" in seen["head_readme"]          # reseal saw it at HEAD
    assert (wt / "other.txt").exists()                  # main's change folded in


def test_sync_main_conflict_merge_concludes_with_the_integration(tmp_path, monkeypatch):
    wt = _pr_branch_behind_main(tmp_path, conflict=True)
    seen = _fake_integration(monkeypatch, wt)
    out = nbci.sync_main(wt, "MyIA.AI.Notebooks/Serie/X-Rust.ipynb",
                         "MyIA.AI.Notebooks/Serie/X-Python.ipynb", "lane:x")
    assert out["merge"].get("resolved_theirs") == [README_REL]
    assert _status(wt) == ""
    parents = subprocess.run(["git", "-C", str(wt), "log", "-1", "--format=%P"],
                             capture_output=True, text=True, encoding="utf-8", errors="replace").stdout.split()
    assert len(parents) == 2                            # the merge commit itself
    assert "| main row |" in seen["head_readme"] and "| X-Rust |" in seen["head_readme"]


def test_sync_main_up_to_date_nothing_to_write_commits_nothing(tmp_path, monkeypatch):
    wt = _pr_branch_behind_main(tmp_path, conflict=False)
    subprocess.run(["git", "-C", str(wt), "merge", "-q", "--no-edit", "origin/main"],
                   check=True, capture_output=True)
    before = _head_subject(wt)
    _fake_integration(monkeypatch, wt, write=False)
    out = nbci.sync_main(wt, "MyIA.AI.Notebooks/Serie/X-Rust.ipynb",
                         "MyIA.AI.Notebooks/Serie/X-Python.ipynb", "lane:x")
    assert out["merge"]["already_up_to_date"] and not out.get("commit_error")
    assert _head_subject(wt) == before and _status(wt) == ""


# ------------------------------------------- one attestation per PR (#27855)

_FAKE_TWIN_TOOL = '''import sys, pathlib
a = sys.argv[1:]
if "--check" in a:
    sys.exit(1)
by = a[a.index("--by") + 1]
d = pathlib.Path("scripts/notebook_tools/twin_pairs.d/demo-pair")
n = max(int(p.name[:4]) for p in d.glob("*.yaml")) + 1
lines = ["date: '2026-11-22'", "by: " + by, "python_sha: head", ""]
(d / f"{n:04d}-2026-11-22-{by.replace(':', '-')}.yaml").write_text(
    chr(10).join(lines), encoding="utf-8")
'''


def _attest(wt: Path, name: str, by: str):
    p = wt / "scripts/notebook_tools/twin_pairs.d/demo-pair" / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(f"date: '2026-11-21'\nby: {by}\npython_sha: x\n", encoding="utf-8")


def _branch_with_attestations(td: Path) -> Path:
    wt = _git_repo(td)
    tool = wt / "scripts/notebook_tools/check_twin_parity.py"
    tool.parent.mkdir(parents=True)
    tool.write_text(_FAKE_TWIN_TOOL, encoding="utf-8")
    _attest(wt, "0001-2026-11-12-codex-cloud-marathon2.yaml", "codex-cloud:marathon2")
    _commit_all(wt)
    subprocess.run(["git", "-C", str(wt), "update-ref", "refs/remotes/origin/main", "main"],
                   check=True, capture_output=True)
    subprocess.run(["git", "-C", str(wt), "checkout", "-q", "-b", "pr"],
                   check=True, capture_output=True)
    _attest(wt, "0002-2026-11-21-myia-ai-01-vllm.yaml", "myia-ai-01:vllm")   # 1st reseal
    _attest(wt, "0003-2026-11-21-myia-po-2028-claudish.yaml", "'myia-po-2028:claudish'")
    _commit_all(wt)
    return wt


def test_reseal_drops_the_branch_own_earlier_attestation(tmp_path):
    """CoursIA#27855: two integrations on one branch left 0005 (intermediate
    python_sha) and 0006 (head, colliding with #27311). After the second reseal
    only the attestation just written may remain among the lane's own
    branch-added ones; main's and another lane's are untouched."""
    wt = _branch_with_attestations(tmp_path)
    res = nbci.reseal_pair(wt, "Demo Pair", "myia-ai-01:vllm")
    d = "scripts/notebook_tools/twin_pairs.d/demo-pair/"
    assert res["ok"], res
    assert res["superseded"] == [d + "0002-2026-11-21-myia-ai-01-vllm.yaml"]
    names = sorted(p.name for p in (wt / d).glob("*.yaml"))
    assert names == ["0001-2026-11-12-codex-cloud-marathon2.yaml",
                     "0003-2026-11-21-myia-po-2028-claudish.yaml",
                     "0004-2026-11-22-myia-ai-01-vllm.yaml"]
    st = _status(wt)
    assert f"D  {d}0002-2026-11-21-myia-ai-01-vllm.yaml" in st   # staged for the commit


def test_reseal_keeps_everything_without_an_integration_ref(tmp_path):
    """No origin/main to diff against: nothing is judged superseded."""
    wt = _branch_with_attestations(tmp_path)
    subprocess.run(["git", "-C", str(wt), "update-ref", "-d", "refs/remotes/origin/main"],
                   check=True, capture_output=True)
    res = nbci.reseal_pair(wt, "Demo Pair", "myia-ai-01:vllm")
    assert res["ok"] and res["superseded"] == []
    assert len(list((wt / "scripts/notebook_tools/twin_pairs.d/demo-pair").glob("*.yaml"))) == 4


def test_attestation_by_reads_plain_and_quoted():
    assert nbci._attestation_by("date: x\nby: myia-ai-01:vllm\n") == "myia-ai-01:vllm"
    assert nbci._attestation_by("by: 'myia-po-2028:claudish'\n") == "myia-po-2028:claudish"
    assert nbci._attestation_by("date: x\n") is None
