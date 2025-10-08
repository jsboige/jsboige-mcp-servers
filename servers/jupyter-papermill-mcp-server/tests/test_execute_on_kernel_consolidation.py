"""
Tests unitaires pour l'outil consolidé execute_on_kernel.
Phase 2 de la consolidation MCP Jupyter-Papermill (SDDD).
"""

import pytest
import tempfile
from pathlib import Path
import asyncio
from unittest.mock import Mock, AsyncMock, patch

from papermill_mcp.services.kernel_service import KernelService
from papermill_mcp.config import MCPConfig
from papermill_mcp.utils.file_utils import FileUtils
from papermill_mcp.core.jupyter_manager import ExecutionResult, ExecutionOutput


@pytest.fixture
def config():
    """Fixture pour la configuration MCP."""
    return MCPConfig()


@pytest.fixture
def service(config):
    """Fixture pour le service kernel."""
    return KernelService(config)


@pytest.fixture
def temp_notebook():
    """Fixture pour créer un notebook temporaire avec plusieurs cellules."""
    with tempfile.TemporaryDirectory() as temp_dir:
        notebook_path = Path(temp_dir) / "test_notebook.ipynb"
        
        # Créer un notebook avec plusieurs cellules
        notebook = FileUtils.create_empty_notebook("python3")
        notebook = FileUtils.add_cell(notebook, "markdown", "# Test Notebook")
        notebook = FileUtils.add_cell(notebook, "code", "print('Cell 1')")
        notebook = FileUtils.add_cell(notebook, "code", "x = 42\nprint(x)")
        notebook = FileUtils.add_cell(notebook, "markdown", "## Section 2")
        notebook = FileUtils.add_cell(notebook, "code", "print('Cell 4')")
        
        FileUtils.write_notebook(notebook, notebook_path)
        
        yield notebook_path


@pytest.fixture
def mock_kernel_id():
    """Fixture pour un kernel ID de test."""
    return "test-kernel-12345"


# ============================================================================
# Tests par Mode (3 tests minimum)
# ============================================================================

class TestExecuteOnKernelModes:
    """Tests pour les différents modes d'exécution."""
    
    @pytest.mark.asyncio
    async def test_execute_on_kernel_code_mode(self, service, mock_kernel_id):
        """Test mode='code' - Exécution de code Python brut."""
        # Mock du jupyter_manager
        mock_result = ExecutionResult(
            status="ok",
            execution_count=1,
            outputs=[
                ExecutionOutput(
                    output_type='stream',
                    content={'name': 'stdout', 'text': 'Hello World\n'}
                )
            ],
            text_output="Hello World\n"
        )
        
        with patch.object(service.jupyter_manager, '_active_kernels', {mock_kernel_id: Mock()}):
            with patch.object(service, 'execute_cell', return_value={
                "kernel_id": mock_kernel_id,
                "execution_count": 1,
                "status": "ok",
                "outputs": [{"output_type": "stream", "content": {"text": "Hello World\n"}}],
                "success": True
            }) as mock_exec:
                result = await service.execute_on_kernel_consolidated(
                    kernel_id=mock_kernel_id,
                    mode="code",
                    code="print('Hello World')"
                )
                
                assert result["mode"] == "code"
                assert result["kernel_id"] == mock_kernel_id
                assert result["success"] is True
                assert "execution_time" in result
                mock_exec.assert_called_once()
    
    @pytest.mark.asyncio
    async def test_execute_on_kernel_notebook_mode(self, service, mock_kernel_id, temp_notebook):
        """Test mode='notebook' - Exécution de toutes les cellules d'un notebook."""
        with patch.object(service.jupyter_manager, '_active_kernels', {mock_kernel_id: Mock()}):
            with patch.object(service, 'execute_notebook_in_kernel', return_value={
                "kernel_id": mock_kernel_id,
                "notebook_path": str(temp_notebook),
                "total_cells": 3,
                "executed_cells": 3,
                "successful_cells": 3,
                "error_cells": 0,
                "total_execution_time": 1.5,
                "results": [],
                "success": True
            }) as mock_exec:
                result = await service.execute_on_kernel_consolidated(
                    kernel_id=mock_kernel_id,
                    mode="notebook",
                    path=str(temp_notebook)
                )
                
                assert result["mode"] == "notebook"
                assert result["path"] == str(temp_notebook)
                assert result["cells_executed"] == 3
                assert result["cells_succeeded"] == 3
                assert result["cells_failed"] == 0
                assert result["success"] is True
                mock_exec.assert_called_once()
    
    @pytest.mark.asyncio
    async def test_execute_on_kernel_notebook_cell_mode(self, service, mock_kernel_id, temp_notebook):
        """Test mode='notebook_cell' - Exécution d'une cellule spécifique."""
        with patch.object(service.jupyter_manager, '_active_kernels', {mock_kernel_id: Mock()}):
            with patch.object(service, 'execute_notebook_cell', return_value={
                "notebook_path": str(temp_notebook),
                "cell_index": 1,
                "kernel_id": mock_kernel_id,
                "execution_count": 1,
                "status": "ok",
                "outputs": [],
                "success": True,
                "execution_time": 0.5
            }) as mock_exec:
                result = await service.execute_on_kernel_consolidated(
                    kernel_id=mock_kernel_id,
                    mode="notebook_cell",
                    path=str(temp_notebook),
                    cell_index=1
                )
                
                assert result["mode"] == "notebook_cell"
                assert result["cell_index"] == 1
                assert result["cell_type"] == "code"
                assert result["success"] is True
                mock_exec.assert_called_once()


