import pytest
import json
import logging
from pathlib import Path
from unittest.mock import Mock, patch
from papermill_mcp.services.notebook_validation_service import NotebookValidationService

class TestNotebookValidationService:
    @pytest.fixture
    def validation_service(self, temp_dir):
        return NotebookValidationService(workspace_dir=str(temp_dir))

    @pytest.fixture
    def valid_notebook_path(self, temp_dir):
        path = temp_dir / "valid.ipynb"
        content = {
            "nbformat": 4,
            "nbformat_minor": 5,
            "metadata": {
                "kernelspec": {"name": "python3", "display_name": "Python 3"},
                "language_info": {"name": "python"},
                "authors": ["Author"],
                "title": "Test Title",
                "custom_field": "custom_value"
            },
            "cells": [
                {
                    "cell_type": "code",
                    "source": "print('hello')",
                    "execution_count": 1,
                    "outputs": [
                        {"output_type": "stream", "name": "stdout", "text": "hello\n"}
                    ],
                    "metadata": {}
                },
                {
                    "cell_type": "markdown",
                    "source": "# Header",
                    "metadata": {}
                }
            ]
        }
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(content, f)
        return path

    @pytest.fixture
    def invalid_notebook_path(self, temp_dir):
        path = temp_dir / "invalid.ipynb"
        content = {
            # Include minimal nbformat to pass FileUtils.read_notebook (nbformat.read)
            "nbformat": 4,
            "nbformat_minor": 5,
            # Missing 'cells' field (or other required fields for custom validation)
            "metadata": {},
            # "cells": [] # Missing cells field
        }
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(content, f)
        return path

    @pytest.fixture
    def error_notebook_path(self, temp_dir):
        path = temp_dir / "error.ipynb"
        content = {
            "nbformat": 4,
            "nbformat_minor": 5,
            "metadata": {},
            "cells": [
                {
                    "cell_type": "code",
                    "source": "1/0",
                    "execution_count": 1,
                    "outputs": [
                        {
                            "output_type": "error",
                            "ename": "ZeroDivisionError",
                            "evalue": "division by zero",
                            "traceback": []
                        }
                    ],
                    "metadata": {}
                }
            ]
        }
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(content, f)
        return path

    def test_resolve_path(self, validation_service, temp_dir):
        abs_path = str(temp_dir / "test.ipynb")
        assert validation_service.resolve_path(abs_path) == abs_path
        
        rel_path = "test.ipynb"
        assert validation_service.resolve_path(rel_path) == str(temp_dir / rel_path)

    @pytest.mark.asyncio
    async def test_inspect_metadata(self, validation_service, valid_notebook_path):
        result = await validation_service.inspect_notebook(valid_notebook_path, mode="metadata")
        
        assert result["success"] is True
        assert result["mode"] == "metadata"
        assert "metadata" in result
        assert result["metadata"]["kernelspec"]["name"] == "python3"
        assert result["metadata"]["title"] == "Test Title"
        assert result["metadata"]["authors"] == ["Author"]
        assert result["metadata"]["custom_metadata"]["custom_field"] == "custom_value"
        assert result["cell_count"] == 2

    @pytest.mark.asyncio
    async def test_inspect_outputs(self, validation_service, valid_notebook_path):
        result = await validation_service.inspect_notebook(valid_notebook_path, mode="outputs")
        
        assert result["success"] is True
        analysis = result["output_analysis"]
        assert analysis["total_cells"] == 2
        assert analysis["code_cells"] == 1
        assert analysis["cells_with_outputs"] == 1
        assert analysis["cells_with_errors"] == 0
        assert analysis["output_types"]["stream"] == 1

    @pytest.mark.asyncio
    async def test_inspect_outputs_with_error(self, validation_service, error_notebook_path):
        result = await validation_service.inspect_notebook(error_notebook_path, mode="outputs")
        
        assert result["success"] is True
        analysis = result["output_analysis"]
        assert analysis["cells_with_errors"] == 1
        assert analysis["cells"][0]["has_error"] is True
        assert analysis["cells"][0]["error_name"] == "ZeroDivisionError"

    @pytest.mark.asyncio
    async def test_inspect_validate_valid(self, validation_service, valid_notebook_path):
        result = await validation_service.inspect_notebook(valid_notebook_path, mode="validate")
        
        assert result["success"] is True
        validation = result["validation"]
        assert validation["is_valid"] is True
        assert validation["error_count"] == 0

    @pytest.mark.asyncio
    async def test_inspect_validate_invalid(self, validation_service, invalid_notebook_path):
        result = await validation_service.inspect_notebook(invalid_notebook_path, mode="validate")
        
        assert result["success"] is True
        validation = result["validation"]
        assert validation["is_valid"] is False
        assert validation["error_count"] > 0
        
        errors = [e["message"] for e in validation["errors"]]
        # We adjusted the fixture, so check for relevant errors
        assert "Missing 'cells' field" in errors

    @pytest.mark.asyncio
    async def test_inspect_full(self, validation_service, valid_notebook_path):
        result = await validation_service.inspect_notebook(valid_notebook_path, mode="full")
        
        assert result["success"] is True
        assert "metadata" in result
        assert "output_analysis" in result
        assert "validation" in result

    @pytest.mark.asyncio
    async def test_inspect_error_handling(self, validation_service, temp_dir):
        # Invalid mode
        with pytest.raises(ValueError):
            await validation_service.inspect_notebook("any.ipynb", mode="invalid_mode")
    
        # File not found
        with pytest.raises(FileNotFoundError):
            await validation_service.inspect_notebook("nonexistent.ipynb")
    
        # Malformed JSON (handled by FileUtils, which raises ValueError)
        # We need to ensure the file exists so the existence check passes
        bad_json_path = temp_dir / "bad_json.ipynb"
        bad_json_path.touch()
        
        # When checking strict read failure (not validate/full mode)
        with patch('papermill_mcp.utils.file_utils.FileUtils.read_notebook', side_effect=ValueError("Invalid JSON")):
             with pytest.raises(ValueError):
                await validation_service.inspect_notebook("bad_json.ipynb", mode="metadata")