#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_error_digest.py
# Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
# jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree.
# -----------------------------------------------------------------------------
"""Offline tests for the repair round's error digest — #27134 (2.3c), 2026-11-21.

evcxr reports every rustc diagnostic as its own `error` output, lints included. Cell 24 of
the 2.3c Rust twin carried 31 of them: 11,538 characters with 156 ANSI codes, for about
ten distinct causes. The repair round showed `errs[-2000:]`, which started in the middle
of a diagnostic and held three of them, the same three every round, and the grain spent
its three rounds without ever seeing the missing `Distribution` import that rustc had
spelled out. The round now gets each distinct cause once, errors before warnings, inside
the same 2,000 characters."""

import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("nb_coder_driver", HERE / "nb_coder_driver.py")
d = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(d)


def _diag(msg, code=None, carets="^^^^", note="", helps=(), level="error"):
    """One evcxr `error` output, in the shape persisted on 2.3c (nb_27134_built.ipynb)."""
    tb = []
    if code is not None:
        tb += [code, code,  # evcxr prints the offending line twice
               f"\x1b[91m{carets}\x1b[0m \x1b[94m{level}: {note or msg}\x1b[0m"]
    tb += [f"\x1b[1mhelp\x1b[0m: {h}\n\n" for h in helps]
    tb.append(msg)
    return {"output_type": "error", "ename": "Error", "evalue": msg, "traceback": tb}


PARENS = "unnecessary parentheses around method argument"
SAMPLE = ("the method `sample` exists for struct `rand_distr::Normal<{float}>`, but its "
          "trait bounds were not satisfied")
SHUFFLE = "no method named `shuffle` found for struct `StdRng` in the current scope"
VT = "no field `vt` on type `SVD<f64, Dyn, Dyn>`"
MISMATCH = "mismatched types"
OUTER = "no method named `outer` found for struct `Matrix<T, R, C, S>` in the current scope"
DEPRECATED = ("use of deprecated method `nalgebra::base::matrix_view::<impl nalgebra::Matrix"
              "<T, R, C, S>>::slice`: Use view instead.")


def _cell_24():
    """2.3c cell 24, reduced: the lints come first, the import hint sits mid-list, and the
    long `mismatched types` diagnostics fill the tail."""
    outs = [_diag(PARENS, helps=["remove these parentheses"]) for _ in range(12)]
    outs += [_diag(SAMPLE, f"    let bruit_y: Vec<f64> = (0..N).map(|_| normal.sample({r})).collect();",
                   "^^^^^^", helps=[
                       "items from traits can only be used if the trait is in scope",
                       "trait `Distribution` which provides `sample` is implemented but not "
                       "in scope; perhaps you want to import it\n\nuse rand_distr::Distribution;"])
             for r in ("&mut rng", "rng", "&mut rng2")]
    outs += [_diag(SHUFFLE, f"    {v}.shuffle(&mut idx);", "^^^^^^^", "method not found in `StdRng`")
             for v in ("rng", "rng_cv")]
    outs += [_diag(VT, f"    let vk = svd.vt.slice((0..k), (0..{p}));", "^^") for p in ("P", "Q", "R")]
    for k in range(5):
        code = f"        let d{k} = u.dot(&x_res * &w);"
        outs.append(_diag(MISMATCH, code, "^" * 11,
                          "expected `&Matrix<f64, _, _, _>`, found `Matrix<f64, Dyn, Const<1>, "
                          "VecStorage<f64, Dyn, Const<1>>>` " + "x" * 120,
                          helps=["consider borrowing here\n\n&("]))
    outs.append(_diag(OUTER, "        x_res -= &ts.outer(&w);", "^^^^^",
                      "method not found in `Matrix<f64, Dyn, nalgebra::Const<1>>`"))
    return {"cell_type": "code", "source": "", "outputs": outs}


