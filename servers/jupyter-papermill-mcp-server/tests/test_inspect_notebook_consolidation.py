"""
Tests unitaires pour l'outil consolidé inspect_notebook.
Phase 1B de la consolidation MCP Jupyter-Papermill (SDDD).
"""

import pytest
import tempfile
from pathlib import Path
import json

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
def basic_notebook():
    """Fixture pour créer un notebook de base sans outputs."""
    with tempfile.TemporaryDirectory() as temp_dir:
        notebook_path = Path(temp_dir) / "basic_notebook.ipynb"
        
        # Créer un notebook simple
        notebook = FileUtils.create_empty_notebook("python3")
        notebook = FileUtils.add_cell(notebook, "markdown", "# Test Notebook")
        notebook = FileUtils.add_cell(notebook, "code", "print('Hello World')")
        notebook = FileUtils.add_cell(notebook, "code", "x = 42\ny = x * 2")
        
        FileUtils.write_notebook(notebook, notebook_path)
        
        yield notebook_path


@pytest.fixture
def notebook_with_outputs():
    """Fixture pour créer un notebook avec outputs et erreurs."""
    with tempfile.TemporaryDirectory() as temp_dir:
        notebook_path = Path(temp_dir) / "notebook_with_outputs.ipynb"
        
        # Créer un notebook avec outputs en JSON direct (pour éviter problèmes de validation)
        notebook_data = {
            "nbformat": 4,
            "nbformat_minor": 5,
            "metadata": {
                "kernelspec": {
                    "display_name": "Python 3",
                    "language": "python",
                    "name": "python3"
                },
                "language_info": {
                    "name": "python",
                    "version": "3.8.0"
                }
            },
            "cells": [
                {
                    "cell_type": "code",
                    "execution_count": 1,
                    "id": "cell1",
                    "metadata": {},
                    "outputs": [
                        {
                            "output_type": "stream",
                            "name": "stdout",
                            "text": ["Test\n"]
                        }
                    ],
                    "source": ["print('Test')"]
                },
                {
                    "cell_type": "code",
                    "execution_count": 2,
                    "id": "cell2",
                    "metadata": {},
                    "outputs": [
                        {
                            "output_type": "execute_result",
                            "execution_count": 2,
                            "data": {
                                "text/plain": ["42"]
                            },
                            "metadata": {}
                        }
                    ],
                    "source": ["42"]
                },
                {
                    "cell_type": "code",
                    "execution_count": 3,
                    "id": "cell3",
                    "metadata": {},
                    "outputs": [
                        {
                            "output_type": "error",
                            "ename": "ZeroDivisionError",
                            "evalue": "division by zero",
                            "traceback": ["Traceback...", "ZeroDivisionError: division by zero"]
                        }
                    ],
                    "source": ["1/0"]
                },
                {
                    "cell_type": "code",
                    "execution_count": None,
                    "id": "cell4",
                    "metadata": {},
                    "outputs": [],
                    "source": ["# No output"]
                }
            ]
        }
        
        # Écrire directement en JSON
        with open(notebook_path, 'w', encoding='utf-8') as f:
            json.dump(notebook_data, f)
        
        yield notebook_path


@pytest.fixture
def invalid_notebook():
    """Fixture pour créer un notebook avec structure invalide."""
    with tempfile.TemporaryDirectory() as temp_dir:
        notebook_path = Path(temp_dir) / "invalid_notebook.ipynb"
        
        # Créer un notebook invalide (manque des champs requis)
        invalid_data = {
            "cells": [
                {
                    "cell_type": "code",
                    # Manque "source"
                    "metadata": {},
                    "outputs": []
                },
                {
                    # Manque "cell_type"
                    "source": "test",
                    "metadata": {}
                }
            ],
            "metadata": {
                "kernelspec": {
                    "name": "python3",
                    "display_name": "Python 3"
                }
            },
            "nbformat": 4,
            "nbformat_minor": 5
        }
        
        with open(notebook_path, 'w', encoding='utf-8') as f:
            json.dump(invalid_data, f)
        
        yield notebook_path


