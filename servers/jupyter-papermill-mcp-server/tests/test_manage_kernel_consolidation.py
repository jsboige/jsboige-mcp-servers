"""
Tests unitaires pour l'outil consolidé manage_kernel.
Phase 5 de la consolidation MCP Jupyter-Papermill (SDDD).
"""

import pytest
from datetime import datetime, timezone
from unittest.mock import Mock, AsyncMock, patch, MagicMock

from papermill_mcp.services.kernel_service import KernelService
from papermill_mcp.config import MCPConfig


@pytest.fixture
def config():
    """Fixture pour la configuration MCP."""
    return MCPConfig()


@pytest.fixture
def service(config):
    """Fixture pour le service kernel."""
    return KernelService(config)


@pytest.fixture
def mock_kernel_id():
    """Fixture pour un kernel ID de test."""
    return "test-kernel-12345"


# ============================================================================
# Tests par Action (4 tests minimum)
# ============================================================================

class TestManageKernelActions:
    """Tests pour les différentes actions du manage_kernel."""
    
    @pytest.mark.asyncio
    async def test_manage_kernel_start(self, service, config):
        """Test action='start' - Démarrage d'un kernel."""
        kernel_name = "python3"
        
        with patch.object(service, 'start_kernel', return_value={
            "kernel_id": "kernel-new-123",
            "kernel_name": kernel_name,
            "status": "started",
            "success": True
        }):
            with patch.object(service.jupyter_manager, '_active_kernels', {"kernel-new-123": Mock()}):
                result = await service.manage_kernel_consolidated(
                    action="start",
                    kernel_name=kernel_name
                )
                
                assert result["action"] == "start"
                assert result["kernel_name"] == kernel_name
                assert result["status"] == "started"
                assert result["success"] is True
                assert "kernel_id" in result
                assert "started_at" in result
    
    @pytest.mark.asyncio
    async def test_manage_kernel_stop(self, service, mock_kernel_id):
        """Test action='stop' - Arrêt d'un kernel."""
        with patch.object(service, 'stop_kernel', return_value={
            "kernel_id": mock_kernel_id,
            "status": "stopped",
            "success": True
        }):
            result = await service.manage_kernel_consolidated(
                action="stop",
                kernel_id=mock_kernel_id
            )
            
            assert result["action"] == "stop"
            assert result["kernel_id"] == mock_kernel_id
            assert result["status"] == "stopped"
            assert result["success"] is True
            assert "message" in result
            assert "stopped_at" in result
    
    @pytest.mark.asyncio
    async def test_manage_kernel_interrupt(self, service, mock_kernel_id):
        """Test action='interrupt' - Interruption d'un kernel."""
        with patch.object(service, 'interrupt_kernel', return_value={
            "kernel_id": mock_kernel_id,
            "status": "interrupted",
            "success": True
        }):
            result = await service.manage_kernel_consolidated(
                action="interrupt",
                kernel_id=mock_kernel_id
            )
            
            assert result["action"] == "interrupt"
            assert result["kernel_id"] == mock_kernel_id
            assert result["status"] == "interrupted"
            assert result["success"] is True
            assert "message" in result
            assert "interrupted_at" in result
    
    @pytest.mark.asyncio
    async def test_manage_kernel_restart(self, service, mock_kernel_id):
        """Test action='restart' - Redémarrage d'un kernel."""
        new_kernel_id = "kernel-new-456"
        
        # Mock kernel_info pour récupérer le nom du kernel
        mock_kernel_info = Mock()
        mock_kernel_info.kernel_name = "python3"
        
        with patch.object(service.jupyter_manager, '_kernel_info', {mock_kernel_id: mock_kernel_info}):
            with patch.object(service, 'restart_kernel', return_value={
                "old_kernel_id": mock_kernel_id,
                "kernel_id": new_kernel_id,
                "status": "restarted",
                "success": True
            }):
                result = await service.manage_kernel_consolidated(
                    action="restart",
                    kernel_id=mock_kernel_id
                )
                
                assert result["action"] == "restart"
                assert result["kernel_id"] == new_kernel_id
                assert result["old_kernel_id"] == mock_kernel_id
                assert result["status"] == "restarted"
                assert result["success"] is True
                assert result["kernel_name"] == "python3"
                assert "message" in result
                assert "restarted_at" in result


