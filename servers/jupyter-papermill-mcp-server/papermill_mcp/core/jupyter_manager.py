"""
Jupyter kernel management using jupyter_client.

Provides low-level kernel lifecycle management and interactive code execution.
"""

import asyncio
import json
import logging
import subprocess
import uuid
from typing import Dict, List, Optional, Any, Union
from dataclasses import dataclass, field
from datetime import datetime

import httpx
from jupyter_client import KernelManager, find_connection_file
from jupyter_client.kernelspec import KernelSpecManager

from ..config import get_config, MCPConfig


@dataclass
class ExecutionOutput:
    """Output from code execution."""
    output_type: str
    content: Dict[str, Any]
    metadata: Optional[Dict[str, Any]] = None
    execution_count: Optional[int] = None


@dataclass
class ExecutionResult:
    """Result from interactive code execution."""
    status: str  # 'ok', 'error', 'timeout'
    execution_count: int
    outputs: List[ExecutionOutput] = field(default_factory=list)
    text_output: str = ""
    error_name: Optional[str] = None
    error_value: Optional[str] = None
    traceback: Optional[List[str]] = None


@dataclass
class KernelInfo:
    """Information about an active kernel."""
    kernel_id: str
    kernel_name: str
    connection_file: str
    started_at: datetime
    last_activity: datetime
    status: str = "idle"  # idle, busy, starting, dead
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            'kernel_id': self.kernel_id,
            'kernel_name': self.kernel_name,
            'connection_file': self.connection_file,
            'started_at': self.started_at.isoformat(),
            'last_activity': self.last_activity.isoformat(),
            'status': self.status
        }


