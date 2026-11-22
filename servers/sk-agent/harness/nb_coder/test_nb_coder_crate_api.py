#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_crate_api.py
# Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
# jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree.
# -----------------------------------------------------------------------------
"""Offline tests for crate-API grounding of Rust repair rounds — 2026-11-20.

MGS-25 (#27133) spent three repair rounds on `rng.next_f64()` under `:dep rand = "0.10"`:
the compiler's only hint was "there is a method `next_u64`", and the model's memory of
rand stops at 0.8. rand 0.10 moved sampling to the extension trait `RngExt`. 2.3b (#27134)
failed the same way on linfa (`GaussianNb::params()`, not `default()`) and plotters
(`BitMapBackend`, behind the `bitmap_backend` feature). A Rust repair round now quotes the
real API from the registry copy the kernel compiled.

The fake registry below copies its lines verbatim from the real registry sources
(rand-0.10.4, linfa-bayes-0.8.1, plotters-0.3.7); the error texts are verbatim from the
built notebooks of runs issue-27133-00084896 and issue-27134."""

import asyncio
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("nb_coder_driver", HERE / "nb_coder_driver.py")
d = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(d)

# Verbatim: run issue-27133-00084896, cell 4, first error output's traceback.
ERR_RAND = ["        .map(|_| (0..n_genes).map(|_| 1.0 + rng.next_f64() * 9.0).collect())",
            "\x1b[91m                                                ^^^^^^^^\x1b[0m \x1b[94merror: "
            "no method named `next_f64` found for struct `StdRng` in the current scope\x1b[0m",
            "no method named `next_f64` found for struct `StdRng` in the current scope",
            "\x1b[1mhelp\x1b[0m: there is a method `next_u64` with a similar name\n\nnext_u64"]
# Verbatim evalues: run issue-27134.
EV_GNB = ("no associated function or constant named `default` found for struct "
          "`GaussianNb<F, L>` in the current scope")
EV_BITMAP = "cannot find type `BitmapBackend` in this scope"
EV_AXIS = "cannot find type `DesiredAxis` in this scope"
EV_DRAW = ("no method named `draw` found for struct `plotters::series::LineSeries<DB, Coord>` "
           "in the current scope")
# Verbatim: run issue-27134, cell 1.
DEPS_23B = (':dep ndarray = "0.17"\n:dep rand = "0.8"\n:dep rand_distr = "0.4"\n'
            ':dep linfa = "0.8"\n:dep linfa-bayes = "0.8"\n:dep linfa-linear = "0.8"\n'
            ':dep plotters = { version = "0.3", default-features = false, features = '
            '["evcxr", "line_series"] }')

