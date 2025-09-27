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
            # Resolve path against workspace
            resolved_path = self.resolve_path(path)
            logger.info(f"Getting metadata for notebook: {path} -> {resolved_path}")
            
            metadata = FileUtils.get_notebook_metadata(resolved_path)
            
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
            # Resolve path against workspace
            resolved_path = Path(self.resolve_path(path))
            logger.info(f"Reading cell {index} from notebook: {path} -> {resolved_path}")
            
            # Read notebook
            notebook = FileUtils.read_notebook(resolved_path)
            
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
            # Resolve path against workspace
            resolved_path = Path(self.resolve_path(path))
            logger.info(f"Reading cells {start_index} to {end_index} from notebook: {path} -> {resolved_path}")
            
            # Read notebook
            notebook = FileUtils.read_notebook(resolved_path)
            
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
            # Resolve path against workspace
            resolved_path = Path(self.resolve_path(path))
            logger.info(f"Listing cells from notebook: {path} -> {resolved_path}")
            
            # Read notebook
            notebook = FileUtils.read_notebook(resolved_path)
            
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
            # Resolve path against workspace
            resolved_path = Path(self.resolve_path(path))
            logger.info(f"Inspecting outputs from notebook: {path} -> {resolved_path}")
            
            # Read notebook
            notebook = FileUtils.read_notebook(resolved_path)
            
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
            # Resolve path against workspace
            resolved_path = Path(self.resolve_path(path))
            logger.info(f"Validating notebook: {path} -> {resolved_path}")
            
            # Read raw JSON content
            with open(resolved_path, 'r', encoding='utf-8') as f:
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
        SOLUTION A - Architecture subprocess avec conda run et environnement complet.
        Résout le timeout de 60s en utilisant subprocess.run avec conda run.
        
        Args:
            input_path: Path to input notebook
            output_path: Optional path to output notebook
            timeout: Optional timeout in seconds (default 60)
            
        Returns:
            Dictionary with execution result and diagnostics
        """
        try:
            import datetime
            import os
            import subprocess
            
            # Resolve input path against workspace
            resolved_input_path = Path(self.resolve_path(input_path))
            
            if output_path is None:
                # CORRECTION BUG INSTABILITÉ : éviter conflits de fichiers avec timestamps
                timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
                output_path = resolved_input_path.parent / f"{resolved_input_path.stem}_executed_{timestamp}.ipynb"
            else:
                output_path = Path(self.resolve_path(output_path))
            
            logger.info(f"Executing notebook (Solution A - subprocess): {input_path} -> {resolved_input_path}")
            
            # Configure timeout (default to 300s for subprocess method)
            if timeout is None:
                timeout = 300  # 5 minutes default pour subprocess
            
            # Working directory fix for .NET NuGet packages
            notebook_dir = resolved_input_path.parent.absolute()
            original_cwd = os.getcwd()
            
            try:
                # Change to notebook directory
                os.chdir(notebook_dir)
                
                start_time = datetime.datetime.now()
                
                # CORRECTION : Utiliser directement python de l'environnement plutôt que conda run
                conda_python = "C:/Users/jsboi/.conda/envs/mcp-jupyter-py310/python.exe"
                cmd = [
                    conda_python, "-m", "papermill",
                    str(resolved_input_path),
                    str(output_path),
                    "--progress-bar"
                ]
                
                logger.info(f"Executing command: {' '.join(cmd)}")
                logger.info(f"Working directory: {notebook_dir}")
                logger.info(f"Timeout: {timeout}s")
                
                # Execute subprocess with comprehensive environment
                env = os.environ.copy()
                
                # Ajouter variables d'environnement critiques
                critical_env_vars = {
                    "CONDA_DEFAULT_ENV": "mcp-jupyter-py310",
                    "CONDA_PREFIX": env.get("CONDA_PREFIX", ""),
                    "ROO_WORKSPACE_DIR": self.workspace_dir,
                    "PYTHONUNBUFFERED": "1",
                    "DOTNET_CLI_TELEMETRY_OPTOUT": "1"
                }
                
                env.update(critical_env_vars)
                
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    check=False,
                    timeout=timeout,
                    env=env,
                    cwd=notebook_dir
                )
                
                end_time = datetime.datetime.now()
                execution_time = (end_time - start_time).total_seconds()
                
                # Diagnostic info
                diagnostic_info = {
                    "method": "conda_run_subprocess",
                    "command": " ".join(cmd),
                    "cwd": str(notebook_dir),
                    "original_cwd": original_cwd,
                    "timeout_configured": timeout,
                    "execution_time_seconds": execution_time,
                    "returncode": result.returncode,
                    "stdout_length": len(result.stdout) if result.stdout else 0,
                    "stderr_length": len(result.stderr) if result.stderr else 0
                }
                
                # Check if execution was successful
                success = result.returncode == 0 and os.path.exists(output_path)
                
                result_dict = {
                    "success": success,
                    "method": "execute_notebook_solution_a",
                    "input_path": str(resolved_input_path),
                    "output_path": str(output_path),
                    "execution_time_seconds": execution_time,
                    "diagnostic": diagnostic_info,
                    "timestamp": end_time.isoformat(),
                    "returncode": result.returncode,
                    "timeout_used": timeout
                }
                
                # Add stdout/stderr if there are issues or for debugging
                if result.stdout:
                    result_dict["stdout"] = result.stdout
                if result.stderr:
                    result_dict["stderr"] = result.stderr
                
                # Add file size info if output exists
                if os.path.exists(output_path):
                    stat = os.stat(output_path)
                    result_dict["output_file_size"] = stat.st_size
                else:
                    result_dict["error"] = "Output notebook file not created"
                    success = False
                    result_dict["success"] = False
                
                if success:
                    logger.info(f"Successfully executed notebook (Solution A subprocess): {output_path}")
                    logger.info(f"Execution time: {execution_time:.2f}s")
                else:
                    logger.error(f"Notebook execution failed (returncode: {result.returncode})")
                    if result.stderr:
                        logger.error(f"Error output: {result.stderr[:500]}...")
                
                return result_dict
                
            finally:
                # Always restore original directory
                os.chdir(original_cwd)
            
        except subprocess.TimeoutExpired as e:
            logger.error(f"Notebook execution timed out after {timeout}s: {input_path}")
            return {
                "success": False,
                "method": "execute_notebook_solution_a",
                "input_path": str(input_path),
                "output_path": str(output_path) if output_path else None,
                "error": f"Execution timed out after {timeout}s",
                "error_type": "TimeoutExpired",
                "timeout_used": timeout,
                "timestamp": datetime.datetime.now().isoformat()
            }
        except Exception as e:
            logger.error(f"Error executing notebook (Solution A subprocess) {input_path}: {e}")
            return {
                "success": False,
                "method": "execute_notebook_solution_a",
                "input_path": str(input_path),
                "output_path": str(output_path) if output_path else None,
                "error": str(e),
                "error_type": type(e).__name__,
                "timestamp": datetime.datetime.now().isoformat()
            }
    
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
    
    async def execute_notebook_subprocess(
        self,
        input_path: Union[str, Path],
        output_path: Optional[Union[str, Path]] = None,
        timeout: Optional[int] = None,
        capture_output: bool = True
    ) -> Dict[str, Any]:
        """
        Nouvelle méthode d'exécution avec architecture subprocess optimisée.
        Implémente la solution définitive avec conda run et gestion d'erreurs robuste.
        
        Args:
            input_path: Path to input notebook
            output_path: Optional path to output notebook
            timeout: Optional timeout in seconds (auto-adapts based on notebook type)
            capture_output: Whether to capture stdout/stderr
            
        Returns:
            Dictionary with execution result and comprehensive diagnostics
        """
        try:
            import datetime
            import os
            import subprocess
            import sys
            import shutil
            
            start_time = datetime.datetime.now()
            
            # Resolve input path against workspace
            resolved_input_path = Path(self.resolve_path(input_path))
            
            if not resolved_input_path.exists():
                raise FileNotFoundError(f"Input notebook not found: {resolved_input_path}")
            
            if output_path is None:
                # CORRECTION BUG INSTABILITÉ : éviter conflits de fichiers avec timestamps
                timestamp = start_time.strftime("%Y%m%d_%H%M%S")
                output_path = resolved_input_path.parent / f"{resolved_input_path.stem}_executed_{timestamp}.ipynb"
            else:
                output_path = Path(self.resolve_path(output_path))
            
            logger.info(f"Executing notebook (subprocess method): {input_path} -> {resolved_input_path}")
            
            # Auto-detect timeout based on notebook type and complexity
            if timeout is None:
                timeout = self._calculate_optimal_timeout(resolved_input_path)
            
            logger.info(f"Configured timeout: {timeout}s")
            
            # Vérifier que conda est disponible
            if not shutil.which("conda"):
                raise EnvironmentError("conda command not found in PATH")
            
            # Working directory setup
            notebook_dir = resolved_input_path.parent.absolute()
            original_cwd = os.getcwd()
            
            try:
                # Change to notebook directory
                os.chdir(notebook_dir)
                
                # Construire la commande conda run avec papermill
                cmd = [
                    "conda", "run", "-n", "mcp-jupyter-py310",
                    "python", "-m", "papermill",
                    str(resolved_input_path.name),  # Utiliser nom relatif dans le répertoire
                    str(output_path.name if output_path.parent == notebook_dir else output_path),
                    "--progress-bar",
                    "--log-output",
                    "--no-request-save-on-cell-execute"
                ]
                
                logger.info(f"Executing command: {' '.join(cmd)}")
                logger.info(f"Working directory: {notebook_dir}")
                
                # Construire l'environnement complet
                env = self._build_complete_environment()
                
                # Diagnostic pré-exécution
                diagnostic_info = {
                    "method": "execute_notebook_subprocess",
                    "command": " ".join(cmd),
                    "cwd": str(notebook_dir),
                    "original_cwd": original_cwd,
                    "timeout_configured": timeout,
                    "env_vars_count": len(env),
                    "conda_env": env.get("CONDA_DEFAULT_ENV", "unknown"),
                    "python_path": env.get("PYTHONPATH", "not_set")
                }
                
                # Execute subprocess with comprehensive environment
                exec_start = datetime.datetime.now()
                
                result = subprocess.run(
                    cmd,
                    capture_output=capture_output,
                    text=True,
                    check=False,
                    timeout=timeout,
                    env=env,
                    cwd=notebook_dir
                )
                
                exec_end = datetime.datetime.now()
                execution_time = (exec_end - exec_start).total_seconds()
                
                # Check if execution was successful
                success = result.returncode == 0 and output_path.exists()
                
                # Comprehensive result dictionary
                result_dict = {
                    "success": success,
                    "method": "execute_notebook_subprocess",
                    "input_path": str(resolved_input_path),
                    "output_path": str(output_path),
                    "execution_time_seconds": execution_time,
                    "timeout_used": timeout,
                    "returncode": result.returncode,
                    "timestamp": exec_end.isoformat(),
                    "diagnostic": diagnostic_info
                }
                
                # Add output analysis
                if output_path.exists():
                    stat = output_path.stat()
                    result_dict["output_file_size"] = stat.st_size
                    result_dict["output_created"] = True
                    
                    # Quick analysis of output notebook
                    try:
                        with open(output_path, 'r', encoding='utf-8') as f:
                            output_content = f.read()
                        result_dict["output_analysis"] = {
                            "content_length": len(output_content),
                            "contains_errors": '"output_type": "error"' in output_content,
                            "execution_count_found": '"execution_count":' in output_content
                        }
                    except Exception as analysis_error:
                        result_dict["output_analysis"] = {"error": str(analysis_error)}
                else:
                    result_dict["output_created"] = False
                    if success:
                        success = False
                        result_dict["success"] = False
                        result_dict["error"] = "Output notebook file not created despite successful returncode"
                
                # Add captured output if requested
                if capture_output:
                    if result.stdout:
                        result_dict["stdout"] = result.stdout
                        result_dict["stdout_length"] = len(result.stdout)
                    if result.stderr:
                        result_dict["stderr"] = result.stderr
                        result_dict["stderr_length"] = len(result.stderr)
                
                # Log results
                if success:
                    logger.info(f"✅ Notebook executed successfully in {execution_time:.2f}s")
                    logger.info(f"📁 Output: {output_path} ({result_dict.get('output_file_size', 0)} bytes)")
                else:
                    logger.error(f"❌ Notebook execution failed (returncode: {result.returncode})")
                    if result.stderr:
                        logger.error(f"Error output: {result.stderr[:500]}...")
                
                return result_dict
                
            finally:
                # Always restore original directory
                os.chdir(original_cwd)
            
        except subprocess.TimeoutExpired as e:
            exec_time = (datetime.datetime.now() - start_time).total_seconds()
            logger.error(f"🕐 Notebook execution timed out after {timeout}s (actual: {exec_time:.2f}s)")
            return {
                "success": False,
                "method": "execute_notebook_subprocess",
                "input_path": str(input_path),
                "output_path": str(output_path) if output_path else None,
                "error": f"Execution timed out after {timeout}s",
                "error_type": "TimeoutExpired",
                "timeout_used": timeout,
                "actual_execution_time": exec_time,
                "timestamp": datetime.datetime.now().isoformat()
            }
        except Exception as e:
            exec_time = (datetime.datetime.now() - start_time).total_seconds()
            logger.error(f"💥 Error executing notebook (subprocess method) {input_path}: {e}")
            return {
                "success": False,
                "method": "execute_notebook_subprocess",
                "input_path": str(input_path),
                "output_path": str(output_path) if output_path else None,
                "error": str(e),
                "error_type": type(e).__name__,
                "actual_execution_time": exec_time,
                "timestamp": datetime.datetime.now().isoformat()
            }
    
    def _calculate_optimal_timeout(self, notebook_path: Path) -> int:
        """
        Calcule le timeout optimal basé sur le type et la complexité du notebook.
        
        Args:
            notebook_path: Path to the notebook
            
        Returns:
            Optimal timeout in seconds
        """
        try:
            notebook_name = notebook_path.name.lower()
            
            # Analyse du contenu pour déterminer la complexité
            with open(notebook_path, 'r', encoding='utf-8') as f:
                content = f.read().lower()
            
            # Timeout de base
            base_timeout = 60  # 1 minute
            
            # Extensions basées sur les patterns détectés
            if 'semantickernel' in notebook_name or 'semantic_kernel' in content:
                # SemanticKernel notebooks (installation packages, API calls)
                if any(pattern in notebook_name for pattern in ['04', 'clr', 'building']):
                    return max(base_timeout, 300)  # 5 minutes pour CLR/building notebooks
                elif any(pattern in notebook_name for pattern in ['05', 'notebookmaker', 'widget']):
                    return max(base_timeout, 240)  # 4 minutes pour widget notebooks
                else:
                    return max(base_timeout, 180)  # 3 minutes pour autres SemanticKernel
            
            # .NET notebooks avec NuGet packages
            if any(pattern in content for pattern in ['.net', 'nuget', 'microsoft.ml', 'dotnet']):
                return max(base_timeout, 150)  # 2.5 minutes pour .NET
            
            # Python notebooks avec ML/AI libraries
            if any(pattern in content for pattern in ['tensorflow', 'pytorch', 'sklearn', 'pandas', 'numpy']):
                return max(base_timeout, 120)  # 2 minutes pour ML
            
            # Notebooks simples
            return base_timeout
            
        except Exception as e:
            logger.warning(f"Failed to calculate optimal timeout for {notebook_path}: {e}")
            return 60  # Default fallback
    
    def _build_complete_environment(self) -> Dict[str, str]:
        """
        Construit un environnement complet avec toutes les variables critiques.
        
        Returns:
            Complete environment dictionary
        """
        env = os.environ.copy()
        
        # Variables critiques pour conda
        conda_vars = {
            "CONDA_DEFAULT_ENV": "mcp-jupyter-py310",
            "CONDA_PREFIX": "C:/Users/jsboi/.conda/envs/mcp-jupyter-py310",
            "CONDA_PROMPT_MODIFIER": "(mcp-jupyter-py310) ",
            "CONDA_PYTHON_EXE": "C:/Users/jsboi/.conda/envs/mcp-jupyter-py310/python.exe",
            "CONDA_SHLVL": "1",
            "CONDA_EXE": "C:/Users/jsboi/.conda/Scripts/conda.exe"
        }
        
        # Variables critiques pour .NET
        dotnet_vars = {
            "DOTNET_ROOT": "C:\\Program Files\\dotnet",
            "DOTNET_HOST_PATH": "C:\\Program Files\\dotnet\\dotnet.exe",
            "NUGET_PACKAGES": "C:\\Users\\jsboi\\.nuget\\packages",
            "MSBuildExtensionsPath": "C:\\Program Files\\dotnet\\sdk\\9.0.305",
            "MSBuildSDKsPath": "C:\\Program Files\\dotnet\\sdk\\9.0.305\\Sdks",
            "MSBuildToolsPath": "C:\\Program Files\\dotnet\\sdk\\9.0.305",
            "MSBuildUserExtensionsPath": "C:\\Users\\jsboi\\AppData\\Local\\Microsoft\\MSBuild",
            "DOTNET_CLI_TELEMETRY_OPTOUT": "1",
            "DOTNET_NOLOGO": "1",
            "DOTNET_SKIP_FIRST_TIME_EXPERIENCE": "1"
        }
        
        # Variables pour Jupyter et Python
        python_vars = {
            "PYTHONPATH": "D:/dev/roo-extensions/mcps/internal/servers/jupyter-papermill-mcp-server",
            "JUPYTER_DATA_DIR": "C:/Users/jsboi/.conda/envs/mcp-jupyter-py310/share/jupyter",
            "JUPYTER_CONFIG_DIR": "C:/Users/jsboi/.conda/envs/mcp-jupyter-py310/etc/jupyter",
            "PYTHONUNBUFFERED": "1",
            "PYTHONDONTWRITEBYTECODE": "1"
        }
        
        # Variables spécifiques Roo
        roo_vars = {
            "ROO_WORKSPACE_DIR": self.workspace_dir
        }
        
        # Construire le PATH complet
        path_components = [
            "C:/Users/jsboi/.conda/envs/mcp-jupyter-py310/Scripts",
            "C:/Users/jsboi/.conda/envs/mcp-jupyter-py310/Library/mingw-w64/bin",
            "C:/Users/jsboi/.conda/envs/mcp-jupyter-py310/Library/usr/bin",
            "C:/Users/jsboi/.conda/envs/mcp-jupyter-py310/Library/bin",
            "C:/Users/jsboi/.conda/envs/mcp-jupyter-py310",
            "C:\\Program Files\\dotnet",
            env.get("PATH", "")
        ]
        
        # Mettre à jour l'environnement
        env.update(conda_vars)
        env.update(dotnet_vars)
        env.update(python_vars)
        env.update(roo_vars)
        env["PATH"] = ";".join(path_components)
        
        return env