"""
Configuration pytest et fixtures communes pour les tests ExecutionManager.

Fournit des fixtures réutilisables pour tester l'architecture ExecutionManager async
avec isolation complète des dépendances externes.
"""

import asyncio
import os
import tempfile
import threading
from datetime import datetime
from pathlib import Path
from typing import Dict, Any
from unittest.mock import Mock, patch, MagicMock
import pytest

# Import des classes à tester
import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from papermill_mcp.services.notebook_service import (
    ExecutionManager, 
    JobStatus, 
    ExecutionJob,
    NotebookService
)
from papermill_mcp.config import MCPConfig


@pytest.fixture
def temp_dir():
    """Fixture pour un répertoire temporaire de test."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield Path(tmpdir)


@pytest.fixture
def mock_config():
    """Fixture pour une configuration MCP mockée."""
    config = Mock(spec=MCPConfig)
    config.working_directory = "/tmp/test"
    config.timeout = 60
    config.kernel_name = "python3"
    return config


@pytest.fixture
def execution_manager():
    """
    Fixture pour un ExecutionManager de test avec contrôle des concurrences.
    """
    manager = ExecutionManager(max_concurrent_jobs=3)
    yield manager
    # Cleanup: arrêter tous les jobs en cours
    try:
        for job_id in list(manager.jobs.keys()):
            if manager.jobs[job_id].status in [JobStatus.RUNNING, JobStatus.PENDING]:
                manager.cancel_job(job_id)
        manager.executor.shutdown(wait=True, cancel_futures=True)
    except:
        pass


@pytest.fixture
def isolated_execution_manager():
    """
    Fixture pour un ExecutionManager complètement isolé (mocks subprocess).
    """
    with patch('subprocess.Popen') as mock_popen:
        # Configurer un processus mock qui termine immédiatement avec succès
        mock_process = MagicMock()
        mock_process.poll.return_value = None  # Process still running
        mock_process.wait.return_value = 0     # Success exit code
        mock_process.pid = 12345
        mock_process.stdout.readline.return_value = ''  # No output
        mock_process.stderr.readline.return_value = ''  # No errors
        mock_popen.return_value = mock_process
        
        manager = ExecutionManager(max_concurrent_jobs=2)
        yield manager, mock_process, mock_popen
        
        # Cleanup
        try:
            manager.executor.shutdown(wait=True, cancel_futures=True)
        except:
            pass


@pytest.fixture
def sample_notebook_simple(temp_dir):
    """
    Fixture pour un notebook de test simple (< 5s).
    """
    notebook_content = {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {
            "kernelspec": {
                "name": "python3",
                "display_name": "Python 3"
            }
        },
        "cells": [
            {
                "cell_type": "code",
                "source": "print('Hello World!')\nresult = 2 + 2\nprint(f'Result: {result}')",
                "metadata": {},
                "execution_count": None,
                "outputs": []
            }
        ]
    }
    
    notebook_path = temp_dir / "simple_test.ipynb"
    with open(notebook_path, 'w', encoding='utf-8') as f:
        import json
        json.dump(notebook_content, f, indent=2)
    
    return notebook_path


@pytest.fixture
def sample_notebook_medium(temp_dir):
    """
    Fixture pour un notebook de test moyen (5-30s).
    """
    notebook_content = {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {},
        "cells": [
            {
                "cell_type": "code",
                "source": "import pandas as pd\nimport numpy as np\ndata = pd.DataFrame({'x': np.random.randn(1000)})\nresult = data.describe()",
                "metadata": {},
                "execution_count": None,
                "outputs": []
            },
            {
                "cell_type": "code", 
                "source": "import time\ntime.sleep(2)  # Simulate processing\nprint('Medium processing complete')",
                "metadata": {},
                "execution_count": None,
                "outputs": []
            }
        ]
    }
    
    notebook_path = temp_dir / "medium_test.ipynb"
    with open(notebook_path, 'w', encoding='utf-8') as f:
        import json
        json.dump(notebook_content, f, indent=2)
    
    return notebook_path


@pytest.fixture
def sample_notebook_complex(temp_dir):
    """
    Fixture pour un notebook de test complexe (30s-3min) - SemanticKernel mock.
    """
    notebook_content = {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {},
        "cells": [
            {
                "cell_type": "markdown",
                "source": "# SemanticKernel Mock Test\nSimulates a complex SemanticKernel notebook execution",
                "metadata": {}
            },
            {
                "cell_type": "code",
                "source": "# Mock SemanticKernel import\nprint('Importing SemanticKernel libraries...')\nimport time\ntime.sleep(5)  # Simulate import time",
                "metadata": {},
                "execution_count": None,
                "outputs": []
            },
            {
                "cell_type": "code",
                "source": "# Mock heavy processing\nprint('Processing semantic operations...')\nfor i in range(10):\n    time.sleep(1)\n    print(f'Step {i+1}/10')",
                "metadata": {},
                "execution_count": None,
                "outputs": []
            }
        ]
    }
    
    notebook_path = temp_dir / "complex_semantic_test.ipynb"
    with open(notebook_path, 'w', encoding='utf-8') as f:
        import json
        json.dump(notebook_content, f, indent=2)
    
    return notebook_path


@pytest.fixture
def sample_notebook_very_complex(temp_dir):
    """
    Fixture pour un notebook de test très complexe (> 3min) - SymbolicAI mock.
    """
    notebook_content = {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {},
        "cells": [
            {
                "cell_type": "markdown",
                "source": "# SymbolicAI Mock Test\nSimulates a very complex SymbolicAI notebook with Tweety JARs",
                "metadata": {}
            },
            {
                "cell_type": "code",
                "source": "# Mock SymbolicAI setup\nprint('Loading SymbolicAI libraries...')\nimport time\ntime.sleep(30)  # Simulate long initialization",
                "metadata": {},
                "execution_count": None,
                "outputs": []
            },
            {
                "cell_type": "code",
                "source": "# Mock Tweety JAR processing\nprint('Processing with Tweety JARs...')\nfor i in range(60):\n    time.sleep(2)\n    print(f'Processing argument {i+1}/60')",
                "metadata": {},
                "execution_count": None,
                "outputs": []
            }
        ]
    }
    
    notebook_path = temp_dir / "very_complex_symbolic_test.ipynb"
    with open(notebook_path, 'w', encoding='utf-8') as f:
        import json
        json.dump(notebook_content, f, indent=2)
    
    return notebook_path


@pytest.fixture
def mock_environment():
    """
    Fixture pour un environnement système mocké.
    """
    env = {
        "CONDA_DEFAULT_ENV": "test-env",
        "CONDA_PREFIX": "/test/conda/envs/test-env",
        "PYTHONPATH": "/test/pythonpath",
        "PATH": "/test/bin:/usr/bin",
        "DOTNET_ROOT": "/test/dotnet",
        "ROO_WORKSPACE_DIR": "/test/workspace"
    }
    return env


@pytest.fixture
def mock_successful_process():
    """
    Fixture pour un processus subprocess qui réussit.
    """
    process = MagicMock()
    process.poll.return_value = None  # Running
    process.wait.return_value = 0     # Success
    process.pid = 12345
    process.stdout.readline.side_effect = [
        "[2025-10-07T14:30:00] Executing cell 1/3\n",
        "[2025-10-07T14:30:01] Cell 1 completed\n",
        "[2025-10-07T14:30:02] Executing cell 2/3\n", 
        "[2025-10-07T14:30:03] Cell 2 completed\n",
        "[2025-10-07T14:30:04] Notebook execution complete\n",
        ""  # EOF
    ]
    process.stderr.readline.return_value = ""
    return process


@pytest.fixture
def mock_failing_process():
    """
    Fixture pour un processus subprocess qui échoue.
    """
    process = MagicMock()
    process.poll.return_value = None  # Running initially
    process.wait.return_value = 1     # Error exit code
    process.pid = 12346
    process.stdout.readline.side_effect = [
        "[2025-10-07T14:30:00] Executing cell 1/3\n",
        "[2025-10-07T14:30:01] Error in cell 1\n",
        ""  # EOF
    ]
    process.stderr.readline.side_effect = [
        "[2025-10-07T14:30:01] ERROR: NameError: name 'undefined_var' is not defined\n",
        ""  # EOF
    ]
    return process


@pytest.fixture
def mock_timeout_process():
    """
    Fixture pour un processus subprocess qui timeout.
    """
    import subprocess
    
    process = MagicMock()
    process.poll.return_value = None  # Still running
    process.wait.side_effect = subprocess.TimeoutExpired(
        cmd="test_command", timeout=30
    )
    process.pid = 12347
    process.terminate.return_value = None
    process.kill.return_value = None
    return process


@pytest.fixture
def mock_notebook_service():
    """
    Fixture pour un NotebookService mocké.
    """
    service = Mock(spec=NotebookService)
    service.resolve_path.side_effect = lambda x: str(Path(x).resolve())
    service._calculate_optimal_timeout.return_value = 120
    service._build_complete_environment.return_value = {
        "PATH": "/test/path",
        "CONDA_DEFAULT_ENV": "test"
    }
    return service


@pytest.fixture
def event_loop():
    """
    Fixture pour un event loop asyncio de test.
    """
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture
def thread_safe_context():
    """
    Fixture pour tester la thread safety avec des verrous.
    """
    context = {
        'lock': threading.RLock(),
        'shared_data': {},
        'access_count': 0
    }
    return context


# Parametrized fixtures pour les tests de complexité
@pytest.fixture(params=[
    ("simple", "simple_test.ipynb", 5),
    ("medium", "medium_test.ipynb", 30), 
    ("complex", "complex_semantic_test.ipynb", 180),
    ("very_complex", "very_complex_symbolic_test.ipynb", 300)
])
def notebook_complexity_fixture(request, temp_dir):
    """
    Fixture paramétrée pour tester différents niveaux de complexité.
    """
    complexity, filename, expected_timeout = request.param
    
    # Créer un notebook approprié selon la complexité
    if complexity == "simple":
        content = {"nbformat": 4, "nbformat_minor": 5, "metadata": {}, 
                  "cells": [{"cell_type": "code", "source": "print('simple')", "metadata": {}}]}
    elif complexity == "medium":
        content = {"nbformat": 4, "nbformat_minor": 5, "metadata": {}, 
                  "cells": [{"cell_type": "code", "source": "import pandas as pd\nprint('medium')", "metadata": {}}]}
    elif complexity == "complex":
        content = {"nbformat": 4, "nbformat_minor": 5, "metadata": {}, 
                  "cells": [{"cell_type": "code", "source": "# semantickernel\nprint('complex')", "metadata": {}}]}
    else:  # very_complex
        content = {"nbformat": 4, "nbformat_minor": 5, "metadata": {}, 
                  "cells": [{"cell_type": "code", "source": "# symbolic ai tweety\nprint('very complex')", "metadata": {}}]}
    
    notebook_path = temp_dir / filename
    with open(notebook_path, 'w') as f:
        import json
        json.dump(content, f)
    
    return {
        'complexity': complexity,
        'path': notebook_path,
        'expected_timeout': expected_timeout
    }
