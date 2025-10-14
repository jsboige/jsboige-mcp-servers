"""
Tests unitaires pour l'outil consolidé read_cells.
Phase 1A de la consolidation MCP Jupyter-Papermill (SDDD).
"""

import pytest
import tempfile
from pathlib import Path
import asyncio

from papermill_mcp.services.notebook_service import NotebookService
from papermill_mcp.config import MCPConfig
from papermill_mcp.utils.file_utils import FileUtils


@pytest.fixture
def config():
    """Fixture pour la configuration MCP."""
    return MCPConfig()


@pytest.fixture
def service(config):
    """Fixture pour le service notebook."""
    return NotebookService(config)


@pytest.fixture
def temp_notebook():
    """Fixture pour créer un notebook temporaire avec plusieurs cellules."""
    with tempfile.TemporaryDirectory() as temp_dir:
        notebook_path = Path(temp_dir) / "test_notebook.ipynb"
        
        # Créer un notebook avec plusieurs cellules
        notebook = FileUtils.create_empty_notebook("python3")
        notebook = FileUtils.add_cell(notebook, "markdown", "# Test Notebook")
        notebook = FileUtils.add_cell(notebook, "code", "print('Cell 1')")
        notebook = FileUtils.add_cell(notebook, "code", "x = 42")
        notebook = FileUtils.add_cell(notebook, "markdown", "## Section 2")
        notebook = FileUtils.add_cell(notebook, "code", "print('Cell 4')")
        
        FileUtils.write_notebook(notebook, notebook_path)
        
        yield notebook_path


class TestReadCellsConsolidated:
    """Tests pour l'outil consolidé read_cells."""
    
    @pytest.mark.asyncio
    async def test_read_cells_mode_single(self, service, temp_notebook):
        """Test mode='single' - Lecture d'une seule cellule."""
        result = await service.read_cells(temp_notebook, mode="single", index=1)
        
        assert result["success"] is True
        assert result["mode"] == "single"
        assert result["index"] == 1
        assert "cell" in result
        assert result["cell"]["cell_type"] == "code"
        assert result["cell"]["source"] == "print('Cell 1')"
    
    @pytest.mark.asyncio
    async def test_read_cells_mode_single_invalid_index(self, service, temp_notebook):
        """Test mode='single' avec index invalide."""
        with pytest.raises(IndexError):
            await service.read_cells(temp_notebook, mode="single", index=100)
    
    @pytest.mark.asyncio
    async def test_read_cells_mode_single_missing_index(self, service, temp_notebook):
        """Test mode='single' sans index (doit échouer)."""
        with pytest.raises(ValueError, match="mode='single' requires 'index' parameter"):
            await service.read_cells(temp_notebook, mode="single")
    
    @pytest.mark.asyncio
    async def test_read_cells_mode_range(self, service, temp_notebook):
        """Test mode='range' - Lecture d'une plage de cellules."""
        result = await service.read_cells(temp_notebook, mode="range", start_index=1, end_index=3)
        
        assert result["success"] is True
        assert result["mode"] == "range"
        assert result["start_index"] == 1
        assert result["end_index"] == 3
        assert result["cell_count"] == 3
        assert len(result["cells"]) == 3
        
        # Vérifier que les cellules sont dans le bon ordre
        assert result["cells"][0]["index"] == 1
        assert result["cells"][1]["index"] == 2
        assert result["cells"][2]["index"] == 3
    
    @pytest.mark.asyncio
    async def test_read_cells_mode_range_no_end(self, service, temp_notebook):
        """Test mode='range' sans end_index (jusqu'à la fin)."""
        result = await service.read_cells(temp_notebook, mode="range", start_index=3)
        
        assert result["success"] is True
        assert result["start_index"] == 3
        assert result["cell_count"] == 2  # Cellules 3 et 4
    
    @pytest.mark.asyncio
    async def test_read_cells_mode_range_missing_start(self, service, temp_notebook):
        """Test mode='range' sans start_index (doit échouer)."""
        with pytest.raises(ValueError, match="mode='range' requires 'start_index' parameter"):
            await service.read_cells(temp_notebook, mode="range")
    
    @pytest.mark.asyncio
    async def test_read_cells_mode_range_invalid_indices(self, service, temp_notebook):
        """Test mode='range' avec indices invalides."""
        # start > end
        with pytest.raises(ValueError):
            await service.read_cells(temp_notebook, mode="range", start_index=3, end_index=1)
        
        # start hors limites
        with pytest.raises(IndexError):
            await service.read_cells(temp_notebook, mode="range", start_index=100)
    
    @pytest.mark.asyncio
    async def test_read_cells_mode_list(self, service, temp_notebook):
        """Test mode='list' - Liste avec preview (mode par défaut)."""
        result = await service.read_cells(temp_notebook, mode="list")
        
        assert result["success"] is True
        assert result["mode"] == "list"
        assert result["cell_count"] == 5
        assert len(result["cells"]) == 5
        
        # Vérifier que les previews sont présents
        for cell in result["cells"]:
            assert "index" in cell
            assert "cell_type" in cell
            assert "preview" in cell
            assert "full_length" in cell
    
    @pytest.mark.asyncio
    async def test_read_cells_mode_list_no_preview(self, service, temp_notebook):
        """Test mode='list' sans preview."""
        result = await service.read_cells(temp_notebook, mode="list", include_preview=False)
        
        assert result["success"] is True
        assert result["mode"] == "list"
        
        # Vérifier que les previews sont absents
        for cell in result["cells"]:
            assert "preview" not in cell
            assert "full_length" in cell
    
    @pytest.mark.asyncio
    async def test_read_cells_mode_list_custom_preview_length(self, service, temp_notebook):
        """Test mode='list' avec longueur de preview personnalisée."""
        result = await service.read_cells(temp_notebook, mode="list", preview_length=10)
        
        assert result["success"] is True
        
        # Vérifier que les previews respectent la longueur
        for cell in result["cells"]:
            if cell["full_length"] > 10:
                assert len(cell["preview"]) <= 13  # 10 + "..."
    
    @pytest.mark.asyncio
    async def test_read_cells_mode_all(self, service, temp_notebook):
        """Test mode='all' - Toutes les cellules complètes."""
        result = await service.read_cells(temp_notebook, mode="all")
        
        assert result["success"] is True
        assert result["mode"] == "all"
        assert result["cell_count"] == 5
        assert len(result["cells"]) == 5
        
        # Vérifier que les cellules complètes sont retournées
        for cell in result["cells"]:
            assert "index" in cell
            assert "cell_type" in cell
            assert "source" in cell
            assert "metadata" in cell
    
    @pytest.mark.asyncio
    async def test_read_cells_invalid_mode(self, service, temp_notebook):
        """Test avec mode invalide."""
        with pytest.raises(ValueError, match="Invalid mode"):
            await service.read_cells(temp_notebook, mode="invalid_mode")
    
    @pytest.mark.asyncio
    async def test_read_cells_default_mode(self, service, temp_notebook):
        """Test que le mode par défaut est 'list'."""
        result = await service.read_cells(temp_notebook)
        
        assert result["mode"] == "list"
        assert result["success"] is True