RAND_LIB = """//! Random-number generators and samplers
pub use rand_core;

pub use rand_core::{CryptoRng, Rng, SeedableRng, TryCryptoRng, TryRng};

pub mod distr;
pub mod prelude;
mod rng;
pub mod rngs;
pub mod seq;

pub use rng::{Fill, RngExt};
"""
RAND_RNG = """use rand_core::{Rng, TryRng};

/// User-level interface for RNGs
pub trait RngExt: Rng {
    /// Return a random value via the [`StandardUniform`] distribution.
    #[inline]
    fn random<T>(&mut self) -> T
    where
        StandardUniform: Distribution<T>,
    {
        StandardUniform.sample(self)
    }

    #[track_caller]
    fn random_range<T, R>(&mut self, range: R) -> T
    where
        T: SampleUniform,
        R: SampleRange<T>,
    {
        assert!(!range.is_empty(), "cannot sample empty range");
        range.sample_single(self).unwrap()
    }

    fn random_bool(&mut self, p: f64) -> bool {
        match distr::Bernoulli::new(p) {
            Ok(d) => self.sample(d),
            Err(_) => panic!("p={:?} is outside range [0.0, 1.0]", p),
        }
    }
}

impl<R: Rng + ?Sized> RngExt for R {}

pub trait Fill: Sized {
    fn fill_slice<R: Rng + ?Sized>(this: &mut [Self], rng: &mut R);
}
"""
RAND_STD = """pub struct StdRng(ChaCha12Rng);

impl TryRng for StdRng {
    type Error = core::convert::Infallible;
}

impl SeedableRng for StdRng {
    type Seed = [u8; 32];

    #[inline(always)]
    fn from_seed(seed: Self::Seed) -> Self {
        StdRng(ChaCha12Rng::from_seed(seed))
    }
}

impl TryCryptoRng for StdRng {}
"""
RAND_TOML = """[package]
name = "rand"
version = "0.10.4"

[features]
default = ["std", "std_rng", "sys_rng", "thread_rng"]
std = ["rand_core/std", "alloc"]
alloc = []
std_rng = ["dep:chacha20"]
sys_rng = ["dep:getrandom"]
thread_rng = ["std", "std_rng", "sys_rng"]
"""
GNB = """#[derive(Debug, Clone, PartialEq)]
pub struct GaussianNb<F: PartialEq, L: Eq + Hash> {
    class_info: HashMap<L, GaussianClassInfo<F>>,
}

impl<F: Float, L: Label> GaussianNb<F, L> {
    /// Construct a new set of hyperparameters
    pub fn params() -> GaussianNbParams<F, L> {
        GaussianNbParams::new()
    }
}
"""
PLOTTERS_LIB = """pub mod chart;
pub mod series;

/// The module imports the most commonly used types and modules in Plotters
pub mod prelude {
    pub use crate::series::{DashedLineSeries, DottedLineSeries, LineSeries};

    // Re-export tier 1 backends for backward compatibility
    #[cfg(feature = "bitmap_backend")]
    #[cfg_attr(doc_cfg, doc(cfg(feature = "bitmap_backend")))]
    pub use plotters_bitmap::BitMapBackend;

    #[cfg(feature = "svg_backend")]
    #[cfg_attr(doc_cfg, doc(cfg(feature = "svg_backend")))]
    pub use plotters_svg::SVGBackend;
}
"""
LINE_SERIES = """pub struct LineSeries<DB: DrawingBackend, Coord> {
    style: ShapeStyle,
}

impl<DB: DrawingBackend, Coord: Clone + 'static> Iterator for LineSeries<DB, Coord> {
    type Item = DynElement<'static, DB, Coord>;
}

impl<DB: DrawingBackend, Coord> LineSeries<DB, Coord> {
    pub fn new<I: IntoIterator<Item = Coord>, S: Into<ShapeStyle>>(iter: I, style: S) -> Self {
        Self::new_with_style(iter, style)
    }

    pub fn point_size(mut self, size: u32) -> Self {
        self.point_size = size;
        self
    }
}
"""
CONTEXT = """impl<'a, DB: DrawingBackend, CT: CoordTranslate> ChartContext<'a, DB, CT> {
    pub fn draw_series<B, E, R, S>(
        &mut self,
        series: S,
    ) -> Result<&mut SeriesAnno<'a, DB>, DrawingAreaErrorKind<DB::ErrorType>>
    where
        B: CoordMapper,
    {
        self.draw_series_impl(series)?;
        Ok(self.alloc_series_anno())
    }
}
"""
# Verbatim plotters-0.3.7/src/element/image.rs:70 and 165-169: names BitMapBackend only as a
# return type, and sorts before src/lib.rs — the noise a declaration-first search must skip.
IMAGE = """impl<'a, Coord, P: PixelFormat> BitMapElement<'a, Coord, P> {
    /// Make the bitmap element as a bitmap backend, so that we can use
    /// plotters drawing functionality on the bitmap element
    pub fn as_bitmap_backend(&mut self) -> BitMapBackend<P> {
        BitMapBackend::with_buffer_and_format(self.image.to_mut(), self.size).unwrap()
    }
}
"""
PLOTTERS_TOML = """[package]
name = "plotters"
version = "0.3.7"

[features]
bitmap_backend = ["plotters-bitmap"]
default = [
    "bitmap_backend",
    "svg_backend",
    "line_series",
]
evcxr = ["svg_backend"]
line_series = []
svg_backend = ["plotters-svg"]
"""


