"""
Papermill executor for MCP server.

Adapted from the robust CoursIA implementation for MCP server usage.
"""

import asyncio
import json
import logging
import os
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Any

import papermill as pm
from papermill.exceptions import PapermillExecutionError

from ..config import get_config, MCPConfig
from ..utils.dotnet_environment import inject_dotnet_environment


@dataclass
class ExecutionMetrics:
    """Execution metrics for monitoring."""
    start_time: datetime = field(default_factory=datetime.now)
    end_time: Optional[datetime] = None
    total_cells: int = 0
    executed_cells: int = 0
    failed_cells: int = 0
    execution_time_seconds: float = 0.0
    cells_per_second: float = 0.0
    kernel_used: Optional[str] = None
    
    @property
    def is_complete(self) -> bool:
        return self.end_time is not None
    
    @property
    def success_rate(self) -> float:
        """Calculate success rate based on executed cells."""
        if self.executed_cells == 0:
            return 0.0
        return ((self.executed_cells - self.failed_cells) / self.executed_cells) * 100


@dataclass
class ExecutionResult:
    """Complete notebook execution result."""
    success: bool
    input_path: str
    output_path: Optional[str]
    metrics: ExecutionMetrics
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    output_content: Optional[str] = None
    
    def to_dict(self) -> Dict[str, Any]:
        """Export for JSON responses."""
        return {
            'success': self.success,
            'input_path': self.input_path,
            'output_path': self.output_path,
            'metrics': {
                'execution_time': self.metrics.execution_time_seconds,
                'cells_per_second': self.metrics.cells_per_second,
                'success_rate': self.metrics.success_rate,
                'kernel': self.metrics.kernel_used,
                'total_cells': self.metrics.total_cells,
                'executed_cells': self.metrics.executed_cells,
                'failed_cells': self.metrics.failed_cells
            },
            'errors': self.errors,
            'warnings': self.warnings,
            'timestamp': self.metrics.start_time.isoformat()
        }


