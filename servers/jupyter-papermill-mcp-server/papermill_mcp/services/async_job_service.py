"""
Async Job Service for managing asynchronous notebook execution.

Extracts ExecutionManager from NotebookService to provide better separation
of concerns and independent testing capabilities.
"""

import logging
import os
import threading
import uuid
import subprocess
import time
from pathlib import Path
from typing import Dict, List, Optional, Any
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from enum import Enum

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
        
        # Ensure timezone awareness for calculation
        start = self.started_at
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
            
        end = self.ended_at
        if end is None:
            end = datetime.now(timezone.utc)
        elif end.tzinfo is None:
            end = end.replace(tzinfo=timezone.utc)
            
        return (end - start).total_seconds()


class AsyncJobService:
    """
    Service dédié à la gestion des jobs d'exécution asynchrones.
    
    Anciennement ExecutionManager, renommé pour cohérence avec l'architecture.
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
        logger.info(f"AsyncJobService initialized with max {max_concurrent_jobs} concurrent jobs")
    
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
                # Use UTC aware datetime
                job.started_at = datetime.now(timezone.utc)
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
                    # Use UTC aware datetime
                    job.ended_at = datetime.now(timezone.utc)
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
                # Use UTC aware datetime
                job.ended_at = datetime.now(timezone.utc)
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
                            # Use UTC aware datetime
                            now = datetime.now(timezone.utc)
                            job.stdout_buffer.append(f"[{now.isoformat()}] {line.rstrip()}")
                            job.updated_at = now
            except Exception as e:
                logger.warning(f"Error capturing stdout for job {job.job_id}: {e}")
        
        def capture_stderr():
            try:
                for line in iter(job.process.stderr.readline, ''):
                    if line:
                        with self.lock:
                            # Use UTC aware datetime
                            now = datetime.now(timezone.utc)
                            job.stderr_buffer.append(f"[{now.isoformat()}] {line.rstrip()}")
                            job.updated_at = now
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
                # Use UTC aware datetime
                job.ended_at = datetime.now(timezone.utc)
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
            try:
                with open(notebook_path, 'r', encoding='utf-8') as f:
                    content = f.read().lower()
            except Exception:
                # Si lecture échoue, assumer basique
                content = ""
            
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
        cutoff_time = datetime.now(timezone.utc) - timedelta(hours=max_age_hours)
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
    
    # ========================================================================
    # PHASE 4: CONSOLIDATED ASYNC JOB MANAGEMENT
    # ========================================================================
    
    def _map_job_status(self, status: JobStatus) -> str:
        """
        Mappe JobStatus enum vers format string Brief Phase 4.
        
        Args:
            status: JobStatus enum value
            
        Returns:
            Status string in Phase 4 format
        """
        mapping = {
            JobStatus.PENDING: "running",
            JobStatus.RUNNING: "running",
            JobStatus.SUCCEEDED: "completed",
            JobStatus.FAILED: "failed",
            JobStatus.CANCELED: "cancelled",
            JobStatus.TIMEOUT: "failed"  # Timeout considéré comme failed
        }
        return mapping.get(status, "unknown")
    
    def _calculate_progress(self, job: ExecutionJob) -> Dict[str, Any]:
        """
        Calcule progression approximative basée sur l'état du job.
        
        Note: Approximation car ExecutionJob ne track pas nativement cells_total/cells_executed.
        Solution future: Parser logs Papermill pour extraction précise.
        
        Args:
            job: ExecutionJob pour lequel calculer la progression
            
        Returns:
            Dictionary avec cells_total, cells_executed, percent
        """
        if job.status == JobStatus.PENDING:
            return {"cells_total": 0, "cells_executed": 0, "percent": 0.0}
        elif job.status == JobStatus.RUNNING:
            # Approximation : 50% pendant exécution
            return {"cells_total": 100, "cells_executed": 50, "percent": 50.0}
        elif job.status in [JobStatus.SUCCEEDED, JobStatus.FAILED, JobStatus.CANCELED, JobStatus.TIMEOUT]:
            return {"cells_total": 100, "cells_executed": 100, "percent": 100.0}
        return {"cells_total": 0, "cells_executed": 0, "percent": 0.0}
    
    async def manage_async_job_consolidated(
        self,
        action: str,
        job_id: Optional[str] = None,
        include_logs: bool = False,
        log_tail: Optional[int] = None,
        filter_status: Optional[str] = None,
        cleanup_older_than: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        🆕 PHASE 4 - Gestion consolidée des jobs d'exécution asynchrone.
        
        Remplace: get_execution_status_async, get_job_logs, cancel_job,
                  list_jobs, cleanup_jobs
        
        Args:
            action: Action à effectuer
                - "status": Obtenir le statut d'un job (requiert job_id)
                - "logs": Obtenir les logs d'un job (requiert job_id)
                - "cancel": Annuler un job en cours (requiert job_id)
                - "list": Lister tous les jobs
                - "cleanup": Nettoyer les jobs terminés
            job_id: ID du job (requis pour status/logs/cancel)
            include_logs: Inclure les logs dans la réponse (action="status")
            log_tail: Nombre de lignes de logs à retourner (action="logs")
            filter_status: Filtrer les jobs par statut (action="list")
            cleanup_older_than: Supprimer jobs terminés il y a plus de N heures (action="cleanup")
            
        Returns:
            Dictionary avec résultat selon l'action (voir docstring tool MCP)
            
        Raises:
            ValueError: Si paramètres invalides ou manquants
        """
        # Validation des paramètres
        if action in ["status", "logs", "cancel"]:
            if job_id is None:
                raise ValueError(f"Parameter 'job_id' is required for action='{action}'")
        
        if log_tail is not None and log_tail <= 0:
            raise ValueError("Parameter 'log_tail' must be positive")
        
        if cleanup_older_than is not None and cleanup_older_than <= 0:
            raise ValueError("Parameter 'cleanup_older_than' must be positive")
        
        # Dispatcher selon l'action
        if action == "status":
            return await self._get_job_status_consolidated(job_id, include_logs)
        elif action == "logs":
            return await self._get_job_logs_consolidated(job_id, log_tail)
        elif action == "cancel":
            return await self._cancel_job_consolidated(job_id)
        elif action == "list":
            return await self._list_jobs_consolidated(filter_status)
        elif action == "cleanup":
            return await self._cleanup_jobs_consolidated(cleanup_older_than)
        else:
            raise ValueError(f"Invalid action: {action}. Must be 'status', 'logs', 'cancel', 'list', or 'cleanup'")
    
    async def _get_job_status_consolidated(
        self, job_id: str, include_logs: bool
    ) -> Dict[str, Any]:
        """
        Obtenir le statut complet d'un job (action="status").
        
        Args:
            job_id: ID du job
            include_logs: Inclure les logs dans la réponse
            
        Returns:
            Dictionary au format Phase 4
        """
        with self.lock:
            if job_id not in self.jobs:
                raise ValueError(f"Job '{job_id}' not found")
            
            job = self.jobs[job_id]
            
            # Construire réponse format Phase 4
            result = {
                "action": "status",
                "job_id": job_id,
                "status": self._map_job_status(job.status),
                "progress": self._calculate_progress(job),
                "started_at": job.started_at.isoformat() if job.started_at else None,
                "completed_at": job.ended_at.isoformat() if job.ended_at else None,
                "execution_time": job.duration_seconds,
                "input_path": job.input_path,
                "output_path": job.output_path,
                "parameters": job.parameters
            }
            
            # Ajouter résultat si completed
            if job.status == JobStatus.SUCCEEDED:
                result["result"] = {
                    "success": True,
                    "output_path": job.output_path,
                    "return_code": job.return_code
                }
            
            # Ajouter erreur si failed
            elif job.status in [JobStatus.FAILED, JobStatus.TIMEOUT]:
                result["error"] = {
                    "message": job.error_message or f"Job {job.status.value.lower()}",
                    "return_code": job.return_code,
                    "status": job.status.value
                }
            
            # Ajouter logs si demandé
            if include_logs:
                # Fusionner stdout et stderr
                all_logs = []
                all_logs.extend(job.stdout_buffer)
                all_logs.extend(job.stderr_buffer)
                result["logs"] = all_logs
            
            return result
    
    async def _get_job_logs_consolidated(
        self, job_id: str, log_tail: Optional[int]
    ) -> Dict[str, Any]:
        """
        Obtenir les logs d'un job (action="logs").
        
        Args:
            job_id: ID du job
            log_tail: Nombre de lignes à retourner (None = toutes)
            
        Returns:
            Dictionary au format Phase 4
        """
        with self.lock:
            if job_id not in self.jobs:
                raise ValueError(f"Job '{job_id}' not found")
            
            job = self.jobs[job_id]
            
            # Fusionner stdout et stderr
            all_logs = []
            all_logs.extend(job.stdout_buffer)
            all_logs.extend(job.stderr_buffer)
            
            total_lines = len(all_logs)
            
            # Appliquer tail si spécifié
            if log_tail:
                all_logs = all_logs[-log_tail:]
            
            return {
                "action": "logs",
                "job_id": job_id,
                "logs": all_logs,
                "total_lines": total_lines,
                "returned_lines": len(all_logs),
                "tail": log_tail
            }
    
    async def _cancel_job_consolidated(self, job_id: str) -> Dict[str, Any]:
        """
        Annuler un job en cours (action="cancel").
        
        Args:
            job_id: ID du job à annuler
            
        Returns:
            Dictionary au format Phase 4
        """
        with self.lock:
            if job_id not in self.jobs:
                raise ValueError(f"Job '{job_id}' not found")
            
            job = self.jobs[job_id]
            
            # Vérifier que le job est annulable
            if job.status not in [JobStatus.PENDING, JobStatus.RUNNING]:
                raise ValueError(f"Cannot cancel job '{job_id}' with status '{job.status.value}'")
            
            # Terminer le job
            self._terminate_job(job, JobStatus.CANCELED, "Job canceled by user request")
            
            return {
                "action": "cancel",
                "job_id": job_id,
                "status": "cancelled",
                "message": f"Job '{job_id}' cancelled successfully",
                "cancelled_at": job.ended_at.isoformat() if job.ended_at else datetime.now().isoformat()
            }
    
    async def _list_jobs_consolidated(
        self, filter_status: Optional[str]
    ) -> Dict[str, Any]:
        """
        Lister tous les jobs (action="list").
        
        Args:
            filter_status: Filtrer par statut ("running", "completed", "failed", "cancelled")
            
        Returns:
            Dictionary au format Phase 4
        """
        with self.lock:
            jobs = []
            
            for job_id, job in self.jobs.items():
                mapped_status = self._map_job_status(job.status)
                
                # Appliquer filtre si spécifié
                if filter_status and mapped_status != filter_status:
                    continue
                
                progress = self._calculate_progress(job)
                
                jobs.append({
                    "job_id": job_id,
                    "status": mapped_status,
                    "started_at": job.started_at.isoformat() if job.started_at else None,
                    "input_path": job.input_path,
                    "progress_percent": progress["percent"]
                })
            
            return {
                "action": "list",
                "jobs": jobs,
                "total": len(jobs),
                "filter_status": filter_status
            }
    
    async def _cleanup_jobs_consolidated(
        self, cleanup_older_than: Optional[int]
    ) -> Dict[str, Any]:
        """
        Nettoyer les jobs terminés (action="cleanup").
        
        Args:
            cleanup_older_than: Supprimer jobs terminés il y a plus de N heures
            
        Returns:
            Dictionary au format Phase 4
        """
        removed_job_ids = []
        now = datetime.now(timezone.utc)
        
        with self.lock:
            jobs_to_remove = []
            
            for job_id, job in self.jobs.items():
                # Ne supprimer que les jobs terminés
                if job.status not in [JobStatus.SUCCEEDED, JobStatus.FAILED, JobStatus.CANCELED, JobStatus.TIMEOUT]:
                    continue
                
                # Appliquer filtre temporel si spécifié
                if cleanup_older_than:
                    if job.ended_at is None:
                        continue
                    age_hours = (now - job.ended_at).total_seconds() / 3600
                    if age_hours < cleanup_older_than:
                        continue
                
                jobs_to_remove.append(job_id)
            
            # Supprimer les jobs identifiés
            for job_id in jobs_to_remove:
                del self.jobs[job_id]
                removed_job_ids.append(job_id)
        
        logger.info(f"Cleaned up {len(removed_job_ids)} jobs (older_than={cleanup_older_than}h)")
        
        return {
            "action": "cleanup",
            "jobs_removed": len(removed_job_ids),
            "jobs_kept": len(self.jobs),
            "older_than_hours": cleanup_older_than,
            "removed_job_ids": removed_job_ids
        }


# Instance globale du gestionnaire d'exécution (Singleton)
_async_job_service: Optional[AsyncJobService] = None


def get_async_job_service() -> AsyncJobService:
    """Récupère l'instance globale du service de jobs asynchrones."""
    global _async_job_service
    if _async_job_service is None:
        _async_job_service = AsyncJobService()
    return _async_job_service