def _registry(tmp_path, monkeypatch) -> Path:
    home = tmp_path / "cargo"
    idx = home / "registry" / "src" / "index.crates.io-1949cf8c6b5b557f"
    files = {
        "rand-0.10.4/src/lib.rs": RAND_LIB, "rand-0.10.4/src/rng.rs": RAND_RNG,
        "rand-0.10.4/src/rngs/std.rs": RAND_STD, "rand-0.10.4/Cargo.toml": RAND_TOML,
        # Older and pre-release copies the version pick must skip for "0.10".
        "rand-0.8.5/src/lib.rs": "pub trait Rng {\n    fn gen<T>(&mut self) -> T;\n}\n",
        "rand-0.10.2/src/lib.rs": "pub struct Old;\n",
        "rand-0.11.0-rc.1/src/lib.rs": "pub struct Next;\n",
        "rand-0.10.5-rc.1/src/lib.rs": "pub struct Next;\n",
        "linfa-bayes-0.8.1/src/lib.rs": "mod gaussian_nb;\npub use gaussian_nb::GaussianNb;\n",
        "linfa-bayes-0.8.1/src/gaussian_nb.rs": GNB,
        "plotters-0.3.7/src/lib.rs": PLOTTERS_LIB,
        "plotters-0.3.7/src/series/line_series.rs": LINE_SERIES,
        "plotters-0.3.7/src/chart/context.rs": CONTEXT,
        "plotters-0.3.7/src/element/image.rs": IMAGE,
        "plotters-0.3.7/Cargo.toml": PLOTTERS_TOML,
        # Library tests are not API: never quoted.
        "plotters-0.3.7/src/tests/fake.rs": "pub struct BitmapBackend;\n",
    }
    for rel, text in files.items():
        p = idx / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
    monkeypatch.setenv("CARGO_HOME", str(home))
    return idx


def _code(src: str, evalues: list[str] | None = None, traceback=None) -> dict:
    c = {"cell_type": "code", "metadata": {}, "source": src, "execution_count": None,
         "outputs": []}
    for ev in evalues or []:
        c["outputs"].append({"output_type": "error", "ename": "Error", "evalue": ev,
                             "traceback": traceback or [ev]})
    return c


def _errs(cells) -> list[str]:
    return [d._outputs_text(c) for c in cells if c.get("outputs")]


# ---- parsing -----------------------------------------------------------------------------

def test_cell_deps_reads_both_dep_forms():
    deps = d.cell_deps([{"cell_type": "markdown", "source": ':dep fake = "1"'},
                        _code(DEPS_23B)])
    assert list(deps) == ["ndarray", "rand", "rand_distr", "linfa", "linfa-bayes",
                          "linfa-linear", "plotters"]
    assert deps["rand"] == {"req": "0.8", "features": [], "default_features": True, "idx": 1}
    assert deps["plotters"] == {"req": "0.3", "features": ["evcxr", "line_series"],
                                "default_features": False, "idx": 1}


def test_req_matches_follows_cargo_caret_semantics():
    cases = [("0.10", (0, 10, 4), True), ("0.10", (0, 11, 0), False),
             ("0.10", (0, 8, 5), False), ("0.10.3", (0, 10, 2), False),
             ("1", (1, 9, 0), True), ("1.2", (1, 1, 0), False), ("1.2", (2, 0, 0), False),
             ("=0.10.4", (0, 10, 4), True), ("=0.10.4", (0, 10, 5), False),
             ("~0.3.1", (0, 3, 7), True), ("~0.3.1", (0, 4, 0), False),
             ("*", (3, 1, 4), True), (None, (0, 1, 0), True), (">=0.3", (0, 9, 0), True),
             ("0.0.3", (0, 0, 3), True), ("0.0.3", (0, 0, 4), False),
             ("0", (0, 9, 1), True), ("0", (1, 0, 0), False), ("^0.8", (0, 8, 5), True),
             ("garbage", (0, 1, 0), False)]
    for req, ver, want in cases:
        assert d._req_matches(req, ver) is want, (req, ver)


