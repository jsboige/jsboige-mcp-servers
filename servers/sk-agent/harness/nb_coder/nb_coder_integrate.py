#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/nb_coder_integrate.py
# Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
# jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree.
# -----------------------------------------------------------------------------
"""nb-coder repo integration — the CI guards a NEW port notebook trips, fixed
deterministically before the PR is pushed (jsboige/vllm, 21/11).

Measured (CoursIA#27829 head 05541d13, #27835 head 7ddca46e, lot-1 fixes
#27803/#27804/#27805, and po-2028:claudish's 14 C# port PRs of the 18/11):
every nb_coder port PR failed blocking guards and waited one Hermes review
cycle (~1 h) for remedies a deterministic pass applies itself:

  1. ``readme-notebook-coverage`` — the new notebook has no row in its folder's
     README (folder convention in force). Fix: a twin link appended on the
     source twin's own README line, mirroring that line's label convention
     (measured shapes: bare `[C#] · [Python]` -> `[Rust]`; `· [jumeau C#]` ->
     `· [jumeau Rust]`; inside a `(+ ...)` group -> bare; po-2028 folders use
     `[Version C#]` -> `[Version Rust]`, and Complexity-style `[X C#]` ->
     `[X Rust]` -- always the folder's own word, never ours).
  2. ``check-nav-chain`` ``orphan_entry`` — the new notebook has no inbound
     navigation edge. Fix: link it from the Python twin's Navigation cell (an
     edge is a link in a nav context — ``_looks_nav`` in the repo's guard: nav
     keyword in the link, nav marker on the line, or any link in a cell that
     contains the word "navigation").
  3. Consequence of 2: editing the twin's markdown breaks the twin-parity seal,
     so the pair is re-sealed in the same PR (``check_twin_parity.py --update``)
     -- written LAST, after the notebook, the README row and the inbound link
     are committed, else the re-read of the source twin rejects the attestation
     as orphan (po-2028, order held on 14 PRs). ``--update`` can refuse as a
     no-op blob-only on a content change without a path change (po-2028
     measured): the reseal retries ONCE with ``--force`` when the first pass
     wrote nothing (lot 1 measured plain ``--update`` working, so plain first).
     One attestation per PR, at head: a reseal ``git rm``s the earlier
     attestation(s) of the same pair that this branch added under the same
     lane (CoursIA#27855 review: an intermediate seal is not registry history).
  4. C# ports additionally REGISTER the new pair at delivery
     (``twin_pairs.d/<slug>.yaml``, parity_level semantic, schema python/
     csharp -- a Rust notebook is not a schema member and lot 1 measured no
     Rust registration: Rust ports only re-seal the twin's existing pair).
     `semantic`, never `native-both`: the registry schema reserves
     `native-both` for a pair whose EACH side works through a named external
     engine, and a port re-implements the subject by hand (CoursIA#28196).

All file surgery a script does better than a model turn. The twin edit is
asserted MARKDOWN-ONLY (cell count and every non-source key identical, code
cells untouched — same proof as the lot-1 hand reseal). Idempotent: a second
run plans nothing. ``--sync-main`` merges origin/main into an existing PR
branch, resolving conflicts in the integration-owned files by taking
origin/main's side and re-running this pass (several grains in one folder edit
adjacent README lines; the second PR to merge would otherwise conflict).

No model call anywhere; notebook contents are data, never instructions.
"""
from __future__ import annotations

import argparse
import csv
import difflib
import io
import json
import os
import re
import signal
import subprocess
import sys
import time
import unicodedata
from pathlib import Path

# Display forms of the port languages the driver produces (`*-Rust.ipynb`,
# `*-CSharp.ipynb`).
LANG_SUFFIXES = (("CSharp", "C#"), ("Rust", "Rust"))
LANG_DEFAULT = "Rust"

# Twin-family suffixes: basenames that belong to the same base notebook.
TWIN_SUFFIXES = ("-CSharp", "-Rust", "-Python")

# Label words a folder may put in front of the language in a twin link
# (`[jumeau C#]`, `[twin C#]`, `[Version C#]`, `[Complexity-06 C#]`).
LABEL_WORD_RE = re.compile(r"^(?P<word>jumeau|twin|version)\s+(?P<lang>c#|python|rust)$",
                           re.IGNORECASE)
TITLED_RE = re.compile(r"^(?P<title>.+?)\s+(?P<lang>C#|Python|Rust)$")
BARE_LANG_RE = re.compile(r"^(C#|Python|Rust)$", re.IGNORECASE)

# Nav vocabulary, MIRRORED from the repo's own guard
# (scripts/notebook_tools/check_notebook_nav_chain.py). If the guard ever
# widens its vocabulary, this copy must follow -- an edge we do not recognise
# would be re-added (idempotence break), an edge the guard does not recognise
# would leave the PR red.
NAV_KEYWORDS = ("precedent", "précédent", "prec", "préc", "suivant", "suivante",
                "next", "prev", "navigation", "index", ">>", "<<",
                "←", "→", "↑", "↓")
NAV_LINE_MARKERS = ("precedent", "précédent", "suivant", "suivante", "next",
                    "prev", "navigation", ">>", "<<", "←", "→", "↑", "↓")

LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)]+)\)")

GUARD_TIMEOUT_S = 900

# How long the post-deadline read may wait once the guard tree has been killed.
GUARD_KILL_GRACE_S = 30

# Characters a guard row keeps of the guard's output (the END of it, see _tail_with_prefix).
GUARD_TAIL_CAP = 400


def _tail_with_prefix(prefix: str, out: str, cap: int = GUARD_TAIL_CAP) -> str:
    """``prefix`` followed by the END of ``out``, inside ``cap`` characters.

    The last lines of a guard's output are its verdict, so the prefix must eat the head,
    never the tail (28/11 review: ``(prefix + tail)[:cap]`` cut the end of the output)."""
    budget = cap - len(prefix)
    if budget <= 0:
        return prefix[:cap]
    return prefix + (out or "")[-budget:]


# How ``_kill_guard_tree`` reports what it managed to kill, and the words the row uses for it.
# "exited" is the shape measured on 28/11 (10 of 10 trials): the guard child has ALREADY fallen
# when the deadline fires and a grandchild keeps the inherited pipe -- `taskkill /T` then answers
# 128 "not found", because it walks the tree from a LIVE parent. Nothing is killed, and the row
# must not say otherwise.
KILL_HOW = {"tree": "tree killed", "child": "child killed only",
            "exited": "child already exited", "nothing": "nothing killed"}

# Characters a failed kill command's own message keeps in a row. taskkill speaks the locale's
# console code page: decoded as "oem", flattened onto one line.
KILL_DETAIL_CAP = 120


def _kill_detail(text: str) -> str:
    """One capped line: what a failed kill command SAID, fit for a row prefix."""
    flat = " ".join((text or "").split())
    return flat if len(flat) <= KILL_DETAIL_CAP else flat[:KILL_DETAIL_CAP - 1] + "…"


def _timed_out_note(proc: subprocess.CompletedProcess, timeout: float) -> str:
    """What the deadline and the post-kill read actually MEASURED, as the row's prefix.

    The post-kill read usually returns in well under a second once the tree is killed;
    saying "pipe abandoned after 30s" then would claim a hang that did not happen
    (28/11 review). ``kill_how``, ``kill_detail``, ``pipe_abandoned`` and ``grace_wait_s``
    are set by ``run_guard_bounded`` from the kill and the read themselves. A tree kill that
    fell back carries the kill command's own words: an unexplained ``child`` was measured
    once in a busy CI selection (28/11) and never under load (30 of 30 trials), so the next
    occurrence must explain itself instead of being re-investigated."""
    waited = getattr(proc, "grace_wait_s", None)
    if waited is None:
        read = "post-kill read unmeasured"
    elif getattr(proc, "pipe_abandoned", False):
        read = f"pipe abandoned after {waited}s"
    else:
        read = f"pipe closed after {waited}s"
    killed = KILL_HOW.get(getattr(proc, "kill_how", None), "kill unmeasured")
    why = getattr(proc, "kill_detail", None)
    if why:
        killed = f"{killed} [{why}]"
    return f"TimeoutExpired after {timeout:g}s ({killed}, {read}): "


def _taskkill_tree(pid: int) -> tuple[int | None, str]:
    """``taskkill /F /T`` on one pid, as ``(exit code, what it said)``. Never raises."""
    try:
        done = subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)],
                              capture_output=True, timeout=GUARD_KILL_GRACE_S,
                              stdin=subprocess.DEVNULL)
        said = done.stderr or done.stdout or b""
        return done.returncode, _kill_detail(
            f"taskkill exit {done.returncode}: " + said.decode("oem", "replace"))
    except Exception as e:
        return None, _kill_detail(f"{type(e).__name__}: {e}")


def _kill_guard_tree(proc: subprocess.Popen) -> tuple[str, str | None]:
    """Kill a guard child AND its descendants, so nothing keeps its pipe open.

    Returns what it managed to kill and, when the tree kill fell back, what the kill command
    said about it:
      * ``"tree"``    -- the tree kill succeeded;
      * ``"child"``   -- the tree kill failed and only the child fell: a grandchild that
                         survives is exactly the case where the pipe outlives the grace;
      * ``"exited"``  -- the child was ALREADY gone, so nothing was killed and an orphan
                         holds the pipe (Windows, measured 10 of 10 trials on 28/11: a guard
                         that spawns a grandchild and returns before the deadline);
      * ``"nothing"`` -- even the child did not fall."""
    if os.name == "nt":
        if proc.poll() is not None:
            return "exited", None
        rc, said = _taskkill_tree(proc.pid)
        if rc == 0:
            return "tree", None
    else:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            return "tree", None
        except Exception as e:
            said = _kill_detail(f"killpg {type(e).__name__}: {e}")
    try:
        proc.kill()
        return "child", said
    except Exception as e:
        return "nothing", _kill_detail(f"{said}; kill {type(e).__name__}: {e}")


