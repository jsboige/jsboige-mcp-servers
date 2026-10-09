"""
Invariant de sobriete memoire #4149 -- fuite OPENBLAS_NUM_THREADS vers les enfants.

Le serveur papermill plafonne OpenBLAS a 1 thread le temps que numpy se charge
(le pool OpenBLAS est dimensionne au chargement), puis RETIRE la variable de
l'environnement pour que les kernels utilisateurs -- interactifs (jupyter_client
copie os.environ, core/jupyter_manager.py), jobs async (env = os.environ.copy(),
services/async_job_service.py) et kernels papermill/nbclient -- heritent du
defaut machine au lieu d'un thread unique force.

Ces tests verrouillent l'invariant en sous-processus : le process pytest a deja
charge numpy et peut porter la variable, l'etat de fin d'import doit donc etre
observe dans un interpreteur vierge.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).parent.parent

_PROBE = (
    "import json, os, sys; import papermill_mcp.main; "
    "print(json.dumps({"
    "'var_absent': 'OPENBLAS_NUM_THREADS' not in os.environ, "
    "'numpy_loaded': 'numpy' in sys.modules}))"
)


def _probe_env_state(extra_env):
    """Importe papermill_mcp.main dans un interpreteur vierge et retourne son etat final."""
    env = {k: v for k, v in os.environ.items() if k != "OPENBLAS_NUM_THREADS"}
    env.update(extra_env)
    result = subprocess.run(
        [sys.executable, "-c", _PROBE],
        cwd=SERVER_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, f"probe failed: {result.stderr[-2000:]}"
    return json.loads(result.stdout.strip().splitlines()[-1])


@pytest.mark.unit
def test_import_capped_variable_removed_and_numpy_loaded():
    """Variable absente au depart -> absente apres import, numpy deja charge.

    Les deux assertions sont solidaires : si numpy n'etait pas charge par la
    chaine d'imports, le retrait de la variable arriverait AVANT le
    dimensionnement du pool et le plafond memoire serait perdu.
    """
    state = _probe_env_state({})
    assert state["numpy_loaded"], (
        "numpy doit etre charge par la chaine d'imports de papermill_mcp.main "
        "(sinon le retrait de la variable arrive avant le dimensionnement du pool)"
    )
    assert state["var_absent"], (
        "OPENBLAS_NUM_THREADS ne doit pas survivre a l'import du serveur : "
        "elle fuit vers les kernels utilisateurs (core/jupyter_manager.py, "
        "services/async_job_service.py, enfants papermill/nbclient)"
    )


@pytest.mark.unit
def test_import_operator_override_preserved():
    """Variable posee par l'operateur -> conservee (setdefault, pas ecrasement)."""
    state = _probe_env_state({"OPENBLAS_NUM_THREADS": "4"})
    assert not state["var_absent"], "un override operateur doit survivre a l'import (setdefault)"
    assert state["numpy_loaded"]