def test_registry_picks_the_highest_compatible_stable_version(tmp_path, monkeypatch):
    _registry(tmp_path, monkeypatch)
    path, ver = d.registry_crate_dir("rand", "0.10")
    assert (path.name, ver) == ("rand-0.10.4", "0.10.4")      # not 0.10.2 nor 0.10.5-rc.1
    assert d.registry_crate_dir("rand", "0.8")[1] == "0.8.5"
    assert d.registry_crate_dir("linfa_bayes", "0.8")[0].name == "linfa-bayes-0.8.1"
    assert d.registry_crate_dir("rand", "0.9") is None
    assert d.registry_crate_dir("serde_json", "1.0") is None


def test_no_registry_means_no_roots(tmp_path, monkeypatch):
    monkeypatch.setenv("CARGO_HOME", str(tmp_path / "nowhere"))
    assert d.cargo_registry_roots() == []


def test_rust_api_errors_parses_the_real_diagnostics():
    errs = d.rust_api_errors("\n".join(ERR_RAND) + "\n" + "\n".join(
        [EV_GNB, EV_BITMAP, EV_AXIS, EV_DRAW]))
    assert errs == [
        {"kind": "method", "item": "next_f64", "owner": "StdRng", "crate": None},
        {"kind": "method", "item": "draw", "owner": "LineSeries", "crate": "plotters"},
        {"kind": "assoc", "item": "default", "owner": "GaussianNb", "crate": None},
        {"kind": "name", "item": "BitmapBackend", "owner": None, "crate": None},
        {"kind": "name", "item": "DesiredAxis", "owner": None, "crate": None},
    ]
    imp = d.rust_api_errors("error[E0432]: unresolved import `rand::distributions`\n"
                            "failed to resolve: could not find `thread_rng` in `rand`")
    assert {"kind": "import", "item": "distributions", "owner": None, "crate": "rand"} in imp
    assert {"kind": "import", "item": "thread_rng", "owner": None, "crate": "rand"} in imp
    assert d.rust_api_errors("thread 'main' panicked at src/lib.rs:3:5") == []


# ---- the block on the two real failures ---------------------------------------------------

def test_mgs25_block_names_the_extension_trait(tmp_path, monkeypatch):
    _registry(tmp_path, monkeypatch)
    cells = [_code(':dep ndarray = "0.17"\n:dep rand = "0.10"\nuse rand::{Rng, SeedableRng};'),
             _code("let x = rng.next_f64();", [ERR_RAND[2]], ERR_RAND)]
    block, info = d.crate_api_block(cells, _errs(cells))
    assert info == {"crates": ["rand 0.10.4"], "dep_cell": 0, "gated": [], "unknown": []}
    assert 'crate rand 0.10.4 — `:dep` demande "0.10" (cellule 0)' in block
    assert "- `StdRng` n'a pas `next_f64` ; ce qui existe :" in block
    assert "pub struct StdRng(ChaCha12Rng)   [src/rngs/std.rs:1]" in block
    assert "StdRng implémente : TryRng, SeedableRng, TryCryptoRng" in block
    assert "trait rand::RngExt (à importer : `use rand::RngExt;`) [src/rng.rs:4]" in block
    assert "    fn random<T>(&mut self) -> T\n" in block              # cut before `where`
    assert "    fn random_range<T, R>(&mut self, range: R) -> T\n" in block
    assert "fn gen<T>" not in block                                  # 0.8.5 never quoted
    assert "activées ici : alloc, default, std, std_rng, sys_rng, thread_rng" in block