class PapermillExecutor:
    """
    Robust Papermill wrapper for MCP server.
    
    Features:
    - Auto-detection of available kernels
    - Asynchronous execution with progress tracking
    - Error handling with detailed context
    - Configurable timeouts and output directories
    - Integration with MCP configuration system
    """
    
    def __init__(self, config: Optional[MCPConfig] = None):
        """
        Initialize PapermillExecutor with MCP configuration.
        
        Args:
            config: MCP configuration instance (uses global config if None)
        """
        self.config = config or get_config()
        self.logger = logging.getLogger(f"MCP.{self.__class__.__name__}")
        
        # Thread pool for async execution
        self._executor = ThreadPoolExecutor(max_workers=2)
        
        # Cache for available kernels
        self._available_kernels: Optional[Dict[str, Dict[str, Any]]] = None
        
        # Ensure output directory exists
        output_dir = Path(self.config.papermill.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        
        self.logger.info(f"PapermillExecutor initialized with output_dir: {output_dir}")
    
    def _get_available_kernels(self) -> Dict[str, Dict[str, Any]]:
        """
        Auto-detect available kernels.
        
        Returns:
            Dict mapping kernel names to their specifications
        """
        if self._available_kernels is not None:
            return self._available_kernels
            
        try:
            result = subprocess.run([
                'jupyter', 'kernelspec', 'list', '--json'
            ], capture_output=True, text=True, timeout=15)
            
            if result.returncode == 0:
                kernel_data = json.loads(result.stdout)
                self._available_kernels = kernel_data.get('kernelspecs', {})
                
                kernel_names = list(self._available_kernels.keys())
                self.logger.info(f"Available kernels detected: {kernel_names}")
                
                return self._available_kernels
            else:
                self.logger.warning(f"Failed to detect kernels: {result.stderr}")
                return {}
                
        except Exception as e:
            self.logger.warning(f"Error detecting kernels: {e}")
            return {}
    
    def _auto_detect_kernel(self, notebook_path: str) -> Optional[str]:
        """
        Auto-detect optimal kernel for notebook.
        
        Args:
            notebook_path: Path to the notebook file
            
        Returns:
            Best kernel name or None if detection fails
        """
        try:
            with open(notebook_path, 'r', encoding='utf-8') as f:
                nb_data = json.load(f)
            
            # Extract kernel from metadata
            kernel_spec = nb_data.get('metadata', {}).get('kernelspec', {})
            preferred_kernel = kernel_spec.get('name')
            
            if preferred_kernel:
                available_kernels = self._get_available_kernels()
                if preferred_kernel in available_kernels:
                    self.logger.info(f"Kernel detected from metadata: {preferred_kernel}")
                    return preferred_kernel
                else:
                    self.logger.warning(f"Preferred kernel '{preferred_kernel}' not available")
            
            # Fallback heuristics
            nb_content = str(nb_data).lower()
            available_kernels = self._get_available_kernels()
            
            if ('.net' in nb_content or 'csharp' in nb_content) and '.net-csharp' in available_kernels:
                return '.net-csharp'
            
            # Default Python for most notebooks
            if 'python3' in available_kernels:
                return 'python3'
            elif 'python' in available_kernels:
                return 'python'
            
            # Return first available kernel as last resort
            return list(available_kernels.keys())[0] if available_kernels else None
            
        except Exception as e:
            self.logger.warning(f"Failed to auto-detect kernel: {e}")
            return None
    
    def _generate_output_path(self, input_path: str, suffix: str = "-output") -> str:
        """Generate output path with MCP naming convention."""
        path_obj = Path(input_path)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        output_name = f"{path_obj.stem}{suffix}_{timestamp}{path_obj.suffix}"
        return str(Path(self.config.papermill.output_dir) / output_name)
    
    async def execute_notebook(self, 
                             input_path: str,
                             output_path: Optional[str] = None,
                             parameters: Optional[Dict[str, Any]] = None,
                             kernel: Optional[str] = None,
                             timeout: Optional[int] = None) -> ExecutionResult:
        """
        Execute notebook with robust error handling.
        
        Args:
            input_path: Path to input notebook
            output_path: Path for output notebook (auto-generated if None)
            parameters: Parameters to inject into notebook
            kernel: Specific kernel to use (auto-detected if None)
            timeout: Execution timeout (uses config default if None)
        
        Returns:
            ExecutionResult with metrics and error details
        """
        metrics = ExecutionMetrics()
        metrics.start_time = datetime.now()
        
        # Validate input path
        if not os.path.exists(input_path):
            error_msg = f"Input notebook not found: {input_path}"
            self.logger.error(error_msg)
            return ExecutionResult(
                success=False, 
                input_path=input_path, 
                output_path=None,
                metrics=metrics,
                errors=[error_msg]
            )
        
        # Generate output path if needed
        if output_path is None:
            output_path = self._generate_output_path(input_path)
        
        # Auto-detect kernel if needed
        if kernel is None:
            kernel = self._auto_detect_kernel(input_path)
            if kernel is None:
                available_kernels = list(self._get_available_kernels().keys())
                error_msg = f"No suitable kernel found. Available kernels: {available_kernels}"
                self.logger.error(error_msg)
                return ExecutionResult(
                    success=False,
                    input_path=input_path,
                    output_path=output_path,
                    metrics=metrics,
                    errors=[error_msg]
                )
                
        metrics.kernel_used = kernel
        
        # Configure timeout
        timeout = timeout or self.config.papermill.timeout
        
        self.logger.info(f"Starting notebook execution: {Path(input_path).name}")
        self.logger.info(f"  Kernel: {kernel}")
        self.logger.info(f"  Timeout: {timeout}s")
        self.logger.info(f"  Output: {output_path}")
        if parameters:
            self.logger.info(f"  Parameters: {list(parameters.keys())}")
        
        try:
            # Execute Papermill in thread pool
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(
                self._executor,
                self._execute_papermill_sync,
                input_path, output_path, parameters, kernel, timeout, metrics
            )
            
            return result
            
        except Exception as e:
            metrics.end_time = datetime.now()
            metrics.execution_time_seconds = (metrics.end_time - metrics.start_time).total_seconds()
            
            error_msg = f"Execution failed: {str(e)}"
            self.logger.error(error_msg)
            
            return ExecutionResult(
                success=False,
                input_path=input_path,
                output_path=output_path,
                metrics=metrics,
                errors=[error_msg]
            )
    
    def _execute_papermill_sync(self,
                               input_path: str,
                               output_path: str,
                               parameters: Optional[Dict[str, Any]],
                               kernel: str,
                               timeout: int,
                               metrics: ExecutionMetrics) -> ExecutionResult:
        """
        Synchronous Papermill execution avec injection d'environnement .NET.
        
        SOLUTION DÉFINITIVE SDDD : Résolution du problème héritage d'environnement
        insuffisant du processus MCP parent vers le kernel .NET enfant.
        """
        
        try:
            # Working Directory comme papermill-coursia
            notebook_dir = os.path.dirname(os.path.abspath(input_path))
            original_cwd = os.getcwd()
            os.chdir(notebook_dir)
            
            self.logger.info(f"📁 Working directory: {notebook_dir}")
            
            # Configure Papermill parameters
            pm_kwargs = {
                'input_path': input_path,
                'output_path': output_path,
                'parameters': parameters or {},
                'kernel_name': kernel,
                'progress_bar': False,  # Disable for MCP server
                'log_output': True,
                'request_timeout': timeout
            }
            
            # Execute with timing + INJECTION D'ENVIRONNEMENT .NET
            start_exec = time.time()
            
            try:
                # SOLUTION DÉFINITIVE : Injection d'environnement .NET pour kernel
                # Résout l'erreur "Value cannot be null. (Parameter 'path1')"
                with inject_dotnet_environment() as injected_vars:
                    if injected_vars:
                        self.logger.info(f"🔧 .NET environment injected: {len(injected_vars)} variables")
                        # Log des variables critiques pour debug
                        critical_vars = ['DOTNET_ROOT', 'MSBuildSDKsPath', 'NUGET_PACKAGES']
                        for var in critical_vars:
                            if var in injected_vars:
                                self.logger.debug(f"  ✅ {var}={injected_vars[var]}")
                    else:
                        self.logger.warning("⚠️  No .NET environment variables injected")
                    
                    # Exécution Papermill avec environnement .NET enrichi
                    result_nb = pm.execute_notebook(**pm_kwargs)
            finally:
                # Restauration working directory original
                os.chdir(original_cwd)
            
            end_exec = time.time()
            
            # Calculate metrics
            metrics.end_time = datetime.now()
            metrics.execution_time_seconds = end_exec - start_exec
            
            # Extract metrics from result notebook
            if result_nb and hasattr(result_nb, 'cells'):
                metrics.total_cells = len(result_nb.cells)
                metrics.executed_cells = sum(1 for cell in result_nb.cells
                                           if cell.cell_type == 'code' and
                                           hasattr(cell, 'execution_count') and
                                           cell.execution_count is not None)
                metrics.failed_cells = sum(1 for cell in result_nb.cells
                                         if cell.cell_type == 'code' and
                                         hasattr(cell, 'outputs') and
                                         any(output.get('output_type') == 'error' 
                                             for output in cell.outputs))
            
            if metrics.execution_time_seconds > 0:
                metrics.cells_per_second = metrics.total_cells / metrics.execution_time_seconds
            
            # Read output content for potential return
            output_content = None
            if os.path.exists(output_path):
                try:
                    with open(output_path, 'r', encoding='utf-8') as f:
                        output_content = f.read()
                except Exception as e:
                    self.logger.warning(f"Failed to read output content: {e}")
            
            self.logger.info(f"Execution successful in {metrics.execution_time_seconds:.2f}s")
            self.logger.info(f"Performance: {metrics.cells_per_second:.2f} cells/s")
            
            return ExecutionResult(
                success=True,
                input_path=input_path,
                output_path=output_path,
                metrics=metrics,
                output_content=output_content
            )
            
        except PapermillExecutionError as e:
            metrics.end_time = datetime.now()
            metrics.execution_time_seconds = (metrics.end_time - metrics.start_time).total_seconds()
            
            # Extract educational error context
            error_details = self._extract_error_context(e)
            
            return ExecutionResult(
                success=False,
                input_path=input_path,
                output_path=output_path,
                metrics=metrics,
                errors=[f"Papermill execution error: {str(e)}"] + error_details
            )
    
    def _extract_error_context(self, error: PapermillExecutionError) -> List[str]:
        """Extract meaningful error context for MCP responses."""
        context = []
        error_str = str(error).lower()
        
        # Common error patterns
        if 'modulenotfounderror' in error_str:
            context.append("Suggestion: Check that required Python packages are installed")
        elif 'filenotfounderror' in error_str:
            context.append("Suggestion: Verify file paths in the notebook")
        elif 'timeout' in error_str:
            context.append("Suggestion: Increase timeout or optimize slow code")
        elif 'kernel' in error_str:
            context.append("Suggestion: Check kernel configuration and availability")
        elif 'memory' in error_str:
            context.append("Suggestion: Reduce memory usage or increase available memory")
            
        return context
    
    async def list_available_kernels(self) -> Dict[str, Dict[str, Any]]:
        """
        List all available kernels asynchronously.
        
        Returns:
            Dict mapping kernel names to their specifications
        """
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(self._executor, self._get_available_kernels)
    
    def close(self):
        """Clean up resources."""
        self._executor.shutdown(wait=True)
        self.logger.info("PapermillExecutor closed")


# Singleton instance for the MCP server
_papermill_executor: Optional[PapermillExecutor] = None


def get_papermill_executor() -> PapermillExecutor:
    """Get the global PapermillExecutor instance."""
    global _papermill_executor
    if _papermill_executor is None:
        _papermill_executor = PapermillExecutor()
    return _papermill_executor


def close_papermill_executor():
    """Close the global PapermillExecutor instance."""
    global _papermill_executor
    if _papermill_executor is not None:
        _papermill_executor.close()
        _papermill_executor = None # Force reload
