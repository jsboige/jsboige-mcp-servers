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
    metadata: Optional[Dict[str, Any]] = Field(default=None, description="Metadonnees de la cellule (optionnel)")


class RemoveCellInput(BaseModel):
    """Input model for remove_cell tool."""
    path: str = Field(description="Chemin du fichier notebook (.ipynb)")
    index: int = Field(description="Index de la cellule a supprimer")


class UpdateCellInput(BaseModel):
    """Input model for update_cell tool."""
    path: str = Field(description="Chemin du fichier notebook (.ipynb)")
    index: int = Field(description="Index de la cellule a modifier")
    source: str = Field(description="Nouveau contenu de la cellule")


def register_notebook_tools(app: FastMCP) -> None:
    """Register all notebook tools with the FastMCP app."""
    
    @app.tool()
    async def read_notebook(path: str) -> Dict[str, Any]:
        """
        Lit un notebook Jupyter a partir d'un fichier
        
        Args:
            path: Chemin du fichier notebook (.ipynb)
            
        Returns:
            Contenu complet du notebook avec metadonnees
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
        ?crit un notebook Jupyter dans un fichier
        
        Args:
            path: Chemin du fichier notebook (.ipynb)
            content: Contenu du notebook au format nbformat
            
        Returns:
            Resultat de l'operation d'ecriture
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
        Cree un nouveau notebook vide
        
        Args:
            path: Chemin du fichier notebook (.ipynb)
            kernel: Nom du kernel (ex: python3)
            
        Returns:
            Resultat de la creation du notebook
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
        Ajoute une cellule a un notebook
        
        Args:
            path: Chemin du fichier notebook (.ipynb)
            cell_type: Type de cellule
            source: Contenu de la cellule
            metadata: Metadonnees de la cellule (optionnel)
            
        Returns:
            Resultat de l'ajout de cellule
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
            index: Index de la cellule a supprimer
            
        Returns:
            Resultat de la suppression
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
            index: Index de la cellule a modifier
            source: Nouveau contenu de la cellule
            
        Returns:
            Resultat de la modification
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
    async def read_cells(
        path: str,
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
            path: Chemin du fichier notebook (.ipynb)
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
            
        Examples:
            # Lire cellule 5
            read_cells("nb.ipynb", mode="single", index=5)
            
            # Lire cellules 10-20
            read_cells("nb.ipynb", mode="range", start_index=10, end_index=20)
            
            # Lire cellules 10 jusqu'à la fin
            read_cells("nb.ipynb", mode="range", start_index=10)
            
            # Liste avec preview (défaut)
            read_cells("nb.ipynb")
            
            # Toutes les cellules complètes
            read_cells("nb.ipynb", mode="all")
        """
        try:
            logger.info(f"Reading cells from notebook (mode={mode}): {path}")
            service = get_notebook_service()
            result = await service.read_cells(
                path=path,
                mode=mode,
                index=index,
                start_index=start_index,
                end_index=end_index,
                include_preview=include_preview,
                preview_length=preview_length
            )
            logger.info(f"Successfully read cells from notebook: {path}")
            return result
        except Exception as e:
            logger.error(f"Error reading cells from notebook {path}: {e}")
            return {
                "error": str(e),
                "error_type": type(e).__name__,
                "path": path,
                "mode": mode,
                "success": False
            }
    
    @app.tool()
    async def read_cell(path: str, index: int) -> Dict[str, Any]:
        """
        Lit une cellule specifique d'un notebook
        
        ⚠️ DEPRECATED: Use read_cells(path, mode="single", index=...) instead.
        
        Args:
            path: Chemin du fichier notebook (.ipynb)
            index: Index de la cellule a lire (0-based)
            
        Returns:
            Informations detaillees sur la cellule
        """
        logger.warning("read_cell is deprecated, use read_cells(mode='single', index=...) instead")
        try:
            logger.info(f"Reading cell {index} from notebook: {path}")
            service = get_notebook_service()
            result = await service.read_cells(path, mode="single", index=index)
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
        
        ⚠️ DEPRECATED: Use read_cells(path, mode="range", start_index=..., end_index=...) instead.
        
        Args:
            path: Chemin du fichier notebook (.ipynb)
            start_index: Index de debut (0-based, inclus)
            end_index: Index de fin (0-based, inclus). Si None, lit jusqu'a la fin
            
        Returns:
            Informations sur les cellules dans la plage
        """
        logger.warning("read_cells_range is deprecated, use read_cells(mode='range', start_index=..., end_index=...) instead")
        try:
            logger.info(f"Reading cells range {start_index}-{end_index} from notebook: {path}")
            service = get_notebook_service()
            result = await service.read_cells(path, mode="range", start_index=start_index, end_index=end_index)
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
        Liste les cellules d'un notebook avec apercu du contenu
        
        ⚠️ DEPRECATED: Use read_cells(path, mode="list") instead.
        
        Args:
            path: Chemin du fichier notebook (.ipynb)
            
        Returns:
            Liste detaillee des cellules avec preview
        """
        logger.warning("list_notebook_cells is deprecated, use read_cells(mode='list') instead")
        try:
            logger.info(f"Listing cells from notebook: {path}")
            service = get_notebook_service()
            result = await service.read_cells(path, mode="list")
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
    async def inspect_notebook(
        path: str,
        mode: str = "metadata"
    ) -> Dict[str, Any]:
        """
        🆕 OUTIL CONSOLIDÉ - Inspection et validation de notebooks.
        
        Remplace: get_notebook_metadata, inspect_notebook_outputs, validate_notebook
        
        Args:
            path: Chemin du fichier notebook (.ipynb)
            mode: Type d'inspection
                - "metadata": Métadonnées du notebook (kernel, language, auteur)
                - "outputs": Analyse des sorties de toutes les cellules code
                - "validate": Validation nbformat + rapport de problèmes
                - "full": Combinaison de metadata + outputs + validate
                
        Returns:
            Dictionary with inspection results based on mode
            
        Examples:
            # Métadonnées seulement
            inspect_notebook("nb.ipynb", mode="metadata")
            
            # Analyse des outputs
            inspect_notebook("nb.ipynb", mode="outputs")
            
            # Validation du notebook
            inspect_notebook("nb.ipynb", mode="validate")
            
            # Inspection complète
            inspect_notebook("nb.ipynb", mode="full")
        """
        try:
            logger.info(f"Inspecting notebook (mode={mode}): {path}")
            service = get_notebook_service()
            result = await service.inspect_notebook(path, mode=mode)
            logger.info(f"Successfully inspected notebook: {path}")
            return result
        except Exception as e:
            logger.error(f"Error inspecting notebook {path}: {e}")
            return {
                "error": str(e),
                "error_type": type(e).__name__,
                "path": path,
                "mode": mode,
                "success": False
            }
    
    @app.tool()
    async def get_notebook_metadata(path: str) -> Dict[str, Any]:
        """
        Recupere les metadonnees completes d'un notebook
        
        ⚠️ DEPRECATED: Use inspect_notebook(path, mode="metadata") instead.
        
        Args:
            path: Chemin du fichier notebook (.ipynb)
            
        Returns:
            Metadonnees completes du notebook
        """
        logger.warning("get_notebook_metadata is deprecated, use inspect_notebook(mode='metadata') instead")
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
        
        ⚠️ DEPRECATED: Use inspect_notebook(path, mode="outputs") instead.
        
        Args:
            path: Chemin du fichier notebook (.ipynb)
            
        Returns:
            Inspection detaillee des outputs de chaque cellule
        """
        logger.warning("inspect_notebook_outputs is deprecated, use inspect_notebook(mode='outputs') instead")
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
        
        ⚠️ DEPRECATED: Use inspect_notebook(path, mode="validate") instead.
        
        Args:
            path: Chemin du fichier notebook (.ipynb)
            
        Returns:
            Resultat de la validation avec problemes detectes
        """
        logger.warning("validate_notebook is deprecated, use inspect_notebook(mode='validate') instead")
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
        Informations systeme rapides et fiables
        
        Returns:
            Informations detaillees sur le systeme, Python, et Jupyter
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