def run_guard_bounded(cmd: list[str], *, cwd, timeout: float = GUARD_TIMEOUT_S,
                      grace: float = GUARD_KILL_GRACE_S) -> subprocess.CompletedProcess:
    """Run a guard script so a grandchild holding its pipe can never wedge the driver.

    ``subprocess.run(..., timeout=T)`` is NOT enough on Windows (po-2028, 27/11): at the
    deadline CPython kills the CHILD and then re-calls ``communicate()`` with NO timeout.
    A grandchild that inherited the stdout handle keeps the pipe open, so that second read
    blocks FOREVER -- the caller sees a live process, zero children (the child was already
    killed), one thread parked in a pipe read and no further write on disk. It happened in
    stage 5 of a delivery: CoursIA#27133's MGS-28 commit was made at 06:51:27Z, the guard
    replay began, and 45 min later the driver was still parked with the branch never
    pushed. The notebook was built AND approved; the PR had to be pushed by hand.

    Three defences, each addressing one half of that shape:
      * ``stdin=DEVNULL`` -- a guard that prompts reads EOF instead of waiting on us;
      * ``stderr=STDOUT`` -- one pipe instead of two, halving the handles a descendant can
        inherit (and keep open past the child's death);
      * a BOUNDED second read after killing the whole TREE (``taskkill /T`` on Windows,
        ``killpg`` elsewhere). A pipe still held past the grace is abandoned, never waited
        on: an unread guard tail is a missing datapoint, a wedged grain is a lost PR.
    """
    popen_kw = {}
    if os.name != "nt":
        popen_kw["start_new_session"] = True   # own process group, killable as a whole
    proc = subprocess.Popen(
        [sys.executable, *cmd], cwd=str(cwd),
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", **popen_kw)
    try:
        out, _ = proc.communicate(timeout=timeout)
        return subprocess.CompletedProcess(cmd, proc.returncode, out or "", "")
    except subprocess.TimeoutExpired:
        killed, why = _kill_guard_tree(proc)
        read_t0 = time.monotonic()
        try:
            out, _ = proc.communicate(timeout=grace)
            abandoned = False
        except subprocess.TimeoutExpired:
            out = ""      # the pipe outlived the tree: give up, never block
            abandoned = True
        done = subprocess.CompletedProcess(cmd, None, out or "", "")
        done.timed_out = True
        # What the kill and the post-kill read MEASURED, so the report can say it instead
        # of assuming the worst case (28/11 review). ``kill_detail`` is None unless the tree
        # kill fell back.
        done.kill_how = killed
        done.kill_detail = why
        done.pipe_abandoned = abandoned
        done.grace_wait_s = round(time.monotonic() - read_t0, 1)
        return done


# The guards the CI raises on a new notebook, replayed with the exact
# commands the lot-1 review comments published (CoursIA#27803 c.1).
GUARDS = (
    ("check-nav-chain",
     ["scripts/notebook_tools/check_notebook_nav_chain.py", "--check",
      "--diff-base", "origin/main"]),
    ("readme-notebook-coverage",
     ["scripts/ci/check_readme_notebook_coverage.py", "--diff-base",
      "origin/main"]),
    ("twin-parity-changed",
     ["scripts/translation/check_twin_parity_changed.py", "--diff",
      "origin/main...HEAD"]),
    # PR-scoped view of the hot-subset ratchet (CoursIA#15322): names only the
    # translated cells THIS branch drifted, never the debt inherited from main.
    ("translation-drift",
     ["scripts/translation/check_pr_translation_drift.py", "origin/main"]),
)

TWIN_PAIRS_DIR = Path("scripts/notebook_tools/twin_pairs.d")

# Differential conformance registry of the Rust ports (CoursIA Epic Origami
# #26510, Pli 3): one YAML per triplet, read by the repo's own organ.
RUST_CONFORMANCE_DIR = Path("scripts/notebook_tools/rust_conformance.d")
CONFORMANCE_CHECKER = "scripts/notebook_tools/check_rust_conformance.py"

# Translation tables (hot-subset ratchet, CoursIA#13551): a cell whose
# translations CSV row carries a deposited `text_<lang>` must never be edited
# by this pass -- any source change turns it into SRC_DRIFT on a translated
# row and the repo-wide ratchet goes red (CoursIA#27855 measured: the nav edge
# appended to cell 0 `intro-hierarchy`, deposited in 7 languages). The resync
# is per-cell plus a dual-key translation override, never ours to take.
TRANSLATIONS_DIR = Path("translations")
PERIMETER_FILE = Path("scripts/translation/check_perimeter.py")
# Mirror of check_perimeter.TARGET_LANGS (the repo's single source of truth),
# used only when that file cannot be read.
TARGET_LANGS_FALLBACK = ("en", "es", "ar", "fa", "zh", "ru", "pt")

GIT_IDENTITY = ("-c", "user.name=nb-coder",
                "-c", "user.email=nb-coder@nb-coder.invalid")


def _git(wt: Path, *args: str, timeout: int = 300) -> tuple[int, str]:
    p = subprocess.run(["git", "-C", str(wt), *args], capture_output=True,
                       text=True, encoding="utf-8", errors="replace",
                       timeout=timeout)
    return p.returncode, (p.stdout or p.stderr or "").strip()


# ---------------------------------------------------------------- notebook io

def detect_nb_format(raw: str) -> dict:
    """Byte-faithful dump format of a repo notebook, measured from the file.

    The repo's notebooks are ``ensure_ascii=False, indent=1`` with no trailing
    newline (verified byte-exact on ``Search-03d-WeightedAstar.ipynb`` at
    origin/main); the detection keeps the module honest if another series
    formats differently, and ``apply_nb`` refuses to write when a round-trip
    of the UNCHANGED notebook does not reproduce the original bytes.

    ``ensure_ascii`` is read from the characters, never from a backslash-u
    substring (CoursIA#27900, 22/11): a LaTeX up-arrow command in a markdown
    cell is stored as an ESCAPED backslash followed by ``uparrow``, so the
    substring test answered True on an ``ensure_ascii=False`` file, the
    round-trip failed and the port PR shipped without README row nor nav
    edge. A file holding one raw non-ASCII character cannot have been dumped
    with ``ensure_ascii=True``; a pure-ASCII file is reproduced by True (every
    escape it carries is re-emitted as such).

    ``newline`` is read from the file too (22/11, CoursIA#28003/#28004/#28018):
    the driver writes the built port with ``Path.write_text``, which turns
    every newline into CRLF on Windows. Without it the round-trip of a CRLF
    port failed at byte 1 and the back link (#582) was never applied. JSON
    strings never hold a raw newline, so only the structural ones change.
    """
    m = re.search(r"^\{[\r\n]+( +)\"cells\"", raw, re.MULTILINE)
    indent = len(m.group(1)) if m else 1
    return {"indent": indent,
            "ensure_ascii": raw.isascii(),
            "trailing_nl": raw.endswith("\n"),
            "newline": "\r\n" if "\r\n" in raw else "\n"}


def load_nb(path: Path) -> tuple[dict, dict, str]:
    raw = path.read_bytes().decode("utf-8")
    return json.loads(raw), detect_nb_format(raw), raw


def dump_nb(nb: dict, fmt: dict) -> str:
    out = json.dumps(nb, ensure_ascii=fmt["ensure_ascii"],
                     indent=fmt["indent"]) + ("\n" if fmt["trailing_nl"] else "")
    return out.replace("\n", "\r\n") if fmt.get("newline") == "\r\n" else out


_INSIGNIFICANT_WS = re.compile(r"\s+")


def apply_nb(path: Path, nb: dict, fmt: dict, original_raw: str) -> bool:
    """Write a notebook only if the format round-trips: the unchanged parse must
    reproduce the original bytes, else the edit would silently reformat the
    whole file (a whole-file diff a reviewer cannot inspect).

    A file that differs from its own canonical dump ONLY by insignificant
    whitespace still carries its data byte-exactly, and refusing it costs the
    README row and the nav edge -- which is what turns the port's guards red.
    Measured 23/11 (CoursIA#28242): one model-emitted
    ``"outputs": [<newline>]`` where the dumper writes ``[]``. Both texts
    encode the SAME parsed object, so string literals are identical in them;
    a difference that survives stripping whitespace is a real one and keeps
    the refusal. Returns True when the file had to be normalised (the caller
    declares it), False on a byte-exact round-trip.
    """
    canonical = dump_nb(json.loads(original_raw), fmt)
    normalized = False
    if canonical != original_raw:
        if (_INSIGNIFICANT_WS.sub("", canonical)
                != _INSIGNIFICANT_WS.sub("", original_raw)):
            raise ValueError(f"{path.name}: byte-faithful round-trip failed -- "
                             "unknown notebook formatting, refusing to write")
        normalized = True
    path.write_bytes(dump_nb(nb, fmt).encode("utf-8"))
    return normalized


def cell_text(cell: dict) -> str:
    src = cell.get("source", "")
    return src if isinstance(src, str) else "".join(src)


def set_cell_text(cell: dict, text: str) -> None:
    """Replace a cell's source preserving its representation (list of lines vs
    string) — the repo's notebooks carry lists with per-line newlines."""
    if isinstance(cell.get("source"), list):
        cell["source"] = text.splitlines(keepends=True)
    else:
        cell["source"] = text


def assert_markdown_only(before: list[dict], after: list[dict], name: str) -> None:
    """Same proof as the lot-1 hand reseal: cell count identical, only markdown
    cells change, and only their 'source' key. Code cells and outputs are never
    touched — a port PR's twin edit is navigation prose, nothing else."""
    if len(before) != len(after):
        raise AssertionError(f"{name}: cell count changed {len(before)} -> {len(after)}")
    for i, (cb, ca) in enumerate(zip(before, after)):
        if cb == ca:
            continue
        if cb.get("cell_type") != "markdown" or ca.get("cell_type") != "markdown":
            raise AssertionError(f"{name}: cell {i} is not markdown on both sides")
        if {k: v for k, v in cb.items() if k != "source"} != \
           {k: v for k, v in ca.items() if k != "source"}:
            raise AssertionError(f"{name}: non-source change in cell {i}")


# ------------------------------------------------------------------ language

def split_port_name(nb_rel: str) -> tuple[str, str]:
    """`Serie-07-Norvig-Rust.ipynb` -> (`Serie-07-Norvig`, `Rust`).

    Returns (base_stem, display_language) for a `*-Rust.ipynb` / `*-CSharp.ipynb`
    port name. The base stem is what the twin family shares; the language is
    what the README label and nav segment name.
    """
    stem = Path(nb_rel).stem
    for suffix, display in LANG_SUFFIXES:
        if stem.endswith("-" + suffix):
            return stem[: -(len(suffix) + 1)], display
    return stem, LANG_DEFAULT


def twin_family_names(base_stem: str) -> set[str]:
    """Basenames of the base notebook and its language twins (base itself,
    -Python, -CSharp, -Rust -- whatever exists on the edited line)."""
    names = {f"{base_stem}.ipynb"}
    for suffix in TWIN_SUFFIXES:
        names.add(f"{base_stem}{suffix}.ipynb")
    return names


def mirror_label(sibling_text: str, lang: str, in_plus_group: bool) -> str:
    """README/nav label for the new twin, MIRRORING the sibling link it sits
    next to — the folder's own convention, never a house word.

    Measured shapes (lot 1 + po-2028 folders): `[Python]` -> `Rust`;
    `[jumeau C#]` -> `jumeau Rust`; `[Version C#]` -> `Version Rust`;
    `[Complexity-06 C#]` -> `Complexity-06 Rust`; a sibling inside a `(+ ...)`
    group takes the bare language (Part1-Foundations' `(+ [jumeau C#](...) ·
    [Rust](...))`). Default `jumeau <Lang>` (the repo's dominant twin word).
    """
    if in_plus_group:
        return lang
    text = sibling_text.strip()
    if BARE_LANG_RE.match(text):
        return lang
    m = LABEL_WORD_RE.match(text)
    if m:
        return f"{m.group('word')} {lang}"
    m = TITLED_RE.match(text)
    if m:
        return f"{m.group('title')} {lang}"
    return f"jumeau {lang}"


# ------------------------------------------------------------------ README row

def plan_readme_row(repo: Path, nb_rel: str, source_rel: str) -> dict:
    """Plan the README twin-link the coverage guard requires.

    The link is appended right after the LAST twin-family link of the source
    twin's own README line, as ` · [label](new.ipynb)` (all lot-1 fixes).
    """
    nb_rel = nb_rel.replace("\\", "/")
    new_name = nb_rel.rsplit("/", 1)[-1]
    base_stem, lang = split_port_name(nb_rel)
    folder = repo / Path(nb_rel).parent
    readmes = sorted(p for p in folder.glob("README*.md") if p.is_file())
    if not readmes:
        return {"todo": False, "why": "no-dir-readme (advisory, guard does not block)"}
    for readme in readmes:
        raw = readme.read_bytes().decode("utf-8")
        if new_name in raw:
            return {"todo": False, "why": f"{new_name} already in {readme.name}",
                    "file": _rel(repo, readme)}
        lines = raw.splitlines(keepends=True)
        family = twin_family_names(base_stem)
        for idx, line in enumerate(lines):
            links = [(m.start(), m.end(), m.group(1), m.group(2))
                     for m in LINK_RE.finditer(line)
                     if m.group(2).rsplit("/", 1)[-1] in family]
            if not links:
                continue
            start, end, text, _ = links[-1]
            in_plus_group = bool(re.search(r"\(\+\s*$", line[:start]))
            label = mirror_label(text, lang, in_plus_group)
            return {"todo": True, "file": _rel(repo, readme), "line": idx,
                    "insert": f" · [{label}]({new_name})", "insert_at": end,
                    "label": label, "path": str(readme)}
    return {"todo": False,
            "why": "no README line links the source twin -- row placement needs "
                   "the folder's own convention (guard will stay red, reported)"}


def apply_readme_row(action: dict) -> bool:
    if not action.get("todo"):
        return False
    path = Path(action["path"])
    raw = path.read_bytes().decode("utf-8")
    lines = raw.splitlines(keepends=True)
    line = lines[action["line"]]
    at = action["insert_at"]
    lines[action["line"]] = line[:at] + action["insert"] + line[at:]
    path.write_bytes("".join(lines).encode("utf-8"))
    return True


# ------------------------------------------------------------------ hot cells

def target_langs(repo: Path) -> tuple[str, ...]:
    """TARGET_LANGS read from the repo's own check_perimeter.py (flat literal
    list), so a language added there is honoured here without a code change."""
    try:
        text = (repo / PERIMETER_FILE).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return TARGET_LANGS_FALLBACK
    m = re.search(r"^TARGET_LANGS\s*=\s*\[([^\]]*)\]", text, re.MULTILINE)
    langs = tuple(re.findall(r"[\"']([A-Za-z_-]{2,8})[\"']", m.group(1))) if m else ()
    return langs or TARGET_LANGS_FALLBACK


def hot_cell_ids(repo: Path, nb_rel: str) -> set[str]:
    """cell ids of `nb_rel` that carry a deposited translation -- the
    ratchet's `deposited` predicate (test_hot_subset_ratchet.hot_anomalies):
    a translations CSV row for this notebook with a non-empty `text_<lang>`
    for a target language. Same-CSV rows are pooled by cell id as the ratchet
    does, so the set is never narrower than what the ratchet would flag."""
    nb_rel = nb_rel.replace("\\", "/")
    tdir = repo / TRANSLATIONS_DIR
    if not tdir.is_dir():
        return set()
    langs = target_langs(repo)
    hot: set[str] = set()
    for csv_path in sorted(tdir.rglob("*.csv")):
        try:
            raw = csv_path.read_bytes().decode("utf-8-sig")
        except (OSError, UnicodeDecodeError):
            continue
        if nb_rel not in raw:
            continue
        mine: set[str] = set()
        deposited: set[str] = set()
        try:
            for row in csv.DictReader(io.StringIO(raw, newline="")):
                cid = row.get("cell_id") or ""
                if not cid:
                    continue
                if (row.get("notebook") or "").replace("\\", "/") == nb_rel:
                    mine.add(cid)
                if any((row.get(f"text_{l}") or "").strip() for l in langs):
                    deposited.add(cid)
        except csv.Error:
            continue
        hot |= mine & deposited
    return hot


# ------------------------------------------------------------------ nav link

def _nav_edge_exists(cells: list[dict], new_name: str) -> bool:
    """True when the twin already links the new notebook in a NAV context —
    same three scopes as the guard's ``_looks_nav`` (link text, line, cell)."""
    for cell in cells:
        if cell.get("cell_type") != "markdown":
            continue
        text = cell_text(cell)
        cell_is_nav = "navigation" in text.lower()
        for line in text.splitlines():
            for m in LINK_RE.finditer(line):
                if m.group(2).rsplit("/", 1)[-1] != new_name:
                    continue
                low = f"{m.group(1)} {m.group(2)}".lower()
                if any(k in low for k in NAV_KEYWORDS):
                    return True
                if any(k in line.lower() for k in NAV_LINE_MARKERS):
                    return True
                if cell_is_nav:
                    return True
    return False


def visible_text(text: str) -> str:
    """Markdown with every link reduced to its text: a filename such as
    `Complexity-03c-ComplexityZoo-Navigation-Python.ipynb` is not a nav
    marker (CoursIA#27855 measured: a prose list line was taken for a bar
    because its link URL contains "Navigation")."""
    return LINK_RE.sub(lambda m: m.group(1), text)


# Words a bar may carry OUTSIDE its links (`**Navigation** :`, `Précédent :
# [..] | Suivant : [..]`, `⬅️ Précédent | 🏠 Index | Suivant ➡️`).
PROSE_WORDS_MAX = 8

# A long line is still a bar when it OPENS on a bold nav label (« **Navigation**
# : [..] — desc · [..] », GameTheory-09c; « **Carnet suivant** : [..] — .. »).
# Words, not arrows: « **Agrégation d'audiences → choix social** » is a title.
NAV_HEAD_RE = re.compile(r"^\s*(?:>\s*)*\*\*([^*]+)\*\*")
NAV_HEAD_WORDS = ("navigation", "suivant", "précédent", "precedent", "suite",
                  "next", "prev")


def _words_outside_links(line: str) -> int:
    return len(re.findall(r"\w+", LINK_RE.sub(" ", line)))


def _has_nav_head(line: str) -> bool:
    m = NAV_HEAD_RE.match(line)
    return bool(m) and any(w in m.group(1).lower() for w in NAV_HEAD_WORDS)


def _is_prose_line(line: str) -> bool:
    """A paragraph that happens to hold an arrow and a notebook link is not a
    bar (CoursIA#27905, 22/11: « **Agrégation d'audiences → choix social** :
    … [Tweety-9](…) … » got ` | [jumeau Rust](…)` glued onto its last
    sentence). Measured on the words left once the links are removed, unless
    the line opens on a nav label; table rows and list items keep their own
    shapes (`_table_block`, list item). Repo measure (22/11, 1,589 notebooks
    with a bar): the word bound alone dropped the bars of 49, among them
    GameTheory-09c's headed `**Navigation**` bar -- hence the head clause."""
    if _is_pipe_row(line) or LIST_ITEM_RE.match(line):
        return False
    return _words_outside_links(line) > PROSE_WORDS_MAX and not _has_nav_head(line)


def _nav_bar_cells(cells: list[dict]) -> dict[int, int]:
    """{cell index: line index} of the LAST nav-bar line of every markdown cell
    that carries one — a bar is a line with a .ipynb link and a nav marker
    (`**Navigation** :`, `<<`, `>>`, arrows...) in its VISIBLE text, link
    targets excluded. Series that duplicate the bar at the end of the notebook
    (ChoixSocial cells 0 and 27) get every copy extended, matching the lot-1
    hand fix."""
    out: dict[int, int] = {}
    for i, cell in enumerate(cells):
        if cell.get("cell_type") != "markdown":
            continue
        last = None
        for j, line in enumerate(cell_text(cell).splitlines()):
            if not any(m in visible_text(line).lower() for m in NAV_LINE_MARKERS):
                continue
            if not any(m.group(2).lower().endswith(".ipynb")
                       for m in LINK_RE.finditer(line)):
                continue
            if _is_prose_line(line):
                continue
            last = j
        if last is not None:
            out[i] = last
    return out


TABLE_SEP_RE = re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$")
UNESCAPED_PIPE_RE = re.compile(r"(?<!\\)\|")


def _is_pipe_row(line: str) -> bool:
    return line.lstrip().startswith("|")


def _split_row(line: str) -> list[str]:
    body = line.strip()
    if body.startswith("|"):
        body = body[1:]
    if body.endswith("|") and not body.endswith("\\|"):
        body = body[:-1]
    return [c.strip() for c in UNESCAPED_PIPE_RE.split(body)]


def _table_block(lines: list[str], j: int) -> tuple[int, int] | None:
    """(last row index, column count) of the Markdown TABLE holding line j, or
    None when line j is not a row of a real table. A real table is a block of
    contiguous pipe rows that contains a separator row (`|---|---|`); a lone
    pipe-delimited nav bar (`| [<< prev](…) | [next >>](…) |`) has none, is not
    rendered as a table, and keeps the extend-the-bar shape."""
    if not _is_pipe_row(lines[j]):
        return None
    start = j
    while start > 0 and _is_pipe_row(lines[start - 1]):
        start -= 1
    end = j
    while end + 1 < len(lines) and _is_pipe_row(lines[end + 1]):
        end += 1
    seps = [k for k in range(start, end + 1)
            if TABLE_SEP_RE.match(lines[k].rstrip("\r\n"))]
    if not seps:
        return None
    return end, len(_split_row(lines[seps[0]]))


def _table_nav_row(bar_row: str, n_cols: int, label: str, stem: str,
                   new_name: str, lang: str, origin: bool = False) -> str:
    """New table row mirroring the bar row's layout: the link goes in the
    column where the bar row has its .ipynb link, the nav marker `→` (one the
    repo guard reads on the line) in the column where the bar row has its own
    marker outside any link, a short relation in the last free column."""
    cells = _split_row(bar_row)
    link_col = next((k for k, c in enumerate(cells)
                     if any(m.group(2).lower().endswith(".ipynb")
                            for m in LINK_RE.finditer(c))), 0)
    marker_col = next((k for k, c in enumerate(cells)
                       if k != link_col and any(
                           mk in LINK_RE.sub("", c).lower()
                           for mk in NAV_LINE_MARKERS)), None)
    out = [""] * max(n_cols, link_col + 1)
    cap = label[:1].upper() + label[1:]
    if marker_col is not None and marker_col < len(out):
        out[link_col] = f"[{stem}]({new_name})"
        out[marker_col] = f"→ {cap}"
    else:
        out[link_col] = f"[→ {stem}]({new_name})"
    free = [k for k in range(len(out)) if not out[k]]
    if free:
        out[free[-1]] = (f"carnet d'origine, en {lang}" if origin
                         else f"même carnet, porté en {lang}")
    return "| " + " | ".join(out) + " |\n"


def _nav_label(bar_line: str, cell_text_: str, lang: str) -> str:
    """Twin segment of the nav bar, mirroring the bar's own twin link
    (`| [twin C#](...)` -> `twin Rust`, `[jumeau C#]` -> `jumeau Rust`);
    default `jumeau <Lang>` (lot-1 cell-0 bars)."""
    for m in LINK_RE.finditer(bar_line):
        text = m.group(1).strip()
        if BARE_LANG_RE.match(text):
            return lang
        mm = LABEL_WORD_RE.match(text) or TITLED_RE.match(text)
        if mm:
            return mirror_label(text, lang, False)
    low = cell_text_.lower()
    if re.search(r"\btwin\b", low):
        return f"twin {lang}"
    return f"jumeau {lang}"


def _family_label(cells: list[dict], base_stem: str, lang: str) -> str | None:
    """Label mirrored from the first twin-family link anywhere in the twin's
    markdown (cell 0's `[Version C#](…-CSharp.ipynb)` -> `Version Rust`), for a
    host line that carries no twin link of its own."""
    family = twin_family_names(base_stem)
    for cell in cells:
        if cell.get("cell_type") != "markdown":
            continue
        for m in LINK_RE.finditer(cell_text(cell)):
            if m.group(2).rsplit("/", 1)[-1] in family:
                return mirror_label(m.group(1), lang, False)
    return None


LIST_ITEM_RE = re.compile(r"^(?P<indent>\s*)(?P<bullet>[-*+])\s+")


def _list_item_end(lines: list[str], j: int) -> int:
    """Index of the last line of the list item starting at line j (its
    indented continuation lines included)."""
    end = j
    while end + 1 < len(lines):
        nxt = lines[end + 1]
        if not nxt.strip() or LIST_ITEM_RE.match(nxt) or not nxt[:1].isspace():
            break
        end += 1
    return end


def _insert_list_item(lines: list[str], j: int, label: str, stem: str,
                      new_name: str, lang: str, origin: bool = False) -> None:
    """Sibling list item after the list item at line j, same bullet and
    indent, with the `→` marker the repo guard reads on the line."""
    m = LIST_ITEM_RE.match(lines[j])
    end = _list_item_end(lines, j)
    cap = label[:1].upper() + label[1:]
    relation = (f"le carnet d'origine, en {lang}" if origin
                else f"le même carnet, porté en {lang}")
    item = (f"{m.group('indent')}{m.group('bullet')} **{cap}** → "
            f"[{stem}]({new_name}) — {relation}.\n")
    if not lines[end].endswith("\n"):
        lines[end] += "\n"
        item = item.rstrip("\n")
    lines.insert(end + 1, item)


def _insert_sibling_line(lines: list[str], j: int, label: str, stem: str,
                         new_name: str, lang: str, origin: bool = False) -> None:
    """Sibling paragraph after the headed nav line at line j (« **Carnet
    suivant** : [..](..) — la suite .. »): a ` | [..]` tail would glue the twin
    onto the line's last sentence. Same blockquote prefix, the `→` marker the
    repo guard reads on the line."""
    prefix = re.match(r"^\s*(?:>\s*)*", lines[j]).group(0)
    cap = label[:1].upper() + label[1:]
    relation = (f"le carnet d'origine, en {lang}" if origin
                else f"le même carnet, porté en {lang}")
    para = f"{prefix}**{cap}** → [{stem}]({new_name}) — {relation}.\n"
    if not lines[j].endswith("\n"):
        lines[j] += "\n"
        para = para.rstrip("\n")
    lines[j + 1:j + 1] = [prefix.rstrip() + "\n", para]


def plan_nav_link(twin_path: Path, nb_rel: str,
                  hot: set[str] | None = None, *, lang: str | None = None,
                  base_stem: str | None = None, origin: bool = False) -> dict:
    """Plan the inbound nav edge in the Python twin.

    Shapes, all measured on the lot-1 fixes: extend every existing nav bar with
    ` | [label](new.ipynb)` (Search-03d cell 0, ChoixSocial cells 0+27) -- or,
    when the bar is a row of a real Markdown table (Search-03c's « Ponts »
    table, #27829), add a whole `| → Jumeau <Lang> | [stem](new) | … |` row at
    the table's end instead of widening that row; when
    no bar exists but a cell is a Navigation cell, append a
    `**Jumeau <Lang>** : [stem](new.ipynb)` line to it (Sudoku-07 cell 0 under
    its `## Navigation` table); when the twin has no navigation at all, prepend
    a minimal `**Navigation** : [jumeau <Lang>](new.ipynb)` bar to its first
    markdown cell and REPORT it — the smallest change the guard accepts, less
    than the series' full prev|index|next bar a reviewer may want.

    ``lang``/``base_stem``/``origin`` serve the OUTBOUND edge (`plan_back_link`):
    the host is then the new port and the target its source twin, whose name
    carries no port suffix ``split_port_name`` knows (`-Python`, or none).

    HOT cells (`hot`: ids carrying a deposited translation, `hot_cell_ids`)
    are never hosts (CoursIA#27855): their bars are skipped and reported, and
    the edge falls back, in order, to a non-hot Navigation cell, a sibling
    list item `- **<Label>** → [stem](new)` after the last .ipynb list link of
    a non-hot cell (the « Pour aller plus loin » list), a minimal bar on the
    first non-hot markdown cell -- or is DECLARED not placed when every
    markdown cell is hot. A bar line that is a prose list item
    (`- **Carnet suivant** : [..](..) — ...`) gets a sibling list item, never a
    ` | [..]` tail.
    """
    nb_rel = nb_rel.replace("\\", "/")
    new_name = nb_rel.rsplit("/", 1)[-1]
    port_stem, port_lang = split_port_name(nb_rel)
    base_stem = base_stem or port_stem
    lang = lang or port_lang
    stem = Path(nb_rel).stem
    hot = hot or set()
    nb, fmt, raw = load_nb(twin_path)
    cells = nb["cells"]
    if _nav_edge_exists(cells, new_name):
        return {"todo": False, "why": "nav edge already present"}

    def is_hot(i: int) -> bool:
        return bool(cells[i].get("id")) and cells[i]["id"] in hot

    all_bars = _nav_bar_cells(cells)
    hot_skipped = sorted(i for i in all_bars if is_hot(i))
    extra = {"hot_skipped": hot_skipped} if hot_skipped else {}
    bars = {i: j for i, j in all_bars.items() if not is_hot(i)}
    if bars:
        changed, labels, hows = [], [], set()
        for i, j in bars.items():
            text = cell_text(cells[i])
            lines = text.splitlines(keepends=True)
            bar = lines[j]
            label = _nav_label(bar, text, lang)
            if label == f"jumeau {lang}":
                label = _family_label(cells, base_stem, lang) or label
            labels.append(label)
            block = _table_block(lines, j)
            if LIST_ITEM_RE.match(bar) and block is None:
                # A prose list item (`- **Carnet suivant** : [..](..) — ..`):
                # a ` | [..]` tail would glue the twin onto another sentence.
                _insert_list_item(lines, j, label, stem, new_name, lang, origin)
                hows.add("added-nav-list-item")
            elif block is not None:
                # A body row of a real Markdown table (Search-03c's « Ponts »
                # table, CoursIA#27829): appending ` | [label](…)` would add a
                # cell the header does not have. Add a whole row instead, after
                # the table's last row, with the header's column count.
                end, n_cols = block
                row = _table_nav_row(bar, n_cols, label, Path(nb_rel).stem,
                                     new_name, lang, origin)
                if not lines[end].endswith("\n"):
                    lines[end] += "\n"
                    row = row.rstrip("\n")
                lines.insert(end + 1, row)
                hows.add("added-nav-table-row")
            elif _words_outside_links(bar) > PROSE_WORDS_MAX:
                # A headed nav line carrying descriptions (`_has_nav_head`).
                _insert_sibling_line(lines, j, label, stem, new_name, lang, origin)
                hows.add("added-nav-sibling-line")
            else:
                body, tail = bar.rstrip("\r\n"), bar[len(bar.rstrip("\r\n")):]
                lines[j] = f"{body} | [{label}]({new_name}){tail}"
                hows.add("extended-nav-bar")
            set_cell_text(cells[i], "".join(lines))
            changed.append(i)
        how = hows.pop() if len(hows) == 1 else "+".join(sorted(hows))
        return _finish_plan(twin_path, nb, fmt, raw,
                            {"todo": True, "how": how,
                             "cells": changed, "label": labels[0], **extra})
    md = [i for i, c in enumerate(cells)
          if c.get("cell_type") == "markdown" and not is_hot(i)]
    for i in md:
        text = cell_text(cells[i])
        if "navigation" not in visible_text(text).lower():
            continue
        addition = f"**Jumeau {lang}** : [{stem}]({new_name})"
        set_cell_text(cells[i], text.rstrip("\n") + "\n\n" + addition + "\n")
        return _finish_plan(twin_path, nb, fmt, raw,
                            {"todo": True, "how": "appended-under-navigation-cell",
                             "cells": [i], "label": f"Jumeau {lang}", **extra})
    label = _family_label(cells, base_stem, lang) or f"jumeau {lang}"
    for i in reversed(md):
        lines = cell_text(cells[i]).splitlines(keepends=True)
        items = [j for j, line in enumerate(lines)
                 if LIST_ITEM_RE.match(line) and any(
                     m.group(2).lower().endswith(".ipynb")
                     for m in LINK_RE.finditer(line))]
        if not items:
            continue
        _insert_list_item(lines, items[-1], label, stem, new_name, lang, origin)
        set_cell_text(cells[i], "".join(lines))
        return _finish_plan(twin_path, nb, fmt, raw,
                            {"todo": True, "how": "added-nav-list-item",
                             "cells": [i], "label": label, **extra})
    if not md:
        if any(c.get("cell_type") == "markdown" for c in cells):
            return {"todo": False, "hot_skipped": hot_skipped,
                    "why": "every markdown cell carries a deposited translation "
                           "(hot-subset ratchet, CoursIA#13551): no host the "
                           "pass may edit -- inbound edge NOT placed, reported"}
        return {"todo": False, "why": "twin has no markdown cell to host a nav bar"}
    first_md = md[0]
    bar = f"**Navigation** : [jumeau {lang}]({new_name})\n\n"
    set_cell_text(cells[first_md], bar + cell_text(cells[first_md]))
    return _finish_plan(twin_path, nb, fmt, raw,
                        {"todo": True, "how": "added-minimal-nav-bar",
                         "cells": [first_md], "label": f"jumeau {lang}",
                         "note": "twin had no Navigation cell -- minimal bar "
                                 "added, series may want prev|index|next",
                         **extra})


def _finish_plan(path: Path, nb: dict, fmt: dict, raw: str, plan: dict) -> dict:
    assert_markdown_only(json.loads(raw)["cells"], nb["cells"], path.name)
    plan["file"] = str(path)
    plan["_nb"], plan["_fmt"], plan["_raw"] = nb, fmt, raw
    return plan


def apply_nav_link(action: dict) -> bool:
    if not action.get("todo"):
        return False
    if apply_nb(Path(action["file"]), action["_nb"], action["_fmt"],
                action["_raw"]):
        action["normalized"] = True   # whitespace-only reformat, declared here
    return True


def twin_display_lang(nb_rel: str) -> str:
    """Display language of a twin from its name: `-CSharp` -> C#, `-Rust` ->
    Rust, `-Python` or no suffix -> Python (ANALYSE's originals carry none:
    `ANALYSE-08-Ramsey-VdW.ipynb`)."""
    stem = Path(nb_rel).stem
    for suffix, display in LANG_SUFFIXES:
        if stem.endswith("-" + suffix):
            return display
    return "Python"


def plan_back_link(worktree: Path, notebook: str, source_nb: str) -> dict:
    """Outbound edge: the NEW port links back to its source twin (22/11,
    CoursIA#27905 + #27864 reviews). The port copies the twin's nav bar, and
    that bar cannot name the twin itself: the Rust notebook linked the C# twin
    and the series, never its Python original, and each review asked for the
    edge by hand. Same shapes and markdown-only proof as the inbound edge, on
    the new notebook; idempotent (a link to the twin in a nav context is an
    edge already)."""
    notebook = notebook.replace("\\", "/")
    source_nb = source_nb.replace("\\", "/")
    new_path = Path(worktree) / notebook
    if not new_path.is_file():
        return {"todo": False, "why": "new notebook not in the worktree"}
    if not (Path(worktree) / source_nb).is_file():
        return {"todo": False, "why": "source twin not in the worktree -- a link "
                                      "to it would be dead, not placed"}
    if Path(notebook).parent != Path(source_nb).parent:
        return {"todo": False, "why": "source twin in another folder -- a bare "
                                      "link would not resolve, not placed"}
    lang = twin_display_lang(source_nb)
    target = source_nb.rsplit("/", 1)[-1]
    # A link that names the twin by its language (`[ANALYSE-08 (Python)](…)` in
    # ANALYSE's `| Index | … |` row, which carries no nav marker the guard
    # reads) is the edge a reviewer asks for: a second, minimal bar would only
    # duplicate it.
    for cell in load_nb(new_path)[0].get("cells", []):
        if cell.get("cell_type") != "markdown":
            continue
        for m in LINK_RE.finditer(cell_text(cell)):
            if (m.group(2).rsplit("/", 1)[-1] == target
                    and lang.lower() in m.group(1).lower()):
                return {"todo": False, "why": "twin already linked by its language"}
    base_stem, _ = split_port_name(notebook)
    return plan_nav_link(new_path, source_nb, set(), lang=lang,
                         base_stem=base_stem, origin=True)


# ------------------------------------------------------------------ registry

def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(name).lower()).strip("-")


