"""
Jupyter kernel management using jupyter_client.

Provides low-level kernel lifecycle management and interactive code execution.
"""

import asyncio
import json
import logging
import subprocess
import sys
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

    status: str  # 'ok', 'error', 'timeout', 'running'
    execution_count: int
    outputs: List[ExecutionOutput] = field(default_factory=list)
    text_output: str = ""
    error_name: Optional[str] = None
    error_value: Optional[str] = None
    traceback: Optional[List[str]] = None


@dataclass
class StreamExecution:
    """Tracks a streaming execution with incremental output collection."""

    execution_id: str
    kernel_id: str
    code: str
    started_at: datetime
    status: str = "running"  # running, ok, error, timeout
    outputs: List[ExecutionOutput] = field(default_factory=list)
    text_output: str = ""
    execution_count: int = 0
    error_name: Optional[str] = None
    error_value: Optional[str] = None
    completed_at: Optional[datetime] = None


@dataclass
class KernelInfo:
    """Information about an active kernel."""

    kernel_id: str
    kernel_name: str
    connection_file: str
    started_at: datetime
    last_activity: datetime
    status: str = "idle"  # idle, busy, starting, dead, unresponsive

    def to_dict(self) -> Dict[str, Any]:
        return {
            "kernel_id": self.kernel_id,
            "kernel_name": self.kernel_name,
            "connection_file": self.connection_file,
            "started_at": self.started_at.isoformat(),
            "last_activity": self.last_activity.isoformat(),
            "status": self.status,
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

        # Streaming executions: execution_id -> StreamExecution
        self._stream_executions: Dict[str, StreamExecution] = {}

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
            base_url = self.config.jupyter_server.base_url.rstrip("/")
            token = self.config.jupyter_server.token

            # Create HTTP client with authentication
            headers = {}
            if token:
                headers["Authorization"] = f"token {token}"

            self._http_client = httpx.AsyncClient(
                base_url=base_url, headers=headers, timeout=30.0
            )

            # Test connection to server
            response = await self._http_client.get("/api/status")
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
                # spec peut être un dict ou un objet, gérons les deux cas
                if isinstance(spec, dict):
                    result[name] = {"name": name, "spec": spec, "resources": {}}
                else:
                    result[name] = {
                        "name": name,
                        "spec": {
                            "display_name": getattr(spec, "display_name", name),
                            "language": getattr(spec, "language", "unknown"),
                            "argv": getattr(spec, "argv", []),
                            "env": getattr(spec, "env", {}),
                            "resource_dir": getattr(spec, "resource_dir", None),
                        },
                        "resources": {},
                    }

            self.logger.info(
                f"Found {len(result)} available kernels: {list(result.keys())}"
            )
            return result

        except Exception as e:
            self.logger.error(f"Failed to list available kernels: {e}")
            return {}

    def list_active_kernels(self) -> List[Dict[str, Any]]:
        """
        List currently active (running) kernels with their metadata.

        Returns:
            List of kernel info dicts (kernel_id, kernel_name, status,
            started_at, last_activity, connection_file).
        """
        try:
            return [
                info.to_dict()
                for info in self._kernel_info.values()
            ]
        except Exception as e:
            self.logger.error(f"Failed to list active kernels: {e}")
            return []

    async def start_kernel(self, kernel_name: str = "python3") -> str:
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
        km: Optional[KernelManager] = None

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
                status="idle",
            )

            self._active_kernels[kernel_id] = km
            self._kernel_info[kernel_id] = kernel_info

            self.logger.info(f"Started kernel '{kernel_name}' with ID: {kernel_id}")
            return kernel_id

        except Exception as e:
            # #3346: km.start_kernel() may have spawned the kernel process before
            # the failure (e.g. IOException during the wait_for_ready handshake on
            # slow-starting .NET kernels). The kernel is not registered yet, so
            # nothing would ever shut it down -- kill it boundedly or the process
            # leaks with no registry entry.
            if km is not None:
                # Tree-kill before the direct-child kill: a .NET kernelspec
                # wrapper (dotnet.exe) has the real kernel as a grandchild.
                tree_kill = await self._kill_process_tree(km)
                if tree_kill and not tree_kill.get("killed"):
                    self.logger.warning(
                        f"#3346 process-tree kill after failed start of "
                        f"'{kernel_name}': {tree_kill}"
                    )
                try:
                    await asyncio.wait_for(
                        asyncio.get_event_loop().run_in_executor(
                            None, lambda: km.shutdown_kernel(now=True)
                        ),
                        timeout=15.0,
                    )
                    self.logger.info(
                        f"Cleaned up spawned kernel process after failed start "
                        f"of '{kernel_name}'"
                    )
                except Exception as cleanup_err:
                    self.logger.error(
                        f"#3346 failed to clean up spawned kernel after start "
                        f"failure of '{kernel_name}' "
                        f"(connection file: {getattr(km, 'connection_file', 'unknown')}): "
                        f"{cleanup_err}"
                    )
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

    async def execute_code(
        self, kernel_id: str, code: str, timeout: Optional[float] = None
    ) -> ExecutionResult:
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

        # #2718: refuse to re-queue on a kernel marked "unresponsive" after a prior
        # non-cooperative timeout (e.g. .NET nuget restore). Executing on a kernel
        # that is still busy at the native layer would block past the deadline again.
        # The caller must restart the kernel to recover -- restart_kernel() resets
        # status to "idle".
        if kernel_info.status == "unresponsive":
            raise RuntimeError(
                f"Kernel {kernel_id} is marked 'unresponsive' after a prior "
                f"non-cooperative timeout. Restart it with "
                f"manage_kernel(action='restart') before executing new code."
            )

        # #3346: these are read by the finally block below, so they must exist
        # on every exit path (including exceptions raised before the loop).
        status = "ok"
        cancelled = False

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

                    msg_type = msg["msg_type"]
                    content = msg["content"]

                    self.logger.debug(f"Received message type: {msg_type}")

                    if msg_type == "stream":
                        text = content.get("text", "")
                        text_output += text
                        outputs.append(
                            ExecutionOutput(
                                output_type="stream",
                                content={
                                    "name": content.get("name", "stdout"),
                                    "text": text,
                                },
                            )
                        )

                    elif msg_type == "execute_result":
                        execution_count = content.get("execution_count", 0)
                        outputs.append(
                            ExecutionOutput(
                                output_type="execute_result",
                                content=content.get("data", {}),
                                metadata=content.get("metadata", {}),
                                execution_count=execution_count,
                            )
                        )

                    elif msg_type == "display_data":
                        outputs.append(
                            ExecutionOutput(
                                output_type="display_data",
                                content=content.get("data", {}),
                                metadata=content.get("metadata", {}),
                            )
                        )

                    elif msg_type == "error":
                        status = "error"
                        error_name = content.get("ename", "Error")
                        error_value = content.get("evalue", "")
                        traceback = content.get("traceback", [])
                        text_output += f"{error_name}: {error_value}\n"
                        if traceback:
                            text_output += "\n".join(traceback)

                        outputs.append(
                            ExecutionOutput(
                                output_type="error",
                                content={
                                    "ename": error_name,
                                    "evalue": error_value,
                                    "traceback": traceback,
                                },
                            )
                        )

                    elif msg_type == "status":
                        execution_state = content.get("execution_state")
                        if execution_state == "idle":
                            # Execution completed
                            break

                except Exception:
                    # Timeout on get_iopub_msg is expected
                    continue

            # Check if we timed out
            if asyncio.get_event_loop().time() >= deadline:
                status = "timeout"
                self.logger.warning(f"Code execution timed out after {timeout}s")
                # The bounded interrupt + status update now live in the finally
                # block below (_finalize_execution), so they run on EVERY exit
                # path -- including cancellation -- instead of only here (#3346).

            return ExecutionResult(
                status=status,
                execution_count=execution_count,
                outputs=outputs,
                text_output=text_output,
                error_name=error_name,
                error_value=error_value,
                traceback=traceback,
            )

        except asyncio.CancelledError:
            # #3346: transport-level hard timeout or caller cancellation. CancelledError
            # derives from BaseException, so it used to skip both the except below and
            # the post-loop status update -- the kernel stayed 'busy' in the registry
            # with a live OS process and nobody left to restart it (the zombie-kernel
            # leak of the full-notebook path). Re-raise after the bounded cleanup in
            # the finally block, which DOES run during cancellation unwinding.
            cancelled = True
            self.logger.error(
                f"Execution on kernel {kernel_id} was cancelled mid-flight -- "
                f"running bounded cleanup before the cancellation completes"
            )
            raise
        except Exception as e:
            error_msg = f"Code execution failed: {e}"
            self.logger.error(error_msg)

            return ExecutionResult(
                status="error",
                execution_count=0,
                outputs=[],
                text_output=str(e),
                error_name="ExecutionError",
                error_value=str(e),
            )
        finally:
            # #3346: bounded finalization for every exit path (ok / error / timeout /
            # cancellation). Time-boxed so it can never hang the return or the
            # cancellation. Status transitions:
            #   - normal/error exit, or timeout with a cooperative interrupt -> 'idle'
            #   - timeout with a non-cooperative kernel, caller present -> 'unresponsive'
            #     (#2718 semantics preserved: registered, re-queue refused, manual
            #     restart recovers)
            #   - cancellation with a non-cooperative kernel -> force-stopped and
            #     deregistered (#3346: nobody is left to restart it)
            try:
                cleanup_diag = await self._finalize_execution(
                    kernel_id,
                    kernel_info,
                    timed_out=(status == "timeout"),
                    cancelled=cancelled,
                )
                if cleanup_diag:
                    self.logger.warning(
                        f"#3346 kernel {kernel_id} cleanup: {cleanup_diag}"
                    )
            except Exception as finalize_err:
                # Finalization must never mask the original outcome.
                self.logger.error(
                    f"#3346 kernel {kernel_id} finalize failed: {finalize_err}"
                )
            kernel_info.last_activity = datetime.now()

    async def _finalize_execution(
        self,
        kernel_id: str,
        kernel_info: "KernelInfo",
        *,
        timed_out: bool,
        cancelled: bool,
    ) -> Optional[Dict[str, Any]]:
        """
        #3346: bounded kernel finalization, called from execute_code's finally block.

        Runs even while a CancelledError unwinds. Never hangs: the interrupt is
        time-boxed (5s) and the escalated stop too (15s).

        Returns a diagnostic dict when a cleanup ran, else None (plain exit).
        """
        if not timed_out and not cancelled:
            kernel_info.status = "idle"
            return None

        # Interrupt the kernel to actually free it. Without this the kernel keeps
        # running the (still-compiling) code, every subsequent call re-queues on a
        # busy kernel and appears to hang indefinitely (the "stuck for hours" bug).
        #
        # #2718: km.interrupt_kernel() can itself block on Windows for
        # dotnet-interactive kernels (interrupt_mode=signal) in the middle of a
        # non-cooperative nuget restore -- time-box it. The shield protects the
        # cleanup from the pending cancellation we may be unwinding.
        interrupt_ok = False
        interrupt_error: Optional[str] = None
        try:
            await asyncio.wait_for(
                asyncio.shield(self.interrupt_kernel(kernel_id)),
                timeout=5.0,
            )
            interrupt_ok = True
        except asyncio.TimeoutError:
            interrupt_error = (
                "interrupt timed out after 5.0s -- kernel stuck in a "
                "non-cooperative code path (e.g. .NET nuget restore)"
            )
        except Exception as ie:
            interrupt_error = f"interrupt failed: {ie}"

        if interrupt_ok:
            kernel_info.status = "idle"
            return {"phase": "cleanup", "interrupt": "ok", "final_status": "idle"}

        self.logger.error(
            f"#3346 kernel {kernel_id} interrupt failed: {interrupt_error}"
        )

        if not cancelled:
            # Caller is present: keep the kernel registered as 'unresponsive' (#2718).
            # The entry-point gate refuses to re-queue on it; recovery is a manual
            # restart, which resets the status to 'idle'.
            kernel_info.status = "unresponsive"
            return {
                "phase": "cleanup",
                "interrupt": interrupt_error,
                "final_status": "unresponsive",
                "recovery": "manage_kernel(action='restart')",
            }

        # Cancelled caller + non-cooperative kernel: nobody will restart this
        # kernel, so leaving it registered busy/unresponsive leaks the process
        # (#3346). Escalate to a bounded force-stop.
        return await self._force_stop_kernel(kernel_id)

    @staticmethod
    def _kernel_pid(km: Any) -> Optional[int]:
        """
        #3346: best-effort extraction of the spawned kernel process PID from a
        jupyter_client KernelManager (km.provisioner.process.pid, 8.x layout).
        Returns None whenever anything is missing or not a real int PID.
        """
        try:
            pid = km.provisioner.process.pid
        except Exception:
            return None
        return pid if isinstance(pid, int) else None

    async def _kill_process_tree(self, km: Any) -> Optional[Dict[str, Any]]:
        """
        #3346: kill the kernel's whole OS process tree on Windows.

        jupyter_client's force-stop (LocalProvisioner SIGKILL path) terminates
        only the process it spawned -- for the .NET kernelspec that is the thin
        `dotnet.exe` wrapper, and the real kernel `dotnet-interactive.exe` is a
        grandchild that survives as an orphan (po-2025 repro 2: registry clean,
        process tree alive). `taskkill /F /T` walks the tree from the parent, so
        it MUST run while the parent is still alive -- i.e. BEFORE any
        direct-child kill. No-op on non-Windows platforms (POSIX relies on the
        provisioner's process-group kill) and when no int PID is available.
        """
        if sys.platform != "win32":
            return None
        pid = self._kernel_pid(km)
        if pid is None:
            return None
        try:
            proc = await asyncio.wait_for(
                asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: subprocess.run(
                        ["taskkill", "/F", "/T", "/PID", str(pid)],
                        capture_output=True,
                        timeout=10,
                    ),
                ),
                timeout=15.0,
            )
            killed = proc.returncode == 0
            detail = (proc.stderr or proc.stdout or b"").decode(
                errors="replace"
            ).strip()
            return {
                "pid": pid,
                "method": "taskkill /F /T",
                "killed": killed,
                "detail": detail[:200] if detail else None,
            }
        except Exception as e:
            self.logger.warning(f"#3346 process-tree kill failed for pid {pid}: {e}")
            return {
                "pid": pid,
                "method": "taskkill /F /T",
                "killed": False,
                "detail": str(e)[:200],
            }

    async def _force_stop_kernel(self, kernel_id: str) -> Dict[str, Any]:
        """
        #3346: bounded force-stop (shutdown now=True) of a non-cooperative kernel,
        with registry removal. Last-resort cleanup when the caller is gone.

        If the kill itself fails, the entry stays registered as 'unresponsive' so
        a later manage_kernel(action='stop') can still recover it manually (this
        is how the incident kernels were eventually reclaimed).
        """
        km = self._active_kernels.get(kernel_id)
        info = self._kernel_info.get(kernel_id)
        connection_file = info.connection_file if info else "unknown"
        stopped = False
        tree_kill: Optional[Dict[str, Any]] = None
        if km is not None:
            # Tree-kill first: taskkill /T needs a LIVE parent to reach the
            # grandchildren (dotnet.exe -> dotnet-interactive.exe).
            tree_kill = await self._kill_process_tree(km)
            try:
                await asyncio.wait_for(
                    asyncio.get_event_loop().run_in_executor(
                        None, lambda: km.shutdown_kernel(now=True)
                    ),
                    timeout=15.0,
                )
                stopped = True
            except asyncio.TimeoutError:
                self.logger.error(
                    f"#3346 force-stop of kernel {kernel_id} timed out after 15s "
                    f"(connection file: {connection_file}) -- manual kill required"
                )
            except Exception as se:
                self.logger.error(
                    f"#3346 force-stop of kernel {kernel_id} failed: {se} "
                    f"(connection file: {connection_file}) -- manual kill required"
                )

        if stopped:
            self._active_kernels.pop(kernel_id, None)
            self._kernel_info.pop(kernel_id, None)
            result = {
                "phase": "cleanup",
                "interrupt": "failed",
                "stop": "stopped",
                "final_status": "removed",
            }
            if tree_kill:
                result["process_tree"] = tree_kill
            return result

        if info is not None:
            info.status = "unresponsive"
        result = {
            "phase": "cleanup",
            "interrupt": "failed",
            "stop": "failed",
            "final_status": "unresponsive",
            "connection_file": connection_file,
            "recovery": "manage_kernel(action='stop')",
        }
        if tree_kill:
            result["process_tree"] = tree_kill
        return result

    async def execute_code_streaming(
        self, kernel_id: str, code: str, timeout: float = 60.0
    ) -> str:
        """
        Start a streaming code execution. Returns execution_id for polling.

        The execution runs in the background, collecting IOPub outputs incrementally.
        Use get_stream_output() to poll for accumulated outputs.

        Args:
            kernel_id: ID of the kernel to use
            code: Code to execute
            timeout: Maximum execution time in seconds

        Returns:
            execution_id for polling via get_stream_output()
        """
        if kernel_id not in self._active_kernels:
            raise RuntimeError(f"Kernel {kernel_id} not found")

        execution_id = str(uuid.uuid4())[:8]
        stream_exec = StreamExecution(
            execution_id=execution_id,
            kernel_id=kernel_id,
            code=code,
            started_at=datetime.now(),
        )
        self._stream_executions[execution_id] = stream_exec

        # Launch execution as background task
        asyncio.get_event_loop().create_task(
            self._run_streaming_execution(execution_id, kernel_id, code, timeout)
        )

        return execution_id

    async def _run_streaming_execution(
        self, execution_id: str, kernel_id: str, code: str, timeout: float
    ) -> None:
        """Background task that runs streaming execution and collects IOPub outputs."""
        stream_exec = self._stream_executions.get(execution_id)
        if not stream_exec:
            return

        km = self._active_kernels.get(kernel_id)
        if not km:
            stream_exec.status = "error"
            stream_exec.error_value = f"Kernel {kernel_id} not found"
            stream_exec.completed_at = datetime.now()
            return

        kernel_info = self._kernel_info[kernel_id]

        # #2718: refuse to re-queue on a kernel marked "unresponsive" (see
        # execute_code entry gate). Streaming is a background task and cannot
        # raise to the caller, so surface the refusal as an error result instead.
        if kernel_info.status == "unresponsive":
            stream_exec.status = "error"
            stream_exec.error_value = (
                f"Kernel {kernel_id} is marked 'unresponsive' after a prior "
                f"non-cooperative timeout. Restart it with "
                f"manage_kernel(action='restart')."
            )
            stream_exec.completed_at = datetime.now()
            return

        try:
            kernel_info.status = "busy"
            kernel_info.last_activity = datetime.now()

            kc = km.client()
            msg_id = kc.execute(code)

            deadline = asyncio.get_event_loop().time() + timeout

            while asyncio.get_event_loop().time() < deadline:
                try:
                    msg = await asyncio.get_event_loop().run_in_executor(
                        None, lambda: kc.get_iopub_msg(timeout=1.0)
                    )

                    msg_type = msg["msg_type"]
                    content = msg["content"]

                    if msg_type == "stream":
                        text = content.get("text", "")
                        stream_exec.text_output += text
                        stream_exec.outputs.append(
                            ExecutionOutput(
                                output_type="stream",
                                content={
                                    "name": content.get("name", "stdout"),
                                    "text": text,
                                },
                            )
                        )

                    elif msg_type == "execute_result":
                        stream_exec.execution_count = content.get("execution_count", 0)
                        stream_exec.outputs.append(
                            ExecutionOutput(
                                output_type="execute_result",
                                content=content.get("data", {}),
                                metadata=content.get("metadata", {}),
                                execution_count=stream_exec.execution_count,
                            )
                        )

                    elif msg_type == "display_data":
                        stream_exec.outputs.append(
                            ExecutionOutput(
                                output_type="display_data",
                                content=content.get("data", {}),
                                metadata=content.get("metadata", {}),
                            )
                        )

                    elif msg_type == "error":
                        stream_exec.status = "error"
                        stream_exec.error_name = content.get("ename", "Error")
                        stream_exec.error_value = content.get("evalue", "")
                        traceback = content.get("traceback", [])
                        stream_exec.text_output += f"{stream_exec.error_name}: {stream_exec.error_value}\n"
                        if traceback:
                            stream_exec.text_output += "\n".join(traceback)
                        stream_exec.outputs.append(
                            ExecutionOutput(
                                output_type="error",
                                content={
                                    "ename": stream_exec.error_name,
                                    "evalue": stream_exec.error_value,
                                    "traceback": traceback,
                                },
                            )
                        )

                    elif msg_type == "status":
                        execution_state = content.get("execution_state")
                        if execution_state == "idle":
                            if stream_exec.status == "running":
                                stream_exec.status = "ok"
                            break

                except Exception:
                    continue

            if asyncio.get_event_loop().time() >= deadline:
                stream_exec.status = "timeout"
                # Interrupt the kernel to actually free it (same root cause as execute_code:
                # without this the kernel stays busy and subsequent calls hang indefinitely).
                #
                # #2718: time-box the interrupt itself -- km.interrupt_kernel() can block
                # indefinitely for non-cooperative code paths (e.g. .NET nuget restore).
                # If the interrupt doesn't return in 5s, mark the kernel "unresponsive".
                interrupt_succeeded = False
                try:
                    await asyncio.wait_for(
                        self.interrupt_kernel(kernel_id),
                        timeout=5.0,
                    )
                    interrupt_succeeded = True
                except asyncio.TimeoutError:
                    self.logger.error(
                        f"Interrupt kernel {kernel_id} timed out (streaming) -- "
                        f"kernel likely stuck in non-cooperative code path. "
                        f"Marking as 'unresponsive'."
                    )
                except Exception as ie:
                    self.logger.error(
                        f"Failed to interrupt kernel {kernel_id} after streaming timeout: {ie}"
                    )
                # Stash for finally block (streaming can't easily thread status through)
                stream_exec._interrupt_succeeded = interrupt_succeeded

        except Exception as e:
            stream_exec.status = "error"
            stream_exec.error_name = "ExecutionError"
            stream_exec.error_value = str(e)
        finally:
            # If timeout occurred and interrupt failed/timed out, kernel is still busy:
            # mark "unresponsive" to prevent next call from re-queueing on busy kernel.
            if stream_exec.status == "timeout" and not getattr(
                stream_exec, "_interrupt_succeeded", False
            ):
                kernel_info.status = "unresponsive"
            else:
                kernel_info.status = "idle"
            kernel_info.last_activity = datetime.now()
            stream_exec.completed_at = datetime.now()

    def get_stream_output(self, execution_id: str) -> Optional[Dict[str, Any]]:
        """
        Get current accumulated output for a streaming execution.

        Args:
            execution_id: ID returned by execute_code_streaming

        Returns:
            Dict with status, outputs, text_output, or None if not found
        """
        stream_exec = self._stream_executions.get(execution_id)
        if not stream_exec:
            return None

        outputs_list = []
        for output in stream_exec.outputs:
            out_dict = {"output_type": output.output_type, "content": output.content}
            if output.metadata:
                out_dict["metadata"] = output.metadata
            if output.execution_count is not None:
                out_dict["execution_count"] = output.execution_count
            outputs_list.append(out_dict)

        result = {
            "execution_id": execution_id,
            "kernel_id": stream_exec.kernel_id,
            "status": stream_exec.status,
            "outputs": outputs_list,
            "text_output": stream_exec.text_output,
            "started_at": stream_exec.started_at.isoformat(),
        }

        if stream_exec.completed_at:
            result["completed_at"] = stream_exec.completed_at.isoformat()
            result["execution_time"] = (
                stream_exec.completed_at - stream_exec.started_at
            ).total_seconds()

        if stream_exec.error_name:
            result["error_name"] = stream_exec.error_name
        if stream_exec.error_value:
            result["error"] = stream_exec.error_value

        return result

    def cleanup_stream_execution(self, execution_id: str) -> bool:
        """Remove a completed streaming execution from tracking."""
        if execution_id in self._stream_executions:
            del self._stream_executions[execution_id]
            return True
        return False
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
            response = await self._http_client.get("/api/sessions")
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
