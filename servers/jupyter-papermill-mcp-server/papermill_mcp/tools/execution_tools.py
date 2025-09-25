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
    async def execute_notebook_papermill(
        input_path: str,
        output_path: Optional[str] = None,
        parameters: Optional[Dict[str, Any]] = None,
        kernel_name: Optional[str] = None,
        timeout: Optional[int] = 900
    ) -> Dict[str, Any]:
        """
        Execute un notebook avec Papermill (execution complete avec parametres)
        
        Args:
            input_path: Chemin du notebook d'entree
            output_path: Chemin du notebook de sortie (optionnel)
            parameters: Parametres a injecter (optionnel)
            kernel_name: Nom du kernel a utiliser (optionnel)
            
        Returns:
            Resultat de l'execution Papermill
        """
        try:
            logger.info(f"Executing notebook with Papermill: {input_path}")
            notebook_service, _ = get_services()
            
            result = await notebook_service.execute_notebook(
                path=input_path,
                output_path=output_path,
                parameters=parameters or {},
                kernel_name=kernel_name,
                timeout=timeout
            )
            
            logger.info(f"Successfully executed notebook with Papermill: {input_path}")
            # Result is already converted to dict in notebook_service
            return result
            
        except Exception as e:
            logger.error(f"Error executing notebook with Papermill {input_path}: {e}")
            return {
                "error": str(e),
                "input_path": input_path,
                "output_path": output_path,
                "success": False
            }
    
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
        timeout: Optional[int] = 900
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
    
    logger.info("Registered execution tools (13 total)")