def pair_member(worktree: Path, rel_path: str, key: str) -> str | None:
    """Value of `key:` of the registry pair whose PYTHON member is `rel_path`.
    Flat scan, no yaml import (pair files are flat mappings; the name line is
    the list dash form `- name:`)."""
    rel_path = rel_path.replace("\\", "/")
    d = worktree / TWIN_PAIRS_DIR
    if not d.is_dir():
        return None
    for f in sorted(d.glob("*.yaml")):
        if f.name.startswith("_"):
            continue
        text = f.read_text(encoding="utf-8", errors="replace")
        m_py = re.search(r"^\s+python:\s*['\"]?([^'\"\n]+?)['\"]?\s*$",
                         text, re.MULTILINE)
        if not m_py or m_py.group(1).replace("\\", "/") != rel_path:
            continue
        for pat in (rf"^-\s+{key}:\s*['\"]?([^'\"\n]+?)['\"]?\s*$",
                    rf"^\s+{key}:\s*['\"]?([^'\"\n]+?)['\"]?\s*$"):
            m = re.search(pat, text, re.MULTILINE)
            if m:
                return m.group(1).strip()
    return None


def find_twin_pair(worktree: Path, source_rel: str) -> str | None:
    """Name of the registry pair whose python member is the source twin, or
    None (twin not registered -- the parity guard has no seal to break, but a
    C# delivery must then REGISTER the pair, cf register_pair)."""
    return pair_member(worktree, source_rel, "name")


def _csharp_member_exists(worktree: Path, nb_rel: str) -> bool:
    """True when `nb_rel` is already the csharp member of some registered pair."""
    nb_rel = nb_rel.replace("\\", "/")
    d = worktree / TWIN_PAIRS_DIR
    if not d.is_dir():
        return False
    for f in sorted(d.glob("*.yaml")):
        if f.name.startswith("_"):
            continue
        text = f.read_text(encoding="utf-8", errors="replace")
        m = re.search(r"^\s+csharp:\s*['\"]?([^'\"\n]+?)['\"]?\s*$",
                      text, re.MULTILINE)
        if m and m.group(1).replace("\\", "/") == nb_rel:
            return True
    return False


