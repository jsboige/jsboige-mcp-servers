import pytest
import asyncio
import time
import subprocess
from unittest.mock import MagicMock, patch, ANY, mock_open
from datetime import datetime, timedelta, timezone
from pathlib import Path

from papermill_mcp.services.async_job_service import AsyncJobService, JobStatus, ExecutionJob

class TestAsyncJobService:

    def test_init(self):
        service = AsyncJobService(max_concurrent_jobs=10)
        assert service.max_concurrent_jobs == 10
        assert service.jobs == {}

    def test_generate_job_id(self):
        service = AsyncJobService()
        job_id1 = service._generate_job_id()
        job_id2 = service._generate_job_id()
        assert len(job_id1) == 8
        assert job_id1 != job_id2

    def test_start_notebook_async_success(self, isolated_execution_manager, temp_dir):
        manager, mock_process, mock_popen = isolated_execution_manager
        
        input_path = temp_dir / "test_notebook.ipynb"
        input_path.touch()
        
        # Mock process methods to keep it running initially but succeed if waited on
        mock_process.poll.return_value = None  # Process running initially
        mock_process.wait.return_value = 0     # Success if waited on

        # IMPORTANT: create the output file so that the check inside _execute_job passes
        # The logic checks: if return_code == 0 and Path(job.output_path).exists():
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        expected_output_path = input_path.parent / f"{input_path.stem}_executed_{timestamp}.ipynb"
        # We need to monkeypatch the timestamp or predict the path.
        # Easier: patch datetime or just check what the job has.
        # But here we are calling start_notebook_async, which creates the job.
        # So we can't create the file before the job determines the path.
        # Let's provide an explicit output path.
        output_path = temp_dir / "output.ipynb"
        output_path.touch()

        result = manager.start_notebook_async(
            input_path=str(input_path),
            output_path=str(output_path),
            parameters={"param": "value"},
            wait_seconds=0.1 # Small wait to ensure thread starts
        )
        
        assert result["success"] is True
        assert result["job_id"] in manager.jobs
        job = manager.jobs[result["job_id"]]
        assert job.input_path == str(input_path.resolve())
        # The status could be RUNNING or SUCCEEDED depending on speed
        assert job.status in [JobStatus.PENDING, JobStatus.RUNNING, JobStatus.SUCCEEDED]
        assert job.parameters == {"param": "value"}
        
    def test_start_notebook_async_max_concurrent(self, temp_dir):
        # Create service with 1 concurrent job
        manager = AsyncJobService(max_concurrent_jobs=1)
        
        input_path = temp_dir / "test_notebook.ipynb"
        input_path.touch()
        
        # Fake a running job
        with manager.lock:
            manager.jobs["fake_job"] = ExecutionJob(
                job_id="fake_job",
                input_path=str(input_path),
                output_path="out.ipynb",
                status=JobStatus.RUNNING
            )
            
        result = manager.start_notebook_async(str(input_path))
        
        assert result["success"] is False
        assert "Too many concurrent jobs" in result["error"]
        
    def test_execute_job_success(self, isolated_execution_manager, temp_dir):
        manager, mock_process, mock_popen = isolated_execution_manager
        
        # Setup mock process for success
        mock_process.poll.return_value = None
        mock_process.wait.return_value = 0
        
        job = ExecutionJob(
            job_id="test_job",
            input_path=str(temp_dir / "in.ipynb"),
            output_path=str(temp_dir / "out.ipynb"),
            timeout_seconds=10
        )
        
        # Create dummy output file to simulate success
        Path(job.output_path).touch()
        
        manager._execute_job(job, None, None)
        
        assert job.status == JobStatus.SUCCEEDED
        assert job.return_code == 0
        assert job.ended_at is not None

    def test_execute_job_failure(self, isolated_execution_manager, temp_dir):
        manager, mock_process, mock_popen = isolated_execution_manager
        
        # Setup mock process for failure
        mock_process.wait.return_value = 1
        
        job = ExecutionJob(
            job_id="test_job",
            input_path=str(temp_dir / "in.ipynb"),
            output_path=str(temp_dir / "out.ipynb"),
            timeout_seconds=10
        )
        
        manager._execute_job(job, None, None)
        
        assert job.status == JobStatus.FAILED
        assert job.return_code == 1

    def test_execute_job_timeout(self, isolated_execution_manager, temp_dir):
        manager, mock_process, mock_popen = isolated_execution_manager
        
        # Setup mock process for timeout
        # First wait raises TimeoutExpired (in _execute_job)
        # Second wait returns 0 (in _terminate_job after terminate/kill)
        mock_process.wait.side_effect = [
            subprocess.TimeoutExpired(cmd="cmd", timeout=10),
            0
        ]
        
        job = ExecutionJob(
            job_id="test_job",
            input_path=str(temp_dir / "in.ipynb"),
            output_path=str(temp_dir / "out.ipynb"),
            timeout_seconds=10
        )
        
        manager._execute_job(job, None, None)
        
        assert job.status == JobStatus.TIMEOUT
        assert "timed out" in str(job.error_message)

    def test_get_execution_status(self):
        manager = AsyncJobService()
        job = ExecutionJob(
            job_id="test_job",
            input_path="in.ipynb",
            output_path="out.ipynb",
            status=JobStatus.RUNNING,
            started_at=datetime.now(timezone.utc)
        )
        manager.jobs["test_job"] = job
        
        status = manager.get_execution_status("test_job")
        assert status["success"] is True
        assert status["status"] == "RUNNING"
        assert status["duration_seconds"] is not None
        
        status_not_found = manager.get_execution_status("invalid")
        assert status_not_found["success"] is False

    def test_get_job_logs(self):
        manager = AsyncJobService()
        job = ExecutionJob(
            job_id="test_job",
            input_path="in.ipynb",
            output_path="out.ipynb",
            stdout_buffer=["line1", "line2", "line3"]
        )
        manager.jobs["test_job"] = job
        
        # Test full logs
        logs = manager.get_job_logs("test_job")
        assert logs["success"] is True
        assert len(logs["stdout_chunk"]) == 3
        
        # Test pagination
        logs_paged = manager.get_job_logs("test_job", since_line=1)
        assert len(logs_paged["stdout_chunk"]) == 2
        assert logs_paged["stdout_chunk"][0] == "line2"

    def test_cancel_job(self, isolated_execution_manager):
        manager, mock_process, mock_popen = isolated_execution_manager
        
        job = ExecutionJob(
            job_id="test_job",
            input_path="in.ipynb",
            output_path="out.ipynb",
            status=JobStatus.RUNNING,
            process=mock_process
        )
        manager.jobs["test_job"] = job
        
        result = manager.cancel_job("test_job")
        
        assert result["success"] is True
        assert result["canceled"] is True
        assert job.status == JobStatus.CANCELED
        mock_process.terminate.assert_called()

    def test_cleanup_old_jobs(self):
        manager = AsyncJobService()
        
        # Use timezone aware datetimes as the service does
        now = datetime.now(timezone.utc)
        
        # Old job (25 hours ago)
        old_time = now - timedelta(hours=25)
        job_old = ExecutionJob(
            job_id="old", input_path="in", output_path="out",
            status=JobStatus.SUCCEEDED, ended_at=old_time
        )
        
        # Recent job (1 hour ago)
        recent_time = now - timedelta(hours=1)
        job_recent = ExecutionJob(
            job_id="recent", input_path="in", output_path="out",
            status=JobStatus.SUCCEEDED, ended_at=recent_time
        )
        
        # Running job
        job_running = ExecutionJob(
            job_id="running", input_path="in", output_path="out",
            status=JobStatus.RUNNING, started_at=recent_time
        )
        
        manager.jobs["old"] = job_old
        manager.jobs["recent"] = job_recent
        manager.jobs["running"] = job_running
        
        # Note: If cleanup_old_jobs uses naive datetime.now(), this test might fail 
        # or error due to tz-aware vs naive comparison.
        # We might need to patch datetime in async_job_service if it's bugged, 
        # or if the service expects us to match its (potentially incorrect) datetime usage.
        # Assuming we might need to fix the service, let's see if it fails first.
        
        try:
            result = manager.cleanup_old_jobs(max_age_hours=24)
            assert result["success"] is True
            assert result["cleaned_jobs"] == 1
            assert "old" not in manager.jobs
            assert "recent" in manager.jobs
            assert "running" in manager.jobs
        except TypeError:
             pytest.fail("Timezone comparison error in cleanup_old_jobs")

    @pytest.mark.asyncio
    async def test_manage_async_job_consolidated(self):
        manager = AsyncJobService()
        job = ExecutionJob(
            job_id="test_job",
            input_path="in.ipynb",
            output_path="out.ipynb",
            status=JobStatus.RUNNING,
            started_at=datetime.now(timezone.utc)
        )
        manager.jobs["test_job"] = job
        
        # Test status
        status = await manager.manage_async_job_consolidated(action="status", job_id="test_job")
        assert status["action"] == "status"
        assert status["status"] == "running"
        
        # Test list
        jobs_list = await manager.manage_async_job_consolidated(action="list")
        assert jobs_list["action"] == "list"
        assert len(jobs_list["jobs"]) == 1
        
        # Test error missing job_id
        with pytest.raises(ValueError):
            await manager.manage_async_job_consolidated(action="status")

    def test_calculate_optimal_timeout(self, temp_dir):
        manager = AsyncJobService()
        
        # Simple file
        simple = temp_dir / "simple.ipynb"
        simple.touch()
        assert manager._calculate_optimal_timeout(simple) == 120
        
        # Complex file (by name)
        complex_name = temp_dir / "04_semantickernel_building.ipynb"
        complex_name.touch()
        assert manager._calculate_optimal_timeout(complex_name) >= 1200
        
        # Widget file (by name, inside semantickernel context)
        widget_name = temp_dir / "05_semantickernel_widget_test.ipynb"
        widget_name.touch()
        # Mock file read to return empty/simple content to isolate name check
        with patch('builtins.open', mock_open(read_data='{}')):
            assert manager._calculate_optimal_timeout(widget_name) >= 600

    def test_calculate_optimal_timeout_content(self, temp_dir):
        manager = AsyncJobService()
        path = temp_dir / "test.ipynb"
        path.touch()

        # .NET content
        with patch('builtins.open', mock_open(read_data='nuget package microsoft.ml')):
            assert manager._calculate_optimal_timeout(path) >= 300

        # ML content
        with patch('builtins.open', mock_open(read_data='import tensorflow as tf')):
            assert manager._calculate_optimal_timeout(path) >= 180

    def test_build_complete_environment(self):
        manager = AsyncJobService()
        env = manager._build_complete_environment()
        
        assert "CONDA_DEFAULT_ENV" in env
        assert "DOTNET_ROOT" in env
        assert "PYTHONPATH" in env
        assert "ROO_WORKSPACE_DIR" in env
        assert "PATH" in env
        assert "mcp-jupyter-py310" in env["CONDA_PREFIX"]

    def test_count_running_jobs(self):
        manager = AsyncJobService()
        
        # Add mixed jobs
        manager.jobs["1"] = ExecutionJob("1", "in", "out", status=JobStatus.RUNNING)
        manager.jobs["2"] = ExecutionJob("2", "in", "out", status=JobStatus.PENDING)
        manager.jobs["3"] = ExecutionJob("3", "in", "out", status=JobStatus.SUCCEEDED)
        manager.jobs["4"] = ExecutionJob("4", "in", "out", status=JobStatus.FAILED)
        
        assert manager._count_running_jobs() == 2

    def test_calculate_progress(self):
        manager = AsyncJobService()
        
        job_pending = ExecutionJob("1", "in", "out", status=JobStatus.PENDING)
        prog = manager._calculate_progress(job_pending)
        assert prog["percent"] == 0.0
        
        job_running = ExecutionJob("2", "in", "out", status=JobStatus.RUNNING)
        prog = manager._calculate_progress(job_running)
        assert prog["percent"] == 50.0
        
        job_done = ExecutionJob("3", "in", "out", status=JobStatus.SUCCEEDED)
        prog = manager._calculate_progress(job_done)
        assert prog["percent"] == 100.0

    def test_get_progress_hint(self):
        manager = AsyncJobService()
        job = ExecutionJob("1", "in", "out")
        
        # No logs
        assert manager._get_progress_hint(job) is None
        
        # Logs with progress
        job.stdout_buffer = ["[time] Executing cell 50%"]
        assert "Executing cell" in manager._get_progress_hint(job)
        
        # Logs without explicit progress
        job.stdout_buffer = ["[time] Just log"]
        hint = manager._get_progress_hint(job)
        assert "Just log" in hint