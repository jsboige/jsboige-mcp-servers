#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_private_path.py
# Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
# jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree.
# -----------------------------------------------------------------------------
"""Offline tests for E0603 grounding of Rust repair rounds — 2026-11-21.

2.3b (#27134) imports `use rand::{Rng, SeedableRng, Distribution};` under `:dep rand =
"0.10"`. evcxr answers "trait `Distribution` is private" and advises importing
`rand::distr::distribution::Distribution` — a path through the PRIVATE module
`distribution`, so following the advice fails again. The importable paths are
`rand::distr::Distribution` and `rand::prelude::Distribution`, which only the crate sources
show. A repair round now quotes them and names the private paths not to follow.

The fake registry copies its lines verbatim from rand-0.10.4 (src/lib.rs:56-75,
src/distr/mod.rs:96-119, src/distr/distribution.rs:38, src/prelude.rs:21-22); the error text
is verbatim from the 2.3b round record of 21/11."""

import importlib.util
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("nb_coder_driver", HERE / "nb_coder_driver.py")
d = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(d)

# Verbatim: 2.3b failing-cell record, 21/11 (evcxr's rendering of E0603).
ERR_PRIVATE = ("trait `Distribution` is private | private trait\r\n"
               "trait `Distribution` is private\r\n"
               "help: import `Distribution` directly\r\n\r\n"
               "rand::distr::distribution::Distribution")
ERR_NDARRAY = ("[3] error: Error: unresolved import `ndarray` |     use ndarray::Array2;")

LIB = """pub use rand_core;

// Re-exports from rand_core
pub use rand_core::{CryptoRng, Rng, SeedableRng, TryCryptoRng, TryRng};

// Public modules
pub mod distr;
pub mod prelude;
mod rng;
pub mod rngs;
pub mod seq;

// Public exports
#[cfg(feature = "thread_rng")]
pub use crate::rngs::thread::rng;

pub use rng::{Fill, RngExt};

#[cfg(feature = "thread_rng")]
use crate::distr::{Distribution, StandardUniform};
"""
DISTR = """mod bernoulli;
mod distribution;
mod float;
mod integer;
mod other;
mod utils;

#[doc(hidden)]
pub mod hidden_export {
    pub use super::float::IntoFloat; // used by rand_distr
}
pub mod slice;
pub mod uniform;
#[cfg(feature = "alloc")]
pub mod weighted;

pub use self::bernoulli::{Bernoulli, BernoulliError};
#[cfg(feature = "alloc")]
pub use self::distribution::SampleString;
pub use self::distribution::{Distribution, Iter, Map};
pub use self::float::{Open01, OpenClosed01};
pub use self::other::{Alphabetic, Alphanumeric};
#[doc(inline)]
pub use self::uniform::Uniform;
"""
DISTRIBUTION = """/// [`sample_iter`]: Distribution::sample_iter
pub trait Distribution<T> {
    /// Generate a random value of `T`, using `rng` as the source of randomness.
    fn sample<R: Rng + ?Sized>(&self, rng: &mut R) -> T;
}
"""
PRELUDE = """//! ```
//! use rand::prelude::*;
//! ```

#[doc(no_inline)]
pub use crate::distr::Distribution;
#[doc(no_inline)]
pub use crate::rngs::SmallRng;
"""


def _registry(tmp_path, monkeypatch) -> Path:
    home = tmp_path / "cargo"
    idx = home / "registry" / "src" / "index.crates.io-1949cf8c6b5b557f"
    for rel, text in {"rand-0.10.4/src/lib.rs": LIB, "rand-0.10.4/src/distr/mod.rs": DISTR,
                      "rand-0.10.4/src/distr/distribution.rs": DISTRIBUTION,
                      "rand-0.10.4/src/prelude.rs": PRELUDE}.items():
        p = idx / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
    monkeypatch.setenv("CARGO_HOME", str(home))
    return idx


def _cells():
    return [{"cell_type": "code", "source": ':dep rand = "0.10"\n:dep ndarray = "0.17"'},
            {"cell_type": "code", "source": "use rand::{Rng, SeedableRng, Distribution};"}]