def test_23b_block_grounds_linfa_and_plotters(tmp_path, monkeypatch):
    _registry(tmp_path, monkeypatch)
    cells = [{"cell_type": "markdown", "metadata": {}, "source": "# 2.3b"},
             _code(DEPS_23B),
             _code("let m = GaussianNb::default();", [EV_GNB]),
             _code("let root = BitmapBackend::new(\"a.png\", (640, 480));\n"
                   "let a = DesiredAxis::X;\nseries.draw();", [EV_BITMAP, EV_AXIS, EV_DRAW])]
    block, info = d.crate_api_block(cells, _errs(cells))
    assert info["crates"] == ["linfa-bayes 0.8.1", "plotters 0.3.7"]
    assert info["dep_cell"] == 1 and info["gated"] == ["bitmap_backend"]
    assert info["unknown"] == ["DesiredAxis"]
    assert "GaussianNb::params() -> GaussianNbParams<F, L>   [src/gaussian_nb.rs:8]" in block
    assert ("LineSeries::new<I: IntoIterator<Item = Coord>, S: Into<ShapeStyle>>(iter: I, "
            "style: S) -> Self   [src/series/line_series.rs:10]") in block
    assert "LineSeries implémente : Iterator" in block
    assert "voisin : ChartContext::draw_series<B, E, R, S>(&mut self, series: S,)" in block
    assert ("pub use plotters_bitmap::BitMapBackend   [src/lib.rs:11, chemin plotters::prelude, "
            "feature bitmap_backend NON activée]") in block
    assert "src/tests/fake.rs" not in block
    assert "as_bitmap_backend" not in block                         # declarations first
    assert "activées ici : evcxr, line_series, svg_backend" in block  # evcxr implies svg
    assert "`DesiredAxis` — ces noms n'existent pas dans ces versions" in block


def test_an_enabled_gate_reads_activee(tmp_path, monkeypatch):
    _registry(tmp_path, monkeypatch)
    cells = [_code(':dep plotters = "0.3"'),              # default features: bitmap_backend on
             _code("BitmapBackend::new()", [EV_BITMAP])]
    block, info = d.crate_api_block(cells, _errs(cells))
    assert "feature bitmap_backend activée]" in block and info["gated"] == []


def test_names_the_notebook_declares_are_not_unknown(tmp_path, monkeypatch):
    _registry(tmp_path, monkeypatch)
    cells = [_code(':dep plotters = "0.3"\nenum DesiredAxis { X, Y }'),
             _code("let a = DesiredAxis::X;", [EV_AXIS]),
             _code("let b = foo;", ["cannot find value `foo` in this scope"])]
    assert d.crate_api_block(cells, _errs(cells)) == ("", {})


def test_nothing_applies_without_deps_errors_or_registry(tmp_path, monkeypatch):
    _registry(tmp_path, monkeypatch)
    assert d.crate_api_block([_code("let x = 1;", [EV_GNB])], [EV_GNB]) == ("", {})
    assert d.crate_api_block([_code(':dep rand = "0.10"')], ["mismatched types"]) == ("", {})
    monkeypatch.setenv("CARGO_HOME", str(tmp_path / "nowhere"))
    cells = [_code(':dep rand = "0.10"'), _code("x", [ERR_RAND[2]])]
    assert d.crate_api_block(cells, _errs(cells)) == ("", {})


def test_the_block_is_capped(tmp_path, monkeypatch):
    _registry(tmp_path, monkeypatch)
    monkeypatch.setattr(d, "CRATE_API_CAP", 200)
    cells = [_code(':dep rand = "0.10"'), _code("x", [ERR_RAND[2]])]
    block, _ = d.crate_api_block(cells, _errs(cells))
    assert len(block) <= 200 + len("\n[… extrait tronqué …]")
    assert block.endswith("[… extrait tronqué …]")


# ---- linking: a failing `:dep` cell, an undeclared crate, a version clash (2.3b, #27134) ----

# Verbatim: run issue-27134 (final state), cells 1 and 3.
EV_FIT = "unresolved import `linfa::Fit`"
TB_FIT = ["no `Fit` in the root", "error: unresolved import `linfa::Fit`", EV_FIT]
EV_NDARRAY = "unresolved import `ndarray`"
TB_NDARRAY = ["use of unresolved module or unlinked crate `ndarray`", EV_NDARRAY,
              "\x1b[1mhelp\x1b[0m: if you wanted to use a crate named `ndarray`, use "
              "`cargo add ndarray` to add it to your `Cargo.toml`"]
