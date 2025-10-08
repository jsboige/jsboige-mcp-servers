"""
MCP tools for kernel operations.

Defines all kernel-related MCP tools using FastMCP.
"""

import logging
from typing import Any, Dict, Optional, Literal

from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, Field

from ..services.kernel_service import KernelService
from ..config import MCPConfig

logger = logging.getLogger(__name__)

# Global service instance
_kernel_service: Optional[KernelService] = None


def initialize_kernel_tools(config: MCPConfig) -> KernelService:
    """Initialize the kernel service for tools."""
    global _kernel_service
    _kernel_service = KernelService(config)
    return _kernel_service


def get_kernel_service() -> KernelService:
    """Get the kernel service instance."""
    if _kernel_service is None:
        raise RuntimeError("Kernel service not initialized")
    return _kernel_service


# Input models for tools
class StartKernelInput(BaseModel):
    """Input model for start_kernel tool."""
    kernel_name: str = Field(default="python3", description="Nom du kernel a demarrer (ex: python3)")


class StopKernelInput(BaseModel):
    """Input model for stop_kernel tool."""
    kernel_id: str = Field(description="ID du kernel a arreter")


class InterruptKernelInput(BaseModel):
    """Input model for interrupt_kernel tool."""
    kernel_id: str = Field(description="ID du kernel a interrompre")


class RestartKernelInput(BaseModel):
    """Input model for restart_kernel tool."""
    kernel_id: str = Field(description="ID du kernel a redemarrer")


class ExecuteCellInput(BaseModel):
    """Input model for execute_cell tool."""
    kernel_id: str = Field(description="ID du kernel sur lequel executer le code")
    code: str = Field(description="Code a executer")


class ExecuteNotebookInput(BaseModel):
    """Input model for execute_notebook tool."""
    path: str = Field(description="Chemin du fichier notebook (.ipynb)")
    kernel_id: str = Field(description="ID du kernel sur lequel executer le notebook")


class ExecuteNotebookCellInput(BaseModel):
    """Input model for execute_notebook_cell tool."""
    path: str = Field(description="Chemin du fichier notebook (.ipynb)")
    cell_index: int = Field(description="Index de la cellule a executer")
    kernel_id: str = Field(description="ID du kernel sur lequel executer la cellule")


