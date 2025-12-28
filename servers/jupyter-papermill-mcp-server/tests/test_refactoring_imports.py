import sys
import os
import asyncio
from pathlib import Path

# Add project root to sys.path
project_root = Path(__file__).parent.parent
sys.path.append(str(project_root))

print(f"Testing imports from {project_root}")

try:
    # 1. Test AsyncJobService extraction
    from papermill_mcp.services.notebook_service import ExecutionManager, get_execution_manager
    from papermill_mcp.services.async_job_service import AsyncJobService
    
    assert ExecutionManager is AsyncJobService, "ExecutionManager alias should point to AsyncJobService"
    print("✅ AsyncJobService extraction passed")
    
    # 2. Test NotebookService splitting and instantiation
    from papermill_mcp.config import MCPConfig
    from papermill_mcp.services.notebook_service import NotebookService
    
    config = MCPConfig()
    notebook_service = NotebookService(config)
    
    assert notebook_service.crud_service is not None, "CRUD service not initialized"
    assert notebook_service.validation_service is not None, "Validation service not initialized"
    assert notebook_service.metadata_service is not None, "Metadata service not initialized"
    print("✅ NotebookService instantiation passed")
    
    # 3. Test KernelService cleaning
    from papermill_mcp.services.kernel_service import KernelService
    kernel_service = KernelService(config)
    
    # Check if deprecated methods are removed (by checking if they raise AttributeError)
    try:
        getattr(kernel_service, "manage_kernel_consolidated")
        print("❌ manage_kernel_consolidated still exists in KernelService")
    except AttributeError:
        print("✅ KernelService cleaning passed (manage_kernel_consolidated removed)")
        
    # 4. Test Execution Tools registration
    from papermill_mcp.tools.execution_tools import initialize_execution_tools, get_services
    
    initialize_execution_tools(config)
    nb_service, k_service = get_services()
    
    assert isinstance(nb_service, NotebookService), "get_services returned wrong NotebookService type"
    assert isinstance(k_service, KernelService), "get_services returned wrong KernelService type"
    print("✅ Execution tools initialization passed")

    print("\n🎉 ALL REFACTORING CHECKS PASSED!")
    
except Exception as e:
    print(f"\n❌ Refactoring validation failed: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)