@pytest.fixture
def empty_notebook():
    """Fixture pour créer un notebook vide."""
    with tempfile.TemporaryDirectory() as temp_dir:
        notebook_path = Path(temp_dir) / "empty_notebook.ipynb"
        
        notebook = FileUtils.create_empty_notebook("python3")
        FileUtils.write_notebook(notebook, notebook_path)
        
        yield notebook_path


class TestInspectNotebookConsolidated:
    """Tests pour l'outil consolidé inspect_notebook."""
    
    # ========== Tests par Mode ==========
    
    @pytest.mark.asyncio
    async def test_inspect_notebook_mode_metadata(self, service, basic_notebook):
        """Test mode='metadata' - Récupération des métadonnées."""
        result = await service.inspect_notebook(basic_notebook, mode="metadata")
        
        assert result["success"] is True
        assert result["mode"] == "metadata"
        assert result["path"] == str(basic_notebook)
        assert "metadata" in result
        assert "nbformat" in result
        assert "nbformat_minor" in result
        assert "cell_count" in result
        assert result["cell_count"] == 3  # 1 markdown + 2 code
        
        # Vérifier les métadonnées du kernel
        metadata = result["metadata"]
        assert "kernelspec" in metadata
        assert metadata["kernelspec"]["name"] == "python3"
        assert "language_info" in metadata
    
    @pytest.mark.asyncio
    async def test_inspect_notebook_mode_outputs(self, service, notebook_with_outputs):
        """Test mode='outputs' - Analyse des sorties."""
        result = await service.inspect_notebook(notebook_with_outputs, mode="outputs")
        
        assert result["success"] is True
        assert result["mode"] == "outputs"
        assert "output_analysis" in result
        
        analysis = result["output_analysis"]
        assert analysis["total_cells"] == 4
        assert analysis["code_cells"] == 4
        assert analysis["cells_with_outputs"] == 3
        assert analysis["cells_with_errors"] == 1
        
        # Vérifier les types d'output
        output_types = analysis["output_types"]
        assert output_types.get("stream", 0) >= 1
        assert output_types.get("execute_result", 0) >= 1
        assert output_types.get("error", 0) >= 1
        
        # Vérifier les détails des cellules (seulement celles avec outputs)
        cells = analysis["cells"]
        assert len(cells) == 3  # 3 cellules avec outputs (la 4ème n'a pas d'output)
        
        # Cellule avec erreur (index 2)
        error_cell = next(c for c in cells if c["index"] == 2)
        assert error_cell["has_error"] is True
        assert error_cell["error_name"] == "ZeroDivisionError"
    
    @pytest.mark.asyncio
    async def test_inspect_notebook_mode_validate(self, service, basic_notebook):
        """Test mode='validate' - Validation du notebook."""
        result = await service.inspect_notebook(basic_notebook, mode="validate")
        
        assert result["success"] is True
        assert result["mode"] == "validate"
        assert "validation" in result
        
        validation = result["validation"]
        assert "is_valid" in validation
        assert validation["is_valid"] is True
        assert "nbformat_version" in validation
        assert "errors" in validation
        assert "warnings" in validation
        assert len(validation["errors"]) == 0  # Notebook valide
        assert "validation_time" in validation
    
    @pytest.mark.asyncio
    async def test_inspect_notebook_mode_full(self, service, notebook_with_outputs):
        """Test mode='full' - Inspection complète."""
        result = await service.inspect_notebook(notebook_with_outputs, mode="full")
        
        assert result["success"] is True
        assert result["mode"] == "full"
        
        # Doit contenir toutes les sections
        assert "metadata" in result
        assert "output_analysis" in result
        assert "validation" in result
        
        # Vérifier que toutes les données sont présentes
        assert "kernelspec" in result["metadata"]
        assert result["output_analysis"]["total_cells"] == 4
        assert result["validation"]["is_valid"] is True
    
    # ========== Tests Backward Compatibility ==========
    
    @pytest.mark.asyncio
    async def test_get_notebook_metadata_wrapper_deprecated(self, service, basic_notebook):
        """Test du wrapper deprecated get_notebook_metadata."""
        result = await service.get_notebook_metadata(basic_notebook)
        
        # Doit avoir l'ancien format
        assert result["success"] is True
        assert result["path"] == str(basic_notebook)
        assert "metadata" in result
        assert "nbformat" in result
        assert "cell_count" in result
        
        # Le wrapper transforme le nouveau format en ancien format
        assert "mode" not in result  # Ancien format ne contient pas 'mode'
    
    @pytest.mark.asyncio
    async def test_inspect_notebook_outputs_wrapper_deprecated(self, service, notebook_with_outputs):
        """Test du wrapper deprecated inspect_notebook_outputs."""
        result = await service.inspect_notebook_outputs(notebook_with_outputs)
        
        # Doit avoir l'ancien format (pas de "output_analysis", mais "outputs" direct)
        assert result["success"] is True
        assert result["path"] == str(notebook_with_outputs)
        assert "outputs" in result  # Ancien format
        assert "cells_with_outputs" in result
        
        # L'ancien format avait une structure différente
        assert result["cells_with_outputs"] == 3
    
    @pytest.mark.asyncio
    async def test_validate_notebook_wrapper_deprecated(self, service, basic_notebook):
        """Test du wrapper deprecated validate_notebook."""
        result = await service.validate_notebook(basic_notebook)
        
        # Doit avoir l'ancien format
        assert result["success"] is True
        assert result["path"] == str(basic_notebook)
        assert "is_valid" in result
        assert "notebook_issues" in result
        assert "cell_issues" in result
        
        # Notebook valide
        assert result["is_valid"] is True
        assert len(result["notebook_issues"]) == 0
        assert len(result["cell_issues"]) == 0
    
    # ========== Tests Edge Cases ==========
    
    @pytest.mark.asyncio
    async def test_inspect_notebook_empty_notebook(self, service, empty_notebook):
        """Test avec un notebook vide (aucune cellule)."""
        result = await service.inspect_notebook(empty_notebook, mode="full")
        
        assert result["success"] is True
        assert result["cell_count"] == 0
        assert result["output_analysis"]["total_cells"] == 0
        assert result["output_analysis"]["code_cells"] == 0
        assert result["validation"]["is_valid"] is True
    
    @pytest.mark.asyncio
    async def test_inspect_notebook_with_errors_in_outputs(self, service, notebook_with_outputs):
        """Test avec un notebook contenant des erreurs d'exécution."""
        result = await service.inspect_notebook(notebook_with_outputs, mode="outputs")
        
        analysis = result["output_analysis"]
        
        # Doit détecter la cellule avec erreur
        assert analysis["cells_with_errors"] == 1
        
        # Trouver la cellule avec erreur
        error_cells = [c for c in analysis["cells"] if c["has_error"]]
        assert len(error_cells) == 1
        assert error_cells[0]["error_name"] == "ZeroDivisionError"
    
    @pytest.mark.asyncio
    async def test_inspect_notebook_invalid_mode(self, service, basic_notebook):
        """Test avec un mode invalide."""
        with pytest.raises(ValueError, match="Invalid mode"):
            await service.inspect_notebook(basic_notebook, mode="invalid_mode")
    
    # ========== Tests Validation ==========
    
    @pytest.mark.asyncio
    async def test_inspect_notebook_valid_notebook(self, service, basic_notebook):
        """Test validation d'un notebook valide."""
        result = await service.inspect_notebook(basic_notebook, mode="validate")
        
        validation = result["validation"]
        assert validation["is_valid"] is True
        assert len(validation["errors"]) == 0
    
    @pytest.mark.asyncio
    async def test_inspect_notebook_invalid_notebook_structure(self, service, invalid_notebook):
        """Test validation d'un notebook avec structure invalide."""
        result = await service.inspect_notebook(invalid_notebook, mode="validate")
        
        validation = result["validation"]
        assert validation["is_valid"] is False
        assert len(validation["errors"]) > 0
        
        # Vérifier que les erreurs sont bien détectées
        error_messages = [e["message"] for e in validation["errors"]]
        assert any("Missing source" in msg for msg in error_messages)
        assert any("Missing cell_type" in msg for msg in error_messages)
    
    # ========== Tests Output Analysis ==========
    
    @pytest.mark.asyncio
    async def test_inspect_notebook_outputs_no_execution(self, service, basic_notebook):
        """Test analyse des outputs d'un notebook non exécuté."""
        result = await service.inspect_notebook(basic_notebook, mode="outputs")
        
        analysis = result["output_analysis"]
        assert analysis["cells_with_outputs"] == 0
        assert analysis["cells_with_errors"] == 0
        
        # Toutes les cellules doivent avoir execution_count = None
        for cell in analysis["cells"]:
            assert cell["execution_count"] is None
            assert cell["output_count"] == 0
    
    @pytest.mark.asyncio
    async def test_inspect_notebook_outputs_with_errors(self, service, notebook_with_outputs):
        """Test analyse des outputs avec erreurs."""
        result = await service.inspect_notebook(notebook_with_outputs, mode="outputs")
        
        analysis = result["output_analysis"]
        
        # Doit avoir exactement 1 erreur
        assert analysis["cells_with_errors"] == 1
        
        # Vérifier les détails de la cellule avec erreur
        error_cell = next(c for c in analysis["cells"] if c["has_error"])
        assert error_cell["error_name"] == "ZeroDivisionError"
        assert error_cell["output_count"] == 1
    
    @pytest.mark.asyncio
    async def test_inspect_notebook_outputs_mixed_types(self, service, notebook_with_outputs):
        """Test analyse des outputs avec types mixtes."""
        result = await service.inspect_notebook(notebook_with_outputs, mode="outputs")
        
        analysis = result["output_analysis"]
        output_types = analysis["output_types"]
        
        # Doit contenir plusieurs types d'outputs
        assert len(output_types) >= 2
        assert "stream" in output_types or "execute_result" in output_types
        assert "error" in output_types
    
    # ========== Tests Fichier Non Existant ==========
    
    @pytest.mark.asyncio
    async def test_inspect_notebook_file_not_found(self, service):
        """Test avec un fichier qui n'existe pas."""
        with pytest.raises(FileNotFoundError):
            await service.inspect_notebook("nonexistent_notebook.ipynb", mode="metadata")
    
    # ========== Tests Métadonnées Spécifiques ==========
    
    @pytest.mark.asyncio
    async def test_inspect_notebook_metadata_kernel_info(self, service, basic_notebook):
        """Test extraction des informations du kernel."""
        result = await service.inspect_notebook(basic_notebook, mode="metadata")
        
        metadata = result["metadata"]
        
        # Vérifier les infos du kernelspec
        assert "kernelspec" in metadata
        kernelspec = metadata["kernelspec"]
        assert "name" in kernelspec
        assert "display_name" in kernelspec
        
        # Vérifier les infos du langage
        assert "language_info" in metadata
        lang_info = metadata["language_info"]
        assert "name" in lang_info