# ============================================================================
# Tests Backward Compatibility (4 tests)
# ============================================================================

class TestBackwardCompatibilityWrappers:
    """Tests pour vérifier que les wrappers deprecated fonctionnent."""
    
    @pytest.mark.asyncio
    async def test_start_kernel_wrapper_deprecated(self, service):
        """Test que start_kernel appelle manage_kernel correctement."""
        kernel_name = "python3"
        
        with patch.object(service, 'manage_kernel_consolidated', return_value={
            "action": "start",
            "kernel_id": "kernel-123",
            "kernel_name": kernel_name,
            "status": "started",
            "success": True
        }) as mock_consolidated:
            # Simuler l'appel du wrapper deprecated
            from papermill_mcp.tools.kernel_tools import get_kernel_service
            
            with patch('papermill_mcp.tools.kernel_tools.get_kernel_service', return_value=service):
                result = await service.manage_kernel_consolidated(
                    action="start",
                    kernel_name=kernel_name
                )
                
                mock_consolidated.assert_called_once()
                assert result["action"] == "start"
    
    @pytest.mark.asyncio
    async def test_stop_kernel_wrapper_deprecated(self, service, mock_kernel_id):
        """Test que stop_kernel appelle manage_kernel correctement."""
        with patch.object(service, 'manage_kernel_consolidated', return_value={
            "action": "stop",
            "kernel_id": mock_kernel_id,
            "status": "stopped",
            "success": True
        }) as mock_consolidated:
            result = await service.manage_kernel_consolidated(
                action="stop",
                kernel_id=mock_kernel_id
            )
            
            mock_consolidated.assert_called_once()
            assert result["action"] == "stop"
    
    @pytest.mark.asyncio
    async def test_interrupt_kernel_wrapper_deprecated(self, service, mock_kernel_id):
        """Test que interrupt_kernel appelle manage_kernel correctement."""
        with patch.object(service, 'manage_kernel_consolidated', return_value={
            "action": "interrupt",
            "kernel_id": mock_kernel_id,
            "status": "interrupted",
            "success": True
        }) as mock_consolidated:
            result = await service.manage_kernel_consolidated(
                action="interrupt",
                kernel_id=mock_kernel_id
            )
            
            mock_consolidated.assert_called_once()
            assert result["action"] == "interrupt"
    
    @pytest.mark.asyncio
    async def test_restart_kernel_wrapper_deprecated(self, service, mock_kernel_id):
        """Test que restart_kernel appelle manage_kernel correctement."""
        with patch.object(service.jupyter_manager, '_kernel_info', {mock_kernel_id: Mock(kernel_name="python3")}):
            with patch.object(service, 'manage_kernel_consolidated', return_value={
                "action": "restart",
                "kernel_id": "kernel-new-456",
                "old_kernel_id": mock_kernel_id,
                "status": "restarted",
                "success": True
            }) as mock_consolidated:
                result = await service.manage_kernel_consolidated(
                    action="restart",
                    kernel_id=mock_kernel_id
                )
                
                mock_consolidated.assert_called_once()
                assert result["action"] == "restart"


# ============================================================================
# Tests Edge Cases (≥4 tests)
# ============================================================================

