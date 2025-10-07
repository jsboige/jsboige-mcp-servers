"""
Utilitaires de test et mocks pour les tests ExecutionManager.

Fournit des fonctions helper et des mocks réutilisables pour simplifier
l'écriture et la maintenance des tests.
"""

import asyncio
import json
import os
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, Any, List, Optional, Callable
from unittest.mock import Mock, MagicMock, patch
import subprocess

from papermill_mcp.services.notebook_service import (
    ExecutionJob, 
    JobStatus,
    ExecutionManager
)


class MockProcess:
    """
    Mock de subprocess.Popen avec comportements configurables.
    """
    
    def __init__(self, 
                 return_code: int = 0,
                 stdout_lines: List[str] = None,
                 stderr_lines: List[str] = None,
                 execution_time: float = 1.0,
                 timeout_after: Optional[float] = None):
        """
        Args:
            return_code: Code de retour du processus
            stdout_lines: Lignes à simuler sur stdout
            stderr_lines: Lignes à simuler sur stderr
            execution_time: Temps d'exécution simulé
            timeout_after: Si spécifié, timeout après ce délai
        """
        self.returncode = None  # Initially running
        self._final_return_code = return_code
        self.pid = 12345
        self.stdout_lines = stdout_lines or ["Notebook execution complete"]
        self.stderr_lines = stderr_lines or []
        self.execution_time = execution_time
        self.timeout_after = timeout_after
        self._start_time = time.time()
        self._terminated = False
        
        # Mock streams
        self.stdout = Mock()
        self.stderr = Mock()
        
        # Configure readline behavior
        self._setup_readline()
    
    def _setup_readline(self):
        """Configure les méthodes readline pour simuler un flux réel."""
        stdout_iter = iter(self.stdout_lines + [''])  # EOF
        stderr_iter = iter(self.stderr_lines + [''])  # EOF
        
        self.stdout.readline.side_effect = lambda: next(stdout_iter, '')
        self.stderr.readline.side_effect = lambda: next(stderr_iter, '')
    
    def poll(self):
        """Simule poll() - retourne None si en cours, return_code si terminé."""
        if self._terminated:
            return self._final_return_code
            
        elapsed = time.time() - self._start_time
        if elapsed >= self.execution_time:
            self.returncode = self._final_return_code
            return self._final_return_code
        return None
    
    def wait(self, timeout=None):
        """Simule wait() avec support timeout."""
        if self.timeout_after and timeout and timeout >= self.timeout_after:
            raise subprocess.TimeoutExpired(cmd="test_command", timeout=timeout)
        
        elapsed = time.time() - self._start_time
        remaining = self.execution_time - elapsed
        
        if timeout and remaining > timeout:
            raise subprocess.TimeoutExpired(cmd="test_command", timeout=timeout)
        
        # Attendre le temps restant
        if remaining > 0:
            time.sleep(remaining)
        
        self.returncode = self._final_return_code
        return self._final_return_code
    
    def terminate(self):
        """Simule terminate()."""
        self._terminated = True
        self.returncode = -15  # SIGTERM
    
    def kill(self):
        """Simule kill()."""
        self._terminated = True
        self.returncode = -9   # SIGKILL


class ExecutionManagerTester:
    """
    Helper pour tester ExecutionManager avec scenarios prédéfinis.
    """
    
    def __init__(self, execution_manager: ExecutionManager):
        self.manager = execution_manager
        self.job_results = {}
    
    async def wait_for_job_completion(self, 
                                     job_id: str, 
                                     timeout: float = 30.0,
                                     poll_interval: float = 0.1) -> Dict[str, Any]:
        """
        Attend qu'un job soit terminé et retourne son statut final.
        
        Args:
            job_id: ID du job à surveiller
            timeout: Timeout maximum d'attente
            poll_interval: Intervalle entre les polls
            
        Returns:
            Statut final du job
            
        Raises:
            TimeoutError: Si le job ne termine pas dans les temps
        """
        start_time = time.time()
        
        while time.time() - start_time < timeout:
            status = self.manager.get_execution_status(job_id)
            
            if not status["success"]:
                raise RuntimeError(f"Impossible de récupérer le statut du job {job_id}")
            
            if status["status"] in ["SUCCEEDED", "FAILED", "CANCELED", "TIMEOUT"]:
                self.job_results[job_id] = status
                return status
            
            await asyncio.sleep(poll_interval)
        
        raise TimeoutError(f"Job {job_id} n'a pas terminé dans les {timeout}s")
    
    def get_job_metrics(self, job_id: str) -> Dict[str, Any]:
        """
        Récupère les métriques d'un job terminé.
        """
        if job_id not in self.job_results:
            status = self.manager.get_execution_status(job_id)
            self.job_results[job_id] = status
        
        result = self.job_results[job_id]
        
        return {
            "job_id": job_id,
            "success": result.get("status") == "SUCCEEDED",
            "duration": result.get("duration_seconds", 0),
            "status": result.get("status"),
            "error": result.get("error_summary")
        }
    
    def assert_job_succeeded(self, job_id: str, max_duration: Optional[float] = None):
        """
        Assert qu'un job a réussi avec des contraintes optionnelles.
        """
        metrics = self.get_job_metrics(job_id)
        
        assert metrics["success"], f"Job {job_id} a échoué: {metrics['error']}"
        
        if max_duration:
            assert metrics["duration"] <= max_duration, \
                f"Job {job_id} a pris {metrics['duration']}s (max: {max_duration}s)"
    
    def assert_job_failed(self, job_id: str, expected_error: Optional[str] = None):
        """
        Assert qu'un job a échoué avec une erreur optionnelle attendue.
        """
        metrics = self.get_job_metrics(job_id)
        
        assert not metrics["success"], f"Job {job_id} aurait dû échouer mais a réussi"
        
        if expected_error:
            error_msg = metrics["error"] or ""
            assert expected_error in error_msg, \
                f"Erreur attendue '{expected_error}' non trouvée dans '{error_msg}'"


