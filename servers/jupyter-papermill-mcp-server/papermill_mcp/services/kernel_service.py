"""
Kernel service for managing Jupyter kernel operations.

Provides business logic for kernel lifecycle and execution operations,
using the JupyterManager for low-level kernel interactions.
"""

import asyncio
import logging
from typing import Dict, List, Optional, Any, Union

from ..core.jupyter_manager import JupyterManager, ExecutionResult
from ..config import MCPConfig

logger = logging.getLogger(__name__)


class KernelService:
    """Service class for kernel operations."""
    
    def __init__(self, config: MCPConfig):
        """
        Initialize the kernel service.
        
        Args:
            config: MCP configuration object
        """
        self.config = config
        self.jupyter_manager = JupyterManager(config)
    
    async def list_kernels(self) -> Dict[str, Any]:
        """
        List all available and active kernels.
        
        Returns:
            Dictionary with available and active kernel information
        """
        try:
            logger.info("Listing kernels")
            
            # Get available kernelspecs - NO await needed, these are sync methods!
            available_kernels = self.jupyter_manager.list_available_kernels()
            
            # Get active kernels - NO await needed, these are sync methods!
            active_kernels = self.jupyter_manager.list_active_kernels()
            
            result = {
                "available_kernels": available_kernels,
                "active_kernels": active_kernels,
                "total_available": len(available_kernels),
                "total_active": len(active_kernels)
            }
            
            logger.info(f"Found {len(available_kernels)} available kernels, {len(active_kernels)} active")
            return result
            
        except Exception as e:
            logger.error(f"Error listing kernels: {e}")
            raise
    
    async def start_kernel(self, kernel_name: str = "python3") -> Dict[str, Any]:
        """
        Start a new kernel.
        
        Args:
            kernel_name: Name of the kernel to start
            
        Returns:
            Dictionary with kernel startup information
        """
        try:
            logger.info(f"Starting kernel: {kernel_name}")
            
            kernel_id = await self.jupyter_manager.start_kernel(kernel_name)
            
            result = {
                "kernel_id": kernel_id,
                "kernel_name": kernel_name,
                "status": "started",
                "success": True
            }
            
            logger.info(f"Successfully started kernel {kernel_name} with ID {kernel_id}")
            return result
            
        except Exception as e:
            logger.error(f"Error starting kernel {kernel_name}: {e}")
            raise
    
    async def stop_kernel(self, kernel_id: str) -> Dict[str, Any]:
        """
        Stop an active kernel.
        
        Args:
            kernel_id: ID of the kernel to stop
            
        Returns:
            Dictionary with operation result
        """
        try:
            logger.info(f"Stopping kernel: {kernel_id}")
            
            await self.jupyter_manager.stop_kernel(kernel_id)
            
            result = {
                "kernel_id": kernel_id,
                "status": "stopped",
                "success": True
            }
            
            logger.info(f"Successfully stopped kernel {kernel_id}")
            return result
            
        except Exception as e:
            logger.error(f"Error stopping kernel {kernel_id}: {e}")
            raise
    
    async def interrupt_kernel(self, kernel_id: str) -> Dict[str, Any]:
        """
        Interrupt a running kernel.
        
        Args:
            kernel_id: ID of the kernel to interrupt
            
        Returns:
            Dictionary with operation result
        """
        try:
            logger.info(f"Interrupting kernel: {kernel_id}")
            
            await self.jupyter_manager.interrupt_kernel(kernel_id)
            
            result = {
                "kernel_id": kernel_id,
                "status": "interrupted",
                "success": True
            }
            
            logger.info(f"Successfully interrupted kernel {kernel_id}")
            return result
            
        except Exception as e:
            logger.error(f"Error interrupting kernel {kernel_id}: {e}")
            raise
    
    async def restart_kernel(self, kernel_id: str) -> Dict[str, Any]:
        """
        Restart a kernel.
        
        Args:
            kernel_id: ID of the kernel to restart
            
        Returns:
            Dictionary with restart result
        """
        try:
            logger.info(f"Restarting kernel: {kernel_id}")
            
            new_kernel_id = await self.jupyter_manager.restart_kernel(kernel_id)
            
            result = {
                "old_kernel_id": kernel_id,
                "kernel_id": new_kernel_id,
                "status": "restarted",
                "success": True
            }
            
            logger.info(f"Successfully restarted kernel, new ID: {new_kernel_id}")
            return result
            
        except Exception as e:
            logger.error(f"Error restarting kernel {kernel_id}: {e}")
            raise
    
    async def execute_cell(self, kernel_id: str, code: str, timeout: float = 60.0) -> Dict[str, Any]:
        """
        Execute code in a specific kernel.
        
        Args:
            kernel_id: ID of the kernel to use
            code: Code to execute
            timeout: Maximum execution time in seconds
            
        Returns:
            Dictionary with execution result
        """
        try:
            logger.info(f"Executing code in kernel {kernel_id}")
            logger.debug(f"Code to execute: {code[:100]}{'...' if len(code) > 100 else ''}")
            
            # Execute code using JupyterManager
            result = await self.jupyter_manager.execute_code(kernel_id, code, timeout)
            
            # Convert ExecutionResult to dictionary
            # Important: Convert ExecutionOutput objects to dictionaries for JSON serialization
            outputs_dict = []
            for output in result.outputs:
                if hasattr(output, '__dict__'):
                    # Convert dataclass to dict
                    output_dict = {
                        'output_type': output.output_type,
                        'content': output.content
                    }
                    if hasattr(output, 'metadata') and output.metadata:
                        output_dict['metadata'] = output.metadata
                    if hasattr(output, 'execution_count') and output.execution_count is not None:
                        output_dict['execution_count'] = output.execution_count
                    outputs_dict.append(output_dict)
                else:
                    outputs_dict.append(output)
            
            execution_dict = {
                "kernel_id": kernel_id,
                "execution_count": result.execution_count,
                "status": result.status,
                "outputs": outputs_dict,
                "error": result.error_name or result.error_value if (result.error_name or result.error_value) else None,
                "execution_time": getattr(result, 'execution_time', None),
                "success": result.status == "ok"
            }
            
            logger.info(f"Code execution completed with status: {result.status}")
            return execution_dict
            
        except Exception as e:
            logger.error(f"Error executing code in kernel {kernel_id}: {e}")
            raise
    
    async def execute_notebook_in_kernel(self, kernel_id: str, notebook_path: str) -> Dict[str, Any]:
        """
        Execute all code cells in a notebook using a specific kernel.
        
        Args:
            kernel_id: ID of the kernel to use
            notebook_path: Path to the notebook to execute
            
        Returns:
            Dictionary with execution results for all cells
        """
        try:
            logger.info(f"Executing notebook {notebook_path} in kernel {kernel_id}")
            
            from ..utils.file_utils import FileUtils
            
            # Read the notebook
            notebook = FileUtils.read_notebook(notebook_path)
            
            results = []
            total_execution_time = 0.0
            
            # Execute each code cell
            for i, cell in enumerate(notebook.cells):
                if cell.cell_type == "code" and cell.source.strip():
                    logger.info(f"Executing cell {i}")
                    
                    try:
                        # Execute the cell
                        cell_result = await self.jupyter_manager.execute_code(
                            kernel_id, 
                            cell.source,
                            timeout=self.config.execution_timeout
                        )
                        
                        cell_dict = {
                            "cell_index": i,
                            "execution_count": cell_result.execution_count,
                            "status": cell_result.status,
                            "outputs": cell_result.outputs,
                            "error": cell_result.error_name or cell_result.error_value if (cell_result.error_name or cell_result.error_value) else None,
                            "execution_time": getattr(cell_result, 'execution_time', None)
                        }
                        
                        total_execution_time += cell_result.execution_time
                        results.append(cell_dict)
                        
                        # Stop on error if configured to do so
                        if cell_result.status == "error" and not self.config.continue_on_error:
                            logger.warning(f"Stopping execution due to error in cell {i}")
                            break
                            
                    except Exception as cell_error:
                        logger.error(f"Error executing cell {i}: {cell_error}")
                        
                        cell_dict = {
                            "cell_index": i,
                            "status": "error",
                            "error": str(cell_error),
                            "execution_time": 0.0
                        }
                        results.append(cell_dict)
                        
                        if not self.config.continue_on_error:
                            break
            
            # Summary
            successful_cells = sum(1 for r in results if r["status"] == "ok")
            error_cells = sum(1 for r in results if r["status"] == "error")
            
            result = {
                "kernel_id": kernel_id,
                "notebook_path": notebook_path,
                "total_cells": len([c for c in notebook.cells if c.cell_type == "code"]),
                "executed_cells": len(results),
                "successful_cells": successful_cells,
                "error_cells": error_cells,
                "total_execution_time": total_execution_time,
                "results": results,
                "success": error_cells == 0
            }
            
            logger.info(f"Notebook execution completed: {successful_cells} successful, {error_cells} errors")
            return result
            
        except Exception as e:
            logger.error(f"Error executing notebook {notebook_path} in kernel {kernel_id}: {e}")
            raise
    
    async def execute_notebook_cell(self, notebook_path: str, cell_index: int, kernel_id: str) -> Dict[str, Any]:
        """
        Execute a specific cell from a notebook in a kernel.
        
        Args:
            notebook_path: Path to the notebook
            cell_index: Index of the cell to execute
            kernel_id: ID of the kernel to use
            
        Returns:
            Dictionary with cell execution result
        """
        try:
            logger.info(f"Executing cell {cell_index} from notebook {notebook_path} in kernel {kernel_id}")
            
            from ..utils.file_utils import FileUtils
            
            # Read the notebook
            notebook = FileUtils.read_notebook(notebook_path)
            
            # Check bounds
            if cell_index < 0 or cell_index >= len(notebook.cells):
                raise IndexError(f"Cell index {cell_index} out of range (0-{len(notebook.cells)-1})")
            
            cell = notebook.cells[cell_index]
            
            # Only execute code cells
            if cell.cell_type != "code":
                raise ValueError(f"Cell {cell_index} is not a code cell (type: {cell.cell_type})")
            
            if not cell.source.strip():
                result = {
                    "notebook_path": notebook_path,
                    "cell_index": cell_index,
                    "kernel_id": kernel_id,
                    "status": "ok",
                    "outputs": [],
                    "execution_time": 0.0,
                    "message": "Empty cell, nothing to execute"
                }
                return result
            
            # Execute the cell
            cell_result = await self.jupyter_manager.execute_code(
                kernel_id,
                cell.source,
                timeout=self.config.execution_timeout
            )
            
            result = {
                "notebook_path": notebook_path,
                "cell_index": cell_index,
                "kernel_id": kernel_id,
                "execution_count": cell_result.execution_count,
                "status": cell_result.status,
                "outputs": cell_result.outputs,
                "error": cell_result.error_name or cell_result.error_value if (cell_result.error_name or cell_result.error_value) else None,
                "execution_time": getattr(cell_result, 'execution_time', None),
                "success": cell_result.status == "ok"
            }
            
            logger.info(f"Cell {cell_index} execution completed with status: {cell_result.status}")
            return result
            
        except Exception as e:
            logger.error(f"Error executing cell {cell_index} from notebook {notebook_path}: {e}")
            raise
    
    async def get_kernel_status(self, kernel_id: str) -> Dict[str, Any]:
        """
        Get the status of a specific kernel.
        
        Args:
            kernel_id: ID of the kernel to check
            
        Returns:
            Dictionary with kernel status information
        """
        try:
            logger.info(f"Getting status for kernel: {kernel_id}")
            
            # Check if kernel exists in active kernels - NO await needed, this is a sync method!
            active_kernels = self.jupyter_manager.list_active_kernels()
            
            kernel_info = None
            for kernel in active_kernels:
                if kernel["kernel_id"] == kernel_id:
                    kernel_info = kernel
                    break
            
            if not kernel_info:
                result = {
                    "kernel_id": kernel_id,
                    "status": "not_found",
                    "exists": False
                }
            else:
                result = {
                    "kernel_id": kernel_id,
                    "kernel_name": kernel_info["kernel_name"],
                    "status": "active",
                    "exists": True,
                    "execution_state": kernel_info.get("execution_state", "unknown"),
                    "connections": kernel_info.get("connections", 0)
                }
            
            logger.info(f"Kernel {kernel_id} status: {result['status']}")
            return result
            
        except Exception as e:
            logger.error(f"Error getting status for kernel {kernel_id}: {e}")
            raise
    
    async def cleanup_kernels(self) -> Dict[str, Any]:
        """
        Clean up all active kernels.
        
        Returns:
            Dictionary with cleanup results
        """
        try:
            logger.info("Cleaning up all kernels")
            
            # Get list of active kernels
            active_kernels = self.jupyter_manager.list_active_kernels()
            
            cleanup_results = []
            for kernel in active_kernels:
                kernel_id = kernel["kernel_id"]
                try:
                    await self.jupyter_manager.stop_kernel(kernel_id)
                    cleanup_results.append({
                        "kernel_id": kernel_id,
                        "status": "stopped",
                        "success": True
                    })
                    logger.info(f"Stopped kernel {kernel_id}")
                except Exception as e:
                    cleanup_results.append({
                        "kernel_id": kernel_id,
                        "status": "error",
                        "error": str(e),
                        "success": False
                    })
                    logger.error(f"Error stopping kernel {kernel_id}: {e}")
            
            successful_cleanups = sum(1 for r in cleanup_results if r["success"])
            
            result = {
                "total_kernels": len(active_kernels),
                "successful_cleanups": successful_cleanups,
                "failed_cleanups": len(active_kernels) - successful_cleanups,
                "results": cleanup_results,
                "success": successful_cleanups == len(active_kernels)
            }
            
            logger.info(f"Cleanup completed: {successful_cleanups}/{len(active_kernels)} kernels stopped")
            return result
            
        except Exception as e:
            logger.error(f"Error during kernel cleanup: {e}")
            raise