def register_pair(worktree: Path, source_rel: str, nb_rel: str, lane: str,
                  facts: dict | None = None) -> dict:
    """Register the NEW pair (source twin + new C# notebook) at delivery —
    parity_level semantic, schema python/csharp, attestation written LAST
    by reseal_pair (po-2028 order, held on 14 PRs). Rust notebooks are NOT
    registered: the registry schema has no rust member and lot 1 measured no
    Rust registration on review-accepted branches.

    The entry states DELIVERY facts only (harness, verifier verdict, execution
    count) -- no `bridge_verdict` (optional in the schema; a SOTA verdict is a
    firsthand judgment the harness does not make) and no 'verified firsthand'
    claim.

    `semantic`, never `native-both`. The registry schema reserves `native-both`
    for a pair whose EACH side does the notebook's work through a named
    external engine -- "un cote qui reimplemente le sujet du notebook a la main
    n'est PAS natif" -- and a C# port re-implements it by hand on both sides.
    This generator wrote `native-both` until 25/11; Hermes contested the line
    on two deliveries (CoursIA Integrales-01, 23/11; CoursIA#28196 Chaines-09,
    25/11), each contest costing a review round. The delivery record says why
    the level is `semantic` and why no verdict is carried, so their absence is
    read as a decision, not as an oversight."""
    source_rel = source_rel.replace("\\", "/")
    nb_rel = nb_rel.replace("\\", "/")
    base_stem, lang = split_port_name(nb_rel)
    if lang != "C#":
        return {"registered": False,
                "why": f"language {lang!r} is not a registry member (python/csharp)"}
    if pair_member(worktree, source_rel, "name"):
        return {"registered": False, "why": "source twin already in a pair"}
    if _csharp_member_exists(worktree, nb_rel):
        return {"registered": False, "why": "notebook already in a pair"}
    family = Path(nb_rel).parent.relative_to("MyIA.AI.Notebooks").as_posix() \
        if nb_rel.startswith("MyIA.AI.Notebooks/") else Path(nb_rel).parent.as_posix()
    name = f"{base_stem} C#"
    facts = facts or {}
    entry = (
        f"- name: \"{name}\"\n"
        f"  family: {family}\n"
        f"  python: {source_rel}\n"
        f"  csharp: {nb_rel}\n"
        f"  parity_level: semantic\n"
        f"  known_differences:\n"
        f"    - \"Enregistrement de livraison ({lane}, harnais nb_coder stages 0-5) : "
        f"portage C# de {Path(source_rel).name}. "
        # `kernel_read` is set when stage 5 found NO recorded execution (an old
        # trace, or no cell ever ran): the name is a READING, not a measurement,
        # and the registry must not upgrade it to "Execution reelle". The value
        # stays ASCII -- the accented PR-body note never enters this line.
        f"{'Kernel lu (execution non enregistree)' if facts.get('kernel_read') else 'Execution reelle sur kernel'} "
        f"{facts.get('kernel', 'n/a')} : {facts.get('executed_cells', 'n/a')} cellules, "
        f"0 erreur. Verification independente : {facts.get('verdict', 'n/a')}. "
        f"Premiere attestation ecrite par l'integration de livraison (check_twin_parity "
        f"--update), en DERNIERE operation (cf #8957). "
        # Why the level is semantic and why no verdict is carried (ASCII, as
        # the rest of the entry). Neither registry identifier is spelled in
        # this prose: a registry-wide grep for a level or for a verdict must
        # only ever hit a field (CoursIA#28196).
        f"Parite semantic : portage ecrit a la main des deux cotes, sans moteur "
        f"externe nommable (le niveau natif des deux cotes en exige un par cote). "
        f"Aucun verdict de pont porte : jugement de premiere main, laisse a la review.\"\n")
    dest = worktree / TWIN_PAIRS_DIR / f"{_slug(name)}.yaml"
    if dest.exists():
        return {"registered": False, "why": f"{dest.name} already exists"}
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(entry, encoding="utf-8", newline="")
    return {"registered": True, "file": (TWIN_PAIRS_DIR / dest.name).as_posix(),
            "pair": name}


def reseal_pair(worktree: Path, pair_name: str, lane: str) -> dict:
    """Re-seal a pair with the repo's own tool (``check_twin_parity.py
    --update``), like the lot-1 hand reseal. Records the git blob SHAs AT
    HEAD, so the notebook, README row and inbound link must already be
    COMMITTED (po-2028: attestation LAST). ``--update`` can refuse as a no-op
    blob-only on a content change (measured po-2028): before retrying with
    ``--force``, the pair's OWN check decides whether a seal is actually
    missing -- a forced duplicate attestation on an already-sealed pair would
    be exactly the false audit the registry's design gate forbids (#9399)."""
    out = {"pair": pair_name, "forced": False}

    def _run(*extra: str) -> subprocess.CompletedProcess:
        return run_guard_bounded(
            ["scripts/notebook_tools/check_twin_parity.py",
             *extra, "--pair", pair_name]
            + (["--by", lane] if "--update" in extra else []),
            cwd=worktree, timeout=GUARD_TIMEOUT_S, grace=GUARD_KILL_GRACE_S)

    proc = _run("--update")
    if getattr(proc, "timed_out", False):
        # A timed-out seal is not a "no-op that --force might fix": re-running the same
        # 900 s guard twice more would spend 30 min to reach the same wall (27/11).
        return out | {"ok": False, "rc": None, "timed_out": True, "audit_files": [],
                      "tail": _tail_with_prefix(_timed_out_note(proc, GUARD_TIMEOUT_S),
                                                proc.stdout or "")}
    audit = _status(worktree, TWIN_PAIRS_DIR.as_posix())
    if proc.returncode == 0 and audit:
        dropped = drop_superseded_attestations(worktree, pair_name, lane, audit)
        return out | {"ok": True, "rc": proc.returncode, "audit_files": audit,
                      "superseded": dropped,
                      "tail": (proc.stdout or proc.stderr or "")[-400:]}
    chk = _run("--check")
    if chk.returncode == 0:  # pair already sealed at HEAD: nothing to attest
        return out | {"ok": True, "rc": proc.returncode, "audit_files": [],
                      "skipped": "already sealed at HEAD",
                      "tail": (chk.stdout or chk.stderr or "")[-400:]}
    proc = _run("--update", "--force")  # drift present, --update refused
    audit = _status(worktree, TWIN_PAIRS_DIR.as_posix())
    out |= {"forced": True, "rc": proc.returncode, "audit_files": audit,
            "tail": (proc.stdout or proc.stderr or "")[-400:]}
    out["ok"] = proc.returncode == 0 and bool(audit)
    if out["ok"]:
        out["superseded"] = drop_superseded_attestations(
            worktree, pair_name, lane, audit)
    return out


def _attestation_by(text: str) -> str | None:
    """The ``by:`` field of an attestation yaml (plain or quoted scalar)."""
    for line in text.splitlines():
        m = re.match(r"""\s*by:\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$""", line)
        if m:
            return m.group(1).strip()
    return None


def drop_superseded_attestations(worktree: Path, pair_name: str, lane: str,
                                 new_files: list[str]) -> list[str]:
    """One attestation per PR, at head (review ai-01:CoursIA on CoursIA#27855,
    22/11): a branch that is integrated twice (driver stage 5, then a later
    ``nb_coder_integrate.py`` pass or ``--sync-main`` after a twin moved on
    main) re-seals twice, and each reseal APPENDS an attestation. The earlier
    one attests an intermediate blob that is neither main nor head, and it
    also takes an ordinal that can collide with an open PR (0006 of #27311).

    The registry is append-only ON MAIN; an attestation this branch added and
    never merged is not history yet. So after a successful reseal, ``git rm``
    every attestation of the SAME pair that the branch itself added (diff
    merge-base(HEAD, origin/main)..HEAD, status A) and that THIS lane wrote,
    keeping the one just written. Attestations on main, and those another lane
    added on the branch, are never touched. An index gap is valid (the repo's
    own test does not check contiguity), so nothing is renumbered. The removal
    is staged; the callers' ``git add -- twin_pairs.d`` + commit carry it."""
    rc, base = _git(worktree, "merge-base", "HEAD", "origin/main")
    if rc != 0 or not base.strip():
        return []
    pair_dir = (TWIN_PAIRS_DIR / _slug(pair_name)).as_posix() + "/"
    rc, out = _git(worktree, "diff", "--name-only", "--diff-filter=A",
                   base.strip(), "HEAD", "--", pair_dir)
    if rc != 0:
        return []
    keep = {f.strip().rstrip("/") for f in new_files}
    dropped: list[str] = []
    for rel in (l.strip() for l in out.splitlines()):
        if not rel or rel in keep or not rel.endswith(".yaml"):
            continue
        path = worktree / rel
        if not path.is_file():
            continue
        if _attestation_by(path.read_text(encoding="utf-8", errors="replace")) != lane:
            continue
        if _git(worktree, "rm", "-q", "--", rel)[0] == 0:
            dropped.append(rel)
    return dropped


def _status(worktree: Path, path: str) -> list[str]:
    rc, out = _git(worktree, "status", "--porcelain", "--", path)
    return [l[3:].strip() for l in out.splitlines() if l.strip()]