class TestBackwardCompatibility:
    """Tests de compatibilité ascendante avec les anciens outils."""
    
    @pytest.mark.asyncio
    async def test_read_cell_wrapper(self, service, temp_notebook):
        """Test que read_cell (deprecated) fonctionne via le wrapper."""
        result = await service.read_cell(temp_notebook, index=1)
        
        assert result["success"] is True
        assert "cell" in result
        assert result["cell"]["cell_type"] == "code"
    
    @pytest.mark.asyncio
    async def test_read_cells_range_wrapper(self, service, temp_notebook):
        """Test que read_cells_range (deprecated) fonctionne via le wrapper."""
        result = await service.read_cells_range(temp_notebook, start_index=1, end_index=3)
        
        assert result["success"] is True
        assert len(result["cells"]) == 3
    
    @pytest.mark.asyncio
    async def test_list_notebook_cells_wrapper(self, service, temp_notebook):
        """Test que list_notebook_cells (deprecated) fonctionne via le wrapper."""
        result = await service.list_notebook_cells(temp_notebook)
        
        assert result["success"] is True
        assert len(result["cells"]) == 5


class TestEdgeCases:
    """Tests des cas limites."""
    
    @pytest.mark.asyncio
    async def test_read_cells_empty_notebook(self, service):
        """Test avec un notebook vide."""
        with tempfile.TemporaryDirectory() as temp_dir:
            notebook_path = Path(temp_dir) / "empty.ipynb"
            notebook = FileUtils.create_empty_notebook("python3")
            FileUtils.write_notebook(notebook, notebook_path)
            
            result = await service.read_cells(notebook_path, mode="list")
            
            assert result["success"] is True
            assert result["cell_count"] == 0
            assert len(result["cells"]) == 0
    
    @pytest.mark.asyncio
    async def test_read_cells_single_cell_notebook(self, service):
        """Test avec un notebook à une seule cellule."""
        with tempfile.TemporaryDirectory() as temp_dir:
            notebook_path = Path(temp_dir) / "single.ipynb"
            notebook = FileUtils.create_empty_notebook("python3")
            notebook = FileUtils.add_cell(notebook, "code", "print('hello')")
            FileUtils.write_notebook(notebook, notebook_path)
            
            # Test single
            result_single = await service.read_cells(notebook_path, mode="single", index=0)
            assert result_single["success"] is True
            
            # Test range
            result_range = await service.read_cells(notebook_path, mode="range", start_index=0, end_index=0)
            assert result_range["success"] is True
            assert result_range["cell_count"] == 1
            
            # Test list
            result_list = await service.read_cells(notebook_path, mode="list")
            assert result_list["success"] is True
            assert result_list["cell_count"] == 1
    
    @pytest.mark.asyncio
    async def test_read_cells_code_with_outputs(self, service):
        """Test lecture de cellules code avec outputs."""
        with tempfile.TemporaryDirectory() as temp_dir:
            notebook_path = Path(temp_dir) / "with_outputs.ipynb"
            notebook = FileUtils.create_empty_notebook("python3")
            
            # Créer une cellule avec outputs simulés via nbformat
            from nbformat.v4 import new_code_cell, new_output
            cell = new_code_cell("print('test')")
            cell.execution_count = 1
            # Utiliser new_output pour créer un output valide
            cell.outputs = [
                new_output("stream", name="stdout", text="test\n")
            ]
            notebook.cells.append(cell)
            
            FileUtils.write_notebook(notebook, notebook_path)
            
            result = await service.read_cells(notebook_path, mode="single", index=0)
            
            assert result["success"] is True
            assert result["cell"]["execution_count"] == 1
            assert "outputs" in result["cell"]
            assert len(result["cell"]["outputs"]) == 1


if __name__ == "__main__":
    pytest.main([__file__, "-v"])