"""
MCP tools for advanced execution operations.

Defines advanced execution tools including Papermill execution,
Jupyter server management, and debugging utilities.
"""

import logging
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, Field

from ..services.notebook_service import NotebookService
from ..services.kernel_service import KernelService
from ..config import MCPConfig

logger = logging.getLogger(__name__)

# Global service instances
_notebook_service: Optional[NotebookService] = None
_kernel_service: Optional[KernelService] = None


def initialize_execution_tools(config: MCPConfig) -> tuple[NotebookService, KernelService]:
    """Initialize services for execution tools."""
    global _notebook_service, _kernel_service
    _notebook_service = NotebookService(config)
    _kernel_service = KernelService(config)
    return _notebook_service, _kernel_service


def get_services() -> tuple[NotebookService, KernelService]:
    """Get the service instances."""
    if _notebook_service is None or _kernel_service is None:
        raise RuntimeError("Execution services not initialized")
    return _notebook_service, _kernel_service


# Input models for tools
class ExecuteNotebookPapermillInput(BaseModel):
    """Input model for execute_notebook_papermill tool."""
    input_path: str = Field(description="Chemin du notebook d'entree")
    output_path: Optional[str] = Field(default=None, description="Chemin du notebook de sortie (optionnel)")
    parameters: Optional[Dict[str, Any]] = Field(default=None, description="Parametres a injecter")
    kernel_name: Optional[str] = Field(default=None, description="Nom du kernel a utiliser")


class StartJupyterServerInput(BaseModel):
    """Input model for start_jupyter_server tool."""
    env_path: str = Field(description="Chemin vers l'executable jupyter-lab.exe dans l'environnement Conda (ou autre).")


class DebugListRuntimeDirInput(BaseModel):
    """Input model for debug_list_runtime_dir tool."""
    pass