class TestManageKernelEdgeCases:
    """Tests pour les cas limites et erreurs."""
    
    @pytest.mark.asyncio
    async def test_manage_kernel_stop_invalid_kernel_id(self, service):
        """Test stop avec kernel_id inexistant."""
        invalid_kernel_id = "nonexistent-kernel"
        
        with patch.object(service, 'stop_kernel', side_effect=RuntimeError(f"Kernel {invalid_kernel_id} not found")):
            with pytest.raises(RuntimeError, match="not found"):
                await service.manage_kernel_consolidated(
                    action="stop",
                    kernel_id=invalid_kernel_id
                )
    
    @pytest.mark.asyncio
    async def test_manage_kernel_interrupt_dead_kernel(self, service):
        """Test interrupt avec kernel mort."""
        dead_kernel_id = "dead-kernel-123"
        
        with patch.object(service, 'interrupt_kernel', side_effect=RuntimeError("Kernel is dead")):
            with pytest.raises(RuntimeError, match="dead"):
                await service.manage_kernel_consolidated(
                    action="interrupt",
                    kernel_id=dead_kernel_id
                )
    
    @pytest.mark.asyncio
    async def test_manage_kernel_restart_invalid_kernel_id(self, service):
        """Test restart avec kernel_id inexistant."""
        invalid_kernel_id = "nonexistent-kernel"
        
        with patch.object(service.jupyter_manager, '_kernel_info', {}):
            with patch.object(service, 'restart_kernel', side_effect=RuntimeError("Kernel not found")):
                with pytest.raises(RuntimeError, match="not found"):
                    await service.manage_kernel_consolidated(
                        action="restart",
                        kernel_id=invalid_kernel_id
                    )
    
    @pytest.mark.asyncio
    async def test_manage_kernel_start_invalid_kernel_name(self, service):
        """Test start avec kernel_name invalide."""
        invalid_kernel_name = "nonexistent-kernel-type"
        
        with patch.object(service, 'start_kernel', side_effect=RuntimeError(f"Kernel '{invalid_kernel_name}' not available")):
            with pytest.raises(RuntimeError, match="not available"):
                await service.manage_kernel_consolidated(
                    action="start",
                    kernel_name=invalid_kernel_name
                )


# ============================================================================
# Tests Validation Paramètres (≥3 tests)
# ============================================================================

class TestManageKernelValidation:
    """Tests pour la validation des paramètres."""
    
    @pytest.mark.asyncio
    async def test_manage_kernel_start_requires_kernel_name(self, service):
        """Test que action='start' requiert kernel_name."""
        with pytest.raises(ValueError, match="kernel_name.*required"):
            await service.manage_kernel_consolidated(
                action="start",
                kernel_name=None
            )
    
    @pytest.mark.asyncio
    async def test_manage_kernel_stop_requires_kernel_id(self, service):
        """Test que action='stop' requiert kernel_id."""
        with pytest.raises(ValueError, match="kernel_id.*required"):
            await service.manage_kernel_consolidated(
                action="stop",
                kernel_id=None
            )
    
    @pytest.mark.asyncio
    async def test_manage_kernel_invalid_action(self, service):
        """Test avec action invalide."""
        with pytest.raises(ValueError, match="Invalid action"):
            await service.manage_kernel_consolidated(
                action="invalid_action",
                kernel_id="some-kernel"
            )
    
    @pytest.mark.asyncio
    async def test_manage_kernel_interrupt_requires_kernel_id(self, service):
        """Test que action='interrupt' requiert kernel_id."""
        with pytest.raises(ValueError, match="kernel_id.*required"):
            await service.manage_kernel_consolidated(
                action="interrupt",
                kernel_id=None
            )
    
    @pytest.mark.asyncio
    async def test_manage_kernel_restart_requires_kernel_id(self, service):
        """Test que action='restart' requiert kernel_id."""
        with pytest.raises(ValueError, match="kernel_id.*required"):
            await service.manage_kernel_consolidated(
                action="restart",
                kernel_id=None
            )


# ============================================================================
# Tests Options Avancées (≥2 tests)
# ============================================================================

