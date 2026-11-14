"""One active-kernel registry for the whole server (#4716).

``initialize_kernel_tools`` and ``initialize_execution_tools`` each built their
own ``KernelService`` -- hence their own ``JupyterManager``, hence their own
``_active_kernels`` dict. A kernel started through the kernel tools was then
invisible to the execution tools: ``list_kernels`` saw it, but
``execute_notebook_cell`` / ``get_kernel_status`` / ``cleanup_all_kernels``
answered "Kernel not found" (the refusal reads ``_active_kernels``).

The server wiring now hands the kernel tools' service to the execution tools.
The load-bearing assertions are identity (ONE registry, not two that happen to
agree) and cross-visibility of an entry registered through the kernel path --
on the base commit both fail, because the two services hold two distinct dicts.
"""

from papermill_mcp.config import MCPConfig
from papermill_mcp.main import JupyterPapermillMCPServer
from papermill_mcp.tools.execution_tools import (
    get_services as get_execution_services,
)
from papermill_mcp.tools.execution_tools import initialize_execution_tools
from papermill_mcp.tools.kernel_tools import get_kernel_service, initialize_kernel_tools

SENTINEL_KERNEL_ID = "sentinel-4716-shared-registry"


def test_server_initialization_shares_one_kernel_registry():
    """An entry registered on the kernel path is visible to the execution tools."""
    server = JupyterPapermillMCPServer(MCPConfig())
    server.initialize()

    kernel_service = get_kernel_service()
    _notebook_service, execution_kernel_service = get_execution_services()

    # Identity first: two distinct JupyterManagers could hold equal-looking
    # dicts and still reproduce the defect.
    assert execution_kernel_service is kernel_service
    assert execution_kernel_service.jupyter_manager is kernel_service.jupyter_manager

    # Then the behavior the refusal paths depend on: the entry is inserted the
    # way start_kernel inserts it (JupyterManager._active_kernels,
    # core/jupyter_manager.py:290) and must be seen from the execution side.
    kernel_service.jupyter_manager._active_kernels[SENTINEL_KERNEL_ID] = object()
    try:
        assert (
            SENTINEL_KERNEL_ID
            in execution_kernel_service.jupyter_manager._active_kernels
        )
    finally:
        kernel_service.jupyter_manager._active_kernels.pop(SENTINEL_KERNEL_ID, None)


def test_execution_tools_default_still_builds_its_own_service():
    """The shared instance is passed explicitly; the default stays standalone.

    Keeping the default is what lets callers that exercise execution_tools
    alone (and the unit tests that do) keep working -- the fix must be wiring,
    not a hidden cross-module reach into kernel_tools' global.
    """
    kernel_service = initialize_kernel_tools(MCPConfig())
    _notebook_service, standalone_service = initialize_execution_tools(MCPConfig())

    assert standalone_service is not kernel_service
    assert standalone_service.jupyter_manager is not kernel_service.jupyter_manager