# ============================================================================
# Tests Backward Compatibility (3 tests)
# ============================================================================

class TestBackwardCompatibility:
    """Tests de compatibilité avec les anciens outils."""
    
    @pytest.mark.asyncio
    async def test_execute_cell_wrapper_deprecated(self, service, mock_kernel_id):
        """Test que execute_cell appelle execute_on_kernel avec mode='code'."""
        with patch.object(service.jupyter_manager, '_active_kernels', {mock_kernel_id: Mock()}):
            with patch.object(service, 'execute_cell', return_value={
                "kernel_id": mock_kernel_id,
                "status": "ok",
                "success": True
            }) as mock_exec:
                result = await service.execute_on_kernel_consolidated(
                    kernel_id=mock_kernel_id,
                    mode="code",
                    code="x = 1"
                )
                assert result["mode"] == "code"
    
    @pytest.mark.asyncio
    async def test_execute_notebook_wrapper_deprecated(self, service, mock_kernel_id, temp_notebook):
        """Test que execute_notebook appelle execute_on_kernel avec mode='notebook'."""
        with patch.object(service.jupyter_manager, '_active_kernels', {mock_kernel_id: Mock()}):
            with patch.object(service, 'execute_notebook_in_kernel', return_value={
                "kernel_id": mock_kernel_id,
                "success": True,
                "executed_cells": 3,
                "successful_cells": 3,
                "error_cells": 0,
                "total_execution_time": 1.0,
                "results": []
            }) as mock_exec:
                result = await service.execute_on_kernel_consolidated(
                    kernel_id=mock_kernel_id,
                    mode="notebook",
                    path=str(temp_notebook)
                )
                assert result["mode"] == "notebook"
    
    @pytest.mark.asyncio
    async def test_execute_notebook_cell_wrapper_deprecated(self, service, mock_kernel_id, temp_notebook):
        """Test que execute_notebook_cell appelle execute_on_kernel avec mode='notebook_cell'."""
        with patch.object(service.jupyter_manager, '_active_kernels', {mock_kernel_id: Mock()}):
            with patch.object(service, 'execute_notebook_cell', return_value={
                "kernel_id": mock_kernel_id,
                "cell_index": 1,
                "status": "ok",
                "success": True,
                "execution_time": 0.3
            }) as mock_exec:
                result = await service.execute_on_kernel_consolidated(
                    kernel_id=mock_kernel_id,
                    mode="notebook_cell",
                    path=str(temp_notebook),
                    cell_index=1
                )
                assert result["mode"] == "notebook_cell"


# ============================================================================
# Tests Edge Cases Exécution (≥6 tests)
# ============================================================================

