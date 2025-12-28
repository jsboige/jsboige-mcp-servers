"""
Notebook Metadata Service.

Handles metadata extraction and notebook listing.
Extracted from notebook_service.py for better modularity.
"""

import logging
from pathlib import Path
from typing import Dict, List, Any, Union

from ..utils.file_utils import FileUtils
from .notebook_validation_service import NotebookValidationService

logger = logging.getLogger(__name__)


class NotebookMetadataService:
    """
    Service for notebook metadata operations.
    
    Provides capabilities to:
    - List notebooks in directory
    - Get notebook metadata (legacy wrapper)
    """
    
    def __init__(self, validation_service: NotebookValidationService):
        """
        Initialize the metadata service.
        
        Args:
            validation_service: Validation service for inspecting notebooks
        """
        self.validation_service = validation_service
    
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
            # Resolve against workspace if needed (handled by caller usually, but FileUtils needs absolute or relative to cwd)
            # Here we assume directory is already resolved or relative to CWD
            
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
        
        DEPRECATED: Use inspect_notebook(path, mode="metadata") instead.
        
        Args:
            path: Path to notebook file
            
        Returns:
            Dictionary with notebook metadata
        """
        logger.warning("get_notebook_metadata is deprecated, use inspect_notebook(mode='metadata') instead")
        result = await self.validation_service.inspect_notebook(path, mode="metadata")
        
        # Transform to old format for backward compatibility
        old_format = {
            'path': result['path'],
            'metadata': result['metadata'],
            'nbformat': result['nbformat'],
            'nbformat_minor': result['nbformat_minor'],
            'cell_count': result['cell_count'],
            'success': result['success']
        }
        
        return old_format