"""
Tests unitaires pour ExecutionManager - Fonctionnalites core isolees.

Ce module teste les fonctionnalites principales de ExecutionManager
en isolation complete (sans subprocess reels).
"""

import pytest
import time
import threading
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import Mock, MagicMock, patch, call

from papermill_mcp.services.notebook_service import (
    ExecutionManager,
    ExecutionJob, 
    JobStatus
)


class TestExecutionManagerCreation:
    """Tests de creation et configuration de l'ExecutionManager."""
    
    def test_creation_basic(self):
        """Test creation basique d'ExecutionManager."""
        manager = ExecutionManager()
        
        assert manager.max_concurrent_jobs == 5  # Default selon le code reel
        assert len(manager.jobs) == 0
        assert manager.executor is not None
    
    def test_creation_with_custom_params(self):
        """Test creation avec parametres personnalises."""
        manager = ExecutionManager(max_concurrent_jobs=3)
        
        assert manager.max_concurrent_jobs == 3
        assert len(manager.jobs) == 0
        assert manager.executor is not None


class TestJobManagement:
    """Tests de gestion des jobs."""
    
    @patch('subprocess.Popen')
    @patch('papermill_mcp.services.notebook_service.Path')
    def test_start_notebook_async_success(self, mock_path_class, mock_popen, sample_notebook_simple):
        """Test demarrage reussi d'un job async."""
        # Mock Path pour eviter les erreurs de filesystem
        mock_path_instance = MagicMock()
        mock_path_instance.resolve.return_value = Path("/mock/notebook.ipynb")
        mock_path_instance.exists.return_value = True
        mock_path_instance.parent = Path("/mock")
        mock_path_instance.stem = "notebook"
        mock_path_instance.name = "notebook.ipynb"
        mock_path_class.return_value = mock_path_instance
        
        # Mock subprocess
        mock_process = MagicMock()
        mock_process.poll.return_value = None  # Process running
        mock_popen.return_value = mock_process
        
        manager = ExecutionManager()
        
        with patch('builtins.open', create=True) as mock_open:
            mock_open.return_value.__enter__.return_value.read.return_value = sample_notebook_simple
            
            result = manager.start_notebook_async(
                input_path="/mock/notebook.ipynb",
                wait_seconds=0
            )
        
        assert result["success"] is True
        assert "job_id" in result
        assert len(manager.jobs) == 1
    
    @patch('subprocess.Popen')
    @patch('papermill_mcp.services.notebook_service.Path')
    def test_get_execution_status(self, mock_path_class, mock_popen, sample_notebook_simple):
        """Test recuperation du statut d'execution."""
        # Setup mocks
        mock_path_instance = MagicMock()
        mock_path_instance.resolve.return_value = Path("/mock/notebook.ipynb")
        mock_path_instance.exists.return_value = True
        mock_path_instance.parent = Path("/mock")
        mock_path_instance.stem = "notebook"
        mock_path_instance.name = "notebook.ipynb"
        mock_path_class.return_value = mock_path_instance
        
        mock_process = MagicMock()
        mock_process.poll.return_value = None
        mock_popen.return_value = mock_process
        
        manager = ExecutionManager()
        
        with patch('builtins.open', create=True) as mock_open:
            mock_open.return_value.__enter__.return_value.read.return_value = sample_notebook_simple
            
            # Start job
            result = manager.start_notebook_async("/mock/notebook.ipynb", wait_seconds=0)
            job_id = result["job_id"]
            
            # Check status
            status = manager.get_execution_status(job_id)
            
            assert status["success"] is True
            assert status["status"] in [JobStatus.PENDING.value, JobStatus.RUNNING.value]
            assert status["job_id"] == job_id