class TestInspectNotebookIntegration:
    """Tests d'intégration pour inspect_notebook."""
    
    @pytest.mark.asyncio
    async def test_inspect_notebook_full_workflow(self, service, notebook_with_outputs):
        """Test du workflow complet: metadata -> outputs -> validate -> full."""
        
        # 1. Récupérer les métadonnées
        meta_result = await service.inspect_notebook(notebook_with_outputs, mode="metadata")
        assert meta_result["success"] is True
        assert "metadata" in meta_result
        
        # 2. Analyser les outputs
        output_result = await service.inspect_notebook(notebook_with_outputs, mode="outputs")
        assert output_result["success"] is True
        assert "output_analysis" in output_result
        
        # 3. Valider
        valid_result = await service.inspect_notebook(notebook_with_outputs, mode="validate")
        assert valid_result["success"] is True
        assert "validation" in valid_result
        
        # 4. Inspection complète
        full_result = await service.inspect_notebook(notebook_with_outputs, mode="full")
        assert full_result["success"] is True
        
        # Vérifier cohérence entre mode='full' et modes individuels
        assert full_result["metadata"]["kernelspec"] == meta_result["metadata"]["kernelspec"]
        assert full_result["output_analysis"]["total_cells"] == output_result["output_analysis"]["total_cells"]
        assert full_result["validation"]["is_valid"] == valid_result["validation"]["is_valid"]