import pytest
from unittest.mock import Mock, patch, ANY
from papermill_mcp.services.notebook_metadata_service import NotebookMetadataService
from papermill_mcp.services.notebook_validation_service import NotebookValidationService

class TestNotebookMetadataService:
    @pytest.fixture
    def validation_service(self):
        return Mock(spec=NotebookValidationService)

    @pytest.fixture
    def metadata_service(self, validation_service):
        return NotebookMetadataService(validation_service)

    @pytest.mark.asyncio
    async def test_list_notebooks(self, metadata_service):
        with patch('papermill_mcp.utils.file_utils.FileUtils.list_notebooks') as mock_list:
            mock_list.return_value = [{"name": "nb.ipynb"}]
            
            result = await metadata_service.list_notebooks("dir", recursive=True)
            
            assert len(result) == 1
            assert result[0]["name"] == "nb.ipynb"
            mock_list.assert_called_with(ANY, True)

    @pytest.mark.asyncio
    async def test_get_notebook_metadata_legacy(self, metadata_service, validation_service):
        validation_service.inspect_notebook.return_value = {
            "path": "path/nb.ipynb",
            "metadata": {"key": "val"},
            "nbformat": 4,
            "nbformat_minor": 5,
            "cell_count": 10,
            "success": True
        }
        
        result = await metadata_service.get_notebook_metadata("path/nb.ipynb")
        
        assert result["path"] == "path/nb.ipynb"
        assert result["metadata"] == {"key": "val"}
        assert result["nbformat"] == 4
        assert result["cell_count"] == 10
        validation_service.inspect_notebook.assert_called_with("path/nb.ipynb", mode="metadata")

    @pytest.mark.asyncio
    async def test_list_notebooks_error(self, metadata_service):
        with patch('papermill_mcp.utils.file_utils.FileUtils.list_notebooks', side_effect=Exception("Error")):
            with pytest.raises(Exception):
                await metadata_service.list_notebooks("dir")