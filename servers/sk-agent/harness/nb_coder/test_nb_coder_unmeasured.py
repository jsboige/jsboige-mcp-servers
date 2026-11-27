# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_unmeasured.py
# Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
# jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree.
# -----------------------------------------------------------------------------
"""An unmeasured repo guard (_unmeasured: ok True, detail.measured False) must not be
listed as "OK" in the PR body (21/11, claudish-bc review of #559)."""
import json
import subprocess
from types import SimpleNamespace

import nb_coder_driver as d


def test_split_gates_separates_unmeasured():
    gates = [
        {"gate": "kernel", "ok": True},
        {"gate": "c2", "ok": True, "detail": {"sequential": True}},
        d._unmeasured("prose-counts", skipped="tool absent: x.py"),
        {"gate": "twin", "ok": False, "detail": {"measured": False}},
        "garbage",
    ]
    ok, unmeasured = d.split_gates(gates)
    assert ok == ["kernel", "c2"]
    assert unmeasured == ["prose-counts"]          # a failed gate is neither


def test_split_gates_measured_true_is_ok():
    ok, unm = d.split_gates([{"gate": "g", "ok": True, "detail": {"measured": True}}])
    assert (ok, unm) == (["g"], [])


def _sh(*cmd, cwd=None):
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=cwd)
    assert p.returncode == 0, (cmd, p.stderr)
    return p.stdout


def test_pr_body_declares_unmeasured_guard(tmp_path, monkeypatch):
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
        issue=27999, notebook="Series/N-Rust.ipynb", pr_branch="nbcoder/unm-27999",
        agent="producer", verifier_agent="critic", grain_tier="MED",
        lane="myia-ai-01:vllm", pr_base="main", pr_repo="jsboige/CoursIA",
        out_dir=str(out_dir))
    rec = {"plan": {"plan": []},
           "verify": {"verdict": "approve", "model_used": "swift", "conversation_id": "v",
                      "findings": []},
           "kernel": {"kernel_name": "rust"}, "execution": [1], "c2": {"sequential": True},
           "calls": [], "conversation_id": "p",
           "gates": [{"gate": "kernel-metadata", "ok": True},
                     d._unmeasured("uncommented-code", skipped="tool absent: guard.py")]}

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
    line = next(l for l in bodies[0].splitlines() if l.startswith("- **Gates**"))
    assert line.startswith("- **Gates** : kernel-metadata OK")
    assert "**non mesurés**" in line and "uncommented-code" in line
    assert "uncommented-code OK" not in line and "uncommented-code," not in line.split(" OK")[0]
