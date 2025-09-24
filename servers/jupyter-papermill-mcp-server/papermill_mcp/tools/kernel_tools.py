"""
MCP tools for kernel operations.

Defines all kernel-related MCP tools using FastMCP.
"""

import logging
from typing import Any, Dict, Optional

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
        Execute du code dans un kernel specifique
        
        Args:
            kernel_id: ID du kernel sur lequel executer le code
            code: Code a executer
            
        Returns:
            Resultat de l'execution du code
        """
        try:
            logger.info(f"Executing code in kernel: {kernel_id}")
            service = get_kernel_service()
            result = await service.execute_cell(kernel_id, code)
            logger.info(f"Successfully executed code in kernel: {kernel_id}")
            return result
        except Exception as e:
            logger.error(f"Error executing code in kernel {kernel_id}: {e}")
            return {
                "error": str(e),
                "kernel_id": kernel_id,
                "success": False
            }
    
    @app.tool()
    async def execute_notebook(path: str, kernel_id: str) -> Dict[str, Any]:
        """
        Execute toutes les cellules de code d'un notebook
        
        Args:
            path: Chemin du fichier notebook (.ipynb)
            kernel_id: ID du kernel sur lequel executer le notebook
            
        Returns:
            Resultat de l'execution du notebook
        """
        try:
            logger.info(f"Executing notebook {path} in kernel: {kernel_id}")
            service = get_kernel_service()
            result = await service.execute_notebook_in_kernel(kernel_id, path)
            logger.info(f"Successfully executed notebook: {path}")
            return result
        except Exception as e:
            logger.error(f"Error executing notebook {path}: {e}")
            return {
                "error": str(e),
                "path": path,
                "kernel_id": kernel_id,
                "success": False
            }
    
    @app.tool()
    async def execute_notebook_cell(path: str, cell_index: int, kernel_id: str) -> Dict[str, Any]:
        """
        Execute une cellule specifique d'un notebook
        
        Args:
            path: Chemin du fichier notebook (.ipynb)
            cell_index: Index de la cellule a executer
            kernel_id: ID du kernel sur lequel executer la cellule
            
        Returns:
            Resultat de l'execution de la cellule
        """
        try:
            logger.info(f"Executing cell {cell_index} from notebook {path} in kernel: {kernel_id}")
            service = get_kernel_service()
            result = await service.execute_notebook_cell(path, cell_index, kernel_id)
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
    
    logger.info("Registered kernel tools")