def register_execution_tools(app: FastMCP) -> None:
    """Register all execution tools with the FastMCP app."""
    
    @app.tool()
    async def execute_notebook(
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
        🆕 OUTIL CONSOLIDÉ - Exécution de notebook avec Papermill.
        
        Remplace: execute_notebook_papermill, parameterize_notebook,
                  execute_notebook_solution_a, execute_notebook_sync, start_notebook_async
        
        Args:
            input_path: Chemin du notebook source
            output_path: Chemin du notebook de sortie (optionnel, auto-généré si None)
            parameters: Paramètres à injecter dans le notebook (dict clé-valeur)
            mode: Mode d'exécution
                - "sync": Exécution synchrone (bloquant, pour notebooks courts)
                - "async": Exécution asynchrone (non-bloquant, retourne job_id)
            kernel_name: Nom du kernel à utiliser (auto-détecté si None)
            timeout: Timeout global en secondes (None = illimité)
            log_output: Activer logging des outputs pendant exécution
            progress_bar: Afficher barre de progression (mode sync uniquement)
            report_mode: Niveau de détail du rapport
                - "full": Toutes les cellules avec outputs
                - "summary": Statistiques + erreurs
                - "minimal": Status uniquement
            
        Returns:
            Mode "sync":
            {
                "status": "success" | "error",
                "mode": "sync",
                "input_path": str,
                "output_path": str,
                "execution_time": float,
                "cells_executed": int,
                "cells_succeeded": int,
                "cells_failed": int,
                "parameters_injected": Dict[str, Any],
                "kernel_name": str,
                "report": {...},
                "error": Optional[dict]
            }
            
            Mode "async":
            {
                "status": "submitted",
                "mode": "async",
                "job_id": str,
                "input_path": str,
                "output_path": str,
                "parameters_injected": Dict[str, Any],
                "kernel_name": str,
                "submitted_at": str,
                "estimated_duration": Optional[float],
                "message": "..."
            }
        """
        try:
            logger.info(f"🆕 CONSOLIDATED execute_notebook (mode={mode}): {input_path}")
            notebook_service, _ = get_services()
            
            result = await notebook_service.execute_notebook_consolidated(
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
            
            logger.info(f"✅ Execute notebook completed (status={result.get('status')})")
            return result
            
        except Exception as e:
            logger.error(f"❌ Error in execute_notebook {input_path}: {e}")
            return {
                "status": "error",
                "mode": mode,
                "error": str(e),
                "input_path": input_path,
                "output_path": output_path
            }
    
    # ============================================================================
    # DEPRECATED WRAPPERS - Commentés Phase 6c (2025-10-10)
    # Ces wrappers ont été remplacés par l'outil consolidé execute_notebook (Phase 3).
    # Code conservé pour référence historique et possibilité de rollback.
    # NE PAS DÉCOMMENTER sans validation architecture.
    # ============================================================================
    
    # @app.tool()
    # async def execute_notebook_papermill(
    #     input_path: str,
    #     output_path: Optional[str] = None,
    #     parameters: Optional[Dict[str, Any]] = None,
    #     kernel_name: Optional[str] = None,
    #     timeout: Optional[int] = 60
    # ) -> Dict[str, Any]:
    #     """
    #     ⚠️ DEPRECATED: Use execute_notebook(..., mode="sync") instead.
    #
    #     Execute un notebook avec Papermill (execution complete avec parametres)
    #
    #     Args:
    #         input_path: Chemin du notebook d'entree
    #         output_path: Chemin du notebook de sortie (optionnel)
    #         parameters: Parametres a injecter (optionnel)
    #         kernel_name: Nom du kernel a utiliser (optionnel)
    #
    #     Returns:
    #         Resultat de l'execution Papermill
    #     """
    #     logger.warning("⚠️ execute_notebook_papermill is deprecated, use execute_notebook(mode='sync') instead")
    #     return await execute_notebook(
    #         input_path=input_path,
    #         output_path=output_path,
    #         parameters=parameters,
    #         mode="sync",
    #         kernel_name=kernel_name,
    #         timeout=timeout
    #     )
    
    # @app.tool()
    # async def parameterize_notebook(
    #     input_path: str,
    #     parameters: Dict[str, Any],
    #     output_path: Optional[str] = None
    # ) -> Dict[str, Any]:
    #     """
    #     ⚠️ DEPRECATED: Use execute_notebook(..., parameters=..., mode="sync") instead.
    #
    #     Execute un notebook avec des parametres via Papermill API directe
    #
    #     Args:
    #         input_path: Chemin du notebook d'entree
    #         parameters: Parametres a injecter dans le notebook
    #         output_path: Chemin du notebook de sortie (optionnel)
    #
    #     Returns:
    #         Resultat de l'execution parametree
    #     """
    #     logger.warning("⚠️ parameterize_notebook is deprecated, use execute_notebook(parameters=...) instead")
    #     return await execute_notebook(
    #         input_path=input_path,
    #         output_path=output_path,
    #         parameters=parameters,
    #         mode="sync"
    #     )
    
    # @app.tool()
    # async def execute_notebook_solution_a(
    #     input_path: str,
    #     output_path: Optional[str] = None,
    #     timeout: Optional[int] = 60
    # ) -> Dict[str, Any]:
    #     """
    #     ⚠️ DEPRECATED: Use execute_notebook(..., mode="sync") instead.
    #
    #     SOLUTION A - API Papermill directe avec correction working directory
    #
    #     Args:
    #         input_path: Chemin du notebook d'entree
    #         output_path: Chemin du notebook de sortie (optionnel)
    #
    #     Returns:
    #         Resultat de l'execution avec timing et diagnostic
    #     """
    #     logger.warning("⚠️ execute_notebook_solution_a is deprecated, use execute_notebook(mode='sync') instead")
    #     return await execute_notebook(
    #         input_path=input_path,
    #         output_path=output_path,
    #         mode="sync",
    #         timeout=timeout
    #     )
    
    # @app.tool()
    # async def execute_notebook_sync(
    #     notebook_path: str,
    #     timeout_seconds: int = 300,
    #     output_path: Optional[str] = None,
    #     parameters: Optional[Dict[str, Any]] = None
    # ) -> Dict[str, Any]:
    #     """
    #     ⚠️ DEPRECATED: Use execute_notebook(..., mode="sync", timeout=...) instead.
    #
    #     Version synchrone avec timeout configurable pour notebooks courts/moyens.
    #     Interface conforme aux spécifications SDDD Mission.
    #
    #     Args:
    #         notebook_path: Chemin du notebook à exécuter
    #         timeout_seconds: Timeout configurable côté serveur (défaut: 300s)
    #         output_path: Chemin de sortie optionnel
    #         parameters: Paramètres optionnels à injecter
    #
    #     Returns:
    #         Dictionary avec résultat d'exécution ou recommandation async
    #     """
    #     logger.warning("⚠️ execute_notebook_sync is deprecated, use execute_notebook(mode='sync', timeout=...) instead")
    #     return await execute_notebook(
    #         input_path=notebook_path,
    #         output_path=output_path,
    #         parameters=parameters,
    #         mode="sync",
    #         timeout=timeout_seconds
    #     )
    
    # @app.tool()
    # async def start_notebook_async(
    #     input_path: str,
    #     output_path: Optional[str] = None,
    #     parameters: Optional[Dict[str, Any]] = None,
    #     working_dir_override: Optional[str] = None,
    #     env_overrides: Optional[Dict[str, str]] = None,
    #     timeout_seconds: Optional[int] = None,
    #     wait_seconds: float = 0
    # ) -> Dict[str, Any]:
    #     """
    #     ⚠️ DEPRECATED: Use execute_notebook(..., mode="async") instead.
    #
    #     Démarre l'exécution asynchrone d'un notebook
    #
    #     Args:
    #         input_path: Chemin du notebook d'entrée
    #         output_path: Chemin du notebook de sortie (optionnel)
    #         parameters: Paramètres à injecter (optionnel)
    #         working_dir_override: Répertoire de travail personnalisé
    #         env_overrides: Variables d'environnement supplémentaires
    #         timeout_seconds: Timeout personnalisé (auto-calculé si None)
    #         wait_seconds: Attendre la confirmation de démarrage (0 = immédiat)
    #
    #     Returns:
    #         Dictionary avec job_id, status, started_at, etc.
    #     """
    #     logger.warning("⚠️ start_notebook_async is deprecated, use execute_notebook(mode='async') instead")
    #
    #     # Note: working_dir_override et env_overrides ne sont pas supportés par le nouvel outil consolidé
    #     # Ces paramètres étaient rarement utilisés et complexifient l'interface
    #     if working_dir_override or env_overrides:
    #         logger.warning("⚠️ working_dir_override and env_overrides are not supported in consolidated tool")
    #
    #     return await execute_notebook(
    #         input_path=input_path,
    #         output_path=output_path,
    #         parameters=parameters,
    #         mode="async",
    #         timeout=timeout_seconds
    #     )
    
    @app.tool()
    async def list_notebook_files(directory: str = ".", recursive: bool = False) -> Dict[str, Any]:
        """
        Liste les fichiers notebook dans un repertoire
        
        Args:
            directory: Repertoire a explorer (defaut: repertoire courant)
            recursive: Recherche recursive (defaut: False)
            
        Returns:
            Liste des notebooks trouves avec leurs metadonnees
        """
        try:
            logger.info(f"Listing notebooks in: {directory} (recursive={recursive})")
            notebook_service, _ = get_services()
            
            notebooks = await notebook_service.list_notebooks(directory, recursive)
            
            result = {
                "directory": directory,
                "recursive": recursive,
                "notebooks": notebooks,
                "count": len(notebooks),
                "success": True
            }
            
            logger.info(f"Found {len(notebooks)} notebooks in {directory}")
            return result
            
        except Exception as e:
            logger.error(f"Error listing notebooks in {directory}: {e}")
            return {
                "error": str(e),
                "directory": directory,
                "success": False
            }
    
    @app.tool()
    async def get_notebook_info(path: str) -> Dict[str, Any]:
        """
        Recupere les metadonnees detaillees d'un notebook
        
        Args:
            path: Chemin du notebook
            
        Returns:
            Metadonnees completes du notebook
        """
        try:
            logger.info(f"Getting notebook info: {path}")
            notebook_service, _ = get_services()
            
            metadata = await notebook_service.get_notebook_metadata(path)
            
            # Add file information
            path_obj = Path(path)
            if path_obj.exists():
                stat = path_obj.stat()
                metadata.update({
                    "file_path": str(path_obj.absolute()),
                    "file_size": stat.st_size,
                    "last_modified": stat.st_mtime,
                    "exists": True
                })
            else:
                metadata.update({
                    "file_path": str(path_obj.absolute()),
                    "exists": False
                })
            
            metadata["success"] = True
            
            logger.info(f"Successfully retrieved notebook info: {path}")
            return metadata
            
        except Exception as e:
            logger.error(f"Error getting notebook info {path}: {e}")
            return {
                "error": str(e),
                "path": path,
                "success": False
            }
    
    @app.tool()
    async def get_kernel_status(kernel_id: str) -> Dict[str, Any]:
        """
        Recupere le statut detaille d'un kernel
        
        Args:
            kernel_id: ID du kernel a verifier
            
        Returns:
            Statut detaille du kernel
        """
        try:
            logger.info(f"Getting kernel status: {kernel_id}")
            _, kernel_service = get_services()
            
            result = await kernel_service.get_kernel_status(kernel_id)
            
            logger.info(f"Successfully retrieved kernel status: {kernel_id}")
            return result
            
        except Exception as e:
            logger.error(f"Error getting kernel status {kernel_id}: {e}")
            return {
                "error": str(e),
                "kernel_id": kernel_id,
                "success": False
            }
    
    @app.tool()
    async def cleanup_all_kernels() -> Dict[str, Any]:
        """
        Nettoie tous les kernels actifs (arret propre)
        
        Returns:
            Resultat du nettoyage de tous les kernels
        """
        try:
            logger.info("Cleaning up all kernels")
            _, kernel_service = get_services()
            
            result = await kernel_service.cleanup_kernels()
            
            logger.info("Successfully cleaned up all kernels")
            return result
            
        except Exception as e:
            logger.error(f"Error cleaning up kernels: {e}")
            return {
                "error": str(e),
                "success": False
            }
    
    @app.tool()
    async def start_jupyter_server(env_path: str) -> Dict[str, Any]:
        """
        Demarre un serveur Jupyter Lab et le connecte au MCP.
        
        Args:
            env_path: Chemin vers l'executable jupyter-lab.exe dans l'environnement Conda (ou autre).
            
        Returns:
            Information sur le serveur demarre
        """
        try:
            logger.info(f"Starting Jupyter server with env: {env_path}")
            
            import subprocess
            import asyncio
            from pathlib import Path
            
            env_path_obj = Path(env_path)
            if not env_path_obj.exists():
                raise FileNotFoundError(f"Jupyter executable not found: {env_path}")
            
            # Start Jupyter Lab server
            cmd = [str(env_path_obj), "--no-browser", "--ip=127.0.0.1", "--port=8888"]
            
            # Use asyncio to start the process
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            
            # Give it a moment to start
            await asyncio.sleep(2)
            
            # Check if process is still running
            if process.returncode is None:
                result = {
                    "status": "started",
                    "env_path": env_path,
                    "process_id": process.pid,
                    "url": "http://127.0.0.1:8888",
                    "success": True
                }
                logger.info(f"Successfully started Jupyter server (PID: {process.pid})")
            else:
                stderr_output = await process.stderr.read()
                result = {
                    "status": "failed",
                    "env_path": env_path,
                    "error": stderr_output.decode() if stderr_output else "Unknown error",
                    "success": False
                }
                logger.error("Failed to start Jupyter server")
            
            return result
            
        except Exception as e:
            logger.error(f"Error starting Jupyter server: {e}")
            return {
                "error": str(e),
                "env_path": env_path,
                "success": False
            }
    
    @app.tool()
    async def stop_jupyter_server() -> Dict[str, Any]:
        """
        Arrete le serveur Jupyter gere par le MCP.
        
        Returns:
            Resultat de l'arret du serveur
        """
        try:
            logger.info("Stopping Jupyter server")
            
            # This is a simplified implementation
            # In a real implementation, you'd track the server process
            import subprocess
            import platform
            
            if platform.system() == "Windows":
                # Kill jupyter-lab processes on Windows
                subprocess.run(["taskkill", "/f", "/im", "jupyter-lab.exe"], 
                             capture_output=True, check=False)
            else:
                # Kill jupyter-lab processes on Unix-like systems
                subprocess.run(["pkill", "-f", "jupyter-lab"], 
                             capture_output=True, check=False)
            
            result = {
                "status": "stopped",
                "success": True
            }
            
            logger.info("Successfully stopped Jupyter server")
            return result
            
        except Exception as e:
            logger.error(f"Error stopping Jupyter server: {e}")
            return {
                "error": str(e),
                "success": False
            }
    
    @app.tool()
    async def debug_list_runtime_dir() -> Dict[str, Any]:
        """
        DEBUG: Lists files in the Jupyter runtime directory.
        
        Returns:
            List of files in Jupyter runtime directory for debugging
        """
        try:
            logger.info("Listing Jupyter runtime directory for debugging")
            
            import jupyter_core.paths
            import os
            
            runtime_dir = jupyter_core.paths.jupyter_runtime_dir()
            
            files = []
            if os.path.exists(runtime_dir):
                for item in os.listdir(runtime_dir):
                    item_path = os.path.join(runtime_dir, item)
                    if os.path.isfile(item_path):
                        stat = os.stat(item_path)
                        files.append({
                            "name": item,
                            "size": stat.st_size,
                            "modified": stat.st_mtime,
                            "is_file": True
                        })
                    else:
                        files.append({
                            "name": item,
                            "is_file": False
                        })
            
            result = {
                "runtime_dir": runtime_dir,
                "exists": os.path.exists(runtime_dir),
                "files": files,
                "file_count": len(files),
                "success": True
            }
            
            logger.info(f"Found {len(files)} items in runtime directory")
            return result
            
        except Exception as e:
            logger.error(f"Error listing runtime directory: {e}")
            return {
                "error": str(e),
                "success": False
            }
    
    @app.tool()
    async def execute_notebook_solution_a(
        input_path: str,
        output_path: Optional[str] = None,
        timeout: Optional[int] = 60
    ) -> Dict[str, Any]:
        """
        SOLUTION A - API Papermill directe avec correction working directory
        
        Args:
            input_path: Chemin du notebook d'entree
            output_path: Chemin du notebook de sortie (optionnel)
            
        Returns:
            Resultat de l'execution avec timing et diagnostic
        """
        try:
            logger.info(f"Executing notebook with Solution A: {input_path}")
            notebook_service, _ = get_services()
            
            result = await notebook_service.execute_notebook_solution_a(
                input_path=input_path,
                output_path=output_path,
                timeout=timeout
            )
            
            logger.info(f"Successfully executed notebook with Solution A: {input_path}")
            return result
            
        except Exception as e:
            logger.error(f"Error executing notebook with Solution A {input_path}: {e}")
            return {
                "error": str(e),
                "input_path": input_path,
                "method": "execute_notebook_solution_a",
                "success": False
            }
    
    @app.tool()
    async def parameterize_notebook(
        input_path: str,
        parameters: Dict[str, Any],
        output_path: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Execute un notebook avec des parametres via Papermill API directe
        
        Args:
            input_path: Chemin du notebook d'entree
            parameters: Parametres a injecter dans le notebook
            output_path: Chemin du notebook de sortie (optionnel)
            
        Returns:
            Resultat de l'execution parametree
        """
        try:
            logger.info(f"Executing parameterized notebook: {input_path}")
            notebook_service, _ = get_services()
            
            result = await notebook_service.parameterize_notebook(
                input_path=input_path,
                parameters=parameters,
                output_path=output_path
            )
            
            logger.info(f"Successfully executed parameterized notebook: {input_path}")
            return result
            
        except Exception as e:
            logger.error(f"Error executing parameterized notebook {input_path}: {e}")
            return {
                "error": str(e),
                "input_path": input_path,
                "parameters": parameters,
                "method": "parameterize_notebook",
                "success": False
            }
    
    @app.tool()
    async def execute_notebook_cell(
        path: str,
        cell_index: int,
        kernel_id: str
    ) -> Dict[str, Any]:
        """
        Execute une cellule specifique d'un notebook sur un kernel
        
        Args:
            path: Chemin du fichier notebook (.ipynb)
            cell_index: Index de la cellule a executer
            kernel_id: ID du kernel sur lequel executer la cellule
            
        Returns:
            Resultat de l'execution de la cellule
        """
        try:
            logger.info(f"Executing cell {cell_index} from notebook: {path}")
            _, kernel_service = get_services()
            
            result = await kernel_service.execute_notebook_cell(
                path=path,
                cell_index=cell_index,
                kernel_id=kernel_id
            )
            
            logger.info(f"Successfully executed cell {cell_index} from notebook: {path}")
            return result
            
        except Exception as e:
            logger.error(f"Error executing cell {cell_index} from notebook {path}: {e}")
            return {
                "error": str(e),
                "path": path,
                "cell_index": cell_index,
                "kernel_id": kernel_id,
                "success": False
            }
    
    @app.tool()
    async def get_execution_status() -> Dict[str, Any]:
        """
        Recupere le statut d'execution global du serveur
        
        Returns:
            Statut global du serveur et des kernels actifs
        """
        try:
            logger.info("Getting global execution status")
            _, kernel_service = get_services()
            
            kernel_status = await kernel_service.list_kernels()
            
            result = {
                "status": "active",
                "timestamp": time.time(),
                "kernel_count": len(kernel_status.get("active_kernels", [])),
                "kernels": kernel_status,
                "success": True
            }
            
            logger.info("Successfully retrieved global execution status")
            return result
            
        except Exception as e:
            logger.error(f"Error getting execution status: {e}")
            return {
                "error": str(e),
                "success": False
            }
    
    @app.tool()
    async def start_notebook_async(
        input_path: str,
        output_path: Optional[str] = None,
        parameters: Optional[Dict[str, Any]] = None,
        working_dir_override: Optional[str] = None,
        env_overrides: Optional[Dict[str, str]] = None,
        timeout_seconds: Optional[int] = None,
        wait_seconds: float = 0
    ) -> Dict[str, Any]:
        """
        Démarre l'exécution asynchrone d'un notebook
        
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
            logger.info(f"Starting async notebook execution: {input_path}")
            notebook_service, _ = get_services()
            
            result = await notebook_service.start_notebook_async(
                input_path=input_path,
                output_path=output_path,
                parameters=parameters,
                working_dir_override=working_dir_override,
                env_overrides=env_overrides,
                timeout_seconds=timeout_seconds,
                wait_seconds=wait_seconds
            )
            
            logger.info(f"Successfully started async execution: {result.get('job_id', 'unknown')}")
            return result
            
        except Exception as e:
            logger.error(f"Error starting async notebook execution {input_path}: {e}")
            return {
                "error": str(e),
                "input_path": input_path,
                "success": False
            }
    
    # ==================== PHASE 4: ASYNC JOB MANAGEMENT ====================
    
    @app.tool()
    async def manage_async_job(
        action: str,
        job_id: Optional[str] = None,
        include_logs: bool = False,
        log_tail: Optional[int] = None,
        filter_status: Optional[str] = None,
        cleanup_older_than: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        🆕 OUTIL CONSOLIDÉ - Gestion des jobs d'exécution asynchrone.
        
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
            Action "status":
            {
                "action": "status",
                "job_id": str,
                "status": "running" | "completed" | "failed" | "cancelled",
                "progress": {
                    "cells_total": int,
                    "cells_executed": int,
                    "percent": float
                },
                "started_at": str,  # ISO 8601
                "completed_at": Optional[str],
                "execution_time": Optional[float],
                "input_path": str,
                "output_path": str,
                "parameters": Dict[str, Any],
                "result": Optional[Dict[str, Any]],  # Si completed
                "error": Optional[Dict[str, Any]],    # Si failed
                "logs": Optional[List[str]]           # Si include_logs=True
            }
            
            Action "logs":
            {
                "action": "logs",
                "job_id": str,
                "logs": List[str],
                "total_lines": int,
                "returned_lines": int,
                "tail": Optional[int]
            }
            
            Action "cancel":
            {
                "action": "cancel",
                "job_id": str,
                "status": "cancelled",
                "message": str,
                "cancelled_at": str
            }
            
            Action "list":
            {
                "action": "list",
                "jobs": [
                    {
                        "job_id": str,
                        "status": str,
                        "started_at": str,
                        "input_path": str,
                        "progress_percent": float
                    },
                    ...
                ],
                "total": int,
                "filter_status": Optional[str]
            }
            
            Action "cleanup":
            {
                "action": "cleanup",
                "jobs_removed": int,
                "jobs_kept": int,
                "older_than_hours": Optional[int],
                "removed_job_ids": List[str]
            }
        
        Validation:
            - action="status"|"logs"|"cancel" → job_id requis
            - action="list"|"cleanup" → job_id non utilisé
            - log_tail doit être positif si spécifié
            - cleanup_older_than doit être positif si spécifié
        """
        try:
            logger.info(f"🆕 CONSOLIDATED manage_async_job (action={action}, job_id={job_id})")
            notebook_service, _ = get_services()
            
            # Récupérer l'ExecutionManager
            from ..services.notebook_service import get_execution_manager
            exec_manager = get_execution_manager()
            
            result = await exec_manager.manage_async_job_consolidated(
                action=action,
                job_id=job_id,
                include_logs=include_logs,
                log_tail=log_tail,
                filter_status=filter_status,
                cleanup_older_than=cleanup_older_than
            )
            
            logger.info(f"✅ Manage async job completed (action={action})")
            return result
            
        except Exception as e:
            logger.error(f"❌ Error in manage_async_job (action={action}): {e}")
            return {
                "action": action,
                "error": str(e),
                "error_type": type(e).__name__,
                "job_id": job_id
            }
    
    # ==================== DEPRECATED ASYNC JOB WRAPPERS ====================
    # These tools are kept for backward compatibility but will be removed in future versions.
    # They now delegate to the consolidated manage_async_job tool.
    
    @app.tool()
    async def get_execution_status_async(
        job_id: str,
        include_logs: bool = False
    ) -> Dict[str, Any]:
        """
        ⚠️ DEPRECATED: Use manage_async_job(action="status", job_id=...) instead.
        
        Récupère le statut d'exécution d'un job asynchrone
        
        Args:
            job_id: ID du job
            include_logs: Inclure les logs dans la réponse
            
        Returns:
            Dictionary avec statut complet du job
        """
        logger.warning("⚠️ get_execution_status_async is deprecated, use manage_async_job(action='status') instead")
        return await manage_async_job(action="status", job_id=job_id, include_logs=include_logs)
    
    @app.tool()
    async def get_job_logs(
        job_id: str,
        tail: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        ⚠️ DEPRECATED: Use manage_async_job(action="logs", job_id=...) instead.
        
        Récupère les logs d'un job avec pagination
        
        Args:
            job_id: ID du job
            tail: Nombre de lignes de logs à retourner
            
        Returns:
            Dictionary avec chunks de logs
        """
        logger.warning("⚠️ get_job_logs is deprecated, use manage_async_job(action='logs') instead")
        return await manage_async_job(action="logs", job_id=job_id, log_tail=tail)
    
    @app.tool()
    async def cancel_job(job_id: str) -> Dict[str, Any]:
        """
        ⚠️ DEPRECATED: Use manage_async_job(action="cancel", job_id=...) instead.
        
        Annule un job en cours d'exécution
        
        Args:
            job_id: ID du job à annuler
            
        Returns:
            Dictionary avec résultat de l'annulation
        """
        logger.warning("⚠️ cancel_job is deprecated, use manage_async_job(action='cancel') instead")
        return await manage_async_job(action="cancel", job_id=job_id)
    
    @app.tool()
    async def list_jobs(
        filter_status: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        ⚠️ DEPRECATED: Use manage_async_job(action="list") instead.
        
        Liste tous les jobs avec statuts raccourcis
        
        Args:
            filter_status: Filtrer par statut ("running", "completed", "failed", "cancelled")
        
        Returns:
            Dictionary avec liste des jobs
        """
        logger.warning("⚠️ list_jobs is deprecated, use manage_async_job(action='list') instead")
        return await manage_async_job(action="list", filter_status=filter_status)
    
    @app.tool()
    async def cleanup_jobs(
        older_than_hours: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        ⚠️ DEPRECATED: Use manage_async_job(action="cleanup") instead.
        
        Nettoie les jobs terminés
        
        Args:
            older_than_hours: Supprimer jobs terminés il y a plus de N heures
            
        Returns:
            Dictionary avec résultat du nettoyage
        """
        logger.warning("⚠️ cleanup_jobs is deprecated, use manage_async_job(action='cleanup') instead")
        return await manage_async_job(action="cleanup", cleanup_older_than=older_than_hours)
    
    @app.tool()
    async def execute_notebook_sync(
        notebook_path: str,
        timeout_seconds: int = 300,
        output_path: Optional[str] = None,
        parameters: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Version synchrone avec timeout configurable pour notebooks courts/moyens.
        Interface conforme aux spécifications SDDD Mission.
        
        Args:
            notebook_path: Chemin du notebook à exécuter
            timeout_seconds: Timeout configurable côté serveur (défaut: 300s)
            output_path: Chemin de sortie optionnel
            parameters: Paramètres optionnels à injecter
            
        Returns:
            Dictionary avec résultat d'exécution ou recommandation async
            
        Usage patterns:
            - Notebooks < 5min : execute_notebook_sync(timeout_seconds=300)
            - Notebooks moyens : execute_notebook_sync(timeout_seconds=600)
            - Notebooks longs (>10min) : Recommandation automatique vers async
        """
        try:
            logger.info(f"Executing notebook (sync mode): {notebook_path} (timeout: {timeout_seconds}s)")
            notebook_service, _ = get_services()
            
            # Recommandation intelligente sync vs async
            recommendation_result = _get_sync_async_recommendation(
                notebook_path=notebook_path,
                requested_timeout=timeout_seconds
            )
            
            if recommendation_result["recommendation"] == "async_strongly_recommended":
                logger.warning(f"Notebook {notebook_path} estimated >10min, recommending async")
                return {
                    "success": True,
                    "method": "execute_notebook_sync",
                    "execution_mode": "async_recommended",
                    "notebook_path": notebook_path,
                    "requested_timeout": timeout_seconds,
                    "recommendation": recommendation_result,
                    "message": f"This notebook is estimated to run >{recommendation_result['estimated_duration_minutes']}min. Consider using start_notebook_async() for better UX.",
                    "alternative_command": f"start_notebook_async('{notebook_path}', timeout_seconds={max(timeout_seconds, 1200)})",
                    "timestamp": time.time()
                }
            
            # Utiliser l'architecture hybride existante (execute_notebook_solution_a)
            # avec timeout configuré selon demande utilisateur
            result = await notebook_service.execute_notebook_solution_a(
                input_path=notebook_path,
                output_path=output_path,
                timeout=timeout_seconds * 2,  # Timeout total = 2x sync timeout
                sync_timeout_seconds=timeout_seconds
            )
            
            # Enrichir la réponse avec informations SDDD
            result.update({
                "method": "execute_notebook_sync",
                "sync_timeout_configured": timeout_seconds,
                "recommendation": recommendation_result,
                "usage_pattern": _determine_usage_pattern(timeout_seconds)
            })
            
            logger.info(f"Sync execution completed: {result.get('execution_mode', 'unknown')}")
            return result
            
        except Exception as e:
            logger.error(f"Error in execute_notebook_sync {notebook_path}: {e}")
            return {
                "success": False,
                "method": "execute_notebook_sync",
                "notebook_path": notebook_path,
                "timeout_seconds": timeout_seconds,
                "error": str(e),
                "error_type": type(e).__name__,
                "timestamp": time.time()
            }
    
    def _get_sync_async_recommendation(notebook_path: str, requested_timeout: int) -> Dict[str, Any]:
        """
        Génère des recommandations intelligentes sync vs async.
        
        Args:
            notebook_path: Chemin du notebook à analyser
            requested_timeout: Timeout demandé par l'utilisateur
            
        Returns:
            Dictionary avec recommandation et justification
        """
        try:
            from pathlib import Path
            
            # Estimation basée sur analyse du contenu (réutilise logique existante)
            notebook_path_obj = Path(notebook_path)
            if not notebook_path_obj.exists():
                return {
                    "recommendation": "unknown",
                    "reason": "Notebook file not found for analysis",
                    "estimated_duration_minutes": "unknown"
                }
            
            # Réutiliser la logique d'estimation existante
            notebook_service, _ = get_services()
            estimated_timeout = notebook_service._calculate_optimal_timeout(notebook_path_obj)
            estimated_minutes = estimated_timeout / 60
            
            # Logique de recommandation SDDD
            if estimated_minutes > 10:
                recommendation = "async_strongly_recommended"
                reason = f"Estimated {estimated_minutes:.1f}min execution (>10min threshold)"
            elif estimated_minutes > 5:
                recommendation = "async_recommended"
                reason = f"Estimated {estimated_minutes:.1f}min execution (>5min threshold)"
            elif requested_timeout > 600:  # 10 minutes
                recommendation = "consider_async"
                reason = f"Requested timeout {requested_timeout/60:.1f}min suggests long execution"
            else:
                recommendation = "sync_optimal"
                reason = f"Estimated {estimated_minutes:.1f}min execution, sync mode optimal"
            
            return {
                "recommendation": recommendation,
                "reason": reason,
                "estimated_duration_minutes": round(estimated_minutes, 1),
                "estimated_timeout_seconds": estimated_timeout,
                "sync_vs_async_threshold": "5min for recommendation, 10min for strong recommendation"
            }
            
        except Exception as e:
            logger.warning(f"Error generating sync/async recommendation: {e}")
            return {
                "recommendation": "unknown",
                "reason": f"Analysis failed: {e}",
                "estimated_duration_minutes": "unknown"
            }
    
    def _determine_usage_pattern(timeout_seconds: int) -> str:
        """Détermine le pattern d'usage basé sur le timeout configuré."""
        if timeout_seconds <= 120:  # 2 minutes
            return "quick_test_prototyping"
        elif timeout_seconds <= 300:  # 5 minutes
            return "medium_notebooks"
        elif timeout_seconds <= 600:  # 10 minutes
            return "complex_notebooks"
        else:
            return "long_notebooks_consider_async"
    
    logger.info("Registered execution tools: 1 consolidated (execute_notebook) + 5 deprecated wrappers + 13 others = 19 total")