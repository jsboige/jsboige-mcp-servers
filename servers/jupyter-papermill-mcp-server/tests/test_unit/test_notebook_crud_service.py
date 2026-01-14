import pytest
import os
from pathlib import Path
from unittest.mock import Mock, patch
from nbformat import NotebookNode
from papermill_mcp.services.notebook_crud_service import NotebookCRUDService

@pytest.fixture
def crud_service(temp_dir):
    """Fixture pour le service CRUD de notebooks"""
    # S'assurer que le répertoire temporaire existe
    temp_dir.mkdir(parents=True, exist_ok=True)
    return NotebookCRUDService(workspace_dir=str(temp_dir))

class TestNotebookCRUDService:

    def test_resolve_path_absolute(self, crud_service, temp_dir):
        abs_path = str(temp_dir / "test.ipynb")
        resolved = crud_service.resolve_path(abs_path)
        assert resolved == abs_path

    def test_resolve_path_relative(self, crud_service, temp_dir):
        rel_path = "test.ipynb"
        resolved = crud_service.resolve_path(rel_path)
        assert resolved == str(temp_dir / rel_path)

    @pytest.mark.asyncio
    async def test_create_notebook(self, crud_service, temp_dir):
        notebook_path = "new_notebook.ipynb"
        result = await crud_service.create_notebook(notebook_path, kernel="python3")

        assert result["success"] is True
        assert result["kernel"] == "python3"
        assert result["cell_count"] == 0
        assert (temp_dir / notebook_path).exists()

    @pytest.mark.asyncio
    async def test_read_notebook(self, crud_service, temp_dir):
        # Create a notebook first
        notebook_path = "read_test.ipynb"
        await crud_service.create_notebook(notebook_path)

        result = await crud_service.read_notebook(notebook_path)

        assert result["nbformat"] == 4
        assert len(result["cells"]) == 0
        assert "file_info" in result
        assert result["file_info"]["path"] == str(temp_dir / notebook_path)

    @pytest.mark.asyncio
    async def test_add_cell(self, crud_service):
        notebook_path = "cell_test.ipynb"
        await crud_service.create_notebook(notebook_path)

        # Add code cell
        result = await crud_service.add_cell(
            notebook_path,
            cell_type="code",
            source="print('hello')",
            metadata={"tag": "test"}
        )

        assert result["success"] is True
        assert result["cell_count"] == 1
        assert result["cell_type"] == "code"

        # Verify content
        notebook = await crud_service.read_notebook(notebook_path)
        cell = notebook["cells"][0]
        assert cell["cell_type"] == "code"
        assert cell["source"] == "print('hello')"
        assert cell["metadata"] == {"tag": "test"}

    @pytest.mark.asyncio
    async def test_update_cell(self, crud_service):
        notebook_path = "update_test.ipynb"
        await crud_service.create_notebook(notebook_path)
        await crud_service.add_cell(notebook_path, "code", "original")

        result = await crud_service.update_cell(
            notebook_path,
            index=0,
            source="updated",
            metadata={"new": "meta"}
        )

        assert result["success"] is True

        # Verify update
        notebook = await crud_service.read_notebook(notebook_path)
        cell = notebook["cells"][0]
        assert cell["source"] == "updated"
        assert cell["metadata"] == {"new": "meta"}

    @pytest.mark.asyncio
    async def test_remove_cell(self, crud_service):
        notebook_path = "remove_test.ipynb"
        await crud_service.create_notebook(notebook_path)
        await crud_service.add_cell(notebook_path, "code", "cell1")
        await crud_service.add_cell(notebook_path, "code", "cell2")

        result = await crud_service.remove_cell(notebook_path, index=0)

        assert result["success"] is True
        assert result["cell_count"] == 1

        notebook = await crud_service.read_notebook(notebook_path)
        assert notebook["cells"][0]["source"] == "cell2"

    @pytest.mark.asyncio
    async def test_list_notebooks(self, crud_service, temp_dir):
        # Create nested structure
        (temp_dir / "dir1").mkdir()
        await crud_service.create_notebook("root.ipynb")
        await crud_service.create_notebook("dir1/nested.ipynb")

        # Test non-recursive
        notebooks = await crud_service.list_notebooks(".", recursive=False)
        assert len(notebooks) == 1
        assert notebooks[0]["name"] == "root.ipynb"

        # Test recursive
        notebooks_rec = await crud_service.list_notebooks(".", recursive=True)
        assert len(notebooks_rec) == 2
        names = [n["name"] for n in notebooks_rec]
        assert "root.ipynb" in names
        assert "nested.ipynb" in names

    @pytest.mark.asyncio
    async def test_read_cells_single(self, crud_service):
        notebook_path = "read_cells.ipynb"
        await crud_service.create_notebook(notebook_path)
        await crud_service.add_cell(notebook_path, "code", "cell0")

        result = await crud_service.read_cells(notebook_path, mode="single", index=0)

        assert result["success"] is True
        assert result["mode"] == "single"
        assert result["cell"]["source"] == "cell0"

    @pytest.mark.asyncio
    async def test_read_cells_range(self, crud_service):
        notebook_path = "range_test.ipynb"
        await crud_service.create_notebook(notebook_path)
        for i in range(5):
            await crud_service.add_cell(notebook_path, "code", f"cell{i}")

        result = await crud_service.read_cells(notebook_path, mode="range", start_index=1, end_index=3)

        assert result["success"] is True
        assert len(result["cells"]) == 3
        assert result["cells"][0]["source"] == "cell1"
        assert result["cells"][-1]["source"] == "cell3"

    @pytest.mark.asyncio
    async def test_read_cells_list(self, crud_service):
        notebook_path = "list_test.ipynb"
        await crud_service.create_notebook(notebook_path)
        await crud_service.add_cell(notebook_path, "code", "long content " * 20)

        result = await crud_service.read_cells(notebook_path, mode="list", preview_length=10)

        assert result["success"] is True
        assert len(result["cells"]) == 1
        assert "preview" in result["cells"][0]
        assert len(result["cells"][0]["preview"]) <= 13 # 10 + "..."

    @pytest.mark.asyncio
    async def test_read_cells_all(self, crud_service):
        notebook_path = "all_test.ipynb"
        await crud_service.create_notebook(notebook_path)
        await crud_service.add_cell(notebook_path, "code", "content")

        result = await crud_service.read_cells(notebook_path, mode="all")

        assert result["success"] is True
        assert len(result["cells"]) == 1
        assert result["cells"][0]["source"] == "content"

    @pytest.mark.asyncio
    async def test_error_handling(self, crud_service):
        # Invalid file
        with pytest.raises(FileNotFoundError):
            await crud_service.read_notebook("nonexistent.ipynb")

        # Invalid index
        await crud_service.create_notebook("index_error.ipynb")
        with pytest.raises(IndexError):
            await crud_service.read_cells("index_error.ipynb", mode="single", index=99)

        # Invalid mode
        with pytest.raises(ValueError):
            await crud_service.read_cells("index_error.ipynb", mode="invalid")