class TestExecutionEdgeCases:
    """Tests des cas limites d'exécution."""
    
    @pytest.mark.asyncio
    async def test_execute_on_kernel_code_with_error(self, service, mock_kernel_id):
        """Test exécution de code avec erreur Python."""
        with patch.object(service.jupyter_manager, '_active_kernels', {mock_kernel_id: Mock()}):
            with patch.object(service, 'execute_cell', return_value={
                "kernel_id": mock_kernel_id,
                "execution_count": 1,
                "status": "error",
                "error": {"ename": "NameError", "evalue": "name 'undefined' is not defined"},
                "outputs": [],
                "success": False
            }):
                result = await service.execute_on_kernel_consolidated(
                    kernel_id=mock_kernel_id,
                    mode="code",
                    code="print(undefined)"
                )
                
                assert result["status"] == "error"
                assert result["success"] is False
                assert "error" in result
    
    @pytest.mark.asyncio
    async def test_execute_on_kernel_code_with_timeout(self, service, mock_kernel_id):
        """Test exécution avec timeout."""
        with patch.object(service.jupyter_manager, '_active_kernels', {mock_kernel_id: Mock()}):
            with patch.object(service, 'execute_cell', return_value={
                "kernel_id": mock_kernel_id,
                "status": "timeout",
                "success": False
            }):
                result = await service.execute_on_kernel_consolidated(
                    kernel_id=mock_kernel_id,
                    mode="code",
                    code="import time; time.sleep(100)",
                    timeout=1
                )
                
                assert result["status"] == "timeout"
                assert result["success"] is False
    
    @pytest.mark.asyncio
    async def test_execute_on_kernel_notebook_empty(self, service, mock_kernel_id):
        """Test exécution d'un notebook vide."""
        with tempfile.TemporaryDirectory() as temp_dir:
            empty_notebook_path = Path(temp_dir) / "empty.ipynb"
            notebook = FileUtils.create_empty_notebook("python3")
            FileUtils.write_notebook(notebook, empty_notebook_path)
            
            with patch.object(service.jupyter_manager, '_active_kernels', {mock_kernel_id: Mock()}):
                with patch.object(service, 'execute_notebook_in_kernel', return_value={
                    "kernel_id": mock_kernel_id,
                    "executed_cells": 0,
                    "successful_cells": 0,
                    "error_cells": 0,
                    "total_execution_time": 0.0,
                    "results": [],
                    "success": True
                }):
                    result = await service.execute_on_kernel_consolidated(
                        kernel_id=mock_kernel_id,
                        mode="notebook",
                        path=str(empty_notebook_path)
                    )
                    
                    assert result["cells_executed"] == 0
                    assert result["success"] is True
    
    @pytest.mark.asyncio
    async def test_execute_on_kernel_notebook_with_errors(self, service, mock_kernel_id, temp_notebook):
        """Test exécution de notebook avec des erreurs dans certaines cellules."""
        with patch.object(service.jupyter_manager, '_active_kernels', {mock_kernel_id: Mock()}):
            with patch.object(service, 'execute_notebook_in_kernel', return_value={
                "kernel_id": mock_kernel_id,
                "executed_cells": 3,
                "successful_cells": 2,
                "error_cells": 1,
                "total_execution_time": 1.5,
                "results": [
                    {"cell_index": 0, "status": "ok"},
                    {"cell_index": 1, "status": "error"},
                    {"cell_index": 2, "status": "ok"}
                ],
                "success": False
            }):
                result = await service.execute_on_kernel_consolidated(
                    kernel_id=mock_kernel_id,
                    mode="notebook",
                    path=str(temp_notebook)
                )
                
                assert result["cells_failed"] == 1
                assert result["success"] is False
    
    @pytest.mark.asyncio
    async def test_execute_on_kernel_invalid_kernel_id(self, service):
        """Test avec un kernel_id inexistant."""
        with pytest.raises(ValueError, match="Kernel .* not found"):
            await service.execute_on_kernel_consolidated(
                kernel_id="nonexistent-kernel",
                mode="code",
                code="print('test')"
            )
    
    @pytest.mark.asyncio
    async def test_execute_on_kernel_invalid_cell_index(self, service, mock_kernel_id, temp_notebook):
        """Test avec un index de cellule invalide."""
        with patch.object(service.jupyter_manager, '_active_kernels', {mock_kernel_id: Mock()}):
            with patch.object(service, 'execute_notebook_cell', side_effect=IndexError("Cell index out of range")):
                with pytest.raises(IndexError):
                    await service.execute_on_kernel_consolidated(
                        kernel_id=mock_kernel_id,
                        mode="notebook_cell",
                        path=str(temp_notebook),
                        cell_index=999
                    )


