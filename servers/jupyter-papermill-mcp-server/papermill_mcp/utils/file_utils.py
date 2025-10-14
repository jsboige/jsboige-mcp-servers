"""
File utility functions for notebook operations.

Provides helper functions for notebook file manipulation.
"""

import json
import os
from pathlib import Path
from typing import Dict, List, Optional, Any, Union

import nbformat
from nbformat import NotebookNode
from nbformat.v4 import new_notebook, new_code_cell, new_markdown_cell, new_raw_cell


class FileUtils:
    """Utility class for file operations."""
    
    @staticmethod
    def ensure_directory(path: Union[str, Path]) -> Path:
        """
        Ensure directory exists, create if necessary.
        
        Args:
            path: Directory path
            
        Returns:
            Path object for the directory
        """
        dir_path = Path(path)
        dir_path.mkdir(parents=True, exist_ok=True)
        return dir_path
    
    @staticmethod
    def read_notebook(path: Union[str, Path]) -> NotebookNode:
        """
        Read a Jupyter notebook from file.
        
        Args:
            path: Path to notebook file
            
        Returns:
            Notebook object
            
        Raises:
            FileNotFoundError: If file doesn't exist
            ValueError: If file is not valid JSON or notebook format
        """
        path = Path(path)
        if not path.exists():
            raise FileNotFoundError(f"Notebook file not found: {path}")
        
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return nbformat.read(f, as_version=4)
        except (json.JSONDecodeError, nbformat.ValidationError) as e:
            raise ValueError(f"Invalid notebook format in {path}: {e}")
    
    @staticmethod
    def write_notebook(notebook: NotebookNode, path: Union[str, Path]) -> Path:
        """
        Write a Jupyter notebook to file.
        
        Args:
            notebook: Notebook object to write
            path: Path where to save the notebook
            
        Returns:
            Path object for the written file
        """
        path = Path(path)
        
        # Ensure parent directory exists
        FileUtils.ensure_directory(path.parent)
        
        # Validate notebook before writing
        nbformat.validate(notebook)
        
        with open(path, 'w', encoding='utf-8') as f:
            nbformat.write(notebook, f)
        
        return path
    
    @staticmethod
    def create_empty_notebook(kernel_name: str = "python3") -> NotebookNode:
        """
        Create a new empty notebook.
        
        Args:
            kernel_name: Name of the kernel to use
            
        Returns:
            Empty notebook object
        """
        notebook = new_notebook()
        
        # Set kernel metadata
        notebook.metadata.kernelspec = {
            "display_name": kernel_name.title(),
            "language": "python" if "python" in kernel_name.lower() else kernel_name,
            "name": kernel_name
        }
        
        # Set language info for Python kernels
        if "python" in kernel_name.lower():
            notebook.metadata.language_info = {
                "name": "python",
                "version": "3.8.0",
                "mimetype": "text/x-python",
                "codemirror_mode": {"name": "ipython", "version": 3},
                "pygments_lexer": "ipython3",
                "nbconvert_exporter": "python",
                "file_extension": ".py"
            }
        
        return notebook
    
    @staticmethod
    def add_cell(notebook: NotebookNode, cell_type: str, source: str, 
                 metadata: Optional[Dict[str, Any]] = None, index: Optional[int] = None) -> NotebookNode:
        """
        Add a cell to a notebook.
        
        Args:
            notebook: Notebook to modify
            cell_type: Type of cell ('code', 'markdown', 'raw')
            source: Cell content
            metadata: Optional cell metadata
            index: Optional position to insert cell (appends if None)
            
        Returns:
            Modified notebook object
        """
        if cell_type == 'code':
            cell = new_code_cell(source=source, metadata=metadata or {})
        elif cell_type == 'markdown':
            cell = new_markdown_cell(source=source, metadata=metadata or {})
        elif cell_type == 'raw':
            cell = new_raw_cell(source=source, metadata=metadata or {})
        else:
            raise ValueError(f"Invalid cell type: {cell_type}")
        
        if index is None:
            notebook.cells.append(cell)
        else:
            notebook.cells.insert(index, cell)
        
        return notebook
    
    @staticmethod
    def remove_cell(notebook: NotebookNode, index: int) -> NotebookNode:
        """
        Remove a cell from a notebook.
        
        Args:
            notebook: Notebook to modify
            index: Index of cell to remove
            
        Returns:
            Modified notebook object
            
        Raises:
            IndexError: If index is out of range
        """
        if index < 0 or index >= len(notebook.cells):
            raise IndexError(f"Cell index {index} out of range (0-{len(notebook.cells)-1})")
        
        del notebook.cells[index]
        return notebook
    
    @staticmethod
    def update_cell(notebook: NotebookNode, index: int, source: str, 
                    metadata: Optional[Dict[str, Any]] = None) -> NotebookNode:
        """
        Update a cell in a notebook.
        
        Args:
            notebook: Notebook to modify
            index: Index of cell to update
            source: New cell content
            metadata: Optional new metadata
            
        Returns:
            Modified notebook object
            
        Raises:
            IndexError: If index is out of range
        """
        if index < 0 or index >= len(notebook.cells):
            raise IndexError(f"Cell index {index} out of range (0-{len(notebook.cells)-1})")
        
        cell = notebook.cells[index]
        cell.source = source
        
        if metadata is not None:
            cell.metadata.update(metadata)
        
        return notebook
    
    @staticmethod
    def list_notebooks(directory: Union[str, Path], recursive: bool = False) -> List[Dict[str, Any]]:
        """
        List notebook files in a directory.
        
        Args:
            directory: Directory to search
            recursive: Whether to search recursively
            
        Returns:
            List of notebook information dictionaries
        """
        directory = Path(directory)
        
        if not directory.exists():
            return []
        
        notebooks = []
        pattern = "**/*.ipynb" if recursive else "*.ipynb"
        
        for notebook_path in directory.glob(pattern):
            try:
                stat = notebook_path.stat()
                
                # Try to read notebook metadata
                notebook_info = {
                    'name': notebook_path.name,
                    'path': str(notebook_path),
                    'size': stat.st_size,
                    'modified': stat.st_mtime,
                    'kernel': 'unknown',
                    'cell_count': 0,
                    'language': 'unknown'
                }
                
                # Try to extract metadata from notebook
                try:
                    nb = FileUtils.read_notebook(notebook_path)
                    notebook_info['cell_count'] = len(nb.cells)
                    
                    # Extract kernel info
                    if hasattr(nb.metadata, 'kernelspec') and nb.metadata.kernelspec:
                        notebook_info['kernel'] = nb.metadata.kernelspec.get('name', 'unknown')
                    
                    # Extract language info
                    if hasattr(nb.metadata, 'language_info') and nb.metadata.language_info:
                        notebook_info['language'] = nb.metadata.language_info.get('name', 'unknown')
                
                except Exception:
                    # If we can't read the notebook, still include basic info
                    pass
                
                notebooks.append(notebook_info)
                
            except Exception:
                # Skip files that can't be processed
                continue
        
        return sorted(notebooks, key=lambda x: x['name'])
    
    @staticmethod
    def get_notebook_metadata(path: Union[str, Path]) -> Dict[str, Any]:
        """
        Get metadata from a notebook file.
        
        Args:
            path: Path to notebook file
            
        Returns:
            Dictionary with notebook metadata
        """
        try:
            nb = FileUtils.read_notebook(path)
            
            metadata = {
                'kernelspec': dict(nb.metadata.get('kernelspec', {})),
                'language_info': dict(nb.metadata.get('language_info', {})),
                'cell_count': len(nb.cells),
                'cells_by_type': {}
            }
            
            # Count cells by type
            for cell in nb.cells:
                cell_type = cell.cell_type
                metadata['cells_by_type'][cell_type] = metadata['cells_by_type'].get(cell_type, 0) + 1
            
            return metadata
            
        except Exception as e:
            return {'error': str(e)}
    
    @staticmethod
    def safe_filename(filename: str) -> str:
        """
        Create a safe filename by removing/replacing problematic characters.
        
        Args:
            filename: Original filename
            
        Returns:
            Safe filename
        """
        # Remove or replace problematic characters
        safe_chars = []
        for char in filename:
            if char.isalnum() or char in '.-_()[]':
                safe_chars.append(char)
            elif char in ' /\\':
                safe_chars.append('_')
        
        return ''.join(safe_chars)
    
    @staticmethod
    def is_notebook_file(path: Union[str, Path]) -> bool:
        """
        Check if a file is a valid Jupyter notebook.
        
        Args:
            path: Path to check
            
        Returns:
            True if file is a valid notebook
        """
        path = Path(path)
        
        if not path.exists() or not path.is_file():
            return False
        
        if not path.name.endswith('.ipynb'):
            return False
        
        try:
            FileUtils.read_notebook(path)
            return True
        except Exception:
            return False