LINFA_TOML = """[package]
name = "linfa"
version = "0.8.1"

[dependencies.ndarray]
version = "0.16"
features = ["approx"]

[dependencies.rand]
version = "0.8"
features = ["small_rng"]

[dev-dependencies.ndarray-rand]
version = "0.15"
"""
LINFA_TRAITS = """pub trait Fit<R: Records, T, E: std::error::Error + From<crate::error::Error>> {
    type Object;
}

pub trait Predict<R: Records, T> {
    fn predict(&self, x: R) -> T;
}
"""


def _linfa_registry(tmp_path, monkeypatch) -> Path:
    idx = _registry(tmp_path, monkeypatch)
    for rel, text in {"linfa-0.8.1/Cargo.toml": LINFA_TOML,
                      "linfa-0.8.1/src/lib.rs": "pub mod traits;\npub mod prelude;\n",
                      "linfa-0.8.1/src/traits.rs": LINFA_TRAITS,
                      "ndarray-0.16.1/src/lib.rs": "pub struct ArrayBase;\n",
                      "ndarray-0.17.2/src/lib.rs": "pub struct ArrayBase;\n"}.items():
        p = idx / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
    return idx


def test_rust_api_errors_parses_linking_diagnostics():
    errs = d.rust_api_errors("\n".join(TB_NDARRAY) + "\nerror[E0308]: mismatched types\n"
                             "note: there are multiple different versions of crate `ndarray` "
                             "in the dependency graph")
    assert {"kind": "crate", "item": "ndarray", "owner": None, "crate": None} in errs
    assert {"kind": "version", "item": "ndarray", "owner": None, "crate": None} in errs
    assert {"kind": "import", "item": "ndarray", "owner": None, "crate": None} in errs


def test_crate_dep_req_reads_tables_and_inline_forms(tmp_path):
    (tmp_path / "Cargo.toml").write_text(
        LINFA_TOML + '\n[dependencies]\nserde = "1.0"\nnum = { version = "0.4", optional = true }\n',
        encoding="utf-8")
    assert d._crate_dep_req(tmp_path, "ndarray") == "0.16"
    assert d._crate_dep_req(tmp_path, "rand") == "0.8"
    assert d._crate_dep_req(tmp_path, "serde") == "1.0"
    assert d._crate_dep_req(tmp_path, "num") == "0.4"
    assert d._crate_dep_req(tmp_path, "ndarray_rand") is None       # dev-dependency only
    assert d._crate_dep_req(tmp_path / "nowhere", "ndarray") is None


def test_a_failing_dep_cell_is_named_as_the_cause_of_the_cascade(tmp_path, monkeypatch):
    _linfa_registry(tmp_path, monkeypatch)
    cells = [{"cell_type": "markdown", "metadata": {}, "source": "# 2.3b"},
             _code(':dep ndarray = "0.16"\n:dep linfa = "0.8"\nuse linfa::{Fit, Predict};',
                   [EV_FIT], TB_FIT),
             _code("use ndarray::Array2;", [EV_NDARRAY], TB_NDARRAY)]
    block, info = d.crate_api_block(cells, _errs(cells))
    assert block.startswith("Crates à lier :\n- La cellule 1 déclare les `:dep` mais elle "
                            "ÉCHOUE")
    assert "d'où les « unlinked crate » plus bas (`ndarray`)" in block
    assert "pub trait Fit<R: Records" in block and "chemin linfa::traits]" in block
    assert "`ndarray` introuvable" not in block                     # a cascade, not an API miss
    assert info["link"] == ["ndarray"] and info["crates"] == ["linfa 0.8.1"]
    assert info["dep_cell"] == 1


