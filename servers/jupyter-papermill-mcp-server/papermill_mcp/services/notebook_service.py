"""
Notebook service for managing notebook operations.

Provides business logic for notebook file operations, combining
core modules and utilities for notebook management.
"""

import asyncio
import json
import logging
import os
import sys
import threading
import uuid
import subprocess
import time
from pathlib import Path
from typing import Dict, List, Optional, Any, Union
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from enum import Enum

from nbformat import NotebookNode

from ..core.papermill_executor import PapermillExecutor
from ..utils.file_utils import FileUtils
from ..config import MCPConfig
from .notebook_service_consolidated import ExecuteNotebookConsolidated

logger = logging.getLogger(__name__)


class JobStatus(Enum):
    """États possibles des jobs d'exécution asynchrone."""
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    CANCELED = "CANCELED"
    TIMEOUT = "TIMEOUT"


@dataclass
class ExecutionJob:
    """Représente un job d'exécution de notebook asynchrone."""
    job_id: str
    input_path: str
    output_path: str
    parameters: Dict[str, Any] = field(default_factory=dict)
    status: JobStatus = JobStatus.PENDING
    started_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    ended_at: Optional[datetime] = None
    return_code: Optional[int] = None
    error_message: Optional[str] = None
    process: Optional[subprocess.Popen] = None
    stdout_buffer: List[str] = field(default_factory=list)
    stderr_buffer: List[str] = field(default_factory=list)
    timeout_seconds: Optional[int] = None
    
    @property
    def duration_seconds(self) -> Optional[float]:
        """Calcule la durée d'exécution en secondes."""
        if not self.started_at:
            return None
        end_time = self.ended_at or datetime.now()
        return (end_time - self.started_at).total_seconds()


