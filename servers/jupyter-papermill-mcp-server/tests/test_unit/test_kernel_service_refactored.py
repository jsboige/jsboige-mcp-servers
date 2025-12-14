import pytest
from unittest.mock import Mock, patch, AsyncMock
from papermill_mcp.services.kernel_service import KernelService
from papermill_mcp.config import MCPConfig

class TestKernelServiceRefactored:
    @pytest.fixture
    def config(self):
        config = Mock(spec=MCPConfig)
        config.jupyter_server = Mock()
        config.jupyter_server.base_url = "http://localhost:8888"
        config.jupyter_server.token = ""
        config.papermill = Mock()
        config.logging = Mock()
        config.offline_mode = False
        return config

    @pytest.fixture
    def kernel_service(self, config):
        service = KernelService(config)
        # Mock internal JupyterManager to avoid external dependencies
        service.jupyter_manager = Mock()
        # Ensure async methods are AsyncMock
        service.jupyter_manager.start_kernel = AsyncMock()
        service.jupyter_manager.stop_kernel = AsyncMock()
        service.jupyter_manager.restart_kernel = AsyncMock()
        service.jupyter_manager.interrupt_kernel = AsyncMock()
        service.jupyter_manager.execute_code = AsyncMock()
        # Ensure sync methods are Mock
        service.jupyter_manager.list_available_kernels = Mock()
        service.jupyter_manager.list_active_kernels = Mock()
        return service

    @pytest.mark.asyncio
    async def test_list_kernels_success(self, kernel_service):
        # Setup mock returns - note these are sync methods in JupyterManager/KernelService
        kernel_service.jupyter_manager.list_available_kernels.return_value = {"python3": {}}
        kernel_service.jupyter_manager.list_active_kernels.return_value = []
        
        result = await kernel_service.list_kernels()
        
        assert result["total_available"] == 1
        assert "python3" in result["available_kernels"]
        assert result["active_kernels"] == []

    @pytest.mark.asyncio
    async def test_start_kernel(self, kernel_service):
        kernel_service.jupyter_manager.start_kernel.return_value = "kernel-123"
        
        result = await kernel_service.start_kernel(kernel_name="python3")
        
        assert result["kernel_id"] == "kernel-123"
        assert result["status"] == "started"
        assert result["success"] is True
        kernel_service.jupyter_manager.start_kernel.assert_called_with("python3")

    @pytest.mark.asyncio
    async def test_stop_kernel(self, kernel_service):
        result = await kernel_service.stop_kernel(kernel_id="kernel-123")
        
        assert result["kernel_id"] == "kernel-123"
        assert result["status"] == "stopped"
        assert result["success"] is True
        kernel_service.jupyter_manager.stop_kernel.assert_called_with("kernel-123")

    @pytest.mark.asyncio
    async def test_restart_kernel(self, kernel_service):
        kernel_service.jupyter_manager.restart_kernel.return_value = "kernel-456"
        
        result = await kernel_service.restart_kernel(kernel_id="kernel-123")
        
        assert result["old_kernel_id"] == "kernel-123"
        assert result["kernel_id"] == "kernel-456"
        assert result["status"] == "restarted"
        kernel_service.jupyter_manager.restart_kernel.assert_called_with("kernel-123")

    @pytest.mark.asyncio
    async def test_interrupt_kernel(self, kernel_service):
        result = await kernel_service.interrupt_kernel(kernel_id="kernel-123")
        
        assert result["kernel_id"] == "kernel-123"
        assert result["status"] == "interrupted"
        kernel_service.jupyter_manager.interrupt_kernel.assert_called_with("kernel-123")

    @pytest.mark.asyncio
    async def test_execute_cell(self, kernel_service):
        # Mock execution result from JupyterManager
        mock_result = Mock()
        mock_result.execution_count = 1
        mock_result.status = "ok"
        mock_result.outputs = [{"output_type": "stream", "content": "text"}]
        mock_result.error_name = None
        mock_result.error_value = None
        kernel_service.jupyter_manager.execute_code.return_value = mock_result
        
        result = await kernel_service.execute_cell(kernel_id="kernel-123", code="print('hi')")
        
        assert result["status"] == "ok"
        assert len(result["outputs"]) == 1
        assert result["success"] is True
        kernel_service.jupyter_manager.execute_code.assert_called_with("kernel-123", "print('hi')", 60.0)

    @pytest.mark.asyncio
    async def test_manage_kernel_consolidated(self, kernel_service):
        # Mock underlying methods which are now implemented in KernelService
        # We need to set return values for the async methods of jupyter_manager
        
        kernel_service.jupyter_manager.start_kernel.return_value = "kernel-123"
        kernel_service.jupyter_manager.stop_kernel.return_value = None
        
        # Test start
        res_start = await kernel_service.manage_kernel_consolidated(action="start", kernel_name="py3")
        assert res_start["status"] == "started"
        kernel_service.jupyter_manager.start_kernel.assert_called_with("py3")
        
        # Test stop
        res_stop = await kernel_service.manage_kernel_consolidated(action="stop", kernel_id="123")
        assert res_stop["status"] == "stopped"
        kernel_service.jupyter_manager.stop_kernel.assert_called_with("123")
        
        # Test invalid action
        with pytest.raises(ValueError):
            await kernel_service.manage_kernel_consolidated(action="invalid", kernel_id="123")

    @pytest.mark.asyncio
    async def test_execute_on_kernel_consolidated(self, kernel_service):
        # Mock execute_cell result (which uses jupyter_manager.execute_code)
        mock_result = Mock()
        mock_result.execution_count = 1
        mock_result.status = "ok"
        mock_result.outputs = []
        mock_result.error_name = None
        mock_result.error_value = None
        kernel_service.jupyter_manager.execute_code.return_value = mock_result
        
        # Test code mode
        res = await kernel_service.execute_on_kernel_consolidated(
            kernel_id="123",
            mode="code",
            code="print(1)"
        )
        assert res["status"] == "ok"
        kernel_service.jupyter_manager.execute_code.assert_called_with("123", "print(1)", 60.0)
        
        # Test invalid mode
        with pytest.raises(ValueError):
            await kernel_service.execute_on_kernel_consolidated(kernel_id="123", mode="invalid")