def test_the_old_tail_never_showed_the_import_rustc_had_spelled_out():
    cell = _cell_24()
    raw = d._outputs_text(cell)
    assert len(raw) > 4000
    assert "use rand_distr::Distribution;" not in raw[-2000:]   # what 2.3c's rounds saw
    digest = d.error_digest(cell, raw)
    assert "use rand_distr::Distribution;" in digest
    assert len(digest) <= d.REPAIR_ERRORS_CAP


def test_each_distinct_cause_is_shown_once_with_its_count():
    digest = d.error_digest(_cell_24(), d._outputs_text(_cell_24()))
    assert digest.startswith("26 diagnostics, 6 causes distinctes")
    for msg in (SAMPLE, SHUFFLE, VT, MISMATCH, OUTER, PARENS):
        assert msg in digest
    assert digest.count(f"- {SAMPLE} ×3") == 1
    assert digest.count(f"- {PARENS} ×12") == 1
    assert "\x1b" not in digest


def test_the_other_sites_of_a_cause_are_listed_by_their_code_line():
    digest = d.error_digest(_cell_24(), d._outputs_text(_cell_24()))
    assert "autres sites : `rng_cv.shuffle(&mut idx);`" in digest


def test_the_twice_printed_code_line_appears_once():
    cell = {"outputs": [_diag(VT, "    let vk = svd.vt;"), _diag(SHUFFLE, "    rng.shuffle(&mut v);")]}
    digest = d.error_digest(cell, d._outputs_text(cell))
    assert digest.count("let vk = svd.vt;") == 1


def test_errors_with_a_code_site_come_before_siteless_lints_and_warnings():
    cell = {"outputs": [_diag(PARENS, helps=["remove these parentheses"]),
                        _diag(DEPRECATED, "    let uk = u.slice((0..1), (0..k));", "^^^^^",
                              level="warning"),
                        _diag(VT, "    let vk = svd.vt;")]}
    digest = d.error_digest(cell, d._outputs_text(cell))
    assert digest.index(VT) < digest.index(PARENS) < digest.index(DEPRECATED)
    assert f"{DEPRECATED} [avertissement]" in digest
    assert f"{VT} [avertissement]" not in digest


def test_the_caret_line_does_not_repeat_the_message():
    cell = {"outputs": [_diag(VT, "    let vk = svd.vt;", "^^"), _diag(OUTER, "    a.outer(&b);")]}
    digest = d.error_digest(cell, d._outputs_text(cell))
    assert digest.count(VT) == 1


def test_causes_that_do_not_fit_are_named_never_dropped():
    outs = [_diag(f"no method named `m{k}` found for struct `S` in the current scope",
                  f"    s.m{k}();", "^^", "x" * 500) for k in range(12)]
    cell = {"outputs": outs}
    digest = d.error_digest(cell, d._outputs_text(cell))
    assert len(digest) <= d.REPAIR_ERRORS_CAP
    assert "autre(s) cause(s) non détaillée(s)" in digest
    named = sum(f"`m{k}`" in digest for k in range(12))
    assert named == 12 or "de plus" in digest


def test_a_single_traceback_keeps_its_tail():
    """IPython / .NET: one error output whose decisive line is the last one."""
    tb = "Traceback (most recent call last):\n" + "  frame\n" * 400 + "ValueError: boom"
    cell = {"outputs": [{"output_type": "error", "ename": "ValueError", "evalue": "boom",
                         "traceback": [tb]}]}
    raw = d._outputs_text(cell)
    assert d.error_digest(cell, raw) == raw[-2000:]
    assert d.error_digest({"outputs": []}, "panicked at x") == "panicked at x"


def test_the_repair_detail_carries_the_digest():
    """The repair loop builds its prompt from the persisted outputs through error_digest."""
    src = (HERE / "nb_coder_driver.py").read_text(encoding="utf-8")
    assert '"errors": error_digest(cells_now[i], errs)' in src
    assert '"errors": errs[-2000:]' not in src