class ExecutionManager:
    """
    Gestionnaire d'exécution asynchrone pour notebooks.
    
    Implémente une architecture job-based qui permet d'exécuter des notebooks
    de longue durée (>60s) sans heurter les timeouts MCP côté client.
    
    Utilise subprocess.Popen pour capture stdout/stderr non bloquante et
    ThreadPoolExecutor pour gestion thread-safe des jobs multiples.
    """
    
    def __init__(self, max_concurrent_jobs: int = 5):
        """
        Initialise le gestionnaire d'exécution.
        
        Args:
            max_concurrent_jobs: Nombre maximum de jobs simultanés
        """
        self.jobs: Dict[str, ExecutionJob] = {}
        self.lock = threading.RLock()
        self.executor = ThreadPoolExecutor(max_workers=max_concurrent_jobs)
        self.max_concurrent_jobs = max_concurrent_jobs
        logger.info(f"ExecutionManager initialized with max {max_concurrent_jobs} concurrent jobs")
    
    def _generate_job_id(self) -> str:
        """Génère un ID unique pour un job."""
        return str(uuid.uuid4())[:8]
    
    def _count_running_jobs(self) -> int:
        """Compte les jobs actuellement en cours d'exécution."""
        with self.lock:
            return sum(1 for job in self.jobs.values()
                      if job.status in [JobStatus.RUNNING, JobStatus.PENDING])
    
    def start_notebook_async(
        self,
        input_path: str,
        output_path: Optional[str] = None,
        parameters: Optional[Dict[str, Any]] = None,
        working_dir_override: Optional[str] = None,
        env_overrides: Optional[Dict[str, str]] = None,
        timeout_seconds: Optional[int] = None,
        wait_seconds: float = 0
    ) -> Dict[str, Any]:
        """
        Démarre l'exécution asynchrone d'un notebook.
        
        Args:
            input_path: Chemin du notebook d'entrée
            output_path: Chemin du notebook de sortie (optionnel)
            parameters: Paramètres à injecter (optionnel)
            working_dir_override: Répertoire de travail personnalisé
            env_overrides: Variables d'environnement supplémentaires
            timeout_seconds: Timeout personnalisé (auto-calculé si None)
            wait_seconds: Attendre la confirmation de démarrage (0 = immédiat)
            
        Returns:
            Dictionary avec job_id, status, started_at, etc.
        """
        with self.lock:
            # Vérifier la limite de jobs concurrent
            if self._count_running_jobs() >= self.max_concurrent_jobs:
                return {
                    "success": False,
                    "error": f"Too many concurrent jobs ({self.max_concurrent_jobs} max)",
                    "running_jobs": self._count_running_jobs()
                }
            
            # Créer le job
            job_id = self._generate_job_id()
            resolved_input_path = str(Path(input_path).resolve())
            
            if output_path is None:
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                output_path = str(Path(input_path).parent / f"{Path(input_path).stem}_executed_{timestamp}.ipynb")
            
            # Calculer timeout optimal si non spécifié
            if timeout_seconds is None:
                timeout_seconds = self._calculate_optimal_timeout(Path(resolved_input_path))
            
            job = ExecutionJob(
                job_id=job_id,
                input_path=resolved_input_path,
                output_path=str(Path(output_path).resolve()),
                parameters=parameters or {},
                timeout_seconds=timeout_seconds
            )
            
            self.jobs[job_id] = job
            logger.info(f"Created job {job_id} for notebook: {input_path}")
            
            # Lancer l'exécution en arrière-plan
            future = self.executor.submit(
                self._execute_job,
                job,
                working_dir_override,
                env_overrides
            )
            
            # Attendre le démarrage si demandé
            if wait_seconds > 0:
                time.sleep(wait_seconds)
                with self.lock:
                    job = self.jobs[job_id]  # Refresh status
            
            return {
                "success": True,
                "job_id": job_id,
                "status": job.status.value,
                "started_at": job.started_at.isoformat() if job.started_at else None,
                "notebook": job.input_path,
                "output_path": job.output_path,
                "timeout_seconds": job.timeout_seconds
            }
    
    def _execute_job(
        self,
        job: ExecutionJob,
        working_dir_override: Optional[str],
        env_overrides: Optional[Dict[str, str]]
    ) -> None:
        """
        Exécute un job en arrière-plan avec subprocess.Popen.
        
        Cette méthode s'exécute dans un thread séparé via ThreadPoolExecutor.
        """
        try:
            with self.lock:
                job.status = JobStatus.RUNNING
                job.started_at = datetime.now()
                job.updated_at = job.started_at
            
            logger.info(f"Starting job {job.job_id}: {job.input_path}")
            
            # Déterminer le répertoire de travail
            if working_dir_override:
                work_dir = Path(working_dir_override)
            else:
                work_dir = Path(job.input_path).parent
            
            # Construire l'environnement complet
            env = self._build_complete_environment()
            if env_overrides:
                env.update(env_overrides)
            
            # Construire la commande conda run
            conda_python = "C:/Users/jsboi/.conda/envs/mcp-jupyter-py310/python.exe"
            cmd = [
                conda_python, "-m", "papermill",
                Path(job.input_path).name,  # Nom relatif dans le répertoire de travail
                Path(job.output_path).name if Path(job.output_path).parent == work_dir else job.output_path,
                "--progress-bar"
            ]
            
            # Ajouter les paramètres si spécifiés
            for key, value in job.parameters.items():
                cmd.extend(["-p", key, str(value)])
            
            logger.info(f"Job {job.job_id} command: {' '.join(cmd)}")
            logger.info(f"Job {job.job_id} working directory: {work_dir}")
            
            # Démarrer le processus avec subprocess.Popen pour capture non-bloquante
            process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=str(work_dir),
                env=env
            )
            
            with self.lock:
                job.process = process
            
            # Capturer stdout/stderr en continu
            self._capture_output_streams(job)
            
            # Attendre la fin ou timeout
            try:
                return_code = process.wait(timeout=job.timeout_seconds)
                
                with self.lock:
                    job.return_code = return_code
                    job.ended_at = datetime.now()
                    job.updated_at = job.ended_at
                    
                    if return_code == 0 and Path(job.output_path).exists():
                        job.status = JobStatus.SUCCEEDED
                        logger.info(f"Job {job.job_id} completed successfully in {job.duration_seconds:.2f}s")
                    else:
                        job.status = JobStatus.FAILED
                        job.error_message = f"Process failed with return code {return_code}"
                        logger.error(f"Job {job.job_id} failed with return code {return_code}")
                        
            except subprocess.TimeoutExpired:
                logger.warning(f"Job {job.job_id} timed out after {job.timeout_seconds}s")
                self._terminate_job(job, JobStatus.TIMEOUT, f"Execution timed out after {job.timeout_seconds}s")
                
        except Exception as e:
            logger.error(f"Job {job.job_id} failed with exception: {e}")
            with self.lock:
                job.status = JobStatus.FAILED
                job.error_message = str(e)
                job.ended_at = datetime.now()
                job.updated_at = job.ended_at
    
    def _capture_output_streams(self, job: ExecutionJob) -> None:
        """
        Capture stdout/stderr en continu dans des threads séparés.
        
        Args:
            job: Job dont capturer les sorties
        """
        def capture_stdout():
            try:
                for line in iter(job.process.stdout.readline, ''):
                    if line:
                        with self.lock:
                            job.stdout_buffer.append(f"[{datetime.now().isoformat()}] {line.rstrip()}")
                            job.updated_at = datetime.now()
            except Exception as e:
                logger.warning(f"Error capturing stdout for job {job.job_id}: {e}")
        
        def capture_stderr():
            try:
                for line in iter(job.process.stderr.readline, ''):
                    if line:
                        with self.lock:
                            job.stderr_buffer.append(f"[{datetime.now().isoformat()}] {line.rstrip()}")
                            job.updated_at = datetime.now()
            except Exception as e:
                logger.warning(f"Error capturing stderr for job {job.job_id}: {e}")
        
        # Démarrer les threads de capture
        threading.Thread(target=capture_stdout, daemon=True).start()
        threading.Thread(target=capture_stderr, daemon=True).start()
    
    def _terminate_job(self, job: ExecutionJob, status: JobStatus, error_message: str) -> None:
        """
        Termine un job avec gestion Windows appropriée.
        
        Args:
            job: Job à terminer
            status: Nouveau statut
            error_message: Message d'erreur
        """
        try:
            if job.process and job.process.poll() is None:
                # Tentative de terminaison gracieuse
                job.process.terminate()
                try:
                    job.process.wait(timeout=5)
                    logger.info(f"Job {job.job_id} terminated gracefully")
                except subprocess.TimeoutExpired:
                    # Force kill si nécessaire (Windows)
                    job.process.kill()
                    job.process.wait()
                    logger.warning(f"Job {job.job_id} force-killed")
            
            with self.lock:
                job.status = status
                job.error_message = error_message
                job.ended_at = datetime.now()
                job.updated_at = job.ended_at
                
        except Exception as e:
            logger.error(f"Error terminating job {job.job_id}: {e}")
    
    def get_execution_status(self, job_id: str) -> Dict[str, Any]:
        """
        Récupère le statut d'exécution d'un job.
        
        Args:
            job_id: ID du job
            
        Returns:
            Dictionary avec statut complet du job
        """
        with self.lock:
            if job_id not in self.jobs:
                return {
                    "success": False,
                    "error": f"Job {job_id} not found",
                    "job_id": job_id
                }
            
            job = self.jobs[job_id]
            
            return {
                "success": True,
                "job_id": job_id,
                "status": job.status.value,
                "started_at": job.started_at.isoformat() if job.started_at else None,
                "updated_at": job.updated_at.isoformat() if job.updated_at else None,
                "ended_at": job.ended_at.isoformat() if job.ended_at else None,
                "duration_seconds": job.duration_seconds,
                "return_code": job.return_code,
                "output_path": job.output_path,
                "error_summary": job.error_message,
                "timeout_seconds": job.timeout_seconds,
                "progress_hint": self._get_progress_hint(job)
            }
    
    def get_job_logs(self, job_id: str, since_line: int = 0) -> Dict[str, Any]:
        """
        Récupère les logs d'un job avec pagination.
        
        Args:
            job_id: ID du job
            since_line: Ligne de départ pour la pagination
            
        Returns:
            Dictionary avec chunks de logs
        """
        with self.lock:
            if job_id not in self.jobs:
                return {
                    "success": False,
                    "error": f"Job {job_id} not found",
                    "job_id": job_id
                }
            
            job = self.jobs[job_id]
            
            stdout_chunk = job.stdout_buffer[since_line:] if since_line < len(job.stdout_buffer) else []
            stderr_chunk = job.stderr_buffer[since_line:] if since_line < len(job.stderr_buffer) else []
            
            return {
                "success": True,
                "job_id": job_id,
                "stdout_chunk": stdout_chunk,
                "stderr_chunk": stderr_chunk,
                "next_line": max(len(job.stdout_buffer), len(job.stderr_buffer)),
                "stdout_eof": job.status in [JobStatus.SUCCEEDED, JobStatus.FAILED, JobStatus.CANCELED, JobStatus.TIMEOUT],
                "stderr_eof": job.status in [JobStatus.SUCCEEDED, JobStatus.FAILED, JobStatus.CANCELED, JobStatus.TIMEOUT],
                "job_status": job.status.value
            }
    
    def cancel_job(self, job_id: str) -> Dict[str, Any]:
        """
        Annule un job en cours d'exécution.
        
        Args:
            job_id: ID du job à annuler
            
        Returns:
            Dictionary avec résultat de l'annulation
        """
        with self.lock:
            if job_id not in self.jobs:
                return {
                    "success": False,
                    "error": f"Job {job_id} not found",
                    "job_id": job_id
                }
            
            job = self.jobs[job_id]
            
            if job.status not in [JobStatus.PENDING, JobStatus.RUNNING]:
                return {
                    "success": False,
                    "error": f"Job {job_id} is not cancelable (status: {job.status.value})",
                    "job_id": job_id,
                    "status": job.status.value
                }
            
            # Terminer le job
            self._terminate_job(job, JobStatus.CANCELED, "Job canceled by user request")
            
            return {
                "success": True,
                "job_id": job_id,
                "canceled": True,
                "status_after": job.status.value,
                "canceled_at": job.ended_at.isoformat() if job.ended_at else None
            }
    
    def list_jobs(self) -> Dict[str, Any]:
        """
        Liste tous les jobs avec statuts raccourcis.
        
        Returns:
            Dictionary avec liste des jobs
        """
        with self.lock:
            jobs_list = []
            for job in self.jobs.values():
                jobs_list.append({
                    "job_id": job.job_id,
                    "status": job.status.value,
                    "input_path": job.input_path,
                    "started_at": job.started_at.isoformat() if job.started_at else None,
                    "duration_seconds": job.duration_seconds,
                    "timeout_seconds": job.timeout_seconds
                })
            
            return {
                "success": True,
                "total_jobs": len(jobs_list),
                "running_jobs": self._count_running_jobs(),
                "jobs": jobs_list
            }
    
    def _get_progress_hint(self, job: ExecutionJob) -> Optional[str]:
        """
        Génère un indice de progression basé sur les logs récents.
        
        Args:
            job: Job pour lequel générer l'indice
            
        Returns:
            Indice de progression ou None
        """
        if not job.stdout_buffer:
            return None
        
        # Rechercher les patterns de progression dans les logs récents
        recent_logs = job.stdout_buffer[-5:]  # 5 dernières lignes
        
        for log_line in reversed(recent_logs):
            if "%" in log_line and any(word in log_line.lower() for word in ["executing", "progress", "cell"]):
                return log_line.split("]", 1)[-1].strip() if "]" in log_line else log_line
        
        # Fallback: dernière ligne non vide
        for log_line in reversed(recent_logs):
            if log_line.strip():
                return log_line.split("]", 1)[-1].strip() if "]" in log_line else log_line[:100]
        
        return None
    
    def _calculate_optimal_timeout(self, notebook_path: Path) -> int:
        """
        Calcule le timeout optimal (réutilise la logique existante).
        """
        try:
            notebook_name = notebook_path.name.lower()
            
            # Analyse du contenu pour déterminer la complexité
            with open(notebook_path, 'r', encoding='utf-8') as f:
                content = f.read().lower()
            
            # Timeout de base
            base_timeout = 120  # 2 minutes base pour job async
            
            # Extensions basées sur les patterns détectés
            if 'semantickernel' in notebook_name or 'semantic_kernel' in content:
                if any(pattern in notebook_name for pattern in ['04', 'clr', 'building']):
                    return max(base_timeout, 1200)  # 20 minutes pour CLR/building notebooks
                elif any(pattern in notebook_name for pattern in ['05', 'notebookmaker', 'widget']):
                    return max(base_timeout, 600)   # 10 minutes pour widget notebooks
                else:
                    return max(base_timeout, 300)   # 5 minutes pour autres SemanticKernel
            
            # .NET notebooks avec NuGet packages
            if any(pattern in content for pattern in ['.net', 'nuget', 'microsoft.ml', 'dotnet']):
                return max(base_timeout, 300)  # 5 minutes pour .NET
            
            # Python notebooks avec ML/AI libraries
            if any(pattern in content for pattern in ['tensorflow', 'pytorch', 'sklearn', 'pandas', 'numpy']):
                return max(base_timeout, 180)  # 3 minutes pour ML
            
            # Notebooks simples
            return base_timeout
            
        except Exception as e:
            logger.warning(f"Failed to calculate optimal timeout for {notebook_path}: {e}")
            return 120  # Default fallback
    
    def _build_complete_environment(self) -> Dict[str, str]:
        """
        Construit un environnement complet (réutilise la logique existante).
        """
        env = os.environ.copy()
        
        # Variables critiques pour conda
        conda_vars = {
            "CONDA_DEFAULT_ENV": "mcp-jupyter-py310",
            "CONDA_PREFIX": "C:/Users/jsboi/.conda/envs/mcp-jupyter-py310",
            "CONDA_PROMPT_MODIFIER": "(mcp-jupyter-py310) ",
            "CONDA_PYTHON_EXE": "C:/Users/jsboi/.conda/envs/mcp-jupyter-py310/python.exe",
            "CONDA_SHLVL": "1",
            "CONDA_EXE": "C:/Users/jsboi/.conda/Scripts/conda.exe"
        }
        
        # Variables critiques pour .NET
        dotnet_vars = {
            "DOTNET_ROOT": "C:\\Program Files\\dotnet",
            "DOTNET_HOST_PATH": "C:\\Program Files\\dotnet\\dotnet.exe",
            "NUGET_PACKAGES": "C:\\Users\\jsboi\\.nuget\\packages",
            "MSBuildExtensionsPath": "C:\\Program Files\\dotnet\\sdk\\9.0.305",
            "MSBuildSDKsPath": "C:\\Program Files\\dotnet\\sdk\\9.0.305\\Sdks",
            "MSBuildToolsPath": "C:\\Program Files\\dotnet\\sdk\\9.0.305",
            "MSBuildUserExtensionsPath": "C:\\Users\\jsboi\\AppData\\Local\\Microsoft\\MSBuild",
            "DOTNET_CLI_TELEMETRY_OPTOUT": "1",
            "DOTNET_NOLOGO": "1",
            "DOTNET_SKIP_FIRST_TIME_EXPERIENCE": "1"
        }
        
        # Variables pour Jupyter et Python
        python_vars = {
            "PYTHONPATH": "D:/dev/roo-extensions/mcps/internal/servers/jupyter-papermill-mcp-server",
            "JUPYTER_DATA_DIR": "C:/Users/jsboi/.conda/envs/mcp-jupyter-py310/share/jupyter",
            "JUPYTER_CONFIG_DIR": "C:/Users/jsboi/.conda/envs/mcp-jupyter-py310/etc/jupyter",
            "PYTHONUNBUFFERED": "1",
            "PYTHONDONTWRITEBYTECODE": "1"
        }
        
        # Variables spécifiques Roo
        workspace_dir = os.getenv('ROO_WORKSPACE_DIR', 'd:/dev/CoursIA')
        roo_vars = {
            "ROO_WORKSPACE_DIR": workspace_dir
        }
        
        # Construire le PATH complet
        path_components = [
            "C:/Users/jsboi/.conda/envs/mcp-jupyter-py310/Scripts",
            "C:/Users/jsboi/.conda/envs/mcp-jupyter-py310/Library/mingw-w64/bin",
            "C:/Users/jsboi/.conda/envs/mcp-jupyter-py310/Library/usr/bin",
            "C:/Users/jsboi/.conda/envs/mcp-jupyter-py310/Library/bin",
            "C:/Users/jsboi/.conda/envs/mcp-jupyter-py310",
            "C:\\Program Files\\dotnet",
            env.get("PATH", "")
        ]
        
        # Mettre à jour l'environnement
        env.update(conda_vars)
        env.update(dotnet_vars)
        env.update(python_vars)
        env.update(roo_vars)
        env["PATH"] = ";".join(path_components)
        
        return env
    
    def cleanup_old_jobs(self, max_age_hours: int = 24) -> Dict[str, Any]:
        """
        Nettoie les anciens jobs terminés.
        
        Args:
            max_age_hours: Age maximum en heures pour conserver les jobs
            
        Returns:
            Dictionary avec résultat du nettoyage
        """
        cutoff_time = datetime.now() - timedelta(hours=max_age_hours)
        cleaned_count = 0
        
        with self.lock:
            jobs_to_remove = []
            for job_id, job in self.jobs.items():
                if (job.status in [JobStatus.SUCCEEDED, JobStatus.FAILED, JobStatus.CANCELED, JobStatus.TIMEOUT] and
                    job.ended_at and job.ended_at < cutoff_time):
                    jobs_to_remove.append(job_id)
            
            for job_id in jobs_to_remove:
                del self.jobs[job_id]
                cleaned_count += 1
        
        logger.info(f"Cleaned up {cleaned_count} old jobs")
        return {
            "success": True,
            "cleaned_jobs": cleaned_count,
            "remaining_jobs": len(self.jobs)
        }


