"""
Tests for file utilities.
"""

import json
import tempfile
from pathlib import Path

import nbformat
import pytest

from papermill_mcp.utils.file_utils import FileUtils


class TestFileUtils:
    """Test FileUtils functionality."""
    
    def test_ensure_directory(self):
        """Test directory creation."""
        with tempfile.TemporaryDirectory() as temp_dir:
            test_path = Path(temp_dir) / "nested" / "directory"
            
            # Directory shouldn't exist initially
            assert not test_path.exists()
            
            # Create directory
            result = FileUtils.ensure_directory(test_path)
            
            # Should exist now and return Path object
            assert test_path.exists()
            assert test_path.is_dir()
            assert isinstance(result, Path)
            assert result == test_path
    
    def test_create_empty_notebook(self):
        """Test empty notebook creation."""
        # Test with default kernel
        notebook = FileUtils.create_empty_notebook()
        
        assert isinstance(notebook, nbformat.NotebookNode)
        assert notebook.nbformat == 4
        assert len(notebook.cells) == 0
        assert notebook.metadata.kernelspec["name"] == "python3"
        assert notebook.metadata.language_info["name"] == "python"
        
        # Test with custom kernel
        notebook = FileUtils.create_empty_notebook("julia-1.6")
        assert notebook.metadata.kernelspec["name"] == "julia-1.6"
    
    def test_add_cell(self):
        """Test adding cells to notebook."""
        notebook = FileUtils.create_empty_notebook()
        
        # Add code cell
        notebook = FileUtils.add_cell(notebook, "code", "print('hello')")
        assert len(notebook.cells) == 1
        assert notebook.cells[0].cell_type == "code"
        assert notebook.cells[0].source == "print('hello')"
        
        # Add markdown cell
        notebook = FileUtils.add_cell(notebook, "markdown", "# Title")
        assert len(notebook.cells) == 2
        assert notebook.cells[1].cell_type == "markdown"
        assert notebook.cells[1].source == "# Title"
        
        # Add cell at specific index
        notebook = FileUtils.add_cell(notebook, "raw", "raw content", index=1)
        assert len(notebook.cells) == 3
        assert notebook.cells[1].cell_type == "raw"
        assert notebook.cells[1].source == "raw content"
    
    def test_remove_cell(self):
        """Test removing cells from notebook."""
        notebook = FileUtils.create_empty_notebook()
        
        # Add some cells
        notebook = FileUtils.add_cell(notebook, "code", "cell 1")
        notebook = FileUtils.add_cell(notebook, "code", "cell 2") 
        notebook = FileUtils.add_cell(notebook, "code", "cell 3")
        
        assert len(notebook.cells) == 3
        
        # Remove middle cell
        notebook = FileUtils.remove_cell(notebook, 1)
        assert len(notebook.cells) == 2
        assert notebook.cells[0].source == "cell 1"
        assert notebook.cells[1].source == "cell 3"
        
        # Test error for invalid index
        with pytest.raises(IndexError):
            FileUtils.remove_cell(notebook, 10)
    
    def test_update_cell(self):
        """Test updating cells in notebook."""
        notebook = FileUtils.create_empty_notebook()
        notebook = FileUtils.add_cell(notebook, "code", "original content")
        
        # Update cell content
        notebook = FileUtils.update_cell(notebook, 0, "updated content")
        assert notebook.cells[0].source == "updated content"
        
        # Update with metadata
        metadata = {"tags": ["test"]}
        notebook = FileUtils.update_cell(notebook, 0, "final content", metadata)
        assert notebook.cells[0].source == "final content"
        assert notebook.cells[0].metadata["tags"] == ["test"]
        
        # Test error for invalid index
        with pytest.raises(IndexError):
            FileUtils.update_cell(notebook, 10, "content")
    
    def test_read_write_notebook(self):
        """Test reading and writing notebooks."""
        with tempfile.TemporaryDirectory() as temp_dir:
            notebook_path = Path(temp_dir) / "test.ipynb"
            
            # Create a notebook
            notebook = FileUtils.create_empty_notebook()
            notebook = FileUtils.add_cell(notebook, "code", "print('test')")
            
            # Write notebook
            written_path = FileUtils.write_notebook(notebook, notebook_path)
            assert written_path == notebook_path
            assert notebook_path.exists()
            
            # Read notebook back
            read_notebook = FileUtils.read_notebook(notebook_path)
            
            assert isinstance(read_notebook, nbformat.NotebookNode)
            assert len(read_notebook.cells) == 1
            assert read_notebook.cells[0].cell_type == "code"
            assert read_notebook.cells[0].source == "print('test')"
    
    def test_read_nonexistent_notebook(self):
        """Test reading non-existent notebook."""
        with pytest.raises(FileNotFoundError):
            FileUtils.read_notebook("/nonexistent/path.ipynb")
    
    def test_safe_filename(self):
        """Test safe filename generation."""
        test_cases = [
            ("normal_file.txt", "normal_file.txt"),
            ("file with spaces.txt", "file_with_spaces.txt"),
            ("file/with\\slashes.txt", "file_with_slashes.txt"),
            ("file:with*special<chars>.txt", "filewithspecialchars.txt"),
            ("file-with_normal(chars)[ok].txt", "file-with_normal(chars)[ok].txt"),
        ]
        
        for input_name, expected in test_cases:
            result = FileUtils.safe_filename(input_name)
            assert result == expected
    
    def test_is_notebook_file(self):
        """Test notebook file detection."""
        with tempfile.TemporaryDirectory() as temp_dir:
            # Create a valid notebook
            notebook_path = Path(temp_dir) / "valid.ipynb"
            notebook = FileUtils.create_empty_notebook()
            FileUtils.write_notebook(notebook, notebook_path)
            
            # Create an invalid file
            invalid_path = Path(temp_dir) / "invalid.ipynb"
            invalid_path.write_text("not a valid notebook")
            
            # Create a non-notebook file
            text_path = Path(temp_dir) / "text.txt"
            text_path.write_text("just text")
            
            # Test detection
            assert FileUtils.is_notebook_file(notebook_path) is True
            assert FileUtils.is_notebook_file(invalid_path) is False
            assert FileUtils.is_notebook_file(text_path) is False
            assert FileUtils.is_notebook_file("/nonexistent.ipynb") is False
    
    def test_get_notebook_metadata(self):
        """Test extracting notebook metadata."""
        with tempfile.TemporaryDirectory() as temp_dir:
            notebook_path = Path(temp_dir) / "test.ipynb"
            
            # Create notebook with various cell types
            notebook = FileUtils.create_empty_notebook("python3")
            notebook = FileUtils.add_cell(notebook, "code", "print('hello')")
            notebook = FileUtils.add_cell(notebook, "markdown", "# Title")
            notebook = FileUtils.add_cell(notebook, "code", "x = 1")
            notebook = FileUtils.add_cell(notebook, "raw", "raw content")
            
            FileUtils.write_notebook(notebook, notebook_path)
            
            # Get metadata
            metadata = FileUtils.get_notebook_metadata(notebook_path)
            
            assert "kernelspec" in metadata
            assert metadata["kernelspec"]["name"] == "python3"
            assert "language_info" in metadata
            assert metadata["language_info"]["name"] == "python"
            assert metadata["cell_count"] == 4
            assert metadata["cells_by_type"]["code"] == 2
            assert metadata["cells_by_type"]["markdown"] == 1
            assert metadata["cells_by_type"]["raw"] == 1
    
    def test_list_notebooks_empty_directory(self):
        """Test listing notebooks in empty directory."""
        with tempfile.TemporaryDirectory() as temp_dir:
            notebooks = FileUtils.list_notebooks(temp_dir)
            assert notebooks == []
    
    def test_list_notebooks_with_files(self):
        """Test listing notebooks with files."""
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            
            # Create some notebooks
            nb1_path = temp_path / "notebook1.ipynb"
            nb2_path = temp_path / "notebook2.ipynb"
            
            notebook = FileUtils.create_empty_notebook()
            FileUtils.write_notebook(notebook, nb1_path)
            FileUtils.write_notebook(notebook, nb2_path)
            
            # Create a non-notebook file
            (temp_path / "text.txt").write_text("not a notebook")
            
            # List notebooks
            notebooks = FileUtils.list_notebooks(temp_dir)
            
            assert len(notebooks) == 2
            notebook_names = [nb["name"] for nb in notebooks]
            assert "notebook1.ipynb" in notebook_names
            assert "notebook2.ipynb" in notebook_names
            
            # Check metadata
            for nb in notebooks:
                assert "path" in nb
                assert "size" in nb
                assert "modified" in nb
                assert "kernel" in nb
                assert "cell_count" in nb


if __name__ == "__main__":
    pytest.main([__file__])