class JupyterManager:
    """
    Manages Jupyter kernels using jupyter_client.
    
    Provides functionality for:
    - Kernel lifecycle management (start, stop, restart)
    - Interactive code execution with IOPub message handling
    - Session management with optional Jupyter server integration
    - Kernel discovery and listing
    """
    
    def __init__(self, config: Optional[MCPConfig] = None):
        """
        Initialize JupyterManager with MCP configuration.
        
        Args:
            config: MCP configuration (uses global config if None)
        """
        self.config = config or get_config()
        self.logger = logging.getLogger(f"MCP.{self.__class__.__name__}")
        
        # Active kernels tracking
        self._active_kernels: Dict[str, KernelManager] = {}
        self._kernel_info: Dict[str, KernelInfo] = {}
        
        # Kernel spec manager for listing available kernels
        self._kernel_spec_manager = KernelSpecManager()
        
        # HTTP client for Jupyter server API (if needed)
        self._http_client: Optional[httpx.AsyncClient] = None
        
        self.logger.info("JupyterManager initialized")
    
    async def initialize_connection(self) -> bool:
        """
        Initialize connection to Jupyter server if configured.
        
        Returns:
            True if connection successful or not required, False otherwise
        """
        if self.config.offline_mode or self.config.skip_connection_check:
            self.logger.info("Skipping Jupyter server connection check (offline mode)")
            return True
        
        try:
            base_url = self.config.jupyter_server.base_url.rstrip('/')
            token = self.config.jupyter_server.token
            
            # Create HTTP client with authentication
            headers = {}
            if token:
                headers['Authorization'] = f'token {token}'
            
            self._http_client = httpx.AsyncClient(
                base_url=base_url,
                headers=headers,
                timeout=30.0
            )
            
            # Test connection to server
            response = await self._http_client.get('/api/status')
            response.raise_for_status()
            
            server_info = response.json()
            self.logger.info(f"Connected to Jupyter server at {base_url}")
            self.logger.info(f"Server version: {server_info.get('version', 'unknown')}")
            
            return True
            
        except Exception as e:
            self.logger.warning(f"Failed to connect to Jupyter server: {e}")
            if self._http_client:
                await self._http_client.aclose()
                self._http_client = None
            return False
    
    def list_available_kernels(self) -> Dict[str, Dict[str, Any]]:
        """
        List all available kernel specifications.
        
        Returns:
            Dictionary mapping kernel names to their specifications
        """
        try:
            # Get kernel specs from jupyter_client
            kernel_specs = self._kernel_spec_manager.get_all_specs()
            
            result = {}
            for name, spec in kernel_specs.items():
                result[name] = {
                    'name': name,
                    'spec': {
                        'display_name': spec.display_name,
                        'language': spec.language,
                        'argv': spec.argv,
                        'env': spec.env,
                        'resource_dir': spec.resource_dir
                    },
                    'resources': {}
                }
            
            self.logger.info(f"Found {len(result)} available kernels: {list(result.keys())}")
            return result
            
        except Exception as e:
            self.logger.error(f"Failed to list available kernels: {e}")
            return {}
    
    async def start_kernel(self, kernel_name: str = 'python3') -> str:
        """
        Start a new kernel instance.
        
        Args:
            kernel_name: Name of the kernel to start
            
        Returns:
            Unique kernel ID
            
        Raises:
            RuntimeError: If kernel fails to start
        """
        kernel_id = str(uuid.uuid4())
        
        try:
            # Create kernel manager
            km = KernelManager(kernel_name=kernel_name)
            
            # Start the kernel
            await asyncio.get_event_loop().run_in_executor(None, km.start_kernel)
            
            # Wait for kernel to be ready
            kc = km.client()
            await asyncio.get_event_loop().run_in_executor(None, kc.wait_for_ready, 30)
            
            # Store kernel info
            now = datetime.now()
            kernel_info = KernelInfo(
                kernel_id=kernel_id,
                kernel_name=kernel_name,
                connection_file=km.connection_file,
                started_at=now,
                last_activity=now,
                status="idle"
            )
            
            self._active_kernels[kernel_id] = km
            self._kernel_info[kernel_id] = kernel_info
            
            self.logger.info(f"Started kernel '{kernel_name}' with ID: {kernel_id}")
            return kernel_id
            
        except Exception as e:
            error_msg = f"Failed to start kernel '{kernel_name}': {e}"
            self.logger.error(error_msg)
            raise RuntimeError(error_msg)
    
    async def stop_kernel(self, kernel_id: str) -> bool:
        """
        Stop a running kernel.
        
        Args:
            kernel_id: ID of the kernel to stop
            
        Returns:
            True if kernel was stopped, False if not found
        """
        if kernel_id not in self._active_kernels:
            self.logger.warning(f"Kernel {kernel_id} not found in active kernels")
            return False
        
        try:
            km = self._active_kernels[kernel_id]
            
            # Shutdown the kernel
            await asyncio.get_event_loop().run_in_executor(None, km.shutdown_kernel)
            
            # Remove from tracking
            del self._active_kernels[kernel_id]
            del self._kernel_info[kernel_id]
            
            self.logger.info(f"Stopped kernel {kernel_id}")
            return True
            
        except Exception as e:
            self.logger.error(f"Error stopping kernel {kernel_id}: {e}")
            return False
    
    async def restart_kernel(self, kernel_id: str) -> bool:
        """
        Restart a running kernel.
        
        Args:
            kernel_id: ID of the kernel to restart
            
        Returns:
            True if kernel was restarted, False if not found
        """
        if kernel_id not in self._active_kernels:
            self.logger.warning(f"Kernel {kernel_id} not found in active kernels")
            return False
        
        try:
            km = self._active_kernels[kernel_id]
            kernel_info = self._kernel_info[kernel_id]
            
            # Restart the kernel
            await asyncio.get_event_loop().run_in_executor(None, km.restart_kernel)
            
            # Update info
            kernel_info.last_activity = datetime.now()
            kernel_info.status = "idle"
            
            self.logger.info(f"Restarted kernel {kernel_id}")
            return True
            
        except Exception as e:
            self.logger.error(f"Error restarting kernel {kernel_id}: {e}")
            return False
    
    async def interrupt_kernel(self, kernel_id: str) -> bool:
        """
        Interrupt a running kernel.
        
        Args:
            kernel_id: ID of the kernel to interrupt
            
        Returns:
            True if kernel was interrupted, False if not found
        """
        if kernel_id not in self._active_kernels:
            self.logger.warning(f"Kernel {kernel_id} not found in active kernels")
            return False
        
        try:
            km = self._active_kernels[kernel_id]
            
            # Interrupt the kernel
            await asyncio.get_event_loop().run_in_executor(None, km.interrupt_kernel)
            
            # Update info
            kernel_info = self._kernel_info[kernel_id]
            kernel_info.last_activity = datetime.now()
            kernel_info.status = "idle"
            
            self.logger.info(f"Interrupted kernel {kernel_id}")
            return True
            
        except Exception as e:
            self.logger.error(f"Error interrupting kernel {kernel_id}: {e}")
            return False
    
    async def execute_code(self, kernel_id: str, code: str, timeout: Optional[float] = None) -> ExecutionResult:
        """
        Execute code on a specific kernel.
        
        Args:
            kernel_id: ID of the kernel to use
            code: Code to execute
            timeout: Execution timeout in seconds
            
        Returns:
            ExecutionResult with outputs and status
            
        Raises:
            RuntimeError: If kernel not found or execution fails
        """
        if kernel_id not in self._active_kernels:
            raise RuntimeError(f"Kernel {kernel_id} not found")
        
        km = self._active_kernels[kernel_id]
        kernel_info = self._kernel_info[kernel_id]
        
        try:
            # Update status
            kernel_info.status = "busy"
            kernel_info.last_activity = datetime.now()
            
            # Get kernel client
            kc = km.client()
            
            # Execute code
            msg_id = kc.execute(code)
            
            # Collect outputs
            outputs = []
            text_output = ""
            execution_count = 0
            error_name = None
            error_value = None
            traceback = None
            status = "ok"
            
            # Process messages with timeout
            timeout = timeout or 60.0
            deadline = asyncio.get_event_loop().time() + timeout
            
            while asyncio.get_event_loop().time() < deadline:
                try:
                    # Check for messages
                    msg = await asyncio.get_event_loop().run_in_executor(
                        None, lambda: kc.get_iopub_msg(timeout=1.0)
                    )
                    
                    msg_type = msg['msg_type']
                    content = msg['content']
                    
                    self.logger.debug(f"Received message type: {msg_type}")
                    
                    if msg_type == 'stream':
                        text = content.get('text', '')
                        text_output += text
                        outputs.append(ExecutionOutput(
                            output_type='stream',
                            content={'name': content.get('name', 'stdout'), 'text': text}
                        ))
                    
                    elif msg_type == 'execute_result':
                        execution_count = content.get('execution_count', 0)
                        outputs.append(ExecutionOutput(
                            output_type='execute_result',
                            content=content.get('data', {}),
                            metadata=content.get('metadata', {}),
                            execution_count=execution_count
                        ))
                    
                    elif msg_type == 'display_data':
                        outputs.append(ExecutionOutput(
                            output_type='display_data',
                            content=content.get('data', {}),
                            metadata=content.get('metadata', {})
                        ))
                    
                    elif msg_type == 'error':
                        status = "error"
                        error_name = content.get('ename', 'Error')
                        error_value = content.get('evalue', '')
                        traceback = content.get('traceback', [])
                        text_output += f"{error_name}: {error_value}\n"
                        if traceback:
                            text_output += "\n".join(traceback)
                        
                        outputs.append(ExecutionOutput(
                            output_type='error',
                            content={
                                'ename': error_name,
                                'evalue': error_value,
                                'traceback': traceback
                            }
                        ))
                    
                    elif msg_type == 'status':
                        execution_state = content.get('execution_state')
                        if execution_state == 'idle':
                            # Execution completed
                            break
                
                except Exception:
                    # Timeout on get_iopub_msg is expected
                    continue
            
            # Check if we timed out
            if asyncio.get_event_loop().time() >= deadline:
                status = "timeout"
                self.logger.warning(f"Code execution timed out after {timeout}s")
            
            # Update kernel info
            kernel_info.status = "idle"
            kernel_info.last_activity = datetime.now()
            
            return ExecutionResult(
                status=status,
                execution_count=execution_count,
                outputs=outputs,
                text_output=text_output,
                error_name=error_name,
                error_value=error_value,
                traceback=traceback
            )
            
        except Exception as e:
            kernel_info.status = "idle"
            kernel_info.last_activity = datetime.now()
            
            error_msg = f"Code execution failed: {e}"
            self.logger.error(error_msg)
            
            return ExecutionResult(
                status="error",
                execution_count=0,
                outputs=[],
                text_output=str(e),
                error_name="ExecutionError",
                error_value=str(e)
            )
    
    def list_active_kernels(self) -> List[Dict[str, Any]]:
        """
        List all active kernels.
        
        Returns:
            List of kernel information dictionaries
        """
        return [info.to_dict() for info in self._kernel_info.values()]
    
    def get_kernel_info(self, kernel_id: str) -> Optional[Dict[str, Any]]:
        """
        Get information about a specific kernel.
        
        Args:
            kernel_id: ID of the kernel
            
        Returns:
            Kernel information dictionary or None if not found
        """
        info = self._kernel_info.get(kernel_id)
        return info.to_dict() if info else None
    
    async def get_sessions(self) -> List[Dict[str, Any]]:
        """
        Get active Jupyter sessions from server (if connected).
        
        Returns:
            List of session information
        """
        if not self._http_client:
            self.logger.warning("No Jupyter server connection available")
            return []
        
        try:
            response = await self._http_client.get('/api/sessions')
            response.raise_for_status()
            return response.json()
        except Exception as e:
            self.logger.error(f"Failed to get sessions: {e}")
            return []
    
    async def close(self):
        """Clean up resources and stop all kernels."""
        # Stop all active kernels
        kernel_ids = list(self._active_kernels.keys())
        for kernel_id in kernel_ids:
            await self.stop_kernel(kernel_id)
        
        # Close HTTP client
        if self._http_client:
            await self._http_client.aclose()
            self._http_client = None
        
        self.logger.info("JupyterManager closed")


# Singleton instance for the MCP server
_jupyter_manager: Optional[JupyterManager] = None


def get_jupyter_manager() -> JupyterManager:
    """Get the global JupyterManager instance."""
    global _jupyter_manager
    if _jupyter_manager is None:
        _jupyter_manager = JupyterManager()
    return _jupyter_manager


async def close_jupyter_manager():
    """Close the global JupyterManager instance."""
    global _jupyter_manager
    if _jupyter_manager is not None:
        await _jupyter_manager.close()
        _jupyter_manager = None