def test_the_private_error_is_parsed_with_its_crate_and_the_advised_path():
    errs = d.rust_api_errors(ERR_PRIVATE)
    assert errs == [{"kind": "private", "item": "Distribution", "owner": None,
                     "crate": "rand", "noun": "trait",
                     "hint": "rand::distr::distribution::Distribution"}]


def test_method_privacy_is_not_an_import_error():
    # E0624 (a private method or associated function) is not fixed by another path.
    assert d.rust_api_errors("associated function `new` is private") == []
    assert d.rust_api_errors("method `inner` is private") == []


def test_the_block_gives_the_public_paths_and_warns_against_the_advised_one(
        tmp_path, monkeypatch):
    _registry(tmp_path, monkeypatch)
    block, info = d.crate_api_block(_cells(), [ERR_PRIVATE])
    assert info["crates"] == ["rand 0.10.4"]
    assert "use rand::distr::Distribution;   [src/distr/mod.rs:20]" in block
    assert "use rand::prelude::Distribution;   [src/prelude.rs:6]" in block
    bad = next(line for line in block.splitlines() if "NE PAS utiliser" in line)
    assert "`rand::distr::distribution::Distribution`" in bad   # the compiler's advice
    assert "`rand::Distribution`" in bad                        # the private root import
    assert "use rand::distr::distribution::Distribution;" not in block
    assert "défini ici : pub trait Distribution<T>" in block and ", privé]" in block


def test_the_public_paths_come_shortest_first(tmp_path, monkeypatch):
    _registry(tmp_path, monkeypatch)
    block, _ = d.crate_api_block(_cells(), [ERR_PRIVATE])
    uses = [line.strip() for line in block.splitlines() if line.strip().startswith("use ")]
    assert uses[0].startswith("use rand::distr::Distribution;")


def test_a_private_module_names_where_its_items_are_reexported(tmp_path, monkeypatch):
    _registry(tmp_path, monkeypatch)
    err = ("module `distribution` is private | private module\r\n"
           "module `distribution` is private")
    cells = _cells()
    cells[1]["source"] = "use rand::distr::distribution::Distribution;"
    block, _ = d.crate_api_block(cells, [err])
    assert "le module `distribution` est privé" in block
    assert ("pub use self::distribution::{Distribution, Iter, Map}   "
            "[src/distr/mod.rs:20, dans rand::distr]") in block


def test_mod_is_public_follows_every_segment(tmp_path, monkeypatch):
    idx = _registry(tmp_path, monkeypatch)
    files = d._crate_files(idx / "rand-0.10.4")
    assert d._mod_is_public(files, "rand", "rand")
    assert d._mod_is_public(files, "rand", "rand::distr")
    assert d._mod_is_public(files, "rand", "rand::prelude")
    assert not d._mod_is_public(files, "rand", "rand::distr::distribution")
    assert not d._mod_is_public(files, "rand", "rand::rng")


def test_a_multiline_reexport_is_read_to_its_semicolon(tmp_path, monkeypatch):
    idx = _registry(tmp_path, monkeypatch)
    (idx / "rand-0.10.4/src/prelude.rs").write_text(
        "pub use crate::distr::{\n    Bernoulli,\n    Distribution,\n};\n", encoding="utf-8")
    block, _ = d.crate_api_block(_cells(), [ERR_PRIVATE])
    assert "use rand::prelude::Distribution;   [src/prelude.rs:1]" in block


def test_other_errors_of_the_round_keep_their_handling(tmp_path, monkeypatch):
    _registry(tmp_path, monkeypatch)
    block, info = d.crate_api_block(_cells(), [ERR_PRIVATE, ERR_NDARRAY])
    assert "use rand::distr::Distribution;" in block
    assert info["crates"][0] == "rand 0.10.4"


def test_against_the_real_registry_when_present():
    roots = d.cargo_registry_roots()
    hit = d.registry_crate_dir("rand", "0.10", roots) if roots else None
    if not hit or hit[1] != "0.10.4":
        pytest.skip("rand 0.10.4 not in the local cargo registry")
    block, _ = d.crate_api_block(_cells(), [ERR_PRIVATE], roots)
    assert "use rand::distr::Distribution;" in block
    assert "use rand::prelude::Distribution;" in block
    assert "use rand::distr::distribution::Distribution;" not in block