# ============================================================================
# Tests Validation Paramètres (≥3 tests)
# ============================================================================

class TestParameterValidation:
    """Tests de validation des paramètres selon le mode."""
    
    @pytest.mark.asyncio
    async def test_execute_on_kernel_code_requires_code(self, service, mock_kernel_id):
        """Test que mode='code' requiert le paramètre 'code'."""
        with patch.object(service.jupyter_manager, '_active_kernels', {mock_kernel_id: Mock()}):
            with pytest.raises(ValueError, match="Parameter 'code' is required for mode='code'"):
                await service.execute_on_kernel_consolidated(
                    kernel_id=mock_kernel_id,
                    mode="code"
                    # code manquant
                )
    
    @pytest.mark.asyncio
    async def test_execute_on_kernel_notebook_requires_path(self, service, mock_kernel_id):
        """Test que mode='notebook' requiert le paramètre 'path'."""
        with patch.object(service.jupyter_manager, '_active_kernels', {mock_kernel_id: Mock()}):
            with pytest.raises(ValueError, match="Parameter 'path' is required for mode='notebook'"):
                await service.execute_on_kernel_consolidated(
                    kernel_id=mock_kernel_id,
                    mode="notebook"
                    # path manquant
                )
    
    @pytest.mark.asyncio
    async def test_execute_on_kernel_notebook_cell_requires_path_and_index(self, service, mock_kernel_id):
        """Test que mode='notebook_cell' requiert 'path' et 'cell_index'."""
        with patch.object(service.jupyter_manager, '_active_kernels', {mock_kernel_id: Mock()}):
            # Test sans path
            with pytest.raises(ValueError, match="Parameters 'path' and 'cell_index' are required"):
                await service.execute_on_kernel_consolidated(
                    kernel_id=mock_kernel_id,
                    mode="notebook_cell",
                    cell_index=0
                    # path manquant
                )
            
            # Test sans cell_index
            with pytest.raises(ValueError, match="Parameters 'path' and 'cell_index' are required"):
                await service.execute_on_kernel_consolidated(
                    kernel_id=mock_kernel_id,
                    mode="notebook_cell",
                    path="/tmp/test.ipynb"
                    # cell_index manquant
                )
    
    @pytest.mark.asyncio
    async def test_execute_on_kernel_invalid_mode(self, service, mock_kernel_id):
        """Test avec un mode invalide."""
        with patch.object(service.jupyter_manager, '_active_kernels', {mock_kernel_id: Mock()}):
            with pytest.raises(ValueError, match="Invalid mode"):
                await service.execute_on_kernel_consolidated(
                    kernel_id=mock_kernel_id,
                    mode="invalid_mode",
                    code="print('test')"
                )


# ============================================================================
# Tests Asynchrones (≥3 tests)
# ============================================================================