def test_an_undeclared_crate_gets_the_requirement_of_its_dependents(tmp_path, monkeypatch):
    _linfa_registry(tmp_path, monkeypatch)
    cells = [_code(':dep linfa = "0.8"'),
             _code("use ndarray::Array2;", [EV_NDARRAY], TB_NDARRAY)]
    block, info = d.crate_api_block(cells, _errs(cells))
    assert ('- `ndarray` n\'est déclarée dans aucun `:dep` : ajoute `:dep ndarray = "0.16"` '
            'dans la cellule 0 (copie locale : ndarray 0.16.1); linfa 0.8.1 en dépend en '
            '"0.16".') in block
    assert info == {"crates": [], "dep_cell": 0, "gated": [], "unknown": [],
                    "link": ["ndarray"]}


def test_a_version_clash_with_a_dependent_is_aligned(tmp_path, monkeypatch):
    _linfa_registry(tmp_path, monkeypatch)
    cells = [_code(':dep ndarray = "0.17"\n:dep linfa = "0.8"'),
             _code("let ds = Dataset::new(x, y);", ["mismatched types"],
                   ["mismatched types", "note: there are multiple different versions of crate "
                                        "`ndarray` in the dependency graph"])]
    block, info = d.crate_api_block(cells, _errs(cells))
    assert ('- `:dep ndarray = "0.17"` (cellule 0) donne ndarray 0.17.2, mais linfa 0.8.1 en '
            'dépend en "0.16" : deux copies de `ndarray` seront liées') in block
    assert 'écris `:dep ndarray = "0.16"` (copie locale : ndarray 0.16.1).' in block
    assert "ÉCHOUE" not in block and info["link"] == ["ndarray"]


def test_coherent_versions_add_no_linking_advice(tmp_path, monkeypatch):
    _linfa_registry(tmp_path, monkeypatch)
    cells = [_code(':dep ndarray = "0.16"\n:dep linfa = "0.8"'),
             _code("x", [EV_FIT], TB_FIT)]
    block, info = d.crate_api_block(cells, _errs(cells))
    assert "Crates à lier" not in block and "link" not in info
    assert "chemin linfa::traits]" in block


def test_repair_prompt_places_the_block_and_the_dep_cell():
    failing = [{"idx": 3, "source": "x", "errors": "e", "cited": []}]
    dep = {"idx": 1, "names": ["rand 0.10.4"], "for": 3, "via": "dep", "source": ':dep r = "1"'}
    trace = {"idx": 2, "names": ["f"], "for": 3, "via": "trace", "source": "fn f() {}"}
    p = d.repair_prompt(failing, "", [trace, dep], None, "crate rand 0.10.4 — X")
    assert "API RÉELLE DES CRATES" in p and "crate rand 0.10.4 — X" in p
    assert p.index("API RÉELLE DES CRATES") < p.index("CELLULES AMONT")
    assert "### Cellule 1 (code, `:dep` — rand 0.10.4)" in p
    assert "AMONT — définit rand" not in p
    assert p.index("CELLULES AMONT") < p.index("CELLULE DES DÉPENDANCES")
    assert "plus les cellules amont que tu corriges" in p
    only_dep = d.repair_prompt(failing, "", [dep], None, "")
    assert "CELLULES AMONT" not in only_dep and "CELLULE DES DÉPENDANCES" in only_dep
    assert "API RÉELLE" not in d.repair_prompt(failing)


# ---- the round ----------------------------------------------------------------------------

def _run_round(tmp_path, monkeypatch, cells, answer, kname="rust"):
    nb = tmp_path / "nb.ipynb"
    nb.write_text(json.dumps({"cells": cells, "metadata": {}, "nbformat": 4,
                              "nbformat_minor": 5}), encoding="utf-8")
    prompts = []

    async def fake_retry(sk, args, rec, stage, prompt, conv, max_tokens=None):
        prompts.append(prompt)
        return {"conversation_id": "c1"}

    async def fake_parse(sk, args, rec, stage, env, conv, max_tokens=None):
        return {"cells": answer}, env

    async def fake_pm(pm, name, payload):
        return {}

    async def fake_start(pm, kname, exec_dir):
        return "k2"

    async def fake_exec(pm, path, kid, targets):
        return [{"cell": i, "ok": True} for i in targets]

    monkeypatch.setattr(d, "sk_call_retry", fake_retry)
    monkeypatch.setattr(d, "parse_or_repair", fake_parse)
    monkeypatch.setattr(d, "pm_call", fake_pm)
    monkeypatch.setattr(d, "start_kernel", fake_start)
    monkeypatch.setattr(d, "execute_cells", fake_exec)
    targets = [i for i, c in enumerate(cells) if c["cell_type"] == "code"]
    rec = {"execution": [{"cell": i, "ok": not cells[i]["outputs"]} for i in targets]}
    asyncio.run(d.repair_kernel_errors(None, None, SimpleNamespace(repair_rounds=1), rec, nb,
                                       kname, tmp_path, "k1", targets, None, ""))
    return prompts, rec["repairs"][0], json.loads(nb.read_text(encoding="utf-8"))["cells"]


