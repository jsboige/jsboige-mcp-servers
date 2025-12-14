"""
Notebook Validation Service.

Handles inspection and validation of notebook structure and outputs.
Extracted from notebook_service.py for better modularity.
"""

import logging
import json
import time
import os
from pathlib import Path
from typing import Dict, List, Optional, Any, Union

from ..utils.file_utils import FileUtils

logger = logging.getLogger(__name__)


class NotebookValidationService:
    """
    Service for notebook inspection and validation.
    
    Provides capabilities to:
    - Extract metadata
    - Analyze outputs
    - Validate format compliance
    - Inspect structure
    """
    
    def __init__(self, workspace_dir: str):
        """
        Initialize the validation service.
        
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
            return path_str
        
        # If relative, resolve against workspace directory
        workspace_path = os.path.join(self.workspace_dir, path_str)
        absolute_path = os.path.abspath(workspace_path)
        
        return absolute_path
    
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
        try:
            # Validate mode
            valid_modes = ["metadata", "outputs", "validate", "full"]
            if mode not in valid_modes:
                raise ValueError(f"Invalid mode: {mode}. Must be one of {valid_modes}")
            
            # Resolve path
            resolved_path = Path(self.resolve_path(path))
            logger.info(f"Inspecting notebook: {path} -> {resolved_path} (mode={mode})")
            
            if not resolved_path.exists():
                raise FileNotFoundError(f"Notebook not found: {resolved_path}")
            
            # Read notebook once
            try:
                notebook = FileUtils.read_notebook(resolved_path)
            except ValueError as e:
                # If read fails, we can only proceed if mode is "validate" or "full"
                # and we want to return the error as a validation failure
                if mode in ["validate", "full"]:
                    logger.warning(f"Failed to read notebook with nbformat: {e}")
                    notebook = None
                else:
                    # For other modes, we need a valid notebook object
                    raise
            
            # Initialize result
            result = {
                "path": str(path),
                "mode": mode,
                "success": True
            }
            
            # Handle read failure early for metadata/outputs modes
            if notebook is None and mode not in ["validate", "full"]:
                result["success"] = False
                result["error"] = "Failed to read notebook structure"
                return result
            
            # Mode METADATA
            if mode in ["metadata", "full"] and notebook:
                metadata_info = {
                    "kernelspec": dict(notebook.metadata.get('kernelspec', {})),
                    "language_info": dict(notebook.metadata.get('language_info', {})),
                }
                
                # Add optional metadata fields
                if 'authors' in notebook.metadata:
                    metadata_info['authors'] = notebook.metadata.get('authors')
                if 'title' in notebook.metadata:
                    metadata_info['title'] = notebook.metadata.get('title')
                
                # Add custom metadata (excluding standard fields)
                standard_fields = {'kernelspec', 'language_info', 'authors', 'title'}
                custom_metadata = {
                    k: v for k, v in notebook.metadata.items()
                    if k not in standard_fields
                }
                if custom_metadata:
                    metadata_info['custom_metadata'] = custom_metadata
                
                result["metadata"] = metadata_info
                result["nbformat"] = notebook.nbformat
                result["nbformat_minor"] = notebook.nbformat_minor
                result["cell_count"] = len(notebook.cells)
            
            # Mode OUTPUTS
            if mode in ["outputs", "full"] and notebook:
                total_cells = len(notebook.cells)
                code_cells = sum(1 for cell in notebook.cells if cell.cell_type == "code")
                cells_with_outputs = 0
                cells_with_errors = 0
                output_types_count = {}
                cells_analysis = []
                
                for i, cell in enumerate(notebook.cells):
                    if cell.cell_type == "code":
                        outputs = getattr(cell, 'outputs', [])
                        
                        if outputs:
                            cells_with_outputs += 1
                            
                            # Analyze cell outputs
                            cell_output_types = []
                            has_error = False
                            error_name = None
                            output_size = 0
                            
                            for output in outputs:
                                output_type = output.get("output_type", "unknown")
                                cell_output_types.append(output_type)
                                
                                # Count by type
                                output_types_count[output_type] = output_types_count.get(output_type, 0) + 1
                                
                                # Check for errors
                                if output_type == "error":
                                    has_error = True
                                    error_name = output.get("ename", "Unknown")
                                    cells_with_errors += 1
                                
                                # Calculate size
                                output_size += len(str(output))
                            
                            cell_info = {
                                "index": i,
                                "execution_count": getattr(cell, 'execution_count', None),
                                "output_count": len(outputs),
                                "output_types": cell_output_types,
                                "has_error": has_error,
                                "output_size_bytes": output_size
                            }
                            
                            if has_error:
                                cell_info["error_name"] = error_name
                            
                            cells_analysis.append(cell_info)
                
                result["output_analysis"] = {
                    "total_cells": total_cells,
                    "code_cells": code_cells,
                    "cells_with_outputs": cells_with_outputs,
                    "cells_with_errors": cells_with_errors,
                    "output_types": output_types_count,
                    "cells": cells_analysis
                }
            
            # Mode VALIDATE
            if mode in ["validate", "full"]:
                start_time = time.time()
                
                errors = []
                warnings = []
                notebook_data = {}
                
                # If notebook read failed earlier, add it as a critical error
                if notebook is None:
                    errors.append({
                        "type": "format_error",
                        "message": "Invalid notebook format (nbformat read failed)",
                        "cell_index": None
                    })
                
                try:
                    # Read raw JSON for validation
                    with open(resolved_path, 'r', encoding='utf-8') as f:
                        notebook_data = json.load(f)
                except json.JSONDecodeError as e:
                    errors.append({
                        "type": "json_error",
                        "message": f"Invalid JSON: {str(e)}",
                        "cell_index": None
                    })
                    notebook_data = {} # Ensure it's empty to skip further checks safely
                
                
                warnings = []
                
                # Validate nbformat version
                if "nbformat" not in notebook_data:
                    errors.append({
                        "type": "missing_field",
                        "message": "Missing 'nbformat' field",
                        "cell_index": None
                    })
                elif notebook_data.get("nbformat") < 4:
                    warnings.append({
                        "type": "old_version",
                        "message": f"Old nbformat version: {notebook_data.get('nbformat')} (recommended: 4+)",
                        "cell_index": None
                    })
                
                # Validate cells field
                if "cells" not in notebook_data:
                    errors.append({
                        "type": "missing_field",
                        "message": "Missing 'cells' field",
                        "cell_index": None
                    })
                elif not isinstance(notebook_data["cells"], list):
                    errors.append({
                        "type": "invalid_type",
                        "message": "'cells' field is not a list",
                        "cell_index": None
                    })
                
                # Validate each cell
                for i, cell in enumerate(notebook_data.get("cells", [])):
                    if "cell_type" not in cell:
                        errors.append({
                            "type": "missing_field",
                            "message": "Missing cell_type",
                            "cell_index": i
                        })
                    elif cell["cell_type"] not in ["code", "markdown", "raw"]:
                        errors.append({
                            "type": "invalid_value",
                            "message": f"Invalid cell_type: {cell['cell_type']}",
                            "cell_index": i
                        })
                    
                    if "source" not in cell:
                        errors.append({
                            "type": "missing_field",
                            "message": "Missing source",
                            "cell_index": i
                        })
                    
                    if cell.get("cell_type") == "code":
                        if "outputs" not in cell:
                            warnings.append({
                                "type": "missing_field",
                                "message": "Missing outputs in code cell",
                                "cell_index": i
                            })
                        if "execution_count" not in cell:
                            warnings.append({
                                "type": "missing_field",
                                "message": "Missing execution_count in code cell",
                                "cell_index": i
                            })
                
                validation_time = time.time() - start_time
                
                result["validation"] = {
                    "is_valid": len(errors) == 0,
                    "error_count": len(errors),
                    "warning_count": len(warnings),
                    "errors": errors,
                    "warnings": warnings,
                    "validation_time_seconds": validation_time
                }
            
            logger.info(f"Successfully inspected notebook {path} (mode={mode})")
            return result
            
        except Exception as e:
            logger.error(f"Error inspecting notebook {path}: {e}")
            raise