class TestJobStates:
    """Tests des transitions d'etats des jobs."""
    
    @patch('subprocess.Popen')
    @patch('papermill_mcp.services.notebook_service.Path')
    def test_job_completion_success(self, mock_path_class, mock_popen, sample_notebook_simple):
        """Test completion avec succes d'un job."""
        # Setup mocks
        mock_path_instance = MagicMock()
        mock_path_instance.resolve.return_value = Path("/mock/notebook.ipynb")
        mock_path_instance.exists.return_value = True
        mock_path_instance.parent = Path("/mock")
        mock_path_instance.stem = "notebook"
        mock_path_instance.name = "notebook.ipynb"
        mock_path_class.return_value = mock_path_instance
        
        mock_process = MagicMock()
        # Simulate process completion
        mock_process.poll.side_effect = [None, None, 0]  # Running, then completed
        mock_process.returncode = 0
        mock_popen.return_value = mock_process
        
        manager = ExecutionManager()
        
        with patch('builtins.open', create=True) as mock_open:
            mock_open.return_value.__enter__.return_value.read.return_value = sample_notebook_simple
            
            # Start job
            result = manager.start_notebook_async("/mock/notebook.ipynb", wait_seconds=0)
            job_id = result["job_id"]
            
            # Wait a bit and check completion
            time.sleep(0.1)
            status = manager.get_execution_status(job_id)
            
            # Should eventually be completed
            assert status["success"] is True


class TestConcurrencyLimits:
    """Tests des limites de concurrence."""
    
    @patch('subprocess.Popen')
    @patch('papermill_mcp.services.notebook_service.Path')
    def test_max_concurrent_jobs_enforcement(self, mock_path_class, mock_popen, sample_notebook_simple):
        """Test application de la limite de jobs concurrents."""
        # Setup mocks
        mock_path_instance = MagicMock()
        mock_path_instance.resolve.return_value = Path("/mock/notebook.ipynb")
        mock_path_instance.exists.return_value = True
        mock_path_instance.parent = Path("/mock")
        mock_path_instance.stem = "notebook"
        mock_path_instance.name = "notebook.ipynb"
        mock_path_class.return_value = mock_path_instance
        
        mock_process = MagicMock()
        mock_process.poll.return_value = None  # Process running
        mock_popen.return_value = mock_process
        
        # Manager avec limite de 2 jobs
        manager = ExecutionManager(max_concurrent_jobs=2)
        
        with patch('builtins.open', create=True) as mock_open:
            mock_open.return_value.__enter__.return_value.read.return_value = sample_notebook_simple
            
            # Start 2 jobs - should succeed
            result1 = manager.start_notebook_async("/mock/notebook1.ipynb", wait_seconds=0)
            assert result1["success"] is True
            
            result2 = manager.start_notebook_async("/mock/notebook2.ipynb", wait_seconds=0)
            assert result2["success"] is True
            
            # Third job should fail
            result3 = manager.start_notebook_async("/mock/notebook3.ipynb", wait_seconds=0)
            assert result3["success"] is False
            assert "Too many concurrent jobs" in result3["error"]


class TestThreadSafety:
    """Tests de la securite thread."""
    
    @patch('subprocess.Popen')
    @patch('papermill_mcp.services.notebook_service.Path')
    def test_concurrent_job_creation(self, mock_path_class, mock_popen, sample_notebook_simple):
        """Test creation concurrent de jobs."""
        # Setup mocks
        mock_path_instance = MagicMock()
        mock_path_instance.resolve.return_value = Path("/mock/notebook.ipynb")
        mock_path_instance.exists.return_value = True
        mock_path_instance.parent = Path("/mock")
        mock_path_instance.stem = "notebook"
        mock_path_instance.name = "notebook.ipynb"
        mock_path_class.return_value = mock_path_instance
        
        mock_process = MagicMock()
        mock_process.poll.return_value = None
        mock_popen.return_value = mock_process
        
        manager = ExecutionManager(max_concurrent_jobs=10)
        results = []
        
        def create_job(index):
            with patch('builtins.open', create=True) as mock_open:
                mock_open.return_value.__enter__.return_value.read.return_value = sample_notebook_simple
                result = manager.start_notebook_async(f"/mock/notebook{index}.ipynb", wait_seconds=0)
                results.append(result)
        
        # Create multiple threads
        threads = []
        for i in range(5):
            thread = threading.Thread(target=create_job, args=(i,))
            threads.append(thread)
            thread.start()
        
        # Wait for all threads
        for thread in threads:
            thread.join()
        
        # All should succeed (within concurrent limit)
        successful = [r for r in results if r["success"]]
        assert len(successful) == 5