def _mgs25():
    return [{"cell_type": "markdown", "metadata": {}, "source": "# MGS-25"},
            _code(':dep rand = "0.10"\nuse rand::{Rng, SeedableRng};'),
            _code("let x: f64 = rng.next_f64();", [ERR_RAND[2]], ERR_RAND)]


def test_a_rust_round_is_grounded_and_may_fix_the_dep_cell(tmp_path, monkeypatch):
    _registry(tmp_path, monkeypatch)
    answer = [{"idx": 2, "cell_type": "code", "source": "let x: f64 = rng.random();"},
              {"idx": 1, "cell_type": "code",
               "source": ':dep rand = "0.10"\nuse rand::{RngExt, SeedableRng};'}]
    prompts, r, cells = _run_round(tmp_path, monkeypatch, _mgs25(), answer)
    p = prompts[0]
    assert "API RÉELLE DES CRATES" in p and "use rand::RngExt;" in p
    assert "### Cellule 1 (code, `:dep` — rand 0.10.4)" in p
    assert r["upstream"] == [1] and r["replaced"] == [2, 1] and r["out_of_scope"] == []
    assert r["crate_api"] == {"crates": ["rand 0.10.4"], "dep_cell": 1, "gated": [],
                              "unknown": []}
    assert "".join(cells[1]["source"]).endswith("use rand::{RngExt, SeedableRng};")


def test_a_failing_dep_cell_is_asked_not_offered(tmp_path, monkeypatch):
    _registry(tmp_path, monkeypatch)
    cells = _mgs25()
    cells[1] = _code(':dep rand = "0.10"\nlet r = rng.next_f64();', [ERR_RAND[2]], ERR_RAND)
    answer = [{"idx": 1, "cell_type": "code", "source": ':dep rand = "0.10"'},
              {"idx": 2, "cell_type": "code", "source": "let x = 1.0;"}]
    prompts, r, _ = _run_round(tmp_path, monkeypatch, cells, answer)
    assert r["upstream"] == [] and r["asked"] == 2
    assert "CELLULE DES DÉPENDANCES" not in prompts[0] and "API RÉELLE" in prompts[0]


def test_other_kernels_are_never_grounded(tmp_path, monkeypatch):
    _registry(tmp_path, monkeypatch)
    answer = [{"idx": 2, "cell_type": "code", "source": "x"}]
    prompts, r, _ = _run_round(tmp_path, monkeypatch, _mgs25(), answer, kname="csharp")
    assert "API RÉELLE" not in prompts[0] and r["crate_api"] is None and r["upstream"] == []


def test_grounding_failure_never_fails_the_round(tmp_path, monkeypatch):
    _registry(tmp_path, monkeypatch)

    def boom(cells, errors, roots=None, absent=()):
        raise OSError("registry unreadable")

    monkeypatch.setattr(d, "crate_api_block", boom)
    answer = [{"idx": 2, "cell_type": "code", "source": "let x = 1.0;"}]
    prompts, r, _ = _run_round(tmp_path, monkeypatch, _mgs25(), answer)
    assert r["replaced"] == [2] and "API RÉELLE" not in prompts[0]
    assert r["crate_api"] == {"error": "OSError: registry unreadable"}
