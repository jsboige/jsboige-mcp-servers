"""
Notebook CRUD Service.

Handles basic Create, Read, Update, Delete operations for notebooks and cells.
Extracted from notebook_service.py for better modularity.
"""

import logging
import os
from pathlib import Path
from typing import Dict, List, Optional, Any, Union

from ..utils.file_utils import FileUtils

logger = logging.getLogger(__name__)


class NotebookCRUDService:
    """
    Service for notebook CRUD operations.
    
    Delegates low-level file operations to FileUtils but handles
    business logic, path resolution validation, and high-level structure.
    """
    
    def __init__(self, workspace_dir: str):
        """
        Initialize the CRUD service.
        
        Args:
            workspace_dir: Root workspace directory for path resolution
        """
        self.workspace_dir = workspace_dir
    
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
            # logger.debug(f"Path resolution (absolute): {path_str}")
            return path_str
        
        # If relative, resolve against workspace directory
        workspace_path = os.path.join(self.workspace_dir, path_str)
        absolute_path = os.path.abspath(workspace_path)
        
        # logger.debug(f"Path resolution: {path_str} -> {absolute_path}")
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
    
    async def list_notebooks(self, directory: Union[str, Path],
                             recursive: bool = False) -> List[Dict[str, Any]]:
        """
        List notebook files in a directory.
        
        Args:
            directory: Directory to search (relative to workspace or absolute)
            recursive: Whether to search recursively
            
        Returns:
            List of notebook information
        """
        try:
            resolved_dir = Path(self.resolve_path(directory))
            logger.info(f"Listing notebooks in: {resolved_dir} (recursive={recursive})")
            
            notebooks = FileUtils.list_notebooks(resolved_dir, recursive)
            
            logger.info(f"Found {len(notebooks)} notebooks")
            return notebooks
            
        except Exception as e:
            logger.error(f"Error listing notebooks in {directory}: {e}")
            raise
    
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