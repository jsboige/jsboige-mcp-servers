# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_pr_body_integration.py
# Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
# jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree.
# -----------------------------------------------------------------------------
"""The stage-5 integration outcome must reach the PR body (22/11).

`integration_pr_lines` was called with the PR entry instead of its
`integration` field, so every port PR since 65fa98c665 (21/11) carried an
empty "Intégration dépôt" header -- including CoursIA#27900, whose integration
had FAILED: the failure the docstring promises to say was never said."""
import json
import subprocess
from types import SimpleNamespace

import pytest

import nb_coder_driver as d


def _sh(*cmd, cwd=None):
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=cwd)
    assert p.returncode == 0, (cmd, p.stderr)
    return p.stdout


def _run_stage5(tmp_path, monkeypatch, fake_integrate):
    origin = tmp_path / "origin.git"
    origin.mkdir()
    _sh("git", "init", "--bare", str(origin), cwd=origin)
    wt = tmp_path / "wt"
    wt.mkdir()
    _sh("git", "init", cwd=wt)
    _sh("git", "checkout", "-b", "main", cwd=wt)
    _sh("git", "remote", "add", "origin", str(origin), cwd=wt)
    (wt / "README.md").write_text("x", encoding="utf-8")
    _sh("git", "add", "README.md", cwd=wt)
    _sh("git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init", cwd=wt)
    (wt / "Series").mkdir()

    out_dir = tmp_path / "out"
    out_dir.mkdir()
    built_nb = out_dir / "built.ipynb"
    built_nb.write_text("{}", encoding="utf-8")

    args = SimpleNamespace(
        issue=27999, notebook="Series/N-Rust.ipynb", pr_branch="nbcoder/integ-27999",
        agent="producer", verifier_agent="critic", grain_tier="MED",
        lane="myia-ai-01:vllm", pr_base="main", pr_repo="jsboige/CoursIA",
        out_dir=str(out_dir))
    rec = {"plan": {"plan": []},
           "create_mode": {"source": "Series/N-Python.ipynb"},
           "verify": {"verdict": "approve", "model_used": "swift", "conversation_id": "v",
                      "findings": []},
           "kernel": {"kernel_name": "rust"}, "execution": [1], "c2": {"sequential": True},
           "calls": [], "conversation_id": "p",
           "gates": [{"gate": "kernel-metadata", "ok": True}]}

    fake = SimpleNamespace(
        integrate=fake_integrate,
        register_pair=lambda *a, **k: {"registered": False},
        find_twin_pair=lambda *a, **k: None,
        replay_guards=lambda *a, **k: [{"guard": "readme-notebook-coverage", "rc": 0}])
    monkeypatch.setattr(d, "_load_integrate_module", lambda: fake)
    monkeypatch.setattr(d, "lane_predecessor", lambda *a, **k: None)
    bodies = []

    def fake_gh(argv, token=None, timeout=60):
        if argv[1].endswith("/pulls"):
            path = next(a for a in argv if a.startswith("body=@"))[len("body=@"):]
            bodies.append(open(path, encoding="utf-8").read())
            return 0, json.dumps({"number": 1, "html_url": "u"})
        return 0, "{}"
    monkeypatch.setattr(d, "gh", fake_gh)

    d.stage5_pr(args, rec, wt, built_nb, {"issue": 27999}, None)
    assert rec["verdict"] == "pr-created", rec.get("pr")
    return bodies[0]


def test_pr_body_carries_the_integration_lines(tmp_path, monkeypatch):
    body = _run_stage5(tmp_path, monkeypatch, lambda wt, nb, src, **kw: {
        "touched": [], "nav": {"how": "list"}, "readme": {"label": "Rust"},
        "conformance": None, "pair": None})
    section = body.split("## Intégration dépôt", 1)[1]
    assert "Ligne README (`Rust`) et arête nav (`list`)" in section
    assert "Garde `readme-notebook-coverage` : exit 0 (OK)" in section


def test_pr_body_says_a_failed_integration(tmp_path, monkeypatch):
    def boom(wt, nb, src, **kw):
        raise ValueError("N-Python.ipynb: byte-faithful round-trip failed")
    body = _run_stage5(tmp_path, monkeypatch, boom)
    assert "Échec de l'intégration" in body
    assert "byte-faithful round-trip failed" in body


def test_pr_body_says_the_link_back_only_when_written():
    """22/11 (CoursIA#27905): the link back to the source twin is said in the
    body when the integration wrote it, and only then."""
    body = d.integration_pr_lines({"readme": "Rust", "nav": "extended-nav-bar",
                                   "back": "extended-nav-bar"})
    assert "Lien retour vers le jumeau d'origine" in body and "`extended-nav-bar`" in body
    assert "Lien retour" not in d.integration_pr_lines({"readme": "Rust", "nav": "x",
                                                        "back": None})
