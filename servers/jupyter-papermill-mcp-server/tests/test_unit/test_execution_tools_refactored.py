import pytest
from unittest.mock import MagicMock, AsyncMock, patch, ANY
from papermill_mcp.tools.execution_tools import register_execution_tools, initialize_execution_tools
from mcp.server.fastmcp import FastMCP

class TestExecutionToolsRefactored:
    @pytest.fixture
    def mock_app(self):
        app = MagicMock(spec=FastMCP)
        # Mock tool decorator
        def tool_decorator():
            def wrapper(func):
                return func
            return wrapper
        app.tool.side_effect = tool_decorator
        return app

    @pytest.fixture
    def mock_services(self):
        with patch('papermill_mcp.tools.execution_tools.get_services') as mock_get:
            nb_service = AsyncMock()
            kernel_service = AsyncMock()
            mock_get.return_value = (nb_service, kernel_service)
            yield nb_service, kernel_service

    @pytest.fixture
    def tools(self, mock_app):
        # Call register_execution_tools to define the functions
        # But we need to capture the defined functions.
        # Since register_execution_tools defines inner functions and registers them,
        # we can inspect the mock_app calls or just import the module and test the inner functions if exposed.
        # But the inner functions are not exposed directly.
        # However, they are decorated with @app.tool(). 
        # We can extract them from the app.tool calls or modify the code to expose them.
        # Or, easier: We mock FastMCP app, pass it to register, and capture the registered tools.
        
        registered_tools = {}
        def tool_decorator():
            def wrapper(func):
                registered_tools[func.__name__] = func
                return func
            return wrapper
        mock_app.tool.side_effect = tool_decorator
        
        register_execution_tools(mock_app)
        return registered_tools

    @pytest.mark.asyncio
    async def test_execute_notebook(self, tools, mock_services):
        nb_service, _ = mock_services
        nb_service.execute_notebook_consolidated.return_value = {"status": "success"}
        
        execute_notebook = tools["execute_notebook"]
        result = await execute_notebook(input_path="test.ipynb")
        
        assert result["status"] == "success"
        nb_service.execute_notebook_consolidated.assert_called_with(
            input_path="test.ipynb",
            output_path=None,
            parameters=None,
            mode="sync",
            kernel_name=None,
            timeout=None,
            log_output=True,
            progress_bar=False,
            report_mode="summary"
        )

    @pytest.mark.asyncio
    async def test_execute_notebook_error(self, tools, mock_services):
        nb_service, _ = mock_services
        nb_service.execute_notebook_consolidated.side_effect = Exception("Exec error")
        
        execute_notebook = tools["execute_notebook"]
        result = await execute_notebook(input_path="test.ipynb")
        
        assert result["status"] == "error"
        assert "Exec error" in result["error"]

    @pytest.mark.asyncio
    async def test_list_notebook_files(self, tools, mock_services):
        nb_service, _ = mock_services
        nb_service.list_notebooks.return_value = [{"name": "nb.ipynb"}]
        
        list_tool = tools["list_notebook_files"]
        result = await list_tool(directory=".", recursive=True)
        
        assert result["success"] is True
        assert result["count"] == 1
        nb_service.list_notebooks.assert_called_with(".", True)

    @pytest.mark.asyncio
    async def test_get_notebook_info(self, tools, mock_services, temp_dir):
        nb_service, _ = mock_services
        nb_service.get_notebook_metadata.return_value = {"metadata": {}}
        
        # Create a file for file info check
        test_file = temp_dir / "info.ipynb"
        test_file.touch()
        
        get_info = tools["get_notebook_info"]
        result = await get_info(path=str(test_file))
        
        assert result["success"] is True
        assert result["exists"] is True
        nb_service.get_notebook_metadata.assert_called_with(str(test_file))

    @pytest.mark.asyncio
    async def test_manage_async_job(self, tools, mock_services):
        # Need to mock get_execution_manager which is imported inside the tool
        with patch('papermill_mcp.services.notebook_service.get_execution_manager') as mock_get_manager:
            exec_manager = AsyncMock()
            mock_get_manager.return_value = exec_manager
            exec_manager.manage_async_job_consolidated.return_value = {"status": "ok"}
            
            manage_tool = tools["manage_async_job"]
            result = await manage_tool(action="status", job_id="123")
            
            assert result["status"] == "ok"
            exec_manager.manage_async_job_consolidated.assert_called_with(
                action="status", job_id="123", include_logs=False, 
                log_tail=None, filter_status=None, cleanup_older_than=None
            )

    @pytest.mark.asyncio
    async def test_start_jupyter_server(self, tools, temp_dir):
        # Create dummy executable
        env_path = temp_dir / "jupyter-lab.exe"
        env_path.touch()
        
        with patch('asyncio.create_subprocess_exec') as mock_exec:
            mock_process = AsyncMock()
            mock_process.returncode = None
            mock_process.pid = 1234
            mock_exec.return_value = mock_process
            
            start_server = tools["start_jupyter_server"]
            result = await start_server(env_path=str(env_path))
            
            assert result["success"] is True
            assert result["status"] == "started"
            assert result["process_id"] == 1234

    @pytest.mark.asyncio
    async def test_get_execution_status(self, tools, mock_services):
        _, kernel_service = mock_services
        kernel_service.list_kernels.return_value = {"active_kernels": []}
        
        status_tool = tools["get_execution_status"]
        result = await status_tool()
        
        assert result["success"] is True
        assert result["status"] == "active"
        assert result["kernel_count"] == 0