def register_kernel_tools(app: FastMCP) -> None:
    """Register all kernel tools with the FastMCP app."""
    
    @app.tool()
    async def list_kernels() -> Dict[str, Any]:
        """
        Liste les kernels disponibles et actifs
        
        Returns:
            Information sur les kernels disponibles et actifs
        """
        try:
            logger.info("Listing kernels")
            service = get_kernel_service()
            result = await service.list_kernels()
            logger.info("Successfully listed kernels")
            return result
        except Exception as e:
            logger.error(f"Error listing kernels: {e}")
            return {
                "error": str(e),
                "success": False
            }
    
    @app.tool()
    async def start_kernel(kernel_name: str = "python3") -> Dict[str, Any]:
        """
        Demarre un nouveau kernel
        
        Args:
            kernel_name: Nom du kernel a demarrer (ex: python3)
            
        Returns:
            Information sur le kernel demarre
        """
        try:
            logger.info(f"Starting kernel: {kernel_name}")
            service = get_kernel_service()
            result = await service.start_kernel(kernel_name)
            logger.info(f"Successfully started kernel: {kernel_name}")
            return result
        except Exception as e:
            logger.error(f"Error starting kernel {kernel_name}: {e}")
            return {
                "error": str(e),
                "kernel_name": kernel_name,
                "success": False
            }
    
    @app.tool()
    async def stop_kernel(kernel_id: str) -> Dict[str, Any]:
        """
        Arrete un kernel actif
        
        Args:
            kernel_id: ID du kernel a arreter
            
        Returns:
            Resultat de l'arret du kernel
        """
        try:
            logger.info(f"Stopping kernel: {kernel_id}")
            service = get_kernel_service()
            result = await service.stop_kernel(kernel_id)
            logger.info(f"Successfully stopped kernel: {kernel_id}")
            return result
        except Exception as e:
            logger.error(f"Error stopping kernel {kernel_id}: {e}")
            return {
                "error": str(e),
                "kernel_id": kernel_id,
                "success": False
            }
    
    @app.tool()
    async def interrupt_kernel(kernel_id: str) -> Dict[str, Any]:
        """
        Interrompt l'execution d'un kernel
        
        Args:
            kernel_id: ID du kernel a interrompre
            
        Returns:
            Resultat de l'interruption
        """
        try:
            logger.info(f"Interrupting kernel: {kernel_id}")
            service = get_kernel_service()
            result = await service.interrupt_kernel(kernel_id)
            logger.info(f"Successfully interrupted kernel: {kernel_id}")
            return result
        except Exception as e:
            logger.error(f"Error interrupting kernel {kernel_id}: {e}")
            return {
                "error": str(e),
                "kernel_id": kernel_id,
                "success": False
            }
    
    @app.tool()
    async def restart_kernel(kernel_id: str) -> Dict[str, Any]:
        """
        Redemarre un kernel
        
        Args:
            kernel_id: ID du kernel a redemarrer
            
        Returns:
            Information sur le kernel redemarre
        """
        try:
            logger.info(f"Restarting kernel: {kernel_id}")
            service = get_kernel_service()
            result = await service.restart_kernel(kernel_id)
            logger.info(f"Successfully restarted kernel: {kernel_id}")
            return result
        except Exception as e:
            logger.error(f"Error restarting kernel {kernel_id}: {e}")
            return {
                "error": str(e),
                "kernel_id": kernel_id,
                "success": False
            }
    
    @app.tool()
    async def execute_cell(kernel_id: str, code: str) -> Dict[str, Any]:
        """
        ⚠️ DEPRECATED: Use execute_on_kernel(kernel_id, mode="code", code=...) instead.
        
        Execute du code dans un kernel specifique
        
        Args:
            kernel_id: ID du kernel sur lequel executer le code
            code: Code a executer
            
        Returns:
            Resultat de l'execution du code
        """
        logger.warning("execute_cell is deprecated, use execute_on_kernel(mode='code') instead")
        return await execute_on_kernel(kernel_id=kernel_id, mode="code", code=code)
    
    @app.tool()
    async def execute_notebook(path: str, kernel_id: str) -> Dict[str, Any]:
        """
        ⚠️ DEPRECATED: Use execute_on_kernel(kernel_id, mode="notebook", path=...) instead.
        
        Execute toutes les cellules de code d'un notebook
        
        Args:
            path: Chemin du fichier notebook (.ipynb)
            kernel_id: ID du kernel sur lequel executer le notebook
            
        Returns:
            Resultat de l'execution du notebook
        """
        logger.warning("execute_notebook is deprecated, use execute_on_kernel(mode='notebook') instead")
        return await execute_on_kernel(kernel_id=kernel_id, mode="notebook", path=path)
    
    @app.tool()
    async def execute_notebook_cell(path: str, cell_index: int, kernel_id: str) -> Dict[str, Any]:
        """
        ⚠️ DEPRECATED: Use execute_on_kernel(kernel_id, mode="notebook_cell", path=..., cell_index=...) instead.
        
        Execute une cellule specifique d'un notebook
        
        Args:
            path: Chemin du fichier notebook (.ipynb)
            cell_index: Index de la cellule a executer
            kernel_id: ID du kernel sur lequel executer la cellule
            
        Returns:
            Resultat de l'execution de la cellule
        """
        logger.warning("execute_notebook_cell is deprecated, use execute_on_kernel(mode='notebook_cell') instead")
        return await execute_on_kernel(kernel_id=kernel_id, mode="notebook_cell", path=path, cell_index=cell_index)
    
    @app.tool()
    async def execute_on_kernel(
        kernel_id: str,
        mode: Literal["code", "notebook", "notebook_cell"],
        code: Optional[str] = None,
        path: Optional[str] = None,
        cell_index: Optional[int] = None,
        timeout: int = 60
    ) -> Dict[str, Any]:
        """
        🆕 OUTIL CONSOLIDÉ - Exécution de code sur un kernel.
        
        Remplace: execute_cell, execute_notebook, execute_notebook_cell
        
        Args:
            kernel_id: ID du kernel sur lequel exécuter
            mode: Type d'exécution
                - "code": Code Python brut (requiert code)
                - "notebook": Toutes les cellules d'un notebook (requiert path)
                - "notebook_cell": Une cellule spécifique (requiert path + cell_index)
            code: Code Python à exécuter (pour mode="code")
            path: Chemin du notebook (pour mode="notebook" | "notebook_cell")
            cell_index: Index de la cellule (pour mode="notebook_cell", 0-based)
            timeout: Timeout en secondes (défaut: 60)
            
        Returns:
            Mode "code":
            {
                "kernel_id": str,
                "mode": "code",
                "execution_count": int,
                "outputs": [
                    {
                        "output_type": str,
                        "text": Optional[str],
                        "data": Optional[dict],
                        "metadata": Optional[dict]
                    },
                    ...
                ],
                "status": str,  # "ok" | "error" | "abort"
                "error": Optional[{
                    "ename": str,
                    "evalue": str,
                    "traceback": [str]
                }],
                "execution_time": float,
                "success": bool
            }
            
            Mode "notebook":
            {
                "kernel_id": str,
                "mode": "notebook",
                "path": str,
                "cells_executed": int,
                "cells_succeeded": int,
                "cells_failed": int,
                "execution_time": float,
                "results": [
                    {
                        "cell_index": int,
                        "cell_type": str,
                        "execution_count": Optional[int],
                        "status": str,
                        "error": Optional[dict],
                        "outputs": [...]
                    },
                    ...
                ],
                "success": bool
            }
            
            Mode "notebook_cell":
            {
                "kernel_id": str,
                "mode": "notebook_cell",
                "path": str,
                "cell_index": int,
                "cell_type": str,
                "execution_count": int,
                "outputs": [...],
                "status": str,
                "error": Optional[dict],
                "execution_time": float,
                "success": bool
            }
        
        Validation:
            - mode="code" → code requis
            - mode="notebook" → path requis
            - mode="notebook_cell" → path + cell_index requis
        """
        try:
            logger.info(f"Executing on kernel {kernel_id} in mode: {mode}")
            service = get_kernel_service()
            result = await service.execute_on_kernel_consolidated(
                kernel_id=kernel_id,
                mode=mode,
                code=code,
                path=path,
                cell_index=cell_index,
                timeout=timeout
            )
            logger.info(f"Successfully executed on kernel {kernel_id} in mode: {mode}")
            return result
        except Exception as e:
            logger.error(f"Error executing on kernel {kernel_id} in mode {mode}: {e}")
            return {
                "error": str(e),
                "kernel_id": kernel_id,
                "mode": mode,
                "success": False
            }
    
    
    logger.info("Registered kernel tools")