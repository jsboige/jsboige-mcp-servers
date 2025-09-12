"""
MCP tools for notebook operations.

Defines all notebook-related MCP tools using FastMCP.
"""

import logging
from pathlib import Path
from typing import Any, Dict, Optional

from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, Field

from ..services.notebook_service import NotebookService
from ..config import MCPConfig

logger = logging.getLogger(__name__)

# Global service instance
_notebook_service: Optional[NotebookService] = None


def initialize_notebook_tools(config: MCPConfig) -> NotebookService:
    """Initialize the notebook service for tools."""
    global _notebook_service
    _notebook_service = NotebookService(config)
    return _notebook_service


def get_notebook_service() -> NotebookService:
    """Get the notebook service instance."""
    if _notebook_service is None:
        raise RuntimeError("Notebook service not initialized")
    return _notebook_service


# Input models for tools
class ReadNotebookInput(BaseModel):
    """Input model for read_notebook tool."""
    path: str = Field(description="Chemin du fichier notebook (.ipynb)")


class WriteNotebookInput(BaseModel):
    """Input model for write_notebook tool."""
    path: str = Field(description="Chemin du fichier notebook (.ipynb)")
    content: Dict[str, Any] = Field(description="Contenu du notebook au format nbformat")


class CreateNotebookInput(BaseModel):
    """Input model for create_notebook tool."""
    path: str = Field(description="Chemin du fichier notebook (.ipynb)")
    kernel: str = Field(default="python3", description="Nom du kernel (ex: python3)")


class AddCellInput(BaseModel):
    """Input model for add_cell tool."""
    path: str = Field(description="Chemin du fichier notebook (.ipynb)")
    cell_type: str = Field(description="Type de cellule", enum=["code", "markdown", "raw"])
    source: str = Field(description="Contenu de la cellule")
    metadata: Optional[Dict[str, Any]] = Field(default=None, description="Métadonnées de la cellule (optionnel)")


class RemoveCellInput(BaseModel):
    """Input model for remove_cell tool."""
    path: str = Field(description="Chemin du fichier notebook (.ipynb)")
    index: int = Field(description="Index de la cellule à supprimer")


class UpdateCellInput(BaseModel):
    """Input model for update_cell tool."""
    path: str = Field(description="Chemin du fichier notebook (.ipynb)")
    index: int = Field(description="Index de la cellule à modifier")
    source: str = Field(description="Nouveau contenu de la cellule")


def register_notebook_tools(app: FastMCP) -> None:
    """Register all notebook tools with the FastMCP app."""
    
    @app.tool()
    async def read_notebook(path: str) -> Dict[str, Any]:
        """
        Lit un notebook Jupyter à partir d'un fichier
        
        Args:
            path: Chemin du fichier notebook (.ipynb)
            
        Returns:
            Contenu complet du notebook avec métadonnées
        """
        try:
            logger.info(f"Reading notebook: {path}")
            service = get_notebook_service()
            result = await service.read_notebook(path)
            logger.info(f"Successfully read notebook: {path}")
            return result
        except Exception as e:
            logger.error(f"Error reading notebook {path}: {e}")
            return {
                "error": str(e),
                "path": path,
                "success": False
            }
    
    @app.tool()
    async def write_notebook(path: str, content: Dict[str, Any]) -> Dict[str, Any]:
        """
        Écrit un notebook Jupyter dans un fichier
        
        Args:
            path: Chemin du fichier notebook (.ipynb)
            content: Contenu du notebook au format nbformat
            
        Returns:
            Résultat de l'opération d'écriture
        """
        try:
            logger.info(f"Writing notebook: {path}")
            service = get_notebook_service()
            result = await service.write_notebook(path, content)
            logger.info(f"Successfully wrote notebook: {path}")
            return result
        except Exception as e:
            logger.error(f"Error writing notebook {path}: {e}")
            return {
                "error": str(e),
                "path": path,
                "success": False
            }
    
    @app.tool()
    async def create_notebook(path: str, kernel: str = "python3") -> Dict[str, Any]:
        """
        Crée un nouveau notebook vide
        
        Args:
            path: Chemin du fichier notebook (.ipynb)
            kernel: Nom du kernel (ex: python3)
            
        Returns:
            Résultat de la création du notebook
        """
        try:
            logger.info(f"Creating notebook: {path} with kernel: {kernel}")
            service = get_notebook_service()
            result = await service.create_notebook(path, kernel)
            logger.info(f"Successfully created notebook: {path}")
            return result
        except Exception as e:
            logger.error(f"Error creating notebook {path}: {e}")
            return {
                "error": str(e),
                "path": path,
                "kernel": kernel,
                "success": False
            }
    
    @app.tool()
    async def add_cell(path: str, cell_type: str, source: str, 
                       metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Ajoute une cellule à un notebook
        
        Args:
            path: Chemin du fichier notebook (.ipynb)
            cell_type: Type de cellule
            source: Contenu de la cellule
            metadata: Métadonnées de la cellule (optionnel)
            
        Returns:
            Résultat de l'ajout de cellule
        """
        try:
            logger.info(f"Adding {cell_type} cell to notebook: {path}")
            service = get_notebook_service()
            result = await service.add_cell(path, cell_type, source, metadata)
            logger.info(f"Successfully added cell to notebook: {path}")
            return result
        except Exception as e:
            logger.error(f"Error adding cell to notebook {path}: {e}")
            return {
                "error": str(e),
                "path": path,
                "cell_type": cell_type,
                "success": False
            }
    
    @app.tool()
    async def remove_cell(path: str, index: int) -> Dict[str, Any]:
        """
        Supprime une cellule d'un notebook
        
        Args:
            path: Chemin du fichier notebook (.ipynb)
            index: Index de la cellule à supprimer
            
        Returns:
            Résultat de la suppression
        """
        try:
            logger.info(f"Removing cell {index} from notebook: {path}")
            service = get_notebook_service()
            result = await service.remove_cell(path, index)
            logger.info(f"Successfully removed cell from notebook: {path}")
            return result
        except Exception as e:
            logger.error(f"Error removing cell from notebook {path}: {e}")
            return {
                "error": str(e),
                "path": path,
                "index": index,
                "success": False
            }
    
    @app.tool()
    async def update_cell(path: str, index: int, source: str) -> Dict[str, Any]:
        """
        Modifie une cellule d'un notebook
        
        Args:
            path: Chemin du fichier notebook (.ipynb)
            index: Index de la cellule à modifier
            source: Nouveau contenu de la cellule
            
        Returns:
            Résultat de la modification
        """
        try:
            logger.info(f"Updating cell {index} in notebook: {path}")
            service = get_notebook_service()
            result = await service.update_cell(path, index, source)
            logger.info(f"Successfully updated cell in notebook: {path}")
            return result
        except Exception as e:
            logger.error(f"Error updating cell in notebook {path}: {e}")
            return {
                "error": str(e),
                "path": path,
                "index": index,
                "success": False
            }
    
    logger.info("Registered notebook tools")