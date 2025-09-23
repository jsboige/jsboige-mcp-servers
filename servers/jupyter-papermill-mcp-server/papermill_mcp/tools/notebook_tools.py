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
    
    @app.tool()
    async def read_cell(path: str, index: int) -> Dict[str, Any]:
        """
        Lit une cellule spécifique d'un notebook
        
        Args:
            path: Chemin du fichier notebook (.ipynb)
            index: Index de la cellule à lire (0-based)
            
        Returns:
            Informations détaillées sur la cellule
        """
        try:
            logger.info(f"Reading cell {index} from notebook: {path}")
            service = get_notebook_service()
            result = await service.read_cell(path, index)
            logger.info(f"Successfully read cell {index} from notebook: {path}")
            return result
        except Exception as e:
            logger.error(f"Error reading cell {index} from notebook {path}: {e}")
            return {
                "error": str(e),
                "path": path,
                "index": index,
                "success": False
            }
    
    @app.tool()
    async def read_cells_range(path: str, start_index: int, end_index: Optional[int] = None) -> Dict[str, Any]:
        """
        Lit une plage de cellules d'un notebook
        
        Args:
            path: Chemin du fichier notebook (.ipynb)
            start_index: Index de début (0-based, inclus)
            end_index: Index de fin (0-based, inclus). Si None, lit jusqu'à la fin
            
        Returns:
            Informations sur les cellules dans la plage
        """
        try:
            logger.info(f"Reading cells range {start_index}-{end_index} from notebook: {path}")
            service = get_notebook_service()
            result = await service.read_cells_range(path, start_index, end_index)
            logger.info(f"Successfully read cells range from notebook: {path}")
            return result
        except Exception as e:
            logger.error(f"Error reading cells range from notebook {path}: {e}")
            return {
                "error": str(e),
                "path": path,
                "start_index": start_index,
                "end_index": end_index,
                "success": False
            }
    
    @app.tool()
    async def list_notebook_cells(path: str) -> Dict[str, Any]:
        """
        Liste les cellules d'un notebook avec aperçu du contenu
        
        Args:
            path: Chemin du fichier notebook (.ipynb)
            
        Returns:
            Liste détaillée des cellules avec preview
        """
        try:
            logger.info(f"Listing cells from notebook: {path}")
            service = get_notebook_service()
            result = await service.list_notebook_cells(path)
            logger.info(f"Successfully listed cells from notebook: {path}")
            return result
        except Exception as e:
            logger.error(f"Error listing cells from notebook {path}: {e}")
            return {
                "error": str(e),
                "path": path,
                "success": False
            }
    
    @app.tool()
    async def get_notebook_metadata(path: str) -> Dict[str, Any]:
        """
        Récupère les métadonnées complètes d'un notebook
        
        Args:
            path: Chemin du fichier notebook (.ipynb)
            
        Returns:
            Métadonnées complètes du notebook
        """
        try:
            logger.info(f"Getting metadata from notebook: {path}")
            service = get_notebook_service()
            result = await service.get_notebook_metadata(path)
            logger.info(f"Successfully got metadata from notebook: {path}")
            return result
        except Exception as e:
            logger.error(f"Error getting metadata from notebook {path}: {e}")
            return {
                "error": str(e),
                "path": path,
                "success": False
            }
    
    @app.tool()
    async def inspect_notebook_outputs(path: str) -> Dict[str, Any]:
        """
        Inspecte les sorties des cellules d'un notebook
        
        Args:
            path: Chemin du fichier notebook (.ipynb)
            
        Returns:
            Inspection détaillée des outputs de chaque cellule
        """
        try:
            logger.info(f"Inspecting outputs from notebook: {path}")
            service = get_notebook_service()
            result = await service.inspect_notebook_outputs(path)
            logger.info(f"Successfully inspected outputs from notebook: {path}")
            return result
        except Exception as e:
            logger.error(f"Error inspecting outputs from notebook {path}: {e}")
            return {
                "error": str(e),
                "path": path,
                "success": False
            }
    
    @app.tool()
    async def validate_notebook(path: str) -> Dict[str, Any]:
        """
        Valide la structure d'un notebook Jupyter
        
        Args:
            path: Chemin du fichier notebook (.ipynb)
            
        Returns:
            Résultat de la validation avec problèmes détectés
        """
        try:
            logger.info(f"Validating notebook: {path}")
            service = get_notebook_service()
            result = await service.validate_notebook(path)
            logger.info(f"Successfully validated notebook: {path}")
            return result
        except Exception as e:
            logger.error(f"Error validating notebook {path}: {e}")
            return {
                "error": str(e),
                "path": path,
                "success": False
            }
    
    @app.tool()
    async def system_info() -> Dict[str, Any]:
        """
        Informations système rapides et fiables
        
        Returns:
            Informations détaillées sur le système, Python, et Jupyter
        """
        try:
            logger.info("Getting system information")
            service = get_notebook_service()
            result = await service.system_info()
            logger.info("Successfully got system information")
            return result
        except Exception as e:
            logger.error(f"Error getting system information: {e}")
            return {
                "error": str(e),
                "success": False
            }
    
    logger.info("Registered notebook tools (13 total)")