# Instance globale du gestionnaire d'exécution
_execution_manager: Optional[ExecutionManager] = None


def get_execution_manager() -> ExecutionManager:
    """Récupère l'instance globale du gestionnaire d'exécution."""
    global _execution_manager
    if _execution_manager is None:
        _execution_manager = ExecutionManager()
    return _execution_manager


class NotebookService:
    """Service class for notebook operations."""
    
    def __init__(self, config: MCPConfig):
        """
        Initialize the notebook service.
        
        Args:
            config: MCP configuration object
        """
        self.config = config
        self.papermill_executor = PapermillExecutor(config)
        
        # Get the workspace directory from environment
        # This should be set by the MCP client (Roo)
        self.workspace_dir = os.getenv('ROO_WORKSPACE_DIR', 'd:/dev/CoursIA')
        logger.info(f"NotebookService initialized with workspace: {self.workspace_dir}")
        
        # Initialize consolidated executor (Phase 3)
        self._consolidated_executor = ExecuteNotebookConsolidated(self)
    
    async def execute_notebook_consolidated(
        self,
        input_path: str,
        output_path: Optional[str] = None,
        parameters: Optional[Dict[str, Any]] = None,
        mode: str = "sync",
        kernel_name: Optional[str] = None,
        timeout: Optional[int] = None,
        log_output: bool = True,
        progress_bar: bool = False,
        report_mode: str = "summary"
    ) -> Dict[str, Any]:
        """
        🆕 PHASE 3 - Exécution consolidée de notebook avec Papermill.
        
        Remplace: execute_notebook_papermill, parameterize_notebook,
                  execute_notebook_solution_a, execute_notebook_sync, start_notebook_async
        
        Args:
            input_path: Chemin du notebook source
            output_path: Chemin du notebook de sortie (optionnel, auto-généré si None)
            parameters: Paramètres à injecter dans le notebook (dict clé-valeur)
            mode: Mode d'exécution ("sync" | "async")
            kernel_name: Nom du kernel à utiliser (auto-détecté si None)
            timeout: Timeout global en secondes (None = illimité)
            log_output: Activer logging des outputs pendant exécution
            progress_bar: Afficher barre de progression (mode sync uniquement)
            report_mode: Niveau de détail du rapport ("full" | "summary" | "minimal")
            
        Returns:
            Dictionary avec résultat selon le mode (voir ExecuteNotebookConsolidated.execute_notebook)
        """
        return await self._consolidated_executor.execute_notebook(
            input_path=input_path,
            output_path=output_path,
            parameters=parameters,
            mode=mode,
            kernel_name=kernel_name,
            timeout=timeout,
            log_output=log_output,
            progress_bar=progress_bar,
            report_mode=report_mode
        )
    
    def resolve_path(self, path: Union[str, Path]) -> str:
        """
        Resolve path to absolute path, handling workspace-relative paths.
        
        Args:
            path: Input path (relative or absolute)
            
        Returns:
            Absolute path string
        """
        path_str = str(path)
        
        # If already absolute, return as-is
        if os.path.isabs(path_str):
            logger.info(f"Path resolution (absolute): {path_str}")
            return path_str
        
        # If relative, resolve against workspace directory
        workspace_path = os.path.join(self.workspace_dir, path_str)
        absolute_path = os.path.abspath(workspace_path)
        
        logger.info(f"Path resolution: {path_str} -> {absolute_path} (workspace: {self.workspace_dir})")
        return absolute_path
    
    async def read_notebook(self, path: Union[str, Path]) -> Dict[str, Any]:
        """
        Read a notebook from file and return its content.
        
        Args:
            path: Path to the notebook file
            
        Returns:
            Dictionary with notebook content and metadata
            
        Raises:
            FileNotFoundError: If notebook file doesn't exist
            ValueError: If notebook format is invalid
        """
        try:
            # Resolve path against workspace
            resolved_path = Path(self.resolve_path(path))
            logger.info(f"Reading notebook: {path} -> {resolved_path}")
            
            # Read notebook using FileUtils
            notebook = FileUtils.read_notebook(resolved_path)
            
            # Get file stats
            stat = resolved_path.stat()
            
            # Convert notebook to dictionary format
            result = {
                "nbformat": notebook.nbformat,
                "nbformat_minor": notebook.nbformat_minor,
                "metadata": dict(notebook.metadata),
                "cells": []
            }
            
            # Convert cells to dictionary format
            for cell in notebook.cells:
                cell_dict = {
                    "cell_type": cell.cell_type,
                    "source": cell.source,
                    "metadata": dict(cell.metadata)
                }
                
                # Add execution-specific fields for code cells
                if cell.cell_type == "code":
                    cell_dict["execution_count"] = getattr(cell, "execution_count", None)
                    cell_dict["outputs"] = getattr(cell, "outputs", [])
                
                result["cells"].append(cell_dict)
            
            # Add file information
            result["file_info"] = {
                "path": str(resolved_path),
                "size": stat.st_size,
                "modified": stat.st_mtime,
                "cell_count": len(notebook.cells)
            }
            
            logger.info(f"Successfully read notebook with {len(notebook.cells)} cells")
            return result
            
        except Exception as e:
            logger.error(f"Error reading notebook {path}: {e}")
            raise
    
    async def write_notebook(self, path: Union[str, Path], content: Dict[str, Any]) -> Dict[str, Any]:
        """
        Write notebook content to a file.
        
        Args:
            path: Path where to save the notebook
            content: Notebook content in dictionary format
            
        Returns:
            Dictionary with operation result
            
        Raises:
            ValueError: If notebook content is invalid
        """
        try:
            # Resolve path against workspace
            resolved_path = Path(self.resolve_path(path))
            logger.info(f"Writing notebook: {path} -> {resolved_path}")
            
            # Convert dictionary to NotebookNode
            from nbformat.v4 import new_notebook
            
            notebook = new_notebook()
            notebook.nbformat = content.get("nbformat", 4)
            notebook.nbformat_minor = content.get("nbformat_minor", 5)
            notebook.metadata.update(content.get("metadata", {}))
            
            # Add cells
            from nbformat.v4 import new_code_cell, new_markdown_cell, new_raw_cell
            
            for cell_data in content.get("cells", []):
                cell_type = cell_data["cell_type"]
                source = cell_data["source"]
                metadata = cell_data.get("metadata", {})
                
                if cell_type == "code":
                    cell = new_code_cell(source=source, metadata=metadata)
                    # Restore execution info if present
                    if "execution_count" in cell_data:
                        cell.execution_count = cell_data["execution_count"]
                    if "outputs" in cell_data:
                        cell.outputs = cell_data["outputs"]
                elif cell_type == "markdown":
                    cell = new_markdown_cell(source=source, metadata=metadata)
                elif cell_type == "raw":
                    cell = new_raw_cell(source=source, metadata=metadata)
                else:
                    raise ValueError(f"Unknown cell type: {cell_type}")
                
                notebook.cells.append(cell)
            
            # Write notebook using FileUtils
            written_path = FileUtils.write_notebook(notebook, resolved_path)
            
            # Get file stats
            stat = written_path.stat()
            
            result = {
                "path": str(written_path),
                "size": stat.st_size,
                "cell_count": len(notebook.cells),
                "success": True
            }
            
            logger.info(f"Successfully wrote notebook with {len(notebook.cells)} cells")
            return result
            
        except Exception as e:
            logger.error(f"Error writing notebook {path}: {e}")
            raise
    
    async def create_notebook(self, path: Union[str, Path], kernel: str = "python3") -> Dict[str, Any]:
        """
        Create a new empty notebook.
        
        Args:
            path: Path for the new notebook
            kernel: Kernel name to use
            
        Returns:
            Dictionary with creation result
        """
        try:
            # Resolve path against workspace
            resolved_path = Path(self.resolve_path(path))
            logger.info(f"Creating new notebook: {path} -> {resolved_path}")
            
            # Create empty notebook using FileUtils
            notebook = FileUtils.create_empty_notebook(kernel)
            
            # Write to file
            written_path = FileUtils.write_notebook(notebook, resolved_path)
            
            # Get file stats
            stat = written_path.stat()
            
            result = {
                "path": str(written_path),
                "kernel": kernel,
                "size": stat.st_size,
                "cell_count": 0,
                "success": True
            }
            
            logger.info(f"Successfully created empty notebook with kernel {kernel}")
            return result
            
        except Exception as e:
            logger.error(f"Error creating notebook {path}: {e}")
            raise
    
    async def add_cell(self, path: Union[str, Path], cell_type: str, source: str,
                       metadata: Optional[Dict[str, Any]] = None, index: Optional[int] = None) -> Dict[str, Any]:
        """
        Add a cell to an existing notebook.
        
        Args:
            path: Path to the notebook file
            cell_type: Type of cell to add ('code', 'markdown', 'raw')
            source: Cell content
            metadata: Optional cell metadata
            index: Optional position to insert cell
            
        Returns:
            Dictionary with operation result
        """
        try:
            resolved_path = self.resolve_path(path)
            path = Path(resolved_path)
            logger.info(f"Adding {cell_type} cell to notebook: {path}")
            
            # Read existing notebook
            notebook = FileUtils.read_notebook(path)
            
            # Add cell using FileUtils
            notebook = FileUtils.add_cell(notebook, cell_type, source, metadata, index)
            
            # Write back to file
            FileUtils.write_notebook(notebook, path)
            
            result = {
                "path": str(path),
                "cell_type": cell_type,
                "cell_count": len(notebook.cells),
                "success": True
            }
            
            logger.info(f"Successfully added {cell_type} cell, total cells: {len(notebook.cells)}")
            return result
            
        except Exception as e:
            logger.error(f"Error adding cell to notebook {path}: {e}")
            raise
    
    async def remove_cell(self, path: Union[str, Path], index: int) -> Dict[str, Any]:
        """
        Remove a cell from a notebook.
        
        Args:
            path: Path to the notebook file
            index: Index of cell to remove
            
        Returns:
            Dictionary with operation result
        """
        try:
            resolved_path = self.resolve_path(path)
            path = Path(resolved_path)
            logger.info(f"Removing cell {index} from notebook: {path}")
            
            # Read existing notebook
            notebook = FileUtils.read_notebook(path)
            
            # Check bounds
            if index < 0 or index >= len(notebook.cells):
                raise IndexError(f"Cell index {index} out of range (0-{len(notebook.cells)-1})")
            
            # Remove cell using FileUtils
            notebook = FileUtils.remove_cell(notebook, index)
            
            # Write back to file
            FileUtils.write_notebook(notebook, path)
            
            result = {
                "path": str(path),
                "removed_index": index,
                "cell_count": len(notebook.cells),
                "success": True
            }
            
            logger.info(f"Successfully removed cell {index}, remaining cells: {len(notebook.cells)}")
            return result
            
        except Exception as e:
            logger.error(f"Error removing cell from notebook {path}: {e}")
            raise
    
    async def update_cell(self, path: Union[str, Path], index: int, source: str,
                          metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Update a cell in a notebook.
        
        Args:
            path: Path to the notebook file
            index: Index of cell to update
            source: New cell content
            metadata: Optional new metadata
            
        Returns:
            Dictionary with operation result
        """
        try:
            resolved_path = self.resolve_path(path)
            path = Path(resolved_path)
            logger.info(f"Updating cell {index} in notebook: {path}")
            
            # Read existing notebook
            notebook = FileUtils.read_notebook(path)
            
            # Update cell using FileUtils
            notebook = FileUtils.update_cell(notebook, index, source, metadata)
            
            # Write back to file
            FileUtils.write_notebook(notebook, path)
            
            result = {
                "path": str(path),
                "updated_index": index,
                "cell_count": len(notebook.cells),
                "success": True
            }
            
            logger.info(f"Successfully updated cell {index}")
            return result
            
        except Exception as e:
            logger.error(f"Error updating cell in notebook {path}: {e}")
            raise
    
    async def execute_notebook(self, path: Union[str, Path],
                               output_path: Optional[Union[str, Path]] = None,
                               parameters: Optional[Dict[str, Any]] = None,
                               kernel_name: Optional[str] = None,
                               timeout: Optional[int] = None) -> Dict[str, Any]:
        """
        Execute a notebook using Papermill.
        
        Args:
            path: Path to the notebook to execute
            output_path: Optional path for output notebook
            parameters: Optional parameters to inject
            kernel_name: Optional kernel name override
            
        Returns:
            Dictionary with execution result
        """
        try:
            # Resolve path against workspace
            resolved_path = self.resolve_path(path)
            logger.info(f"Executing notebook: {path} -> {resolved_path}")
            
            # Use PapermillExecutor to run the notebook
            result = await self.papermill_executor.execute_notebook(
                input_path=resolved_path,
                output_path=output_path,
                parameters=parameters or {},
                kernel=kernel_name,
                timeout=timeout
            )
            
            # Convert ExecutionResult object to dictionary
            result_dict = result.to_dict()
            logger.info(f"Successfully executed notebook: {result.output_path}")
            return result_dict
            
        except Exception as e:
            logger.error(f"Error executing notebook {path}: {e}")
            raise
    
    async def list_notebooks(self, directory: Union[str, Path], 
                             recursive: bool = False) -> List[Dict[str, Any]]:
        """
        List notebook files in a directory.
        
        Args:
            directory: Directory to search
            recursive: Whether to search recursively
            
        Returns:
            List of notebook information
        """
        try:
            directory = Path(directory)
            logger.info(f"Listing notebooks in: {directory} (recursive={recursive})")
            
            notebooks = FileUtils.list_notebooks(directory, recursive)
            
            logger.info(f"Found {len(notebooks)} notebooks")
            return notebooks
            
        except Exception as e:
            logger.error(f"Error listing notebooks in {directory}: {e}")
            raise
    
    async def get_notebook_metadata(self, path: Union[str, Path]) -> Dict[str, Any]:
        """
        Get metadata from a notebook file.
        
        DEPRECATED: Use inspect_notebook(path, mode="metadata") instead.
        
        Args:
            path: Path to notebook file
            
        Returns:
            Dictionary with notebook metadata
        """
        logger.warning("get_notebook_metadata is deprecated, use inspect_notebook(mode='metadata') instead")
        result = await self.inspect_notebook(path, mode="metadata")
        
        # Transform to old format for backward compatibility
        old_format = {
            'path': result['path'],
            'metadata': result['metadata'],
            'nbformat': result['nbformat'],
            'nbformat_minor': result['nbformat_minor'],
            'cell_count': result['cell_count'],
            'success': result['success']
        }
        
        return old_format
    
    async def read_cell(self, path: Union[str, Path], index: int) -> Dict[str, Any]:
        """
        Read a specific cell from a notebook.
        
        DEPRECATED: Use read_cells(path, mode="single", index=index) instead.
        
        Args:
            path: Path to notebook file
            index: Index of the cell to read (0-based)
            
        Returns:
            Dictionary with cell information
            
        Raises:
            IndexError: If cell index is out of range
        """
        logger.warning("read_cell is deprecated, use read_cells(mode='single', index=...) instead")
        return await self.read_cells(path, mode="single", index=index)
            
    
    async def read_cells_range(self, path: Union[str, Path], start_index: int, end_index: Optional[int] = None) -> Dict[str, Any]:
        """
        Read a range of cells from a notebook.
        
        DEPRECATED: Use read_cells(path, mode="range", start_index=..., end_index=...) instead.
        
        Args:
            path: Path to notebook file
            start_index: Starting index (0-based, inclusive)
            end_index: Ending index (0-based, inclusive). If None, reads from start_index to end
            
        Returns:
            Dictionary with cells information
        """
        logger.warning("read_cells_range is deprecated, use read_cells(mode='range', start_index=..., end_index=...) instead")
        return await self.read_cells(path, mode="range", start_index=start_index, end_index=end_index)
    
    async def read_cells(
        self,
        path: Union[str, Path],
        mode: str = "list",
        index: Optional[int] = None,
        start_index: Optional[int] = None,
        end_index: Optional[int] = None,
        include_preview: bool = True,
        preview_length: int = 100
    ) -> Dict[str, Any]:
        """
        🆕 OUTIL CONSOLIDÉ - Lecture flexible de cellules d'un notebook.
        
        Remplace: read_cell, read_cells_range, list_notebook_cells
        
        Args:
            path: Chemin du fichier notebook
            mode: Mode de lecture
                - "single": Une seule cellule (requiert index)
                - "range": Plage de cellules (requiert start_index, end_index optionnel)
                - "list": Liste avec preview de toutes les cellules (défaut)
                - "all": Toutes les cellules complètes
            index: Index de la cellule pour mode="single" (0-based)
            start_index: Index de début pour mode="range" (0-based, inclus)
            end_index: Index de fin pour mode="range" (0-based, inclus, None = jusqu'à la fin)
            include_preview: Inclure preview dans mode="list" (défaut: True)
            preview_length: Longueur du preview (défaut: 100 caractères)
            
        Returns:
            Dictionary with cells data based on mode
            
        Raises:
            ValueError: If parameters are inconsistent with mode
            IndexError: If cell index is out of range
        """
        try:
            # Resolve path against workspace
            resolved_path = Path(self.resolve_path(path))
            logger.info(f"Reading cells from notebook (mode={mode}): {path} -> {resolved_path}")
            
            # Validation des paramètres selon le mode
            if mode == "single":
                if index is None:
                    raise ValueError("mode='single' requires 'index' parameter")
            elif mode == "range":
                if start_index is None:
                    raise ValueError("mode='range' requires 'start_index' parameter")
            
            # Read notebook
            notebook = FileUtils.read_notebook(resolved_path)
            total_cells = len(notebook.cells)
            
            # Mode SINGLE: Retourner une seule cellule
            if mode == "single":
                if index < 0 or index >= total_cells:
                    raise IndexError(f"Cell index {index} out of range (0 to {total_cells - 1})")
                
                cell = notebook.cells[index]
                cell_data = {
                    "index": index,
                    "cell_type": cell.cell_type,
                    "source": cell.source,
                    "metadata": dict(cell.metadata)
                }
                
                # Add execution info for code cells
                if cell.cell_type == "code":
                    cell_data["execution_count"] = getattr(cell, 'execution_count', None)
                    if hasattr(cell, 'outputs') and cell.outputs:
                        cell_data["outputs"] = cell.outputs
                
                result = {
                    "path": str(path),
                    "mode": "single",
                    "cell": cell_data,
                    "index": index,
                    "success": True
                }
                
                logger.info(f"Successfully read cell {index}")
                return result
            
            # Mode RANGE: Retourner une plage de cellules
            elif mode == "range":
                # Handle end_index
                if end_index is None:
                    end_index = total_cells - 1
                
                # Validate indices
                if start_index < 0 or start_index >= total_cells:
                    raise IndexError(f"Start index {start_index} out of range (0 to {total_cells - 1})")
                if end_index < 0 or end_index >= total_cells:
                    raise IndexError(f"End index {end_index} out of range (0 to {total_cells - 1})")
                if start_index > end_index:
                    raise ValueError(f"Start index {start_index} must be <= end index {end_index}")
                
                # Extract cells in range
                cells_data = []
                for i in range(start_index, end_index + 1):
                    cell = notebook.cells[i]
                    cell_data = {
                        "index": i,
                        "cell_type": cell.cell_type,
                        "source": cell.source,
                        "metadata": dict(cell.metadata)
                    }
                    
                    # Add execution info for code cells
                    if cell.cell_type == "code":
                        cell_data["execution_count"] = getattr(cell, 'execution_count', None)
                        if hasattr(cell, 'outputs') and cell.outputs:
                            cell_data["outputs"] = cell.outputs
                    
                    cells_data.append(cell_data)
                
                result = {
                    "path": str(path),
                    "mode": "range",
                    "cells": cells_data,
                    "start_index": start_index,
                    "end_index": end_index,
                    "cell_count": len(cells_data),
                    "success": True
                }
                
                logger.info(f"Successfully read {len(cells_data)} cells")
                return result
            
            # Mode LIST: Liste avec preview
            elif mode == "list":
                cells_info = []
                for i, cell in enumerate(notebook.cells):
                    # Get source text
                    source_text = ''.join(cell.source) if isinstance(cell.source, list) else cell.source
                    
                    cell_info = {
                        "index": i,
                        "cell_type": cell.cell_type,
                        "full_length": len(source_text)
                    }
                    
                    # Add preview if requested
                    if include_preview:
                        preview = source_text[:preview_length] + "..." if len(source_text) > preview_length else source_text
                        cell_info["preview"] = preview
                    
                    # Add execution info for code cells
                    if cell.cell_type == "code":
                        cell_info["execution_count"] = getattr(cell, 'execution_count', None)
                        cell_info["has_outputs"] = hasattr(cell, 'outputs') and bool(cell.outputs)
                    
                    cells_info.append(cell_info)
                
                result = {
                    "path": str(path),
                    "mode": "list",
                    "cells": cells_info,
                    "cell_count": len(cells_info),
                    "success": True
                }
                
                logger.info(f"Successfully listed {len(cells_info)} cells")
                return result
            
            # Mode ALL: Toutes les cellules complètes
            elif mode == "all":
                cells_data = []
                for i, cell in enumerate(notebook.cells):
                    cell_data = {
                        "index": i,
                        "cell_type": cell.cell_type,
                        "source": cell.source,
                        "metadata": dict(cell.metadata)
                    }
                    
                    # Add execution info for code cells
                    if cell.cell_type == "code":
                        cell_data["execution_count"] = getattr(cell, 'execution_count', None)
                        if hasattr(cell, 'outputs') and cell.outputs:
                            cell_data["outputs"] = cell.outputs
                    
                    cells_data.append(cell_data)
                
                result = {
                    "path": str(path),
                    "mode": "all",
                    "cells": cells_data,
                    "cell_count": len(cells_data),
                    "success": True
                }
                
                logger.info(f"Successfully read all {len(cells_data)} cells")
                return result
            
            else:
                raise ValueError(f"Invalid mode: {mode}. Must be 'single', 'range', 'list', or 'all'")
                
        except Exception as e:
            logger.error(f"Error reading cells from notebook {path}: {e}")
            raise
    
    async def list_notebook_cells(self, path: Union[str, Path]) -> Dict[str, Any]:
        """
        Liste les cellules d'un notebook avec apercu du contenu.
        
        DEPRECATED: Use read_cells(path, mode="list") instead.
        
        Args:
            path: Path to notebook file
            
        Returns:
            Dictionary with cells information and preview
        """
        logger.warning("list_notebook_cells is deprecated, use read_cells(mode='list') instead")
        return await self.read_cells(path, mode="list")
    
    async def inspect_notebook_outputs(self, path: Union[str, Path]) -> Dict[str, Any]:
        """
        Inspecte les sorties des cellules d'un notebook.
        
        DEPRECATED: Use inspect_notebook(path, mode="outputs") instead.
        
        Args:
            path: Path to notebook file
            
        Returns:
            Dictionary with detailed outputs information
        """
        logger.warning("inspect_notebook_outputs is deprecated, use inspect_notebook(mode='outputs') instead")
        result = await self.inspect_notebook(path, mode="outputs")
        
        # Transform to old format for backward compatibility
        old_format = {
            "path": result["path"],
            "cells_with_outputs": result["output_analysis"]["cells_with_outputs"],
            "outputs": [
                {
                    "cell_index": cell["index"],
                    "execution_count": cell["execution_count"],
                    "output_count": cell["output_count"],
                    "output_types": cell["output_types"]
                }
                for cell in result["output_analysis"]["cells"]
            ],
            "success": result["success"]
        }
        
        return old_format
    
    async def validate_notebook(self, path: Union[str, Path]) -> Dict[str, Any]:
        """
        DEPRECATED: Use inspect_notebook(path, mode="validate") instead.
        
        Valide la structure d'un notebook Jupyter.
        
        Args:
            path: Path to notebook file
            
        Returns:
            Dictionary with validation results (old format for backward compatibility)
        """
        logger.warning(
            "validate_notebook is deprecated, use inspect_notebook(mode='validate') instead"
        )
        
        # Call new consolidated method
        result = await self.inspect_notebook(path, mode="validate")
        
        # Transform to old format for backward compatibility
        validation = result.get("validation", {})
        
        # Convert new errors format to old issues format
        notebook_issues = [
            error["message"] for error in validation.get("errors", [])
            if error.get("cell_index") is None
        ]
        
        cell_issues = []
        for error in validation.get("errors", []):
            if error.get("cell_index") is not None:
                cell_idx = error["cell_index"]
                # Check if we already have an entry for this cell
                existing = next((c for c in cell_issues if c["cell_index"] == cell_idx), None)
                if existing:
                    existing["issues"].append(error["message"])
                else:
                    cell_issues.append({
                        "cell_index": cell_idx,
                        "issues": [error["message"]]
                    })
        
        old_format = {
            "path": result["path"],
            "is_valid": validation.get("is_valid", False),
            "notebook_issues": notebook_issues,
            "cell_issues": cell_issues,
            "success": result["success"]
        }
        
        return old_format
    async def inspect_notebook(
        self, 
        path: Union[str, Path], 
        mode: str = "metadata"
    ) -> Dict[str, Any]:
        """
        🆕 OUTIL CONSOLIDÉ - Inspection et validation de notebooks.
        
        Remplace: get_notebook_metadata, inspect_notebook_outputs, validate_notebook
        
        Args:
            path: Path to notebook file
            mode: Type d'inspection
                - "metadata": Métadonnées du notebook (kernel, language, auteur)
                - "outputs": Analyse des sorties de toutes les cellules code
                - "validate": Validation nbformat + rapport de problèmes
                - "full": Combinaison de metadata + outputs + validate
        
        Returns:
            Dictionary with inspection results based on mode
        """
        import time
        
        try:
            # Validate mode
            valid_modes = ["metadata", "outputs", "validate", "full"]
            if mode not in valid_modes:
                raise ValueError(f"Invalid mode: {mode}. Must be one of {valid_modes}")
            
            # Resolve path
            resolved_path = Path(self.resolve_path(path))
            logger.info(f"Inspecting notebook: {path} -> {resolved_path} (mode={mode})")
            
            if not resolved_path.exists():
                raise FileNotFoundError(f"Notebook not found: {resolved_path}")
            
            # Read notebook once
            notebook = FileUtils.read_notebook(resolved_path)
            
            # Initialize result
            result = {
                "path": str(path),
                "mode": mode,
                "success": True
            }
            
            # Mode METADATA
            if mode in ["metadata", "full"]:
                metadata_info = {
                    "kernelspec": dict(notebook.metadata.get('kernelspec', {})),
                    "language_info": dict(notebook.metadata.get('language_info', {})),
                }
                
                # Add optional metadata fields
                if 'authors' in notebook.metadata:
                    metadata_info['authors'] = notebook.metadata.get('authors')
                if 'title' in notebook.metadata:
                    metadata_info['title'] = notebook.metadata.get('title')
                
                # Add custom metadata (excluding standard fields)
                standard_fields = {'kernelspec', 'language_info', 'authors', 'title'}
                custom_metadata = {
                    k: v for k, v in notebook.metadata.items() 
                    if k not in standard_fields
                }
                if custom_metadata:
                    metadata_info['custom_metadata'] = custom_metadata
                
                result["metadata"] = metadata_info
                result["nbformat"] = notebook.nbformat
                result["nbformat_minor"] = notebook.nbformat_minor
                result["cell_count"] = len(notebook.cells)
            
            # Mode OUTPUTS
            if mode in ["outputs", "full"]:
                total_cells = len(notebook.cells)
                code_cells = sum(1 for cell in notebook.cells if cell.cell_type == "code")
                cells_with_outputs = 0
                cells_with_errors = 0
                output_types_count = {}
                cells_analysis = []
                
                for i, cell in enumerate(notebook.cells):
                    if cell.cell_type == "code":
                        outputs = getattr(cell, 'outputs', [])
                        
                        if outputs:
                            cells_with_outputs += 1
                            
                            # Analyze cell outputs
                            cell_output_types = []
                            has_error = False
                            error_name = None
                            output_size = 0
                            
                            for output in outputs:
                                output_type = output.get("output_type", "unknown")
                                cell_output_types.append(output_type)
                                
                                # Count by type
                                output_types_count[output_type] = output_types_count.get(output_type, 0) + 1
                                
                                # Check for errors
                                if output_type == "error":
                                    has_error = True
                                    error_name = output.get("ename", "Unknown")
                                    cells_with_errors += 1
                                
                                # Calculate size
                                output_size += len(str(output))
                            
                            cell_info = {
                                "index": i,
                                "execution_count": getattr(cell, 'execution_count', None),
                                "output_count": len(outputs),
                                "output_types": cell_output_types,
                                "has_error": has_error,
                                "output_size_bytes": output_size
                            }
                            
                            if has_error:
                                cell_info["error_name"] = error_name
                            
                            cells_analysis.append(cell_info)
                
                result["output_analysis"] = {
                    "total_cells": total_cells,
                    "code_cells": code_cells,
                    "cells_with_outputs": cells_with_outputs,
                    "cells_with_errors": cells_with_errors,
                    "output_types": output_types_count,
                    "cells": cells_analysis
                }
            
            # Mode VALIDATE
            if mode in ["validate", "full"]:
                start_time = time.time()
                
                # Read raw JSON for validation
                with open(resolved_path, 'r', encoding='utf-8') as f:
                    notebook_data = json.load(f)
                
                errors = []
                warnings = []
                
                # Validate nbformat version
                if "nbformat" not in notebook_data:
                    errors.append({
                        "type": "missing_field",
                        "message": "Missing 'nbformat' field",
                        "cell_index": None
                    })
                elif notebook_data.get("nbformat") < 4:
                    warnings.append({
                        "type": "old_version",
                        "message": f"Old nbformat version: {notebook_data.get('nbformat')} (recommended: 4+)",
                        "cell_index": None
                    })
                
                # Validate cells field
                if "cells" not in notebook_data:
                    errors.append({
                        "type": "missing_field",
                        "message": "Missing 'cells' field",
                        "cell_index": None
                    })
                elif not isinstance(notebook_data["cells"], list):
                    errors.append({
                        "type": "invalid_type",
                        "message": "'cells' field is not a list",
                        "cell_index": None
                    })
                
                # Validate each cell
                for i, cell in enumerate(notebook_data.get("cells", [])):
                    if "cell_type" not in cell:
                        errors.append({
                            "type": "missing_field",
                            "message": "Missing cell_type",
                            "cell_index": i
                        })
                    elif cell["cell_type"] not in ["code", "markdown", "raw"]:
                        errors.append({
                            "type": "invalid_value",
                            "message": f"Invalid cell_type: {cell['cell_type']}",
                            "cell_index": i
                        })
                    
                    if "source" not in cell:
                        errors.append({
                            "type": "missing_field",
                            "message": "Missing source",
                            "cell_index": i
                        })
                
                validation_time = time.time() - start_time
                
                result["validation"] = {
                    "is_valid": len(errors) == 0,
                    "nbformat_version": f"{notebook_data.get('nbformat', 'unknown')}.{notebook_data.get('nbformat_minor', 'unknown')}",
                    "errors": errors,
                    "warnings": warnings,
                    "validation_time": round(validation_time, 4)
                }
            
            logger.info(f"Successfully inspected notebook in mode '{mode}'")
            return result
            
        except Exception as e:
            logger.error(f"Error inspecting notebook {path}: {e}")
            raise
    
    
    async def system_info(self) -> Dict[str, Any]:
        """
        Informations systeme rapides et fiables.
        
        Returns:
            Dictionary with system information
        """
        try:
            import datetime
            import os
            import platform
            import sys
            
            logger.info("Getting system information")
            
            # Basic system info
            info = {
                "timestamp": datetime.datetime.now().isoformat(),
                "python": {
                    "version": platform.python_version(),
                    "executable": sys.executable
                },
                "system": {
                    "os": os.name,
                    "platform": platform.system(),
                    "cwd": os.getcwd()
                },
                "environment": {
                    "conda_env": os.environ.get("CONDA_DEFAULT_ENV", "NOT_SET"),
                    "conda_prefix": os.environ.get("CONDA_PREFIX", "NOT_SET"),
                    "userprofile": os.environ.get("USERPROFILE", "NOT_SET"),
                    "total_env_vars": len(os.environ)
                },
                "success": True
            }
            
            # Jupyter kernels info (safe attempt)
            try:
                from jupyter_client.kernelspec import KernelSpecManager
                ksm = KernelSpecManager()
                specs = ksm.get_all_specs()
                info["jupyter"] = {
                    "kernels_available": list(specs.keys()),
                    "kernel_count": len(specs)
                }
            except Exception as e:
                info["jupyter"] = {"error": str(e)}
            
            logger.info("Successfully retrieved system information")
            return info
            
        except Exception as e:
            logger.error(f"Error getting system information: {e}")
            raise
    
    async def execute_notebook_solution_a(
        self,
        input_path: Union[str, Path],
        output_path: Optional[Union[str, Path]] = None,
        timeout: Optional[int] = None,
        sync_timeout_seconds: int = 25
    ) -> Dict[str, Any]:
        """
        SOLUTION A - Architecture subprocess hybride : sync court + job asynchrone.
        Résout le timeout MCP de 60s en utilisant ExecutionManager job-based.
        
        Args:
            input_path: Path to input notebook
            output_path: Optional path to output notebook
            timeout: Optional timeout total pour le job (auto-calculé si None)
            sync_timeout_seconds: Temps d'attente sync avant passage en mode async (défaut 25s)
            
        Returns:
            Dictionary with execution result or in_progress status with job_id
        """
        try:
            import datetime
            start_time = datetime.datetime.now()
            
            # Résoudre le path d'entrée
            resolved_input_path = Path(self.resolve_path(input_path))
            logger.info(f"Executing notebook (Solution A - Hybrid): {input_path} -> {resolved_input_path}")
            
            # Utiliser l'ExecutionManager pour démarrer le job
            exec_manager = get_execution_manager()
            
            job_result = exec_manager.start_notebook_async(
                input_path=str(resolved_input_path),
                output_path=str(output_path) if output_path else None,
                timeout_seconds=timeout,
                wait_seconds=2  # Attendre 2s pour confirmation démarrage
            )
            
            if not job_result["success"]:
                return {
                    "success": False,
                    "method": "execute_notebook_solution_a",
                    "input_path": str(resolved_input_path),
                    "error": job_result.get("error", "Failed to start async job"),
                    "timestamp": start_time.isoformat()
                }
            
            job_id = job_result["job_id"]
            logger.info(f"Started async job {job_id}, waiting up to {sync_timeout_seconds}s for completion")
            
            # Polling avec timeout sync
            poll_start = datetime.datetime.now()
            poll_interval = 1.0  # 1 seconde entre polls
            
            while True:
                # Vérifier le statut du job
                status_result = exec_manager.get_execution_status(job_id)
                if not status_result["success"]:
                    return {
                        "success": False,
                        "method": "execute_notebook_solution_a",
                        "job_id": job_id,
                        "error": "Failed to get job status",
                        "timestamp": datetime.datetime.now().isoformat()
                    }
                
                job_status = status_result["status"]
                elapsed_time = (datetime.datetime.now() - poll_start).total_seconds()
                
                # Si terminé avec succès dans les temps : retour sync
                if job_status == "SUCCEEDED":
                    logger.info(f"Job {job_id} completed successfully in {elapsed_time:.2f}s (sync mode)")
                    return {
                        "success": True,
                        "method": "execute_notebook_solution_a",
                        "execution_mode": "sync_completed",
                        "input_path": str(resolved_input_path),
                        "output_path": status_result["output_path"],
                        "execution_time_seconds": status_result["duration_seconds"],
                        "job_id": job_id,
                        "timestamp": datetime.datetime.now().isoformat()
                    }
                
                # Si échec : retour sync avec erreur
                elif job_status in ["FAILED", "CANCELED", "TIMEOUT"]:
                    logger.error(f"Job {job_id} failed with status {job_status}")
                    return {
                        "success": False,
                        "method": "execute_notebook_solution_a",
                        "execution_mode": "sync_failed",
                        "input_path": str(resolved_input_path),
                        "job_id": job_id,
                        "job_status": job_status,
                        "error": status_result.get("error_summary", f"Job {job_status}"),
                        "execution_time_seconds": status_result["duration_seconds"],
                        "timestamp": datetime.datetime.now().isoformat()
                    }
                
                # Si timeout sync atteint : passage en mode async
                elif elapsed_time >= sync_timeout_seconds:
                    logger.info(f"Job {job_id} still running after {sync_timeout_seconds}s, switching to async mode")
                    return {
                        "success": True,
                        "method": "execute_notebook_solution_a",
                        "execution_mode": "in_progress",
                        "input_path": str(resolved_input_path),
                        "job_id": job_id,
                        "job_status": job_status,
                        "elapsed_time_seconds": elapsed_time,
                        "sync_timeout_seconds": sync_timeout_seconds,
                        "message": f"Notebook execution in progress. Use get_execution_status('{job_id}') to poll status.",
                        "polling_instructions": {
                            "get_status": f"get_execution_status('{job_id}')",
                            "get_logs": f"get_job_logs('{job_id}')",
                            "cancel": f"cancel_job('{job_id}')"
                        },
                        "timestamp": datetime.datetime.now().isoformat()
                    }
                
                # Continuer le polling
                await asyncio.sleep(poll_interval)
                
        except Exception as e:
            logger.error(f"Error in execute_notebook_solution_a {input_path}: {e}")
            return {
                "success": False,
                "method": "execute_notebook_solution_a",
                "input_path": str(input_path),
                "error": str(e),
                "error_type": type(e).__name__,
                "timestamp": datetime.datetime.now().isoformat()
            }
    
    # Méthodes wrapper pour ExecutionManager (exposition MCP)
    
    async def start_notebook_async(
        self,
        input_path: Union[str, Path],
        output_path: Optional[Union[str, Path]] = None,
        parameters: Optional[Dict[str, Any]] = None,
        working_dir_override: Optional[str] = None,
        env_overrides: Optional[Dict[str, str]] = None,
        timeout_seconds: Optional[int] = None,
        wait_seconds: float = 0
    ) -> Dict[str, Any]:
        """
        Démarre l'exécution asynchrone d'un notebook.
        
        Args:
            input_path: Chemin du notebook d'entrée
            output_path: Chemin du notebook de sortie (optionnel)
            parameters: Paramètres à injecter (optionnel)
            working_dir_override: Répertoire de travail personnalisé
            env_overrides: Variables d'environnement supplémentaires
            timeout_seconds: Timeout personnalisé (auto-calculé si None)
            wait_seconds: Attendre la confirmation de démarrage (0 = immédiat)
            
        Returns:
            Dictionary avec job_id, status, started_at, etc.
        """
        try:
            # Résoudre les paths avec workspace
            resolved_input_path = self.resolve_path(input_path)
            resolved_output_path = self.resolve_path(output_path) if output_path else None
            
            logger.info(f"Starting async notebook execution: {input_path} -> {resolved_input_path}")
            
            exec_manager = get_execution_manager()
            result = exec_manager.start_notebook_async(
                input_path=resolved_input_path,
                output_path=resolved_output_path,
                parameters=parameters,
                working_dir_override=working_dir_override,
                env_overrides=env_overrides,
                timeout_seconds=timeout_seconds,
                wait_seconds=wait_seconds
            )
            
            logger.info(f"Async job started: {result.get('job_id', 'unknown')}")
            return result
            
        except Exception as e:
            logger.error(f"Error starting async notebook execution {input_path}: {e}")
            return {
                "success": False,
                "error": str(e),
                "error_type": type(e).__name__,
                "input_path": str(input_path),
                "timestamp": datetime.now().isoformat()
            }
    
    async def get_execution_status_async(self, job_id: str) -> Dict[str, Any]:
        """
        Récupère le statut d'exécution d'un job asynchrone.
        
        Args:
            job_id: ID du job
            
        Returns:
            Dictionary avec statut complet du job
        """
        try:
            logger.info(f"Getting execution status for job: {job_id}")
            
            exec_manager = get_execution_manager()
            result = exec_manager.get_execution_status(job_id)
            
            logger.info(f"Status retrieved for job {job_id}: {result.get('status', 'unknown')}")
            return result
            
        except Exception as e:
            logger.error(f"Error getting execution status for job {job_id}: {e}")
            return {
                "success": False,
                "error": str(e),
                "error_type": type(e).__name__,
                "job_id": job_id,
                "timestamp": datetime.now().isoformat()
            }
    
    async def get_job_logs_async(self, job_id: str, since_line: int = 0) -> Dict[str, Any]:
        """
        Récupère les logs d'un job avec pagination.
        
        Args:
            job_id: ID du job
            since_line: Ligne de départ pour la pagination
            
        Returns:
            Dictionary avec chunks de logs
        """
        try:
            logger.info(f"Getting logs for job {job_id} from line {since_line}")
            
            exec_manager = get_execution_manager()
            result = exec_manager.get_job_logs(job_id, since_line)
            
            logger.info(f"Logs retrieved for job {job_id}: {len(result.get('stdout_chunk', []))} stdout, {len(result.get('stderr_chunk', []))} stderr lines")
            return result
            
        except Exception as e:
            logger.error(f"Error getting logs for job {job_id}: {e}")
            return {
                "success": False,
                "error": str(e),
                "error_type": type(e).__name__,
                "job_id": job_id,
                "timestamp": datetime.now().isoformat()
            }
    
    async def cancel_job_async(self, job_id: str) -> Dict[str, Any]:
        """
        Annule un job en cours d'exécution.
        
        Args:
            job_id: ID du job à annuler
            
        Returns:
            Dictionary avec résultat de l'annulation
        """
        try:
            logger.info(f"Canceling job: {job_id}")
            
            exec_manager = get_execution_manager()
            result = exec_manager.cancel_job(job_id)
            
            logger.info(f"Job {job_id} cancellation result: {result.get('canceled', False)}")
            return result
            
        except Exception as e:
            logger.error(f"Error canceling job {job_id}: {e}")
            return {
                "success": False,
                "error": str(e),
                "error_type": type(e).__name__,
                "job_id": job_id,
                "timestamp": datetime.now().isoformat()
            }
    
    async def list_jobs_async(self) -> Dict[str, Any]:
        """
        Liste tous les jobs avec statuts raccourcis.
        
        Returns:
            Dictionary avec liste des jobs
        """
        try:
            logger.info("Listing all execution jobs")
            
            exec_manager = get_execution_manager()
            result = exec_manager.list_jobs()
            
            logger.info(f"Listed {result.get('total_jobs', 0)} jobs ({result.get('running_jobs', 0)} running)")
            return result
            
        except Exception as e:
            logger.error(f"Error listing jobs: {e}")
            return {
                "success": False,
                "error": str(e),
                "error_type": type(e).__name__,
                "timestamp": datetime.now().isoformat()
            }
    
    async def parameterize_notebook(
        self,
        input_path: Union[str, Path],
        parameters: Dict[str, Any],
        output_path: Optional[Union[str, Path]] = None
    ) -> Dict[str, Any]:
        """
        Execute un notebook avec des parametres via Papermill API directe.
        
        Args:
            input_path: Path to input notebook
            parameters: Parameters to inject (Dict or JSON string from Roo)
            output_path: Optional path to output notebook
            
        Returns:
            Dictionary with execution result
        """
        try:
            import datetime
            import os
            import json
            
            # CORRECTION BUG PYDANTIC : Gerer serialisation JSON via Roo
            if isinstance(parameters, str):
                # Roo peut envoyer les parametres comme string JSON
                try:
                    parameters = json.loads(parameters) if parameters else {}
                except json.JSONDecodeError:
                    # Si ce n'est pas du JSON valide, retourner erreur explicite
                    return {
                        "status": "error",
                        "error": f"Parametres invalides - JSON attendu: {parameters}",
                        "error_type": "InvalidParametersFormat",
                        "method": "parameterize_notebook_fastmcp"
                    }
            
            input_path = Path(input_path)
            if output_path is None:
                output_path = input_path.parent / f"{input_path.stem}_parameterized.ipynb"
            else:
                output_path = Path(output_path)
            
            logger.info(f"Executing parameterized notebook: {input_path}")
            
            # Diagnostic info
            diagnostic_info = {
                "method": "papermill_direct_api_with_parameters",
                "cwd": os.getcwd(),
                "python_env": sys.executable,
                "parameters_count": len(parameters)
            }
            
            # CORRECTION BUG CRITIQUE : Éviter os.chdir() - Les executors gèrent leur working directory
            notebook_dir = input_path.parent.absolute()
            
            start_time = datetime.datetime.now()
            
            # Execute with PapermillExecutor (il gère son propre working directory)
            result = await self.papermill_executor.execute_notebook(
                input_path=input_path,
                output_path=output_path,
                parameters=parameters,
                kernel=None
            )
            
            end_time = datetime.datetime.now()
            execution_time = (end_time - start_time).total_seconds()
            
            # Enhance result
            result.update({
                "parameters": parameters,
                "method": "parameterize_notebook_fixed",
                "execution_time_seconds": execution_time,
                "diagnostic": diagnostic_info,
                "timestamp": end_time.isoformat(),
                "notebook_dir": str(notebook_dir)
            })
            
            logger.info(f"Successfully executed parameterized notebook: {result.get('output_path')}")
            return result
            
        except Exception as e:
            logger.error(f"Error executing parameterized notebook {input_path}: {e}")
            raise
    
    async def execute_notebook_subprocess(
        self,
        input_path: Union[str, Path],
        output_path: Optional[Union[str, Path]] = None,
        timeout: Optional[int] = None,
        capture_output: bool = True
    ) -> Dict[str, Any]:
        """
        Nouvelle méthode d'exécution avec architecture subprocess optimisée.
        Implémente la solution définitive avec conda run et gestion d'erreurs robuste.
        
        Args:
            input_path: Path to input notebook
            output_path: Optional path to output notebook
            timeout: Optional timeout in seconds (auto-adapts based on notebook type)
            capture_output: Whether to capture stdout/stderr
            
        Returns:
            Dictionary with execution result and comprehensive diagnostics
        """
        try:
            import datetime
            import os
            import subprocess
            import sys
            import shutil
            
            start_time = datetime.datetime.now()
            
            # Resolve input path against workspace
            resolved_input_path = Path(self.resolve_path(input_path))
            
            if not resolved_input_path.exists():
                raise FileNotFoundError(f"Input notebook not found: {resolved_input_path}")
            
            if output_path is None:
                # CORRECTION BUG INSTABILITÉ : éviter conflits de fichiers avec timestamps
                timestamp = start_time.strftime("%Y%m%d_%H%M%S")
                output_path = resolved_input_path.parent / f"{resolved_input_path.stem}_executed_{timestamp}.ipynb"
            else:
                output_path = Path(self.resolve_path(output_path))
            
            logger.info(f"Executing notebook (subprocess method): {input_path} -> {resolved_input_path}")
            
            # Auto-detect timeout based on notebook type and complexity
            if timeout is None:
                timeout = self._calculate_optimal_timeout(resolved_input_path)
            
            logger.info(f"Configured timeout: {timeout}s")
            
            # Vérifier que conda est disponible
            if not shutil.which("conda"):
                raise EnvironmentError("conda command not found in PATH")
            
            # CORRECTION BUG CRITIQUE : Utiliser seulement cwd parameter (redondance os.chdir dangereuse supprimée)
            notebook_dir = resolved_input_path.parent.absolute()
            
            # Construire la commande conda run avec papermill
            cmd = [
                "conda", "run", "-n", "mcp-jupyter-py310",
                "python", "-m", "papermill",
                str(resolved_input_path.name),  # Utiliser nom relatif dans le répertoire
                str(output_path.name if output_path.parent == notebook_dir else output_path),
                "--progress-bar",
                "--log-output",
                "--no-request-save-on-cell-execute"
            ]
            
            logger.info(f"Executing command: {' '.join(cmd)}")
            logger.info(f"Working directory: {notebook_dir}")
            
            # Construire l'environnement complet
            env = self._build_complete_environment()
            
            # Diagnostic pré-exécution
            diagnostic_info = {
                "method": "execute_notebook_subprocess_fixed",
                "command": " ".join(cmd),
                "cwd": str(notebook_dir),
                "timeout_configured": timeout,
                "env_vars_count": len(env),
                "conda_env": env.get("CONDA_DEFAULT_ENV", "unknown"),
                "python_path": env.get("PYTHONPATH", "not_set"),
                "fix_applied": "removed_dangerous_os_chdir"
            }
            
            # Execute subprocess with comprehensive environment (cwd parameter SEULEMENT)
            exec_start = datetime.datetime.now()
            
            result = subprocess.run(
                cmd,
                capture_output=capture_output,
                text=True,
                check=False,
                timeout=timeout,
                env=env,
                cwd=notebook_dir  # Working directory sécurisé - PAS de os.chdir()
            )
            
            exec_end = datetime.datetime.now()
            execution_time = (exec_end - exec_start).total_seconds()
            
            # Check if execution was successful
            success = result.returncode == 0 and output_path.exists()
            
            # Comprehensive result dictionary
            result_dict = {
                "success": success,
                "method": "execute_notebook_subprocess_fixed",
                "input_path": str(resolved_input_path),
                "output_path": str(output_path),
                "execution_time_seconds": execution_time,
                "timeout_used": timeout,
                "returncode": result.returncode,
                "timestamp": exec_end.isoformat(),
                "diagnostic": diagnostic_info
            }
            
            # Add output analysis
            if output_path.exists():
                stat = output_path.stat()
                result_dict["output_file_size"] = stat.st_size
                result_dict["output_created"] = True
                
                # Quick analysis of output notebook
                try:
                    with open(output_path, 'r', encoding='utf-8') as f:
                        output_content = f.read()
                    result_dict["output_analysis"] = {
                        "content_length": len(output_content),
                        "contains_errors": '"output_type": "error"' in output_content,
                        "execution_count_found": '"execution_count":' in output_content
                    }
                except Exception as analysis_error:
                    result_dict["output_analysis"] = {"error": str(analysis_error)}
            else:
                result_dict["output_created"] = False
                if success:
                    success = False
                    result_dict["success"] = False
                    result_dict["error"] = "Output notebook file not created despite successful returncode"
            
            # Add captured output if requested
            if capture_output:
                if result.stdout:
                    result_dict["stdout"] = result.stdout
                    result_dict["stdout_length"] = len(result.stdout)
                if result.stderr:
                    result_dict["stderr"] = result.stderr
                    result_dict["stderr_length"] = len(result.stderr)
            
            # Log results
            if success:
                logger.info(f"✅ Notebook executed successfully in {execution_time:.2f}s")
                logger.info(f"📁 Output: {output_path} ({result_dict.get('output_file_size', 0)} bytes)")
            else:
                logger.error(f"❌ Notebook execution failed (returncode: {result.returncode})")
                if result.stderr:
                    logger.error(f"Error output: {result.stderr[:500]}...")
            
            return result_dict
            
        except subprocess.TimeoutExpired as e:
            exec_time = (datetime.datetime.now() - start_time).total_seconds()
            logger.error(f"🕐 Notebook execution timed out after {timeout}s (actual: {exec_time:.2f}s)")
            return {
                "success": False,
                "method": "execute_notebook_subprocess",
                "input_path": str(input_path),
                "output_path": str(output_path) if output_path else None,
                "error": f"Execution timed out after {timeout}s",
                "error_type": "TimeoutExpired",
                "timeout_used": timeout,
                "actual_execution_time": exec_time,
                "timestamp": datetime.datetime.now().isoformat()
            }
        except Exception as e:
            exec_time = (datetime.datetime.now() - start_time).total_seconds()
            logger.error(f"💥 Error executing notebook (subprocess method) {input_path}: {e}")
            return {
                "success": False,
                "method": "execute_notebook_subprocess",
                "input_path": str(input_path),
                "output_path": str(output_path) if output_path else None,
                "error": str(e),
                "error_type": type(e).__name__,
                "actual_execution_time": exec_time,
                "timestamp": datetime.datetime.now().isoformat()
            }
    
    def _calculate_optimal_timeout(self, notebook_path: Path) -> int:
        """
        Calcule le timeout optimal basé sur le type et la complexité du notebook.
        
        Args:
            notebook_path: Path to the notebook
            
        Returns:
            Optimal timeout in seconds
        """
        try:
            notebook_name = notebook_path.name.lower()
            
            # Analyse du contenu pour déterminer la complexité
            with open(notebook_path, 'r', encoding='utf-8') as f:
                content = f.read().lower()
            
            # Timeout de base
            base_timeout = 60  # 1 minute
            
            # Extensions basées sur les patterns détectés
            if 'semantickernel' in notebook_name or 'semantic_kernel' in content:
                # SemanticKernel notebooks (installation packages, API calls)
                if any(pattern in notebook_name for pattern in ['04', 'clr', 'building']):
                    return max(base_timeout, 300)  # 5 minutes pour CLR/building notebooks
                elif any(pattern in notebook_name for pattern in ['05', 'notebookmaker', 'widget']):
                    return max(base_timeout, 240)  # 4 minutes pour widget notebooks
                else:
                    return max(base_timeout, 180)  # 3 minutes pour autres SemanticKernel
            
            # .NET notebooks avec NuGet packages
            if any(pattern in content for pattern in ['.net', 'nuget', 'microsoft.ml', 'dotnet']):
                return max(base_timeout, 150)  # 2.5 minutes pour .NET
            
            # Python notebooks avec ML/AI libraries
            if any(pattern in content for pattern in ['tensorflow', 'pytorch', 'sklearn', 'pandas', 'numpy']):
                return max(base_timeout, 120)  # 2 minutes pour ML
            
            # Notebooks simples
            return base_timeout
            
        except Exception as e:
            logger.warning(f"Failed to calculate optimal timeout for {notebook_path}: {e}")
            return 60  # Default fallback
    
    def _build_complete_environment(self) -> Dict[str, str]:
        """
        Construit un environnement complet avec toutes les variables critiques.
        
        Returns:
            Complete environment dictionary
        """
        env = os.environ.copy()
        
        # Variables critiques pour conda
        conda_vars = {
            "CONDA_DEFAULT_ENV": "mcp-jupyter-py310",
            "CONDA_PREFIX": "C:/Users/jsboi/.conda/envs/mcp-jupyter-py310",
            "CONDA_PROMPT_MODIFIER": "(mcp-jupyter-py310) ",
            "CONDA_PYTHON_EXE": "C:/Users/jsboi/.conda/envs/mcp-jupyter-py310/python.exe",
            "CONDA_SHLVL": "1",
            "CONDA_EXE": "C:/Users/jsboi/.conda/Scripts/conda.exe"
        }
        
        # Variables critiques pour .NET
        dotnet_vars = {
            "DOTNET_ROOT": "C:\\Program Files\\dotnet",
            "DOTNET_HOST_PATH": "C:\\Program Files\\dotnet\\dotnet.exe",
            "NUGET_PACKAGES": "C:\\Users\\jsboi\\.nuget\\packages",
            "MSBuildExtensionsPath": "C:\\Program Files\\dotnet\\sdk\\9.0.305",
            "MSBuildSDKsPath": "C:\\Program Files\\dotnet\\sdk\\9.0.305\\Sdks",
            "MSBuildToolsPath": "C:\\Program Files\\dotnet\\sdk\\9.0.305",
            "MSBuildUserExtensionsPath": "C:\\Users\\jsboi\\AppData\\Local\\Microsoft\\MSBuild",
            "DOTNET_CLI_TELEMETRY_OPTOUT": "1",
            "DOTNET_NOLOGO": "1",
            "DOTNET_SKIP_FIRST_TIME_EXPERIENCE": "1"
        }
        
        # Variables pour Jupyter et Python
        python_vars = {
            "PYTHONPATH": "D:/dev/roo-extensions/mcps/internal/servers/jupyter-papermill-mcp-server",
            "JUPYTER_DATA_DIR": "C:/Users/jsboi/.conda/envs/mcp-jupyter-py310/share/jupyter",
            "JUPYTER_CONFIG_DIR": "C:/Users/jsboi/.conda/envs/mcp-jupyter-py310/etc/jupyter",
            "PYTHONUNBUFFERED": "1",
            "PYTHONDONTWRITEBYTECODE": "1"
        }
        
        # Variables spécifiques Roo
        roo_vars = {
            "ROO_WORKSPACE_DIR": self.workspace_dir
        }
        
        # Construire le PATH complet
        path_components = [
            "C:/Users/jsboi/.conda/envs/mcp-jupyter-py310/Scripts",
            "C:/Users/jsboi/.conda/envs/mcp-jupyter-py310/Library/mingw-w64/bin",
            "C:/Users/jsboi/.conda/envs/mcp-jupyter-py310/Library/usr/bin",
            "C:/Users/jsboi/.conda/envs/mcp-jupyter-py310/Library/bin",
            "C:/Users/jsboi/.conda/envs/mcp-jupyter-py310",
            "C:\\Program Files\\dotnet",
            env.get("PATH", "")
        ]
        
        # Mettre à jour l'environnement
        env.update(conda_vars)
        env.update(dotnet_vars)
        env.update(python_vars)
        env.update(roo_vars)
        env["PATH"] = ";".join(path_components)
        
        return env