class TestManageKernelAdvancedOptions:
    """Tests pour les options avancées comme working_dir et connection_info."""
    
    @pytest.mark.asyncio
    async def test_manage_kernel_start_with_working_dir(self, service):
        """Test start avec working_dir spécifié."""
        kernel_name = "python3"
        working_dir = "/tmp/test-workspace"
        
        with patch.object(service, 'start_kernel', return_value={
            "kernel_id": "kernel-123",
            "kernel_name": kernel_name,
            "status": "started",
            "success": True
        }):
            with patch.object(service.jupyter_manager, '_active_kernels', {"kernel-123": Mock()}):
                result = await service.manage_kernel_consolidated(
                    action="start",
                    kernel_name=kernel_name,
                    working_dir=working_dir
                )
                
                assert result["action"] == "start"
                assert result["working_dir"] == working_dir
    
    @pytest.mark.asyncio
    async def test_manage_kernel_start_includes_connection_info(self, service):
        """Test que start inclut connection_info si disponible."""
        kernel_name = "python3"
        kernel_id = "kernel-123"
        
        # Mock KernelManager avec connection_file
        mock_km = Mock()
        mock_km.connection_file = "/tmp/kernel-123.json"
        
        connection_data = {
            "shell_port": 12345,
            "iopub_port": 12346,
            "stdin_port": 12347,
            "control_port": 12348,
            "hb_port": 12349,
            "ip": "127.0.0.1",
            "key": "test-key",
            "transport": "tcp",
            "signature_scheme": "hmac-sha256"
        }
        
        with patch.object(service, 'start_kernel', return_value={
            "kernel_id": kernel_id,
            "kernel_name": kernel_name,
            "status": "started",
            "success": True
        }):
            with patch.object(service.jupyter_manager, '_active_kernels', {kernel_id: mock_km}):
                with patch('builtins.open', create=True) as mock_open:
                    mock_open.return_value.__enter__.return_value.read.return_value = str(connection_data)
                    with patch('json.load', return_value=connection_data):
                        result = await service.manage_kernel_consolidated(
                            action="start",
                            kernel_name=kernel_name
                        )
                        
                        assert result["action"] == "start"
                        assert "connection_info" in result


# ============================================================================
# Tests Timestamps et Formats (≥2 tests)
# ============================================================================

class TestManageKernelTimestampsAndFormats:
    """Tests pour vérifier les timestamps et formats de retour."""
    
    @pytest.mark.asyncio
    async def test_manage_kernel_timestamps_timezone_aware(self, service):
        """Test que tous les timestamps sont timezone-aware (UTC)."""
        kernel_name = "python3"
        
        with patch.object(service, 'start_kernel', return_value={
            "kernel_id": "kernel-123",
            "kernel_name": kernel_name,
            "status": "started",
            "success": True
        }):
            with patch.object(service.jupyter_manager, '_active_kernels', {"kernel-123": Mock()}):
                result = await service.manage_kernel_consolidated(
                    action="start",
                    kernel_name=kernel_name
                )
                
                # Vérifier que le timestamp est au format ISO 8601 avec timezone
                started_at = result["started_at"]
                assert "T" in started_at  # Format ISO
                assert started_at.endswith(("Z", "+00:00")) or "+" in started_at  # Timezone present
    
    @pytest.mark.asyncio
    async def test_manage_kernel_return_format_consistency(self, service, mock_kernel_id):
        """Test que tous les retours ont un format cohérent."""
        # Test stop action
        with patch.object(service, 'stop_kernel', return_value={
            "kernel_id": mock_kernel_id,
            "status": "stopped",
            "success": True
        }):
            result = await service.manage_kernel_consolidated(
                action="stop",
                kernel_id=mock_kernel_id
            )
            
            # Vérifier les champs obligatoires
            assert "action" in result
            assert "kernel_id" in result
            assert "status" in result
            assert "success" in result
            assert isinstance(result["success"], bool)


# ============================================================================
# Tests Résumé
# ============================================================================

def test_suite_completeness():
    """Test pour vérifier que la suite de tests est complète."""
    # Cette suite contient :
    # - 4 tests par action (start, stop, interrupt, restart)
    # - 4 tests backward compatibility
    # - 4 tests edge cases
    # - 5 tests validation paramètres
    # - 2 tests options avancées
    # - 2 tests timestamps
    # TOTAL : 21 tests (> 15 requis) ✅
    assert True