def create_test_notebook(cells: List[Dict[str, Any]], 
                        metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Crée un notebook de test avec les cellules spécifiées.
    
    Args:
        cells: Liste des cellules à ajouter
        metadata: Métadonnées du notebook
        
    Returns:
        Dictionnaire représentant le notebook
        
    Example:
        cells = [
            {"cell_type": "code", "source": "print('Hello')"},
            {"cell_type": "markdown", "source": "# Title"}
        ]
        notebook = create_test_notebook(cells)
    """
    return {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": metadata or {},
        "cells": [
            {
                "cell_type": cell.get("cell_type", "code"),
                "source": cell["source"],
                "metadata": cell.get("metadata", {}),
                "execution_count": cell.get("execution_count"),
                "outputs": cell.get("outputs", [])
            }
            for cell in cells
        ]
    }


def write_test_notebook(notebook_path: Path, 
                       cells: List[Dict[str, Any]], 
                       metadata: Optional[Dict[str, Any]] = None):
    """
    Écrit un notebook de test sur le disque.
    """
    notebook_content = create_test_notebook(cells, metadata)
    
    notebook_path.parent.mkdir(parents=True, exist_ok=True)
    with open(notebook_path, 'w', encoding='utf-8') as f:
        json.dump(notebook_content, f, indent=2)


class ThreadSafeTester:
    """
    Helper pour tester la thread safety de ExecutionManager.
    """
    
    def __init__(self):
        self.results = []
        self.lock = threading.Lock()
        self.errors = []
    
    def thread_worker(self, 
                      worker_id: int,
                      execution_manager: ExecutionManager,
                      notebook_path: str,
                      iterations: int = 1):
        """
        Worker thread pour tester les accès concurrents.
        """
        try:
            for i in range(iterations):
                # Simuler des opérations concurrentes
                job_result = execution_manager.start_notebook_async(
                    input_path=notebook_path,
                    wait_seconds=0.1  # Court délai pour vérifier l'état
                )
                
                with self.lock:
                    self.results.append({
                        "worker_id": worker_id,
                        "iteration": i,
                        "job_id": job_result.get("job_id"),
                        "success": job_result.get("success", False),
                        "timestamp": datetime.now().isoformat()
                    })
                
                # Petit délai entre opérations
                time.sleep(0.05)
                
        except Exception as e:
            with self.lock:
                self.errors.append({
                    "worker_id": worker_id,
                    "error": str(e),
                    "timestamp": datetime.now().isoformat()
                })
    
    def run_concurrent_test(self,
                           execution_manager: ExecutionManager,
                           notebook_path: str,
                           num_threads: int = 5,
                           iterations_per_thread: int = 3) -> Dict[str, Any]:
        """
        Lance un test de concurrence et retourne les résultats.
        """
        self.results.clear()
        self.errors.clear()
        
        threads = []
        start_time = time.time()
        
        # Lancer les threads
        for worker_id in range(num_threads):
            thread = threading.Thread(
                target=self.thread_worker,
                args=(worker_id, execution_manager, notebook_path, iterations_per_thread)
            )
            threads.append(thread)
            thread.start()
        
        # Attendre la fin
        for thread in threads:
            thread.join(timeout=30)  # Timeout de sécurité
        
        end_time = time.time()
        
        return {
            "duration": end_time - start_time,
            "total_operations": len(self.results),
            "successful_operations": len([r for r in self.results if r["success"]]),
            "errors": self.errors,
            "results": self.results
        }


def mock_environment_variables() -> Dict[str, str]:
    """
    Retourne un environnement de test standard.
    """
    return {
        "CONDA_DEFAULT_ENV": "test-mcp-jupyter",
        "CONDA_PREFIX": "/test/conda/envs/test-mcp-jupyter",
        "CONDA_PYTHON_EXE": "/test/conda/envs/test-mcp-jupyter/python.exe",
        "PYTHONPATH": "/test/papermill-mcp",
        "JUPYTER_DATA_DIR": "/test/jupyter/data",
        "DOTNET_ROOT": "/test/dotnet",
        "NUGET_PACKAGES": "/test/nuget/packages",
        "ROO_WORKSPACE_DIR": "/test/workspace",
        "PATH": "/test/conda/bin:/usr/bin:/bin"
    }


class TimeoutHelper:
    """
    Helper pour tester les comportements avec timeout.
    """
    
    @staticmethod
    def create_timeout_scenarios() -> List[Dict[str, Any]]:
        """
        Crée des scénarios de test pour les timeouts.
        """
        return [
            {
                "name": "quick_success",
                "execution_time": 1.0,
                "timeout": 5.0,
                "expected_outcome": "success"
            },
            {
                "name": "timeout_short",
                "execution_time": 10.0,
                "timeout": 5.0,
                "expected_outcome": "timeout"
            },
            {
                "name": "timeout_long",
                "execution_time": 30.0,
                "timeout": 60.0,
                "expected_outcome": "success"
            }
        ]
    
    @staticmethod
    async def wait_with_timeout(coro, timeout: float):
        """
        Execute une coroutine avec timeout.
        """
        try:
            return await asyncio.wait_for(coro, timeout=timeout)
        except asyncio.TimeoutError:
            raise TimeoutError(f"Opération timeout après {timeout}s")


def assert_job_status_progression(job_statuses: List[str], 
                                expected_progression: List[str]):
    """
    Vérifie qu'un job suit la progression de statuts attendue.
    
    Args:
        job_statuses: Liste des statuts observés dans l'ordre chronologique
        expected_progression: Liste des statuts attendus
        
    Example:
        assert_job_status_progression(
            ["PENDING", "RUNNING", "SUCCEEDED"],
            ["PENDING", "RUNNING", "SUCCEEDED"]
        )
    """
    assert len(job_statuses) >= len(expected_progression), \
        f"Pas assez de statuts observés: {job_statuses} vs {expected_progression}"
    
    for i, expected_status in enumerate(expected_progression):
        assert job_statuses[i] == expected_status, \
            f"À l'étape {i}, attendu '{expected_status}' mais trouvé '{job_statuses[i]}'"


def create_complexity_test_data() -> Dict[str, Dict[str, Any]]:
    """
    Crée des données de test pour différents niveaux de complexité.
    """
    return {
        "simple": {
            "cells": [
                {"cell_type": "code", "source": "result = 2 + 2\nprint(f'Result: {result}')"}
            ],
            "expected_timeout_range": (5, 30),
            "expected_duration_range": (0.1, 5.0)
        },
        "medium": {
            "cells": [
                {"cell_type": "code", "source": "import pandas as pd\nimport numpy as np"},
                {"cell_type": "code", "source": "data = pd.DataFrame({'x': np.random.randn(1000)})"},
                {"cell_type": "code", "source": "result = data.describe()"}
            ],
            "expected_timeout_range": (30, 120),
            "expected_duration_range": (5.0, 30.0)
        },
        "complex": {
            "cells": [
                {"cell_type": "markdown", "source": "# SemanticKernel Test"},
                {"cell_type": "code", "source": "# Mock semantickernel import\nprint('Loading SemanticKernel...')"},
                {"cell_type": "code", "source": "# Complex operations\nfor i in range(100):\n    pass"}
            ],
            "expected_timeout_range": (120, 300),
            "expected_duration_range": (30.0, 180.0)
        },
        "very_complex": {
            "cells": [
                {"cell_type": "markdown", "source": "# SymbolicAI with Tweety JARs"},
                {"cell_type": "code", "source": "# Mock symbolic AI setup\nprint('Loading Tweety JARs...')"},
                {"cell_type": "code", "source": "# Very complex operations\nfor i in range(1000):\n    pass"}
            ],
            "expected_timeout_range": (300, 1200),
            "expected_duration_range": (180.0, 600.0)
        }
    }