def _rel(repo: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(repo.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


# ------------------------------------------------------------------ rust conformance

# A wall-clock duration inside an output line (`Resolu en 1.72 ms`, `Temps
# total: 22.33 ms`): its VALUE is never compared (the specs say "présence
# seule"), the line around it is an anchor that must exist on both sides.
DURATION_RE = re.compile(
    r"(?<![\w.,])\d+(?:[.,]\d+)?\s*(?:ms|µs|us|ns|s|sec|secondes?)(?![A-Za-zÀ-ÿ])")
DURATION_NUM = r"\d+(?:[.,]\d+)?"
# `label : value` / `label ? value` / `label = value` -- the label is the anchor
# of a three-sided line measure, the value what is compared.
LABEL_LINE_RE = re.compile(r"^(?P<label>\S[^\n]*?(?:\s:|:|\s\?|\s=))\s+(?P<value>\S[^\n]*?)\s*$")
# A three-sided line measure compares a VALUE (a number, a boolean, a
# collection) -- a prose tail (« Coûts contrastés : terrain non-dégénéré »)
# is wording, not a result, and the C# twin rewords freely.
VALUE_LITERAL_RE = re.compile(
    r"^(?:True|False|None|true|false|OUI|NON|Oui|Non|\{.*\}|\[.*\]|\(.*\))$")
RICH_MIMES = ("image/png", "image/jpeg", "image/svg+xml", "text/html",
              "application/vnd.plotly.v1+json")
NONDETERMINISTIC_RE = re.compile(r"\bat 0x[0-9a-fA-F]{6,}")
# An environment banner (« Python 3.13.16, stdlib only », « Z3 version : 4.16.0 »)
# reports the runtime, not a result of the notebook: the Rust port reports its
# own toolchain (« Rust, std only ») and must never be asked to print Python's.
# Short outputs only -- a long cell that mentions a version still carries results.
ENV_BANNER_RE = re.compile(
    r"(?im)\bPython\s+3\.\d+|\bversion\b\s*[:=]?\s*v?\d+\.\d+"
    r"|^\s*[\w.-]+\s*[:=]\s*v?\d+\.\d+\.\d+\s*$")
ENV_BANNER_MAX_LINES = 6


def is_rust_port(nb_rel: str) -> bool:
    return Path(nb_rel.replace("\\", "/")).name.endswith("-Rust.ipynb")


def conformance_slug(nb_rel: str) -> str:
    """`Sudoku-07-Norvig-Rust.ipynb` -> `sudoku-07-norvig` (registry file stem)."""
    return _slug(split_port_name(nb_rel)[0])


def conformance_file(nb_rel: str) -> Path:
    return RUST_CONFORMANCE_DIR / f"{conformance_slug(nb_rel)}.yaml"


def notebook_outputs(path: Path) -> dict[int, str]:
    """{code-cell index: output text} -- MIRROR of the repo checker's
    `read_notebook_outputs` (stream `text` + `text/plain` of execute_result /
    display_data, concatenated). A different reading would generate patterns
    the checker does not see."""
    nb = json.loads(path.read_text(encoding="utf-8"))
    out: dict[int, str] = {}
    for i, cell in enumerate(nb.get("cells", [])):
        if cell.get("cell_type") != "code":
            continue
        chunks: list[str] = []
        for o in cell.get("outputs") or []:
            if "text" in o:
                t = o["text"]
                chunks.append("".join(t) if isinstance(t, list) else str(t))
            data = o.get("data") or {}
            if "text/plain" in data:
                t = data["text/plain"]
                chunks.append("".join(t) if isinstance(t, list) else str(t))
        out[i] = "".join(chunks)
    return out


def _duration_template(line: str) -> str:
    """Regex for one output line whose duration values float: the text is
    escaped verbatim, each duration number becomes `\\d+(?:[.,]\\d+)?`."""
    parts, pos = [], 0
    for m in DURATION_RE.finditer(line):
        parts.append(re.escape(line[pos:m.start()]))
        unit = re.sub(r"^" + DURATION_NUM, "", m.group(0))
        parts.append(DURATION_NUM + re.escape(unit))
        pos = m.end()
    parts.append(re.escape(line[pos:]))
    return "".join(parts)


def _segments(text: str) -> list[dict]:
    """Split a reference output on its duration lines. Each segment is the
    text BETWEEN two anchors; its pattern captures it, the anchors (duration
    lines with floating values) must match on the compared side too."""
    lines = text.split("\n")
    dur = [i for i, l in enumerate(lines) if DURATION_RE.search(l)]
    if not dur:
        return [{"pattern": r"\A\s*(.*?)\s*\Z", "text": text.strip(), "durations": 0}]
    # `\r?$`: the C# kernel writes CRLF; a bare `$` would never anchor there.
    anchor = {i: r"(?m:^" + _duration_template(lines[i].rstrip("\r")) + r"\r?$)" for i in dur}
    bounds = [None, *dur, None]
    segs = []
    for k in range(len(bounds) - 1):
        a, b = bounds[k], bounds[k + 1]
        lo = 0 if a is None else a + 1
        hi = len(lines) if b is None else b
        body = "\n".join(lines[lo:hi]).strip()
        if not body:
            continue
        # The left anchor walks EVERY earlier duration line in order: two
        # `Temps moyen : … ms` lines share one template, and a lone anchor
        # would match the first occurrence for the second segment.
        left = r"\A" + "".join(r"(?:.*?)" + anchor[j] for j in dur if a is not None and j <= a)
        right = r"\Z" if b is None else anchor[b]
        segs.append({"pattern": left + r"\s*(.*?)\s*" + right, "text": body,
                     "durations": len(dur)})
    return segs


def _extract(text: str, pattern: str) -> str | None:
    """Same extraction as the checker (re.DOTALL, first group, strip)."""
    m = re.search(pattern, text, re.DOTALL)
    if not m:
        return None
    return (m.group(1) if m.groups() else m.group(0)).strip()


def _first_diff(ref: str, other: str) -> str:
    # CRLF is reported by `_csharp_gap` on its own; here it would hide the
    # real first difference behind two lines that look identical.
    a, b = ref.split("\n"), other.replace("\r\n", "\n").split("\n")
    for i in range(max(len(a), len(b))):
        la = a[i] if i < len(a) else "<fin>"
        lb = b[i] if i < len(b) else "<fin>"
        if la != lb:
            if la.strip() == lb.strip():
                la, lb = repr(la), repr(lb)
            # Excerpt around the first differing column: a fixed `[:60]` showed
            # two identical-looking prefixes when the lines part after column 60
            # (ChoixSocial-02 c2, « (Gale-Shapley) » vs « (Gale-Shapley, twin C# »).
            col = next((j for j, (x, y) in enumerate(zip(la, lb)) if x != y),
                       min(len(la), len(lb)))
            start = max(0, col - DIFF_CONTEXT_BEFORE)
            return (f"ligne {i + 1} : « {_window(lb, start)} » contre "
                    f"« {_window(la, start)} » côté Python")
    return "texte identique"


DIFF_CONTEXT_BEFORE = 20
DIFF_WINDOW = 60


def _window(line: str, start: int) -> str:
    cut = line[start:start + DIFF_WINDOW]
    return ("…" if start else "") + cut + ("…" if start + DIFF_WINDOW < len(line) else "")


def _label_lines(text: str) -> dict[str, str]:
    """{label: value} for the lines of `text` shaped `label : value` whose label
    occurs ONCE and whose line carries no duration -- a duplicated label (the
    doubled `Step 5:` of a trace) would anchor on the wrong line."""
    seen: dict[str, list[str]] = {}
    for line in text.split("\n"):
        if DURATION_RE.search(line):
            continue
        m = LABEL_LINE_RE.match(line.rstrip())
        if m:
            seen.setdefault(m.group("label"), []).append(m.group("value"))
    return {k: v[0] for k, v in seen.items()
            if len(v) == 1 and (re.search(r"\d", v[0]) or VALUE_LITERAL_RE.match(v[0]))}


def _ascii_slug(text: str) -> str:
    """Measure-id slug: ASCII only (`Stable ?` -> `stable`, `Coût` -> `cout`)."""
    flat = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "_", flat.lower()).strip("_")


def _csharp_gap(i: int, cs_txt: str | None, cs_got: str | None, ref: str,
                cs_code: set[int]) -> str:
    """Why the aligned C# cell is not comparable -- MEASURED at generation,
    written into the `absent:` motif so a reviewer reads the gap, not a guess."""
    if i not in cs_code:
        return (f"Le carnet C# n'a pas de cellule de code à l'index {i} "
                "(structure de cellules différente du jumeau Python)")
    if not (cs_txt or "").strip():
        return f"La cellule C# {i} ne porte pas de sortie"
    if cs_got is None:
        return (f"La cellule C# {i} n'imprime pas les lignes-ancres de durée "
                "du segment Python")
    if cs_got.replace("\r\n", "\n").replace("\r", "") == ref:
        return (f"La cellule C# {i} ne diffère du Python que par ses fins de "
                "ligne CRLF (noyau .NET)")
    return f"La cellule C# {i} diffère du texte Python ({_first_diff(ref, cs_got)})"


def rich_output_cells(path: Path) -> set[int]:
    """Code cells with a rich display (figure, HTML table). Their `text/plain`
    is a language-specific repr (`<Figure size 640x480 with 1 Axes>`, a pandas
    frame) that a Rust port can never print verbatim: never measured here."""
    nb = json.loads(Path(path).read_text(encoding="utf-8"))
    return {i for i, c in enumerate(nb.get("cells", []))
            if c.get("cell_type") == "code"
            and any(set((o.get("data") or {})) & set(RICH_MIMES) for o in c.get("outputs") or [])}


def is_env_banner(text: str) -> bool:
    lines = [ln for ln in text.splitlines() if ln.strip()]
    return 0 < len(lines) <= ENV_BANNER_MAX_LINES and bool(ENV_BANNER_RE.search(text))


# --------------------------------------------------------- spec `## Tolerances`
# A stochastic lot spec (CoursIA#28072, Sudoku-04: the Rust port uses its own
# std RNG, so seed-dependent outputs can never match the Python twin) carries a
# per-cell contract table. Rows say HOW each cell is judged -- the strict-text
# rule below is only the default. Accents and casing vary between specs
# (`Tolérances`/`Tolerances`, `Comparé à`/`Compare a`): heading and header
# detection are accent-folded, the cell VALUES keep the spec's own wording (the
# declared-absent motifs quote it verbatim).
_SPEC_TOLERANCES_HEAD_RE = re.compile(r"^#{2,6}\s*tolerances?\b")
_SPEC_HEADING_RE = re.compile(r"^#{1,6}\s+\S")
# « sortie Python cellule N » / « sorties Python » / « jumeau Python »
_SPEC_PY_OUTPUT_RE = re.compile(r"sorties?\s+python|python\s+cellule|jumeau\s+python")
# The wall-clock words a duration row uses (accent-folded): lots 1-12 write
# « durees : presence seule », App-12 #28069 writes « temps : presence seule »
# and « ms/coup : presence seule » for the same contract.
_SPEC_DUREE_RE = re.compile(r"\b(?:durees?|temps|murales?)\b|ms/coup")
# Only DECIMAL numbers are masked by a duration row: wall-clock values print
# with a fractional part (`1.8`, `302.0`, `2306.2`), while the integers next to
# them are game results the spec keeps strict (App-12 #28069: `4W-0D-2L`,
# `Score 66`). An integer duration column stays strict -- fail-closed.
_NUM_TOKEN_RE = re.compile(r"\d+\.\d+(?:[eE][-+]?\d+)?")


def _flat(s: str) -> str:
    """Accent-folded lowercase (`Tolérances` -> `tolerances`)."""
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()


# The CoursIA coordinator's own vocabulary (CoursIA#28944, 28/11: an 11-row table
# on ONE notebook). Three rows say a quantity is not compared between the twins.
# None of them is an ABSENCE: each is a MASK, and every other token of the cell
# stays exactly compared (the spec's rule, quoted: « une égalité de compteurs qui
# échoue n'est pas arrondie ni tolérée — elle se mesure, se déclare dans cette
# table »). Measured 28/11: the organ read all 7 cells of that table as `strict`,
# so a stage-3 gate would have pushed the producer to print the Python twin's
# wall-clock values instead of the ones it had measured.
#   `non comparée`     a machine-dependent value (a `Temps(ms)` column). The row
#                      names HOW MANY (`(6 valeurs)`): that count is the contract.
#   `forme seulement`  `Compare a` holds a REGEX the output satisfies on its own
#                      (`Solution \(MAC\): [0-9.]+ms, 81 assignations, 0 backtracks`:
#                      the milliseconds float, the counters are pinned by the regex).
#   `écart déclaré`    a named, counted difference: `` `/` au lieu de `\`, une seule
#                      ligne concernée ``.
_SPEC_NON_COMPARABLE_RE = re.compile(r"\bnon\s*compar|\bnot\s+compared\b")
_SPEC_FORM_ONLY_RE = re.compile(r"forme\s+seule(?:ment)?|forme\s+uniquement")
_SPEC_DECLARED_GAP_RE = re.compile(r"ecart\s+declare|declared\s+(?:gap|difference)")
_SPEC_DECLARED_COUNT_RE = re.compile(r"\((\d+)\s+(?:valeurs?|values?)\)")
_SPEC_DECLARED_LINES_RE = re.compile(r"(?:une\s+seule|(\d+))\s+lignes?\s+concerne")
# A value a mask row tolerates: a number, and nothing else.
_MASK_NUMBER_RE = re.compile(r"[-+]?\d+(?:[.,]\d+)?")
# Its wildcard in a measure's pattern. NON-capturing on purpose: the checker
# (and `_extract`) read group 1, the first literal run of the cell.
_WILD_NUMBER = r"[0-9]+(?:[.,][0-9]+)?"
_BACKTICKED_RE = re.compile(r"`([^`\n]+)`")
_REGEX_META = set("\\[]{}+*?|^$")
_MASK_KINDS = ("non_comparable", "form", "declared_gap")


def parse_spec_tolerance_rows(spec_body: str | None) -> dict[int, list[dict]]:
    """`{cell_index: [row, ...]}` -- EVERY row of a lot spec's `## Tolerances`
    table (`| Cellule (source) | Grandeur comparee | Tolerance | Compare a |`),
    in table order. The first column may list several cells (`9, 16, 32, 39,
    41, 43`) and carry bold markup; a cell may own several rows. The table is
    read from its heading to the next heading; prose in between is skipped.
    No table -> `{}`: today's strict behaviour, unchanged."""
    rows: dict[int, list[dict]] = {}
    if not spec_body:
        return rows
    in_section = False
    header_seen = False
    for line in spec_body.splitlines():
        stripped = line.strip()
        if _SPEC_HEADING_RE.match(stripped):
            if in_section:
                break                      # next section: the table is done
            if _SPEC_TOLERANCES_HEAD_RE.match(_flat(stripped)):
                in_section = True
            continue
        if not in_section or not stripped.startswith("|"):
            continue
        cells = [c.strip() for c in stripped.strip("|").split("|")]
        if len(cells) < 4:
            continue
        if not header_seen:
            if "cellule" in _flat(cells[0]):
                header_seen = True
            continue
        if set(_flat("".join(cells))) <= set("-: "):
            continue                        # the `|---|---|` separator row
        idxs = [int(x) for x in re.findall(r"\d+", cells[0].replace("**", ""))]
        for i in idxs:
            rows.setdefault(i, []).append(
                {"quantity": cells[1], "tolerance": cells[2], "compare": cells[3]})
    return rows


def parse_spec_tolerances(spec_body: str | None) -> dict[int, dict]:
    """`{cell_index: {"quantity", "tolerance", "compare"}}` from a lot spec's
    `## Tolerances` table, one entry per cell.

    A cell with SEVERAL rows (CoursIA#28944 cell 33: `Assigns`/`Backtracks`/
    `Succes` exacte, then `Temps(ms)` non comparée) keeps them ALL: its row
    carries them in `rows`, and its own fields join theirs with « ; ». Until
    28/11 the last row overwrote the others, so a strict row vanished under
    the tolerant one below it (and the reverse)."""
    out: dict[int, dict] = {}
    for i, rs in parse_spec_tolerance_rows(spec_body).items():
        if len(rs) == 1:
            out[i] = rs[0]
        else:
            out[i] = {"quantity": " ; ".join(r["quantity"] for r in rs),
                      "tolerance": " ; ".join(r["tolerance"] for r in rs),
                      "compare": " ; ".join(r["compare"] for r in rs),
                      "rows": rs}
    return out


def _spec_one_row_kind(row: dict | None) -> str:
    """Classify ONE `## Tolerances` row.

    - `invariants`: the `Compare a` column judges by invariants and never the
      Python output (« invariants, pas le committe ») -- the strict measure is
      not the contract;
    - `mixed`: both the Python output and invariants (« sortie Python cellule
      N + invariants »);
    - `duration`: the row grants wall-clock durations in presence only
      (« durees : presence seule »);
    - `non_comparable` / `form` / `declared_gap`: a MASK row (see the block
      comment above) -- the rest of the cell stays exactly compared;
    - `strict` (or no row at all): today's exact-text rule."""
    if not row:
        return "strict"
    blob = _flat(" ".join((row.get("compare") or "", row.get("tolerance") or "",
                           (row.get("quantity") or ""))))
    has_invariants = "invariant" in blob
    has_python = bool(_SPEC_PY_OUTPUT_RE.search(blob))
    if has_invariants and not has_python:
        return "invariants"
    if has_invariants and has_python:
        return "mixed"
    if _SPEC_DUREE_RE.search(blob) and "presence seule" in blob:
        return "duration"
    if _SPEC_FORM_ONLY_RE.search(blob):
        return "form"
    if _SPEC_DECLARED_GAP_RE.search(blob):
        return "declared_gap"
    if _SPEC_NON_COMPARABLE_RE.search(blob):
        return "non_comparable"
    return "strict"


def spec_rows_kind(rows: list[dict]) -> str:
    """The CELL's kind from ALL of its rows. Fail-closed: a row that asks for an
    exact comparison is never dropped by another.

    - only `invariants`/`mixed` rows: the first of them (the whole cell is
      declared by the spec);
    - an `invariants`/`mixed` row BESIDE an exact row: `strict` -- the two
      quantities cannot be told apart without a mask, so the exact one holds
      and the core names the row it could not apply;
    - a `duration` row, alone or beside exact rows: `duration` (it already
      tolerates the decimals only, the integers stay compared);
    - otherwise `strict`: exact rows, mask rows or both -- the masks are
      applied by the core, per quantity, and never un-strict the rest."""
    kinds = [_spec_one_row_kind(r) for r in rows]
    declared = [k for k in kinds if k in ("invariants", "mixed")]
    if declared:
        return declared[0] if all(k in ("invariants", "mixed") for k in kinds) else "strict"
    return "duration" if "duration" in kinds else "strict"


def spec_row_kind(row: dict | None) -> str:
    """The kind of one row as `parse_spec_tolerances` returns it: a single row
    is classified alone, the merged row of a multi-row cell by ALL its rows
    (`spec_rows_kind`)."""
    if row and row.get("rows"):
        return spec_rows_kind(row["rows"])
    return _spec_one_row_kind(row)


def _durations_only_diff(ref: str, other: str) -> bool:
    """True when two outputs differ ONLY by their decimal numbers (CoursIA#28072
    cell 48: `0.0 0.3` vs `1.8 302.0` inside a table with no time unit, so the
    duration-LINE detector never anchored them). Decimals are masked and runs
    of whitespace collapsed -- a table's column padding follows the number
    widths. Integers are NOT masked: a wrong win count or score next to a
    duration column is a divergence, never tolerated by the duration row."""
    def mask(text: str) -> list[list[str]]:
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        return [_NUM_TOKEN_RE.sub("#", ln).split() for ln in text.split("\n")]
    return mask(ref) == mask(other)


def _spec_absent_reason(kind: str, cell: int, row: dict, spec_ref: str | None) -> str:
    """The `absent:` motif of a spec-declared Rust side: it QUOTES the spec row
    so a reviewer reads the contract, not a bare skip."""
    at = f"{spec_ref}, " if spec_ref else ""
    if kind == "duration":
        return (f"durees en presence seule (spec {at}Tolerances, cellule {cell}) : "
                f"{row.get('tolerance') or ''}".rstrip(" :"))
    return (f"contrat a invariants declare par la spec ({at}Tolerances, cellule {cell}) : "
            f"{row.get('compare') or ''}".rstrip(" :"))


# --- MASQUE : une ligne de tolérance n'est jamais une absence ------------------
#
# Le vocabulaire du coordinateur CoursIA (CoursIA#28944, 28/11) dit « CETTE
# valeur-là n'est pas comparée » ; il ne dit jamais « cette cellule n'est pas
# comparée ». Un MASQUE remplace la valeur tolérée, dans le motif lu sur les
# deux côtés, par une classe non capturante qui n'accepte qu'elle (un nombre,
# ou l'une des deux formes déclarées) ; tout autre morceau du segment devient
# SA PROPRE mesure. Pourquoi une mesure par morceau : le contrôle
# (`check_measure` de `check_rust_conformance.py`) ne compare que le groupe 1
# d'une mesure, et un groupe est contigu -- une valeur tolérée au milieu d'une
# ligne interdit de capturer « tout sauf elle » en un seul groupe.
#
# Fail-closed, dans l'ordre : une ligne de masque dont le contrat ne tient pas
# (compteur déclaré non retrouvé, structure différente, regex non satisfaite)
# ne masque RIEN et NOMME pourquoi à côté de la divergence ; un masque qui
# tient est écrit seulement si chaque morceau se relit des deux côtés.


_MASK_NUMBER_CLASS = r"[0-9]+(?:[.,][0-9]+)?"


def _col_key(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", _flat(text))


def _mask_non_comparable(py: str, rs: str, row: dict) -> tuple[
        list[tuple[int, int, str]], list[tuple[int, int, str]], str | None]:
    """`non comparée` -- the row names a COLUMN and, when it says so, how many
    values it holds (`Temps(ms)`, `(6 valeurs)`). The values of that column
    are the mask; the count and the position are the contract, never « whatever
    differs ». The column is located from the END of its line: a label counts
    several words (`BACKTRACKING MRV LCV`) where the header counts one.
    Returns `(spans, rust_spans, None)` when the row holds -- the first on the
    Python text, the second on the Rust one -- and `([], [], reason)` when it
    does not."""
    quantity = row.get("quantity") or ""
    lit = _BACKTICKED_RE.search(quantity)
    label = lit.group(1) if lit else re.split(r"\s*\(", quantity, 1)[0].strip(" *")
    key = _col_key(label)
    if not key:
        return [], [], "la ligne ne nomme pas la grandeur non comparée"
    pl, rl = py.split("\n"), rs.split("\n")
    if len(pl) != len(rl):
        return [], [], f"{len(pl)} lignes côté Python, {len(rl)} côté Rust"
    off = first = None
    for n, line in enumerate(pl):
        keys = [_col_key(t) for t in line.split()]
        if key in keys:
            off, first = len(keys) - 1 - keys.index(key), n
            break
    if off is None:
        return [], [], f"aucune ligne de la sortie Python ne porte l'en-tête « {label} »"
    spans: list[tuple[int, int, str]] = []
    rust: list[tuple[int, int, str]] = []
    base = sum(len(pl[k]) + 1 for k in range(first + 1))   # offset of the line after the header
    rbase = sum(len(rl[k]) + 1 for k in range(first + 1))
    for n in range(first + 1, len(pl)):
        if n > first + 1:
            base += len(pl[n - 1]) + 1
            rbase += len(rl[n - 1]) + 1
        pt, rt = pl[n].split(), rl[n].split()
        if not pt:
            continue
        if len(pt) != len(rt):
            return [], [], f"ligne {n + 1} : {len(pt)} jetons côté Python, {len(rt)} côté Rust"
        if len(pt) <= off:
            continue                        # too short to hold the column
        j = len(pt) - 1 - off
        if not _MASK_NUMBER_RE.fullmatch(pt[j]):
            continue                        # a repeated header, a rule, a note
        if not _MASK_NUMBER_RE.fullmatch(rt[j]):
            return [], [], f"ligne {n + 1} : « {rt[j]} » côté Rust, un nombre est attendu"
        tok = list(re.finditer(r"\S+", pl[n]))[j]
        spans.append((base + tok.start(), base + tok.end(), _MASK_NUMBER_CLASS))
        rtok = list(re.finditer(r"\S+", rl[n]))[j]
        rust.append((rbase + rtok.start(), rbase + rtok.end(), _MASK_NUMBER_CLASS))
    m = _SPEC_DECLARED_COUNT_RE.search(quantity)
    if m and len(spans) != int(m.group(1)):
        return [], [], (f"la ligne déclare {m.group(1)} valeur(s), {len(spans)} lue(s) "
                        f"dans la colonne « {label} »")
    if not spans:
        return [], [], f"aucune valeur lue dans la colonne « {label} »"
    return spans, rust, None


def _mask_form(py: str, rs: str, row: dict) -> tuple[
        list[tuple[int, int, str]], list[tuple[int, int, str]], str | None]:
    """`forme seulement` -- `Compare a` holds a REGEX the output satisfies on
    its own (`Solution \\(MAC\\): [0-9.]+ms, 81 assignations, 0 backtracks`: the
    counters are pinned BY the regex, the milliseconds float is not). Both
    sides must satisfy it; what differs between the two matches is the mask,
    and it must be a number on both sides."""
    rx = None
    for lit in _BACKTICKED_RE.findall(row.get("compare") or ""):
        if not any(ch in _REGEX_META for ch in lit):
            continue
        try:
            rx = re.compile(lit)
        except re.error as exc:
            return [], [], f"la regex de la ligne est illisible ({exc})"
        break
    if rx is None:
        return [], [], "la ligne dit « forme seulement » sans donner de regex"
    mp, mr = rx.search(py), rx.search(rs)
    if not mp:
        return [], [], "la sortie Python ne satisfait pas la regex déclarée"
    if not mr:
        return [], [], "la sortie Rust ne satisfait pas la regex déclarée"
    a, b = mp.group(0), mr.group(0)
    p = 0
    while p < min(len(a), len(b)) and a[p] == b[p]:
        p += 1
    s = 0
    while s < min(len(a), len(b)) - p and a[len(a) - 1 - s] == b[len(b) - 1 - s]:
        s += 1
    mid_a, mid_b = a[p:len(a) - s], b[p:len(b) - s]
    if not (_MASK_NUMBER_RE.fullmatch(mid_a) and _MASK_NUMBER_RE.fullmatch(mid_b)):
        return [], [], ("la partie variable de « forme seulement » n'est pas un nombre : "
                        f"« {mid_a} » côté Python, « {mid_b} » côté Rust")
    return ([(mp.start() + p, mp.start() + len(a) - s, _MASK_NUMBER_CLASS)],
            [(mr.start() + p, mr.start() + len(b) - s, _MASK_NUMBER_CLASS)], None)


def _mask_declared_gap(py: str, rs: str, row: dict) -> tuple[
        list[tuple[int, int, str]], list[tuple[int, int, str]], str | None]:
    """`écart déclaré` -- a NAMED difference (« `/` au lieu de `\\`, une seule
    ligne concernée »). The form the Python twin shows is the reference and the
    other the declared one; the two texts must differ by that substitution
    ALONE, on the number of lines the row declares."""
    blob = " ".join((row.get("compare") or "", row.get("tolerance") or ""))
    lits = _BACKTICKED_RE.findall(blob)
    if len(lits) != 2 or lits[0] == lits[1]:
        return [], [], "la ligne doit nommer les deux formes, chacune entre backticks"
    a, b = lits
    if a in py and b not in py:
        ref, dec = a, b
    elif b in py and a not in py:
        ref, dec = b, a
    else:
        return [], [], "une seule des deux formes doit être lisible côté Python"
    if py.replace(ref, dec) != rs:
        return [], [], f"l'écart « {dec} » au lieu de « {ref} » n'est pas la seule différence"
    lines = sum(1 for line in py.split("\n") if ref in line)
    m = _SPEC_DECLARED_LINES_RE.search(_flat(blob))
    if m:
        want = 1 if m.group(1) is None else int(m.group(1))
        if lines != want:
            return [], [], f"la ligne déclare {want} ligne(s) concernée(s), {lines} lue(s)"
    cls = f"(?:{re.escape(dec)}|{re.escape(ref)})"
    return ([(mm.start(), mm.end(), cls) for mm in re.finditer(re.escape(ref), py)],
            [(mm.start(), mm.end(), cls) for mm in re.finditer(re.escape(dec), rs)], None)


_MASK_FNS = {"non_comparable": _mask_non_comparable, "form": _mask_form,
             "declared_gap": _mask_declared_gap}


def _spec_mask(py: str, rs: str, rows: list[dict]) -> tuple[
        list[tuple[int, int, str]], list[tuple[int, int, str]], list[str]]:
    """The union of the mask rows a segment HOLDS, and the reasons of those it
    does not: spans only when every mask row holds -- on the Python text and on
    the Rust one (the Rust spans serve the diagnosis of a failing piece)."""
    spans: list[tuple[int, int, str]] = []
    rust: list[tuple[int, int, str]] = []
    broken: list[str] = []
    for row in rows:
        kind = _spec_one_row_kind(row)
        if kind not in _MASK_FNS:
            continue
        got, got_rust, why = _MASK_FNS[kind](py, rs, row)
        if why is not None:
            broken.append(f"{kind} : {why}")
        else:
            spans.extend(got)
            rust.extend(got_rust)
    if broken:
        return [], [], broken
    return sorted(spans), sorted(rust), broken


_MASK_BLANK = "\u2300"      # the glyph of a masked value, the same on both sides


def _masked_fail_detail(p: dict, py_n: str, rs_n: str,
                        py_spans: list[tuple[int, int, str]],
                        rs_spans: list[tuple[int, int, str]]) -> str:
    """The first failing measure in words a producer can act on: the COMPARED
    text that differs, never the masked value. The masked values are blanked on
    both sides first -- a message that leads with the tolerated difference (the
    durations) sends the producer to copy the Python constants, the very
    defect the mask exists to end."""
    def blanked(text: str, spans: list[tuple[int, int, str]]) -> str:
        out, pos = [], 0
        for span in sorted(spans):
            s, e = span[0], span[1]
            if s < pos:
                continue
            out.append(text[pos:s])
            out.append(_MASK_BLANK)
            pos = e
        out.append(text[pos:])
        return "".join(out)

    n = p.get("line") or 0
    if not n:
        return _first_diff(blanked(py_n, py_spans), blanked(rs_n, rs_spans))
    pl, rl = py_n.split("\n"), rs_n.split("\n")
    if n > len(rl):
        return f"la ligne {n} manque côté Rust"
    base = sum(len(pl[k]) + 1 for k in range(n - 1))
    rbase = sum(len(rl[k]) + 1 for k in range(n - 1))

    def cut(spans: list[tuple[int, int, str]], b: int, ln: str) -> list[tuple[int, int, str]]:
        return [(max(s, b) - b, min(e, b + len(ln)) - b) for s, e, _c in spans
                if s < b + len(ln) and e > b]

    a = blanked(pl[n - 1], cut(py_spans, base, pl[n - 1])).split()
    b = blanked(rl[n - 1], cut(rs_spans, rbase, rl[n - 1])).split()
    ops = difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes()
    for tag, i1, i2, j1, j2 in ops:
        if tag != "equal":
            return (f"ligne {n} : « {' '.join(b[j1:j2]) or '∅'} » côté Rust contre "
                    f"« {' '.join(a[i1:i2]) or '∅'} » côté Python")
    return f"ligne {n} : {p['id']}"


def _mask_pieces(text: str, spans: list[tuple[int, int, str]]) -> list[dict]:
    """The segment as an ordered list of pieces: `lit` (a run of non-whitespace,
    compared), `wild` (a tolerated span, masked), `ws` (a run of whitespace,
    read with padding free). Overlapping spans: the first holds."""
    out: list[dict] = []

    def emit(chunk: str, base: int) -> None:
        for m in re.finditer(r"\s+|\S+", chunk):
            if m.group(0)[0].isspace():
                out.append({"kind": "ws", "text": m.group(0)})
            else:
                out.append({"kind": "lit", "text": m.group(0)})

    pos = 0
    for s, e, cls in sorted(spans):
        if s < pos:
            continue
        emit(text[pos:s], pos)
        out.append({"kind": "wild", "cls": cls})
        pos = e
    emit(text[pos:], pos)
    return out


def _ws_pattern(ws: str) -> str:
    """A run of whitespace as a pattern: a line break stays a line break (the
    structure of the output is compared) with its padding free; a run of
    spaces stays at least one. A table's column padding follows the widths of
    the numbers -- the very thing the row does not compare."""
    if "\n" in ws:
        return r"[ \t]*\r?\n[ \t]*" * ws.count("\n")
    return r"[ \t\f\v]+" if ws[0] in " \t\f\v" else r"\s+"


def _line_runs(line: str, spans: list[tuple[int, int, str]]) -> list[dict]:
    """One reference line cut by its tolerated spans: an ordered list of runs
    -- `lit` (text that stays compared, spaces included), `ws` (a run of
    whitespace that TOUCHES a masked value: its width follows the value's, so
    it is read « at least one »), `wild` (the masked value). The whitespace
    away from a masked value is part of a `lit` run: compared exactly, as the
    strict rule does. A span may cut a word (`33.7` + `ms,`)."""
    units: list[dict] = []

    def emit(chunk: str) -> None:
        for m in re.finditer(r"\s+|\S+", chunk):
            units.append({"kind": "ws" if m.group(0)[0].isspace() else "lit",
                          "text": m.group(0)})

    pos = 0
    for s, e, cls in sorted(spans):
        if s < pos:
            continue                            # overlapping spans: the first holds
        emit(line[pos:s])
        units.append({"kind": "wild", "cls": cls})
        pos = e
    emit(line[pos:])
    runs: list[dict] = []
    for n, u in enumerate(units):
        touches = u["kind"] == "ws" and any(
            0 <= j < len(units) and units[j]["kind"] == "wild" for j in (n - 1, n + 1))
        if u["kind"] == "wild" or touches:
            runs.append(u)
        elif runs and runs[-1]["kind"] == "lit":
            runs[-1]["text"] += u["text"]
        else:
            runs.append({"kind": "lit", "text": u["text"]})
    return runs


def _runs_pattern(runs: list[dict], captured: int = -1, line: bool = True) -> str:
    """The regex of a run sequence: every `lit` escaped exactly (the captured
    one in group 1), `ws` at least one space, `wild` a non-capturing class.
    A line pattern is anchored on its own line (`(?m:^…$)`, CRLF tolerated)."""
    parts = []
    for n, r in enumerate(runs):
        if r["kind"] == "wild":
            parts.append("(?:" + r["cls"] + ")")
        elif r["kind"] == "ws":
            parts.append(r"[ \t\f\v]+" if r["text"][0] in " \t\f\v" else r"\s+")
        elif n == captured:
            parts.append("(" + re.escape(r["text"]) + ")")
        else:
            parts.append(re.escape(r["text"]))
    if line:
        return r"(?m:^" + "".join(parts) + r"[ \t]*\r?$)"
    return "".join(parts)


def _mask_patterns(mid: str, seg_pattern: str, text: str,
                   spans: list[tuple[int, int, str]]) -> list[dict] | None:
    """The measures of a masked segment, `[{"id", "piece", "pattern", "kind",
    "line"}]`: one per LINE of the reference that keeps compared text (a line
    cut by a masked value gives one per compared run), plus one for the whole
    segment -- its order of lines and tokens, the first compared text captured
    (a line more, a line less, a moved token: none of them is a tolerated
    value)."""
    if seg_pattern.count("(.*?)") != 1:
        return None
    left, right = seg_pattern.split("(.*?)")
    out: list[dict] = []
    base = 0
    for n, line in enumerate(text.split("\n"), 1):
        ls, le = base, base + len(line)
        base = le + 1
        if not line.strip():
            continue
        mine = [(max(s, ls) - ls, min(e, le) - ls, cls)
                for s, e, cls in spans if s < le and e > ls]
        runs = _line_runs(line, mine)
        lits = [k for k, r in enumerate(runs) if r["kind"] == "lit" and r["text"].strip()]
        for q, k in enumerate(lits, 1):
            one = len(lits) == 1
            out.append({"id": f"{mid}_l{n}" if one else f"{mid}_l{n}p{q}",
                        "kind": "ligne" if one else "partie", "line": n,
                        "piece": runs[k]["text"].strip(),
                        "pattern": _runs_pattern(runs, k)})
    pieces = _mask_pieces(text, spans)
    lits = [p for p in pieces if p["kind"] == "lit"]
    if not lits:
        return None                        # nothing left to compare: never a mask
    parts = []
    for p in pieces:
        if p is lits[0]:
            parts.append("(" + re.escape(p["text"]) + ")")
        elif p["kind"] == "lit":
            parts.append(re.escape(p["text"]))
        elif p["kind"] == "wild":
            parts.append("(?:" + p["cls"] + ")")
        else:
            parts.append(_ws_pattern(p["text"]))
    out.append({"id": f"{mid}_structure", "kind": "structure", "line": 0,
                "piece": lits[0]["text"],
                "pattern": left + r"\s*" + "".join(parts) + r"\s*" + right})
    return out


def _masked_segment(mid: str, cell: int, seg: dict, got: str, rs_txt: str, py_txt: str,
                    mask_rows: list[dict], spec_ref: str | None, cs_out: dict | None,
                    cs_code: set[int]) -> dict | None:
    """The strict measure of a segment replaced by the masked measures under
    the cell's mask rows: `{"measures", "divergence", "masked"}`, or `None`
    when the organ cannot model the segment (the caller keeps today's path).
    `divergence` is None only when every measure reads back on the Rust side."""
    py_n = seg["text"].replace("\r\n", "\n")
    rs_n = got.replace("\r\n", "\n")
    at = f" ({spec_ref}, Tolerances, cellule {cell})" if spec_ref else ""
    tol = " ; ".join(" ".join(str(r.get("tolerance") or r.get("compare") or "").split())
                     for r in mask_rows)
    spans, rs_spans, broken = _spec_mask(py_n, rs_n, mask_rows)
    if broken:
        # The reason leads: the row that does not apply IS the cause, and a
        # message that opens on the tolerated difference hides it.
        return {"measures": [], "masked": None,
                "divergence": {"id": mid, "cell": cell, "text": (
                    f"ligne de tolérance non applicable{at} : {' ; '.join(broken)}"
                    f" -- la cellule reste comparée strictement ; premier écart : "
                    f"{_first_diff(seg['text'], got)}")}}
    pats = _mask_patterns(mid, seg["pattern"], py_n, spans)
    if pats is None or any(_extract(py_txt, p["pattern"]) != p["piece"] for p in pats):
        return None                    # generator limit: the strict measure stays
    failing = [p["id"] for p in pats if _extract(rs_txt, p["pattern"]) != p["piece"]]
    measures: list[dict] = []
    for p in pats:
        head = f"Sortie de la cellule {cell}"
        if p["kind"] == "structure":
            desc = (f"{head} : ordre des lignes et des jetons identique au jumeau Python"
                    f" (tolérance « {tol} »{at} : la valeur qu'elle nomme est masquée, "
                    "jamais comparée)")
        else:
            where = (f", ligne {p['line']}" if p["kind"] == "ligne"
                     else f", ligne {p['line']}, partie {p['id'].rsplit('p', 1)[1]}")
            desc = (f"{head}{where} : texte identique au jumeau Python hors de la valeur"
                    f" masquée (tolérance « {tol} »{at})")
        sides: dict = {"python": {"cell": cell, "pattern": p["pattern"], "transform": "text"},
                       "rust": {"cell": cell, "pattern": p["pattern"], "transform": "text"}}
        if cs_out is not None:
            cs_txt = cs_out.get(cell)
            cs_got = _extract(cs_txt, p["pattern"]) if cs_txt else None
            if cs_got == p["piece"]:
                sides["csharp"] = {"cell": cell, "pattern": p["pattern"], "transform": "text"}
            else:
                gap = _csharp_gap(cell, cs_txt, cs_got, p["piece"], cs_code)
                sides["csharp"] = {"absent": (
                    f"{gap} : côté déclaré absent, mesuré à la génération ; "
                    "la comparaison stricte porte sur Python et Rust.")}
        measures.append({"id": p["id"], "description": desc, "tolerance": 0,
                         "reference": "python", "sides": sides})
    divergence = None
    if failing:
        shown = ", ".join(failing[:4]) + (" …" if len(failing) > 4 else "")
        first = next(p for p in pats if p["id"] == failing[0])
        divergence = {"id": mid, "cell": cell, "text": (
            f"la tolérance{at} ne couvre que la valeur qu'elle nomme, le reste est "
            f"comparé : {len(failing)} mesure(s) en échec ({shown}) ; la première : "
            f"{_masked_fail_detail(first, py_n, rs_n, spans, rs_spans)}")}
    return {"measures": measures, "masked": {"id": mid, "cell": cell,
            "reason": f"valeur non comparée, déclarée par la spec{at} : {tol}"},
            "divergence": divergence}


def _conformance_core(py_path: Path, rs_path: Path, cs_path: Path | None,
                      spec_body: str | None = None,
                      spec_ref: str | None = None) -> dict:
    """Measures + Rust divergences + generator skips, from three notebook paths
    (the stage-3 gate calls it on the BUILT notebook, before any commit).

    `spec_body` (optional): the lot spec's issue body. Its `## Tolerances`
    table, when present, DOWNGRADES the strict-text rule per cell -- an
    invariants row is never strictly measured, a mixed row keeps the strict
    measure only where it already matches, a durations row tolerates
    numeric-only gaps. A spec-declared side is written `absent:` with the spec
    row quoted (reported by the checker, never a failure) and named in
    `spec_absent`/`skipped` so the PR body says it. `spec_ref` (e.g. `#28072`)
    anchors the motif back to the issue.

    A mask row (`non comparée`, `forme seulement`, `écart déclaré`) works the
    other way round: the cell STAYS measured, under one pattern per piece that
    masks the value the row names and compares everything else
    (`_masked_segment`); the replaced measure is named in `spec_masked`."""
    py_out = notebook_outputs(py_path)
    rs_out = notebook_outputs(rs_path)
    cs_out = notebook_outputs(cs_path) if cs_path is not None and Path(cs_path).is_file() else None
    rich = rich_output_cells(py_path)
    tolerances = parse_spec_tolerances(spec_body)
    all_rows = parse_spec_tolerance_rows(spec_body)
    measures: list[dict] = []
    divergences: list[dict] = []
    skipped: list[str] = []
    spec_absent: list[dict] = []
    spec_masked: list[dict] = []
    cs_code = set(cs_out) if cs_out is not None else set()
    for i in sorted(py_out):
        if not py_out[i].strip():
            continue
        if i in rich:
            skipped.append(f"c{i}: sortie riche côté Python (figure/HTML), non mesurée")
            continue
        if NONDETERMINISTIC_RE.search(py_out[i]):
            skipped.append(f"c{i}: adresse mémoire dans la sortie Python, non mesurée")
            continue
        if is_env_banner(py_out[i]):
            skipped.append(f"c{i}: bannière d'environnement (versions) côté Python, non mesurée")
            continue
        row = tolerances.get(i)
        kind = spec_row_kind(row)
        segs = _segments(py_out[i])
        rs_txt = rs_out.get(i)
        for k, seg in enumerate(segs):
            mid = f"c{i}_text" if len(segs) == 1 else f"c{i}_seg{k + 1}"
            desc = (f"Sortie de la cellule {i}, texte identique au jumeau Python"
                    + (f" (segment {k + 1}/{len(segs)} ; durées murales en présence "
                       "seule, valeurs jamais comparées)" if seg["durations"] else ""))
            if _extract(py_out[i], seg["pattern"]) != seg["text"]:
                # The reference side cannot read its own pattern: a generator
                # limit (an output shape it does not model), never a measure.
                skipped.append(f"{mid}: motif non relu côté Python, mesure non écrite")
                continue
            sides: dict = {"python": {"cell": i, "pattern": seg["pattern"], "transform": "text"},
                           "rust": {"cell": i, "pattern": seg["pattern"], "transform": "text"}}
            got = _extract(rs_txt, seg["pattern"]) if rs_txt else None
            strict_ok = got == seg["text"]
            absent_reason: str | None = None
            if kind == "invariants":
                absent_reason = _spec_absent_reason(kind, i, row, spec_ref)
            elif kind == "mixed" and not strict_ok:
                absent_reason = _spec_absent_reason(kind, i, row, spec_ref)
            elif (kind == "duration" and not strict_ok and got is not None
                  and _durations_only_diff(seg["text"], got)):
                absent_reason = _spec_absent_reason(kind, i, row, spec_ref)
            masked = None
            mask_rows = [r for r in all_rows.get(i, []) if _spec_one_row_kind(r) in _MASK_KINDS]
            if not strict_ok and got is not None and absent_reason is None and mask_rows:
                masked = _masked_segment(mid, i, seg, got, rs_txt, py_out[i], mask_rows,
                                         spec_ref, cs_out, cs_code)
            if masked is not None and masked["masked"] is not None:
                # The mask holds and every piece is written: the cell stays
                # measured, only the named value is never compared.
                measures.extend(masked["measures"])
                if masked["divergence"] is not None:
                    divergences.append(masked["divergence"])
                spec_masked.append(masked["masked"])
                skipped.append(f"{mid}: {masked['masked']['reason']} -- "
                               f"{len(masked['measures'])} morceaux mesurés")
                continue
            if masked is not None and masked["divergence"] is not None:
                divergences.append(masked["divergence"])
            elif absent_reason is not None:
                # Fail-closed stays readable: the spec's own contract replaces
                # the strict measure, the motif quotes the row, the checker
                # reports the absent side without failing on it.
                sides["rust"] = {"absent": absent_reason}
                desc += " ; côté Rust déclaré absent (contrat de la spec)"
                skipped.append(f"{mid}: côté Rust déclaré absent -- {absent_reason}")
                spec_absent.append({"id": mid, "cell": i, "reason": absent_reason})
            elif not strict_ok:
                text = ("la cellule Rust n'imprime rien" if not rs_txt
                        else "les lignes-ancres de durée du segment Python manquent"
                        if got is None else _first_diff(seg["text"], got))
                held = [r for r in all_rows.get(i, [])
                        if _spec_one_row_kind(r) in ("invariants", "mixed")]
                if held:
                    # `spec_rows_kind` kept the cell strict: an exact row of the
                    # same cell holds these rows to strict too. Named, with the
                    # way out -- a tolerated quantity is WRITTEN as a mask.
                    where = f" ({spec_ref}, Tolerances, cellule {i})" if spec_ref else ""
                    quoted = " ; ".join("« " + " ".join(str(
                        r.get("tolerance") or r.get("compare") or "").split())[:90] + " »"
                        for r in held)
                    text += (f" ; tenues pour strictes{where}, une ligne exacte de la même"
                             f" cellule : {quoted} -- une grandeur tolérée à côté de compteurs"
                             " exacts s'écrit « non comparée », « forme seulement » ou"
                             " « écart déclaré »")
                divergences.append({"id": mid, "cell": i, "text": text})
            if cs_out is not None:
                cs_txt = cs_out.get(i)
                cs_got = _extract(cs_txt, seg["pattern"]) if cs_txt else None
                if cs_got == seg["text"]:
                    sides["csharp"] = {"cell": i, "pattern": seg["pattern"], "transform": "text"}
                else:
                    gap = _csharp_gap(i, cs_txt, cs_got, seg["text"], cs_code)
                    sides["csharp"] = {"absent": (
                        f"{gap} : côté déclaré absent, mesuré à la génération ; "
                        "la comparaison stricte porte sur Python et Rust.")}
            measures.append({"id": mid, "description": desc, "tolerance": 0,
                             "reference": "python", "sides": sides})
        if cs_out is not None and rs_txt and cs_out.get(i):
            py_l, rs_l, cs_l = (_label_lines(py_out[i]), _label_lines(rs_txt),
                                _label_lines(cs_out[i]))
            for label, value in py_l.items():
                if rs_l.get(label) != value or cs_l.get(label) != value:
                    continue
                # The whole pattern sits in the multiline group: a bare `$`
                # outside it means end-of-cell under the checker's DOTALL
                # search, so only a cell's LAST line would ever match.
                pat = r"(?m:^" + re.escape(label) + r"[ \t]+([^\n]*?)[ \t]*\r?$)"
                # Self-check with the checker's own extraction on all three
                # sides: a measure the organ cannot read is never written.
                if any(_extract(t, pat) != value for t in (py_out[i], rs_txt, cs_out[i])):
                    continue
                lid = f"c{i}_{_ascii_slug(label)[:40] or 'ligne'}"
                if any(m["id"] == lid for m in measures):
                    continue
                measures.append({
                    "id": lid,
                    "description": f"« {label} » de la cellule {i}, même valeur sur les trois côtés",
                    "tolerance": 0, "reference": "python",
                    "sides": {s: {"cell": i, "pattern": pat, "transform": "text"}
                              for s in ("python", "csharp", "rust")}})
    return {"measures": measures, "divergences": divergences, "skipped": skipped,
            "spec_absent": spec_absent, "spec_masked": spec_masked,
            "has_csharp": cs_out is not None}


def conformance_divergences(py_path: Path, rs_path: Path,
                            spec_body: str | None = None,
                            spec_ref: str | None = None) -> list[dict]:
    """Rust cells whose output differs from the Python twin's same-index cell,
    as the registry entry written at delivery would measure them. Stage-3 gate
    input: a divergence found here is repaired BEFORE the PR, not by review.
    `spec_body` (a lot spec's `## Tolerances` table) keeps its declared
    contracts out of the divergences -- a stochastic port is judged by its
    spec, not by text it can never reproduce."""
    return _conformance_core(py_path, rs_path, None, spec_body=spec_body,
                             spec_ref=spec_ref)["divergences"]


def build_conformance_entry(worktree: Path, nb_rel: str, source_rel: str,
                            spec_body: str | None = None,
                            spec_ref: str | None = None) -> dict:
    """The `rust_conformance.d` entry of an nb_coder Rust port, from the
    COMMITTED outputs of the port and its twins (CoursIA c0018, 21/11: the
    lot-1 specs require it at delivery and every PR without it came back).

    Correspondence by cell INDEX: an nb_coder port keeps its Python twin's
    cell structure (the twin-parity seal checks it), and the lot specs compare
    "sortie Python cellule N" to Rust cell N. One measure per code cell the
    Python twin prints something in, strict text equality (tolerance 0);
    duration lines split the cell into segments and are matched by presence
    only. The entry is written whether or not the sides agree: a divergence is
    the checker's finding, never smoothed here (fail-closed). The C# side is
    compared where its aligned cell prints the same text, else DECLARED absent
    with the measured gap; lines `label : value` identical on all three sides
    add three-sided measures anchored on the label.

    `spec_body`: the lot spec's issue body. Its `## Tolerances` table (a
    stochastic contract, CoursIA#28072) declares some cells judged by
    invariants or with durations in presence only -- those Rust sides are
    written `absent:` quoting the spec row instead of the strict measure, and
    named in `spec_absent` (the checker reports an absent side, it never fails
    on one)."""
    worktree = Path(worktree)
    nb_rel = nb_rel.replace("\\", "/")
    source_rel = source_rel.replace("\\", "/")
    base, _ = split_port_name(nb_rel)
    cs_rel = (Path(nb_rel).parent / f"{base}-CSharp.ipynb").as_posix()
    core = _conformance_core(worktree / source_rel, worktree / nb_rel,
                             worktree / cs_rel if (worktree / cs_rel).is_file() else None,
                             spec_body=spec_body, spec_ref=spec_ref)
    measures = core["measures"]
    entry = {"name": base,
             "family": Path(nb_rel).parent.as_posix().replace("MyIA.AI.Notebooks/", "", 1),
             "python": source_rel}
    if core["has_csharp"]:
        entry["csharp"] = cs_rel
    entry["rust"] = nb_rel
    entry["measures"] = measures
    three = sum(1 for m in measures if "cell" in (m["sides"].get("csharp") or {}))
    return {"file": conformance_file(nb_rel).as_posix(), "entry": entry,
            "measures": len(measures), "three_sided": three,
            "csharp": cs_rel if core["has_csharp"] else None,
            "divergences": core["divergences"], "skipped": core["skipped"],
            "spec_absent": core["spec_absent"], "spec_masked": core["spec_masked"]}


def _yq(s) -> str:
    """YAML scalar: a JSON string is a valid YAML double-quoted scalar."""
    return json.dumps(s, ensure_ascii=False) if isinstance(s, str) else json.dumps(s)


def render_conformance_yaml(built: dict) -> str:
    """Stdlib YAML of one registry entry (the module stays import-free; the
    tests load it back with PyYAML)."""
    e = built["entry"]
    head = [
        f"# Conformité différentielle de {e['name']} (portage Rust nb_coder).",
        "#",
        "# Écrite à la livraison par nb_coder_integrate depuis les sorties COMMITÉES",
        "# des carnets : correspondance par index de cellule (le portage garde la",
        "# structure de cellules du jumeau Python, scellée par twin-parity), une",
        "# mesure par cellule qui imprime côté Python, égalité stricte du texte ;",
        "# les lignes de durée murale sont des ancres en présence seule. Le côté",
        "# C# est comparé où sa cellule alignée imprime le même texte, sinon",
        "# déclaré absent avec l'écart mesuré. À corriger À LA MAIN si une",
        "# divergence est un écart d'API documenté : le fichier n'est jamais",
        "# réécrit par l'outil une fois présent.",
    ]
    # The cells the generator chose NOT to measure, with the measured reason
    # (CoursIA#27818 review, 22/11: a PR comment said « motif écrit dans
    # l'entrée » and the entry carried none -- the generator knew it and
    # dropped it). Comments, not keys: the registry schema has no field for a
    # cell that is not a measure, and the repo's hand-written entries already
    # carry such motives as header comments (gametheory-04h-routing-poa).
    skipped = [" ".join(str(s).split()) for s in built.get("skipped") or []]
    if skipped:
        head += ["#", "# Cellules non mesurées (motif relevé à la génération) :"]
        head += [f"#   - {s}" for s in skipped]
    masked = [" ".join(str(m.get("reason") or "").split()) for m in built.get("spec_masked") or []]
    if masked:
        head += ["#", "# Valeurs non comparées (lignes de tolérance de la spec, appliquées",
                 "# comme un MASQUE : la mesure reste écrite, un morceau par jeton, la valeur",
                 "# nommée seule est masquée) :"]
        head += [f"#   - {m.get('id')} : {why}" for m, why in zip(built["spec_masked"], masked)]
    lines = head + [f"- name: {_yq(e['name'])}", f"  family: {_yq(e['family'])}",
                    f"  python: {e['python']}"]
    if e.get("csharp"):
        lines.append(f"  csharp: {e['csharp']}")
    lines += [f"  rust: {e['rust']}", "  measures:"]
    for m in e["measures"]:
        lines += [f"    - id: {m['id']}", f"      description: {_yq(m['description'])}",
                  f"      tolerance: {m['tolerance']}", f"      reference: {m['reference']}",
                  "      sides:"]
        for side in ("python", "rust", "csharp"):
            spec = m["sides"].get(side)
            if spec is None:
                continue
            lines.append(f"        {side}:")
            if "absent" in spec:
                lines.append(f"          absent: {_yq(spec['absent'])}")
            else:
                lines += [f"          cell: {spec['cell']}",
                          f"          pattern: {_yq(spec['pattern'])}",
                          f"          transform: {spec['transform']}"]
    return "\n".join(lines) + "\n"


def plan_conformance(worktree: Path, nb_rel: str, source_rel: str,
                     spec_body: str | None = None,
                     spec_ref: str | None = None) -> dict:
    """Plan the registry entry of a Rust port: todo when the file is missing.
    An existing file is NEVER rewritten -- a human correction (an API gap
    declared by hand) must survive a re-run (idempotence + authorship).
    `spec_body`/`spec_ref` thread the lot spec's `## Tolerances` contract into
    the generated entry (see `build_conformance_entry`)."""
    if not is_rust_port(nb_rel):
        return {"todo": False, "why": "not a Rust port"}
    worktree = Path(worktree)
    rel = conformance_file(nb_rel)
    if (worktree / rel).is_file():
        return {"todo": False, "file": rel.as_posix(), "why": "entry already present"}
    if not (worktree / RUST_CONFORMANCE_DIR).is_dir():
        return {"todo": False, "why": f"no {RUST_CONFORMANCE_DIR.as_posix()} in the repo"}
    built = build_conformance_entry(worktree, nb_rel, source_rel,
                                    spec_body=spec_body, spec_ref=spec_ref)
    return {"todo": True, "path": str(worktree / rel), "text": render_conformance_yaml(built),
            **{k: v for k, v in built.items() if k != "entry"}}


def apply_conformance(plan: dict) -> bool:
    if not plan.get("todo"):
        return False
    Path(plan["path"]).write_text(plan["text"], encoding="utf-8", newline="\n")
    return True


# ------------------------------------------------------------------ guards

def replay_guards(worktree: Path, notebook: str | None = None) -> list[dict]:
    """Replay the guards with the exact commands the lot-1 review
    comments published. Read-only against git; run AFTER the integration
    commits so `--diff-base origin/main` sees them. A Rust port with a
    registry entry also replays the differential conformance organ on it
    (`--entry <slug>.yaml`: fail-closed when the entry does not exist)."""
    guards = list(GUARDS)
    if notebook and is_rust_port(notebook) and (Path(worktree) / conformance_file(notebook)).is_file():
        guards.append(("rust-conformance",
                       [CONFORMANCE_CHECKER, "--entry", conformance_file(notebook).name]))
    out = []
    for name, cmd in guards:
        try:
            proc = run_guard_bounded(cmd, cwd=worktree, timeout=GUARD_TIMEOUT_S,
                                     grace=GUARD_KILL_GRACE_S)
        except OSError as e:                      # sys.executable unusable: recorded, not fatal
            out.append({"guard": name, "cmd": " ".join(["python", *cmd]), "rc": None,
                        "tail": f"{type(e).__name__}: {e}"[:GUARD_TAIL_CAP], "timed_out": False})
            continue
        tail = (proc.stdout or "")[-GUARD_TAIL_CAP:]
        timed_out = bool(getattr(proc, "timed_out", False))
        if timed_out:
            tail = _tail_with_prefix(_timed_out_note(proc, GUARD_TIMEOUT_S), proc.stdout or "")
        out.append({"guard": name, "cmd": " ".join(["python", *cmd]),
                    "rc": proc.returncode, "tail": tail, "timed_out": timed_out})
    return out


# ------------------------------------------------------------------ integrate

def integrate(worktree: Path, notebook: str, source_nb: str,
              spec_body: str | None = None, spec_ref: str | None = None) -> dict:
    """Apply the two file edits (README row + inbound nav link). Returns the
    plan for each plus the touched repo-relative files. Idempotent: on an
    already-integrated branch both plans report todo=False and nothing moves.
    `spec_body`/`spec_ref` thread the lot spec's `## Tolerances` contract into
    the conformance entry (declared-absent Rust sides instead of strict
    measures the spec itself does not ask for)."""
    worktree = Path(worktree)
    notebook = notebook.replace("\\", "/")
    source_nb = source_nb.replace("\\", "/")
    twin = worktree / source_nb
    if not twin.is_file():
        return {"error": f"source notebook not found: {source_nb}"}
    nav = plan_nav_link(twin, notebook, hot_cell_ids(worktree, source_nb))
    apply_nav_link(nav)
    back = plan_back_link(worktree, notebook, source_nb)
    apply_nav_link(back)
    readme = plan_readme_row(worktree, notebook, source_nb)
    apply_readme_row(readme)
    conf = plan_conformance(worktree, notebook, source_nb,
                            spec_body=spec_body, spec_ref=spec_ref)
    apply_conformance(conf)
    touched = ([source_nb] if nav.get("todo") else []) + \
              ([notebook] if back.get("todo") else []) + \
              ([readme["file"]] if readme.get("todo") else []) + \
              ([conf["file"]] if conf.get("todo") else [])
    return {"notebook": notebook, "source_nb": source_nb,
            "nav": {k: v for k, v in nav.items() if not k.startswith("_")},
            "back": {k: v for k, v in back.items() if not k.startswith("_")},
            "readme": {k: v for k, v in readme.items() if k != "path"},
            "conformance": _conformance_summary(conf),
            "pair": find_twin_pair(worktree, source_nb),
            "touched": touched}


def integration_commit_message(result: dict, lane: str) -> str:
    """Name only what `integrate` actually wrote. A retrofit that adds just the
    conformance entry to an already-integrated PR must not claim a README row
    and a nav edge: a reviewer reads the commit list to know what moved."""
    stem = Path(result["notebook"]).stem
    touched = set(result.get("touched") or [])
    parts, why = [], []
    if result.get("readme", {}).get("todo") and result["readme"].get("file") in touched:
        parts.append("ligne README")
        why.append("ligne README exigée par readme-notebook-coverage")
    if result.get("source_nb") in touched:
        parts.append("arête nav")
        why.append("arête entrante exigée par check-nav-chain (le jumeau Python ne "
                   "change qu'en markdown : barre/section Navigation)")
    if result.get("notebook") in touched:
        parts.append("lien retour")
        why.append("lien du nouveau carnet vers son jumeau d'origine (la barre "
                   "recopiée du jumeau ne peut pas le nommer ; markdown seul)")
    conf = result.get("conformance") or {}
    if conf.get("file") in touched:
        parts.append("entrée rust_conformance")
        why.append(f"entrée `{Path(conf['file']).name}` ({conf.get('measures', '?')} "
                   "mesure(s)) lue par check_rust_conformance.py")
    title = " + ".join(parts) or "intégration"
    return (f"Chore(integration): {title} pour {stem}\n\n"
            + "".join(f"- {w}\n" for w in why) + "\n"
            f"Lane: {lane}\n"
            "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>\n")


def _conformance_summary(plan: dict) -> dict:
    return {k: v for k, v in plan.items() if k not in ("path", "text", "entry")}


def plan_only(worktree: Path, notebook: str, source_nb: str,
              spec_body: str | None = None, spec_ref: str | None = None) -> dict:
    """--check-only: the same plans, zero writes."""
    worktree = Path(worktree)
    notebook = notebook.replace("\\", "/")
    source_nb = source_nb.replace("\\", "/")
    twin = worktree / source_nb
    if not twin.is_file():
        return {"error": f"source notebook not found: {source_nb}"}
    nav = plan_nav_link(twin, notebook, hot_cell_ids(worktree, source_nb))
    back = plan_back_link(worktree, notebook, source_nb)
    readme = plan_readme_row(worktree, notebook, source_nb)
    conf = plan_conformance(worktree, notebook, source_nb,
                            spec_body=spec_body, spec_ref=spec_ref)
    return {"notebook": notebook, "source_nb": source_nb,
            "nav": {k: v for k, v in nav.items()
                    if not k.startswith("_") and k != "file"},
            "back": {k: v for k, v in back.items()
                     if not k.startswith("_") and k != "file"},
            "readme": {k: v for k, v in readme.items() if k != "path"},
            "conformance": _conformance_summary(conf),
            "pair": find_twin_pair(worktree, source_nb),
            "todo": bool(nav.get("todo") or back.get("todo") or readme.get("todo")
                         or conf.get("todo"))}


# ------------------------------------------------------------------ sync-main

def owned_files(worktree: Path, notebook: str, source_nb: str) -> list[str]:
    """Paths whose conflicts --sync-main may resolve itself: the notebook
    folder's README(s), the source twin, the twin-pairs registry. Invariant:
    on an nb_coder branch those files carry ONLY this integration's edits,
    so taking origin/main's side then re-running it loses nothing."""
    notebook = notebook.replace("\\", "/")
    source_nb = source_nb.replace("\\", "/")
    folder = worktree / Path(notebook).parent
    owned = sorted(_rel(worktree, p) for p in folder.glob("README*.md"))
    owned.append(source_nb)
    owned.append(TWIN_PAIRS_DIR.as_posix())
    if is_rust_port(notebook):  # created by this integration only
        owned.append(conformance_file(notebook).as_posix())
    return owned


def merge_owned_conflicts(worktree: Path, owned: list[str]) -> dict:
    """`git merge origin/main` (no rebase, no force-push). Conflicts confined
    to `owned` paths are resolved by taking origin/main's version (the caller
    re-runs the integration on top, idempotently); ANY other conflict aborts
    the merge and reports. Testable without the guards."""
    rc, out = _git(worktree, "merge", "origin/main", "--no-edit")
    if rc == 0:
        return {"merged": True, "already_up_to_date": "Already up to date" in out,
                "output": out[-300:]}
    rc_u, conflicted = _git(worktree, "diff", "--name-only", "--diff-filter=U")
    paths = [p for p in conflicted.splitlines() if p.strip()]
    owned_ok = all(any(p == o or p.startswith(o.rstrip("/") + "/") for o in owned)
                   for p in paths)
    if not paths or not owned_ok:
        _git(worktree, "merge", "--abort")
        return {"merged": False, "aborted": True, "conflicts": paths,
                "output": out[-300:]}
    for p in paths:  # take origin/main's side, then the caller re-integrates
        _git(worktree, "restore", "--source=origin/main", "--staged",
             "--worktree", "--", p)
    return {"merged": True, "resolved_theirs": paths, "output": out[-300:]}


def sync_main(worktree: Path, notebook: str, source_nb: str, lane: str,
              facts: dict | None = None) -> dict:
    """--sync-main: fold origin/main into an existing PR branch, re-apply the
    integration (idempotent), re-seal LAST, replay the guards. Several grains
    in one folder edit adjacent README lines: the second PR to merge would
    otherwise conflict -- measured risk on the 4 Complexity grains queued by
    po-2028."""
    worktree = Path(worktree)
    merge = merge_owned_conflicts(worktree, owned_files(worktree, notebook, source_nb))
    if not merge.get("merged"):
        return {"merge": merge, "guards": replay_guards(worktree, notebook)}
    result = integrate(worktree, notebook, source_nb)
    for f in result.get("touched", []):
        _git(worktree, "add", "--", f)
    # A CLEAN `git merge` has already committed (rc 0): a bare `commit
    # --no-edit` then has no message to reuse and fails, leaving the
    # integration staged while the reseal reads a HEAD without it -- guards
    # replayed on the working tree said green on a branch whose push would
    # carry nothing (CoursIA#27900, 22/11). `--no-edit` only concludes a merge
    # still in progress (conflicts resolved from origin/main); otherwise the
    # integration gets its own commit, named after what it wrote.
    in_merge = _git(worktree, "rev-parse", "-q", "--verify", "MERGE_HEAD")[0] == 0
    if in_merge:
        rc_c, out_c = _git(worktree, *GIT_IDENTITY, "commit", "--no-edit")
    elif result.get("touched"):
        rc_c, out_c = _git(worktree, *GIT_IDENTITY, "commit", "-m",
                           integration_commit_message(result, lane))
    else:
        rc_c, out_c = 0, ""
    if rc_c != 0 or result.get("error"):
        return {"merge": merge, "integration": result,
                "commit_error": out_c[-300:] if rc_c != 0 else None,
                "guards": replay_guards(worktree, notebook)}
    return {"merge": merge, "integration": result,
            "reseal": _reseal_after(worktree, notebook, source_nb, lane, facts),
            "guards": replay_guards(worktree, notebook)}


def _reseal_after(worktree: Path, notebook: str, source_nb: str, lane: str,
                  facts: dict | None) -> dict | None:
    """Register (C# first delivery) then re-seal, and commit the registry
    writes so the guards read them at HEAD."""
    reg = register_pair(worktree, source_nb, notebook, lane, facts)
    pair = find_twin_pair(worktree, source_nb)
    if not pair:
        return {"registered": reg, "why": "no pair to seal"}
    reseal = reseal_pair(worktree, pair, lane)
    if reg.get("registered") or reseal.get("audit_files"):
        _git(worktree, "add", "--", TWIN_PAIRS_DIR.as_posix())
        msg = (f"Chore(twin-parity): rescelle « {pair} » après intégration "
               f"({Path(notebook).stem})\n\nAttestation écrite en DERNIÈRE "
               "opération, après carnet, ligne README et lien de navigation.\n\n"
               f"Lane: {lane}\n"
               "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>\n")
        _git(worktree, *GIT_IDENTITY, "commit", "-m", msg)
    return {"registered": reg, "reseal": reseal}


# ------------------------------------------------------------------ cli

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Integrate an nb_coder port notebook into the repo's "
                    "guards (README row, inbound nav link, twin-parity reseal).")
    ap.add_argument("--worktree", required=True, help="CoursIA worktree root")
    ap.add_argument("--notebook", required=True,
                    help="repo-relative path of the NEW notebook")
    ap.add_argument("--source-nb", required=True, dest="source_nb",
                    help="repo-relative path of its Python source twin")
    ap.add_argument("--check-only", action="store_true",
                    help="plan only: report what would change, write nothing")
    ap.add_argument("--sync-main", action="store_true", dest="sync_main",
                    help="existing PR branch: merge origin/main (no rebase), "
                         "resolve integration-owned conflicts from origin/main, "
                         "re-apply, re-seal, replay guards")
    ap.add_argument("--by", default="myia-ai-01:vllm",
                    help="lane identity for the twin-parity reseal")
    ap.add_argument("--facts", default=None,
                    help="JSON delivery facts for the C# pair registration "
                         "(kernel, executed_cells, verdict; optional kernel_read=true "
                         "when no execution was recorded: the kernel was read, not measured)")
    args = ap.parse_args(argv)
    wt = Path(args.worktree)
    facts = json.loads(args.facts) if args.facts else None

    if args.check_only:
        result = plan_only(wt, args.notebook, args.source_nb)
        result["guards"] = replay_guards(wt, args.notebook)
        print(json.dumps(result, ensure_ascii=False, indent=1))
        return 0 if not result.get("todo") else 1

    if args.sync_main:
        result = sync_main(wt, args.notebook, args.source_nb, args.by, facts)
        result["guards"] = result.get("guards") or replay_guards(wt, args.notebook)
        print(json.dumps(result, ensure_ascii=False, indent=1, default=str))
        return 0 if (result.get("merge", {}).get("merged")
                     and not result.get("commit_error")
                     and not (result.get("integration") or {}).get("error")
                     and all(g["rc"] == 0 for g in result["guards"])) else 1

    result = integrate(wt, args.notebook, args.source_nb)
    if result.get("error"):
        print(json.dumps(result, ensure_ascii=False, indent=1))
        return 2
    for f in result["touched"]:
        _git(wt, "add", "--", f)
    if result["touched"]:
        _git(wt, *GIT_IDENTITY, "commit", "-m", integration_commit_message(result, args.by))
    result["reseal"] = _reseal_after(wt, args.notebook, args.source_nb,
                                     args.by, facts)
    result["guards"] = replay_guards(wt, args.notebook)
    print(json.dumps(result, ensure_ascii=False, indent=1, default=str))
    return 0 if all(g["rc"] == 0 for g in result["guards"]) else 1


if __name__ == "__main__":
    sys.exit(main())
