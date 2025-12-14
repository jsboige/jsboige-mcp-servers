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
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from enum import Enum

from nbformat import NotebookNode

from ..core.papermill_executor import PapermillExecutor
from ..utils.file_utils import FileUtils
from ..config import MCPConfig
from .notebook_service_consolidated import ExecuteNotebookConsolidated
from .async_job_service import (
    AsyncJobService,
    ExecutionJob,
    JobStatus,
    get_async_job_service
)
from .notebook_crud_service import NotebookCRUDService
from .notebook_validation_service import NotebookValidationService
from .notebook_metadata_service import NotebookMetadataService

logger = logging.getLogger(__name__)

# Maintain backward compatibility
ExecutionManager = AsyncJobService


# Instance globale du gestionnaire d'exécution
_execution_manager: Optional[ExecutionManager] = None


def get_execution_manager() -> ExecutionManager:
    """Récupère l'instance globale du gestionnaire d'exécution."""
    return get_async_job_service()


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
        
        # Initialize modular services
        self.crud_service = NotebookCRUDService(self.workspace_dir)
        self.validation_service = NotebookValidationService(self.workspace_dir)
        self.metadata_service = NotebookMetadataService(self.validation_service)
        
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
        return self.crud_service.resolve_path(path)
    
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
        return await self.crud_service.read_notebook(path)
    
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
        return await self.crud_service.write_notebook(path, content)
    
    async def create_notebook(self, path: Union[str, Path], kernel: str = "python3") -> Dict[str, Any]:
        """
        Create a new empty notebook.
        
        Args:
            path: Path for the new notebook
            kernel: Kernel name to use
            
        Returns:
            Dictionary with creation result
        """
        return await self.crud_service.create_notebook(path, kernel)
    
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
        return await self.crud_service.add_cell(path, cell_type, source, metadata, index)
    
    async def remove_cell(self, path: Union[str, Path], index: int) -> Dict[str, Any]:
        """
        Remove a cell from a notebook.
        
        Args:
            path: Path to the notebook file
            index: Index of cell to remove
            
        Returns:
            Dictionary with operation result
        """
        return await self.crud_service.remove_cell(path, index)
    
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
        return await self.crud_service.update_cell(path, index, source, metadata)
    
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
        return await self.metadata_service.list_notebooks(directory, recursive)
    
    async def get_notebook_metadata(self, path: Union[str, Path]) -> Dict[str, Any]:
        """
        Get metadata from a notebook file.
        
        DEPRECATED: Use inspect_notebook(path, mode="metadata") instead.
        
        Args:
            path: Path to notebook file
            
        Returns:
            Dictionary with notebook metadata
        """
        return await self.metadata_service.get_notebook_metadata(path)
    
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
        """
        return await self.crud_service.read_cells(
            path, mode, index, start_index, end_index, include_preview, preview_length
        )
    
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
        return await self.validation_service.inspect_notebook(path, mode)
    
    
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
                "timestamp": datetime.now().isoformat(),
                "python": {
                    "version": platform.python_version(),
                    "executable": sys.executable,
                    "implementation": platform.python_implementation()
                },
                "platform": {
                    "system": platform.system(),
                    "release": platform.release(),
                    "version": platform.version(),
                    "machine": platform.machine(),
                    "processor": platform.processor()
                },
                "server": {
                    "cwd": os.getcwd(),
                    "pid": os.getpid(),
                    "workspace": self.workspace_dir
                }
            }
            
            # Jupyter specific info
            try:
                import jupyter_core
                import nbformat
                import papermill
                
                info["jupyter"] = {
                    "core_version": jupyter_core.__version__,
                    "nbformat_version": nbformat.__version__,
                    "papermill_version": papermill.__version__
                }
            except ImportError as e:
                info["jupyter_error"] = str(e)
            
            return info
            
        except Exception as e:
            logger.error(f"Error getting system info: {e}")
            return {"error": str(e)}

    async def list_kernels(self) -> Dict[str, Any]:
        """
        Liste les kernels disponibles.
        
        Returns:
            Dictionary with kernels information
        """
        try:
            from jupyter_client.kernelspec import KernelSpecManager
            ksm = KernelSpecManager()
            specs = ksm.get_all_specs()
            
            return {
                "kernels": specs,
                "default": ksm.default_kernel_name
            }
        except Exception as e:
            logger.error(f"Error listing kernels: {e}")
            return {"error": str(e), "kernels": {}}
            
    async def cleanup_all_kernels(self) -> Dict[str, Any]:
        """
        Nettoie tous les kernels actifs (arret propre).
        
        Returns:
            Dictionary with cleanup results
        """
        try:
            # Not really applicable in this stateless service architecture
            # but implemented for compatibility
            return {
                "success": True, 
                "message": "No active kernels to cleanup in stateless mode",
                "count": 0
            }
        except Exception as e:
            logger.error(f"Error cleaning up kernels: {e}")
            return {"success": False, "error": str(e)}