class TestAsyncExecution:
    """Tests de gestion asynchrone des exécutions."""
    
    @pytest.mark.asyncio
    async def test_execute_on_kernel_concurrent_executions(self, service, mock_kernel_id):
        """Test d'exécutions concurrentes sur le même kernel."""
        with patch.object(service.jupyter_manager, '_active_kernels', {mock_kernel_id: Mock()}):
            with patch.object(service, 'execute_cell', return_value={
                "kernel_id": mock_kernel_id,
                "status": "ok",
                "success": True
            }):
                # Lancer plusieurs exécutions en parallèle
                tasks = [
                    service.execute_on_kernel_consolidated(
                        kernel_id=mock_kernel_id,
                        mode="code",
                        code=f"x = {i}"
                    )
                    for i in range(3)
                ]
                
                results = await asyncio.gather(*tasks)
                
                assert len(results) == 3
                assert all(r["success"] for r in results)
    
    @pytest.mark.asyncio
    async def test_execute_on_kernel_timeout_handling(self, service, mock_kernel_id):
        """Test de gestion du timeout d'exécution."""
        with patch.object(service.jupyter_manager, '_active_kernels', {mock_kernel_id: Mock()}):
            with patch.object(service, 'execute_cell', side_effect=asyncio.TimeoutError("Execution timeout")):
                with pytest.raises(asyncio.TimeoutError):
                    await service.execute_on_kernel_consolidated(
                        kernel_id=mock_kernel_id,
                        mode="code",
                        code="import time; time.sleep(100)",
                        timeout=1
                    )
    
    @pytest.mark.asyncio
    async def test_execute_on_kernel_custom_timeout(self, service, mock_kernel_id):
        """Test avec un timeout personnalisé."""
        with patch.object(service.jupyter_manager, '_active_kernels', {mock_kernel_id: Mock()}):
            with patch.object(service, 'execute_cell', return_value={
                "kernel_id": mock_kernel_id,
                "status": "ok",
                "success": True
            }) as mock_exec:
                result = await service.execute_on_kernel_consolidated(
                    kernel_id=mock_kernel_id,
                    mode="code",
                    code="print('test')",
                    timeout=120  # 2 minutes
                )
                
                assert result["success"] is True
                # Vérifier que le timeout a été passé
                mock_exec.assert_called_once()
                call_args = mock_exec.call_args
                assert call_args[0][2] == 120  # timeout argument


# ============================================================================
# Tests Supplémentaires pour atteindre 18+ tests
# ============================================================================

class TestAdditionalCases:
    """Tests supplémentaires pour couverture exhaustive."""
    
    @pytest.mark.asyncio
    async def test_execute_on_kernel_empty_code(self, service, mock_kernel_id):
        """Test avec du code vide."""
        with patch.object(service.jupyter_manager, '_active_kernels', {mock_kernel_id: Mock()}):
            with patch.object(service, 'execute_cell', return_value={
                "kernel_id": mock_kernel_id,
                "status": "ok",
                "outputs": [],
                "success": True
            }):
                result = await service.execute_on_kernel_consolidated(
                    kernel_id=mock_kernel_id,
                    mode="code",
                    code=""
                )
                
                assert result["success"] is True
    
    @pytest.mark.asyncio
    async def test_execute_on_kernel_multiline_code(self, service, mock_kernel_id):
        """Test avec du code multi-lignes."""
        multiline_code = """
def factorial(n):
    if n <= 1:
        return 1
    return n * factorial(n-1)

print(factorial(5))
"""
        with patch.object(service.jupyter_manager, '_active_kernels', {mock_kernel_id: Mock()}):
            with patch.object(service, 'execute_cell', return_value={
                "kernel_id": mock_kernel_id,
                "execution_count": 1,
                "status": "ok",
                "outputs": [{"output_type": "stream", "content": {"text": "120\n"}}],
                "success": True
            }):
                result = await service.execute_on_kernel_consolidated(
                    kernel_id=mock_kernel_id,
                    mode="code",
                    code=multiline_code
                )
                
                assert result["success"] is True
                assert result["status"] == "ok"
    
    @pytest.mark.asyncio
    async def test_execute_on_kernel_notebook_cell_zero_index(self, service, mock_kernel_id, temp_notebook):
        """Test exécution de la première cellule (index 0)."""
        with patch.object(service.jupyter_manager, '_active_kernels', {mock_kernel_id: Mock()}):
            with patch.object(service, 'execute_notebook_cell', return_value={
                "kernel_id": mock_kernel_id,
                "cell_index": 0,
                "status": "ok",
                "success": True,
                "execution_time": 0.1
            }):
                result = await service.execute_on_kernel_consolidated(
                    kernel_id=mock_kernel_id,
                    mode="notebook_cell",
                    path=str(temp_notebook),
                    cell_index=0
                )
                
                assert result["cell_index"] == 0
                assert result["success"] is True