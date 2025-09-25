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
from pathlib import Path
from typing import Dict, List, Optional, Any, Union

from nbformat import NotebookNode

from ..core.papermill_executor import PapermillExecutor
from ..utils.file_utils import FileUtils
from ..config import MCPConfig

logger = logging.getLogger(__name__)


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
            return path_str
        
        # If relative, resolve against workspace directory
        workspace_path = os.path.join(self.workspace_dir, path_str)
        absolute_path = os.path.abspath(workspace_path)
        
        logger.debug(f"Path resolution: {path_str} -> {absolute_path}")
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
            path = Path(path)
            logger.info(f"Writing notebook: {path}")
            
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
            written_path = FileUtils.write_notebook(notebook, path)
            
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
            path = Path(path)
            logger.info(f"Creating new notebook: {path}")
            
            # Create empty notebook using FileUtils
            notebook = FileUtils.create_empty_notebook(kernel)
            
            # Write to file
            written_path = FileUtils.write_notebook(notebook, path)
            
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
            path = Path(path)
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
            path = Path(path)
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
            path = Path(path)
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
        try:
            directory = Path(directory)
            logger.info(f"Listing notebooks in: {directory} (recursive={recursive})")
            
            notebooks = FileUtils.list_notebooks(directory, recursive)
            
            logger.info(f"Found {len(notebooks)} notebooks")
            return notebooks
            
        except Exception as e:
            logger.error(f"Error listing notebooks in {directory}: {e}")
            raise
    
    async def get_notebook_metadata(self, path: Union[str, Path]) -> Dict[str, Any]:
        """
        Get metadata from a notebook file.
        
        Args:
            path: Path to notebook file
            
        Returns:
            Dictionary with notebook metadata
        """
        try:
            path = Path(path)
            logger.info(f"Getting metadata for notebook: {path}")
            
            metadata = FileUtils.get_notebook_metadata(path)
            
            logger.info("Successfully retrieved notebook metadata")
            return metadata
            
        except Exception as e:
            logger.error(f"Error getting metadata for notebook {path}: {e}")
    
    async def read_cell(self, path: Union[str, Path], index: int) -> Dict[str, Any]:
        """
        Read a specific cell from a notebook.
        
        Args:
            path: Path to notebook file
            index: Index of the cell to read (0-based)
            
        Returns:
            Dictionary with cell information
            
        Raises:
            IndexError: If cell index is out of range
        """
        try:
            path = Path(path)
            logger.info(f"Reading cell {index} from notebook: {path}")
            
            # Read notebook
            notebook = FileUtils.read_notebook(path)
            
            # Check if index is valid
            if index < 0 or index >= len(notebook.cells):
                raise IndexError(f"Cell index {index} out of range (0 to {len(notebook.cells) - 1})")
            
            cell = notebook.cells[index]
            
            # Convert cell to dictionary format
            cell_data = {
                "index": index,
                "cell_type": cell.cell_type,
                "source": cell.source,
                "metadata": cell.metadata,
                "has_outputs": hasattr(cell, 'outputs') and bool(cell.outputs)
            }
            
            # Add execution info for code cells
            if cell.cell_type == "code":
                cell_data["execution_count"] = getattr(cell, 'execution_count', None)
                if hasattr(cell, 'outputs') and cell.outputs:
                    cell_data["outputs"] = cell.outputs
                    cell_data["output_count"] = len(cell.outputs)
            
            result = {
                "path": str(path),
                "cell": cell_data,
                "total_cells": len(notebook.cells),
                "success": True
            }
            
            logger.info(f"Successfully read cell {index}")
            return result
            
        except Exception as e:
            logger.error(f"Error reading cell {index} from notebook {path}: {e}")
            raise
            
    
    async def read_cells_range(self, path: Union[str, Path], start_index: int, end_index: Optional[int] = None) -> Dict[str, Any]:
        """
        Read a range of cells from a notebook.
        
        Args:
            path: Path to notebook file
            start_index: Starting index (0-based, inclusive)
            end_index: Ending index (0-based, inclusive). If None, reads from start_index to end
            
        Returns:
            Dictionary with cells information
        """
        try:
            path = Path(path)
            logger.info(f"Reading cells {start_index} to {end_index} from notebook: {path}")
            
            # Read notebook
            notebook = FileUtils.read_notebook(path)
            
            total_cells = len(notebook.cells)
            
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
                    "metadata": cell.metadata,
                    "has_outputs": hasattr(cell, 'outputs') and bool(cell.outputs)
                }
                
                # Add execution info for code cells
                if cell.cell_type == "code":
                    cell_data["execution_count"] = getattr(cell, 'execution_count', None)
                    if hasattr(cell, 'outputs') and cell.outputs:
                        cell_data["outputs"] = cell.outputs
                        cell_data["output_count"] = len(cell.outputs)
                
                cells_data.append(cell_data)
            
            result = {
                "path": str(path),
                "start_index": start_index,
                "end_index": end_index,
                "cells": cells_data,
                "cells_count": len(cells_data),
                "total_cells": total_cells,
                "success": True
            }
            
            logger.info(f"Successfully read {len(cells_data)} cells")
            return result
            
        except Exception as e:
            logger.error(f"Error reading cells range from notebook {path}: {e}")
            raise
    
    async def list_notebook_cells(self, path: Union[str, Path]) -> Dict[str, Any]:
        """
        Liste les cellules d'un notebook avec apercu du contenu.
        
        Args:
            path: Path to notebook file
            
        Returns:
            Dictionary with cells information and preview
        """
        try:
            path = Path(path)
            logger.info(f"Listing cells from notebook: {path}")
            
            # Read notebook
            notebook = FileUtils.read_notebook(path)
            
            cells_info = []
            for i, cell in enumerate(notebook.cells):
                # Get source preview (first 100 characters)
                source_text = ''.join(cell.source) if isinstance(cell.source, list) else cell.source
                source_preview = source_text[:100] + "..." if len(source_text) > 100 else source_text
                
                cell_info = {
                    "index": i,
                    "cell_type": cell.cell_type,
                    "source_preview": source_preview
                }
                
                if cell.cell_type == "code":
                    cell_info["execution_count"] = getattr(cell, 'execution_count', None)
                    cell_info["has_outputs"] = hasattr(cell, 'outputs') and bool(cell.outputs)
                
                cells_info.append(cell_info)
            
            result = {
                "path": str(path),
                "total_cells": len(cells_info),
                "cells": cells_info,
                "success": True
            }
            
            logger.info(f"Successfully listed {len(cells_info)} cells")
            return result
            
        except Exception as e:
            logger.error(f"Error listing cells from notebook {path}: {e}")
            raise
    
    async def inspect_notebook_outputs(self, path: Union[str, Path]) -> Dict[str, Any]:
        """
        Inspecte les sorties des cellules d'un notebook.
        
        Args:
            path: Path to notebook file
            
        Returns:
            Dictionary with detailed outputs information
        """
        try:
            path = Path(path)
            logger.info(f"Inspecting outputs from notebook: {path}")
            
            # Read notebook
            notebook = FileUtils.read_notebook(path)
            
            outputs_info = []
            for i, cell in enumerate(notebook.cells):
                if cell.cell_type == "code":
                    outputs = getattr(cell, 'outputs', [])
                    if outputs:
                        cell_outputs = {
                            "cell_index": i,
                            "execution_count": getattr(cell, 'execution_count', None),
                            "output_count": len(outputs),
                            "output_types": [out.get("output_type") for out in outputs]
                        }
                        
                        # Preview output data
                        for j, output in enumerate(outputs):
                            if output.get("output_type") == "execute_result":
                                data = output.get("data", {})
                                cell_outputs[f"output_{j}_data_keys"] = list(data.keys())
                            elif output.get("output_type") == "stream":
                                text = ''.join(output.get("text", []))
                                preview = text[:200] + "..." if len(text) > 200 else text
                                cell_outputs[f"output_{j}_text_preview"] = preview
                        
                        outputs_info.append(cell_outputs)
            
            result = {
                "path": str(path),
                "cells_with_outputs": len(outputs_info),
                "outputs": outputs_info,
                "success": True
            }
            
            logger.info(f"Successfully inspected outputs from {len(outputs_info)} cells")
            return result
            
        except Exception as e:
            logger.error(f"Error inspecting outputs from notebook {path}: {e}")
            raise
    
    async def validate_notebook(self, path: Union[str, Path]) -> Dict[str, Any]:
        """
        Valide la structure d'un notebook Jupyter.
        
        Args:
            path: Path to notebook file
            
        Returns:
            Dictionary with validation results
        """
        try:
            path = Path(path)
            logger.info(f"Validating notebook: {path}")
            
            # Read raw JSON content
            with open(path, 'r', encoding='utf-8') as f:
                notebook_data = json.load(f)
            
            issues = []
            
            # Basic structure validation
            if "nbformat" not in notebook_data:
                issues.append("Missing 'nbformat' field")
            elif notebook_data.get("nbformat") < 4:
                issues.append(f"Old nbformat version: {notebook_data.get('nbformat')}")
            
            if "cells" not in notebook_data:
                issues.append("Missing 'cells' field")
            elif not isinstance(notebook_data["cells"], list):
                issues.append("'cells' field is not a list")
            
            # Cell validation
            cell_issues = []
            for i, cell in enumerate(notebook_data.get("cells", [])):
                cell_problems = []
                
                if "cell_type" not in cell:
                    cell_problems.append("Missing cell_type")
                elif cell["cell_type"] not in ["code", "markdown", "raw"]:
                    cell_problems.append(f"Invalid cell_type: {cell['cell_type']}")
                
                if "source" not in cell:
                    cell_problems.append("Missing source")
                
                if cell_problems:
                    cell_issues.append({"cell_index": i, "issues": cell_problems})
            
            result = {
                "path": str(path),
                "is_valid": len(issues) == 0 and len(cell_issues) == 0,
                "notebook_issues": issues,
                "cell_issues": cell_issues,
                "success": True
            }
            
            logger.info(f"Notebook validation completed, valid: {result['is_valid']}")
            return result
            
        except Exception as e:
            logger.error(f"Error validating notebook {path}: {e}")
            raise
    
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
                "timestamp": datetime.datetime.now().isoformat(),
                "python": {
                    "version": platform.python_version(),
                    "executable": sys.executable
                },
                "system": {
                    "os": os.name,
                    "platform": platform.system(),
                    "cwd": os.getcwd()
                },
                "environment": {
                    "conda_env": os.environ.get("CONDA_DEFAULT_ENV", "NOT_SET"),
                    "conda_prefix": os.environ.get("CONDA_PREFIX", "NOT_SET"),
                    "userprofile": os.environ.get("USERPROFILE", "NOT_SET"),
                    "total_env_vars": len(os.environ)
                },
                "success": True
            }
            
            # Jupyter kernels info (safe attempt)
            try:
                from jupyter_client.kernelspec import KernelSpecManager
                ksm = KernelSpecManager()
                specs = ksm.get_all_specs()
                info["jupyter"] = {
                    "kernels_available": list(specs.keys()),
                    "kernel_count": len(specs)
                }
            except Exception as e:
                info["jupyter"] = {"error": str(e)}
            
            logger.info("Successfully retrieved system information")
            return info
            
        except Exception as e:
            logger.error(f"Error getting system information: {e}")
            raise
    
    async def execute_notebook_solution_a(
        self,
        input_path: Union[str, Path],
        output_path: Optional[Union[str, Path]] = None,
        timeout: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        SOLUTION A - API Papermill directe avec correction working directory.
        
        Args:
            input_path: Path to input notebook
            output_path: Optional path to output notebook
            
        Returns:
            Dictionary with execution result and diagnostics
        """
        try:
            import datetime
            import os
            
            input_path = Path(input_path)
            if output_path is None:
                # CORRECTION BUG INSTABILIT? : ?viter conflits de fichiers avec timestamps
                timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
                output_path = input_path.parent / f"{input_path.stem}_executed_{timestamp}.ipynb"
            else:
                output_path = Path(output_path)
            
            logger.info(f"Executing notebook (Solution A): {input_path}")
            
            # Diagnostic info
            diagnostic_info = {
                "method": "papermill_direct_api_with_cwd_fix",
                "cwd": os.getcwd(),
                "python_env": sys.executable
            }
            
            # Working directory fix for .NET NuGet packages
            notebook_dir = input_path.parent.absolute()
            original_cwd = os.getcwd()
            
            try:
                # Change to notebook directory
                os.chdir(notebook_dir)
                
                start_time = datetime.datetime.now()
                
                # Execute with PapermillExecutor (which handles the API call)
                result = await self.papermill_executor.execute_notebook(
                    input_path=input_path,
                    output_path=output_path,
                    parameters={},
                    kernel=None,
                    timeout=timeout
                )
                
                end_time = datetime.datetime.now()
                execution_time = (end_time - start_time).total_seconds()
                
                # Convert ExecutionResult to dictionary and enhance with Solution A specific info
                result_dict = result.to_dict()
                result_dict.update({
                    "method": "execute_notebook_solution_a",
                    "execution_time_seconds": execution_time,
                    "diagnostic": diagnostic_info,
                    "timestamp": end_time.isoformat()
                })
                
            finally:
                # Always restore original directory
                os.chdir(original_cwd)
            
            logger.info(f"Successfully executed notebook (Solution A): {result_dict.get('output_path')}")
            return result_dict
            
        except Exception as e:
            logger.error(f"Error executing notebook (Solution A) {input_path}: {e}")
            raise
    
    async def parameterize_notebook(
        self,
        input_path: Union[str, Path],
        parameters: Dict[str, Any],
        output_path: Optional[Union[str, Path]] = None
    ) -> Dict[str, Any]:
        """
        Execute un notebook avec des parametres via Papermill API directe.
        
        Args:
            input_path: Path to input notebook
            parameters: Parameters to inject (Dict or JSON string from Roo)
            output_path: Optional path to output notebook
            
        Returns:
            Dictionary with execution result
        """
        try:
            import datetime
            import os
            import json
            
            # CORRECTION BUG PYDANTIC : Gerer serialisation JSON via Roo
            if isinstance(parameters, str):
                # Roo peut envoyer les parametres comme string JSON
                try:
                    parameters = json.loads(parameters) if parameters else {}
                except json.JSONDecodeError:
                    # Si ce n'est pas du JSON valide, retourner erreur explicite
                    return {
                        "status": "error",
                        "error": f"Parametres invalides - JSON attendu: {parameters}",
                        "error_type": "InvalidParametersFormat",
                        "method": "parameterize_notebook_fastmcp"
                    }
            
            input_path = Path(input_path)
            if output_path is None:
                output_path = input_path.parent / f"{input_path.stem}_parameterized.ipynb"
            else:
                output_path = Path(output_path)
            
            logger.info(f"Executing parameterized notebook: {input_path}")
            
            # Diagnostic info
            diagnostic_info = {
                "method": "papermill_direct_api_with_parameters",
                "cwd": os.getcwd(),
                "python_env": sys.executable,
                "parameters_count": len(parameters)
            }
            
            # Working directory fix for .NET NuGet packages
            notebook_dir = input_path.parent.absolute()
            original_cwd = os.getcwd()
            
            try:
                # Change to notebook directory
                os.chdir(notebook_dir)
                
                start_time = datetime.datetime.now()
                
                # Execute with PapermillExecutor
                result = await self.papermill_executor.execute_notebook(
                    input_path=input_path,
                    output_path=output_path,
                    parameters=parameters,
                    kernel=None
                )
                
                end_time = datetime.datetime.now()
                execution_time = (end_time - start_time).total_seconds()
                
                # Enhance result
                result.update({
                    "parameters": parameters,
                    "method": "parameterize_notebook",
                    "execution_time_seconds": execution_time,
                    "diagnostic": diagnostic_info,
                    "timestamp": end_time.isoformat()
                })
                
            finally:
                # Always restore original directory
                os.chdir(original_cwd)
            
            logger.info(f"Successfully executed parameterized notebook: {result.get('output_path')}")
            return result
            
        except Exception as e:
            logger.error(f"Error executing parameterized notebook {input_path}: {e}")
            raise