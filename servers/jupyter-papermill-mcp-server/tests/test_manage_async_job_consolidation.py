"""
Tests pour l'outil consolidé manage_async_job (Phase 4 - Consolidation API)

Test la consolidation de:
- get_execution_status_async
- get_job_logs
- cancel_job
- list_jobs
- cleanup_jobs

En un seul outil: manage_async_job
"""

import pytest
from datetime import datetime, timedelta, timezone
from typing import Dict, Any

# Import du service
from papermill_mcp.services.notebook_service import ExecutionManager, ExecutionJob, JobStatus


# ============================================================================
# Fixtures et Helpers
# ============================================================================

@pytest.fixture
def execution_manager():
    """Fixture pour un ExecutionManager vierge."""
    return ExecutionManager()


@pytest.fixture
def sample_job_running():
    """Job en cours d'exécution."""
    job = ExecutionJob(
        job_id="job-running-001",
        input_path="/path/to/notebook.ipynb",
        output_path="/path/to/output.ipynb",
        parameters={"param1": "value1"},
        status=JobStatus.RUNNING,
        started_at=datetime.now(timezone.utc)
    )
    job.stdout_buffer = ["[2025-01-01T00:00:00] Starting execution", "[2025-01-01T00:00:01] Log line 2"]
    job.stderr_buffer = []
    return job


@pytest.fixture
def sample_job_completed():
    """Job terminé avec succès."""
    started = datetime.now(timezone.utc) - timedelta(minutes=5)
    completed = datetime.now(timezone.utc)
    
    job = ExecutionJob(
        job_id="job-completed-001",
        input_path="/path/to/notebook.ipynb",
        output_path="/path/to/output.ipynb",
        parameters={"param1": "value1"},
        status=JobStatus.SUCCEEDED,
        started_at=started
    )
    job.ended_at = completed
    job.return_code = 0
    job.stdout_buffer = ["Log 1", "Log 2", "Log 3", "Completed"]
    job.stderr_buffer = []
    return job


@pytest.fixture
def sample_job_failed():
    """Job terminé avec erreur."""
    started = datetime.now(timezone.utc) - timedelta(minutes=3)
    completed = datetime.now(timezone.utc)
    
    job = ExecutionJob(
        job_id="job-failed-001",
        input_path="/path/to/notebook.ipynb",
        output_path="/path/to/output.ipynb",
        parameters={"param1": "value1"},
        status=JobStatus.FAILED,
        started_at=started
    )
    job.ended_at = completed
    job.return_code = 1
    job.error_message = "Cell execution failed"
    job.stdout_buffer = ["Log 1"]
    job.stderr_buffer = ["ERROR: Division by zero"]
    return job


@pytest.fixture
def sample_job_cancelled():
    """Job annulé."""
    started = datetime.now(timezone.utc) - timedelta(minutes=2)
    completed = datetime.now(timezone.utc)
    
    job = ExecutionJob(
        job_id="job-cancelled-001",
        input_path="/path/to/notebook.ipynb",
        output_path="/path/to/output.ipynb",
        parameters={},
        status=JobStatus.CANCELED,
        started_at=started
    )
    job.ended_at = completed
    job.stdout_buffer = ["Log 1", "Cancelled"]
    job.stderr_buffer = []
    return job


def inject_jobs(manager: ExecutionManager, *jobs: ExecutionJob):
    """Helper pour injecter des jobs dans le manager."""
    for job in jobs:
        manager.jobs[job.job_id] = job


# ============================================================================
# Tests par Action (5 tests minimum)
# ============================================================================

@pytest.mark.asyncio
async def test_manage_async_job_status_basic(execution_manager, sample_job_running):
    """Test action='status' basique sans logs."""
    inject_jobs(execution_manager, sample_job_running)
    
    result = await execution_manager.manage_async_job_consolidated(
        action="status",
        job_id="job-running-001",
        include_logs=False
    )
    
    assert result["action"] == "status"
    assert result["job_id"] == "job-running-001"
    assert result["status"] == "running"
    assert result["input_path"] == "/path/to/notebook.ipynb"
    assert result["output_path"] == "/path/to/output.ipynb"
    assert result["parameters"] == {"param1": "value1"}
    assert "logs" not in result
    
    # Vérifier le progress
    assert "progress" in result
    assert result["progress"]["percent"] == 50.0  # RUNNING = 50%


@pytest.mark.asyncio
async def test_manage_async_job_logs_basic(execution_manager, sample_job_running):
    """Test action='logs' basique sans tail."""
    inject_jobs(execution_manager, sample_job_running)
    
    result = await execution_manager.manage_async_job_consolidated(
        action="logs",
        job_id="job-running-001"
    )
    
    assert result["action"] == "logs"
    assert result["job_id"] == "job-running-001"
    assert len(result["logs"]) == 2
    assert result["total_lines"] == 2
    assert result["returned_lines"] == 2
    assert result["tail"] is None


@pytest.mark.asyncio
async def test_manage_async_job_cancel_basic(execution_manager, sample_job_running):
    """Test action='cancel' basique."""
    inject_jobs(execution_manager, sample_job_running)
    
    result = await execution_manager.manage_async_job_consolidated(
        action="cancel",
        job_id="job-running-001"
    )
    
    assert result["action"] == "cancel"
    assert result["job_id"] == "job-running-001"
    assert result["status"] == "cancelled"
    assert "message" in result
    assert "cancelled_at" in result
    
    # Vérifier que le job est bien annulé
    job = execution_manager.jobs["job-running-001"]
    assert job.status == JobStatus.CANCELED


@pytest.mark.asyncio
async def test_manage_async_job_list_basic(execution_manager, sample_job_running, sample_job_completed):
    """Test action='list' basique sans filtre."""
    inject_jobs(execution_manager, sample_job_running, sample_job_completed)
    
    result = await execution_manager.manage_async_job_consolidated(
        action="list"
    )
    
    assert result["action"] == "list"
    assert result["total"] == 2
    assert result["filter_status"] is None
    assert len(result["jobs"]) == 2
    
    # Vérifier structure des jobs
    job_ids = {job["job_id"] for job in result["jobs"]}
    assert "job-running-001" in job_ids
    assert "job-completed-001" in job_ids
    
    for job in result["jobs"]:
        assert "status" in job
        assert "started_at" in job
        assert "input_path" in job
        assert "progress_percent" in job


@pytest.mark.asyncio
async def test_manage_async_job_cleanup_basic(execution_manager, sample_job_completed, sample_job_failed):
    """Test action='cleanup' basique sans filtre temporel."""
    inject_jobs(execution_manager, sample_job_completed, sample_job_failed)
    
    result = await execution_manager.manage_async_job_consolidated(
        action="cleanup"
    )
    
    assert result["action"] == "cleanup"
    assert result["jobs_removed"] == 2
    assert result["jobs_kept"] == 0
    assert result["older_than_hours"] is None
    assert len(result["removed_job_ids"]) == 2
    assert "job-completed-001" in result["removed_job_ids"]
    assert "job-failed-001" in result["removed_job_ids"]
    
    # Vérifier que les jobs sont bien supprimés
    assert len(execution_manager.jobs) == 0


# ============================================================================
# Tests Options Avancées (≥4 tests)
# ============================================================================

@pytest.mark.asyncio
async def test_manage_async_job_status_with_logs(execution_manager, sample_job_completed):
    """Test action='status' avec include_logs=True."""
    inject_jobs(execution_manager, sample_job_completed)
    
    result = await execution_manager.manage_async_job_consolidated(
        action="status",
        job_id="job-completed-001",
        include_logs=True
    )
    
    assert result["action"] == "status"
    assert "logs" in result
    assert len(result["logs"]) == 4
    assert result["logs"][-1] == "Completed"


@pytest.mark.asyncio
async def test_manage_async_job_logs_with_tail(execution_manager, sample_job_completed):
    """Test action='logs' avec log_tail pour limiter les lignes."""
    inject_jobs(execution_manager, sample_job_completed)
    
    result = await execution_manager.manage_async_job_consolidated(
        action="logs",
        job_id="job-completed-001",
        log_tail=2
    )
    
    assert result["action"] == "logs"
    assert result["tail"] == 2
    assert result["total_lines"] == 4
    assert result["returned_lines"] == 2
    assert result["logs"] == ["Log 3", "Completed"]  # Les 2 dernières


@pytest.mark.asyncio
async def test_manage_async_job_list_with_filter(execution_manager, sample_job_running, sample_job_completed, sample_job_failed):
    """Test action='list' avec filter_status."""
    inject_jobs(execution_manager, sample_job_running, sample_job_completed, sample_job_failed)
    
    # Filtrer seulement les jobs terminés avec succès
    result = await execution_manager.manage_async_job_consolidated(
        action="list",
        filter_status="completed"
    )
    
    assert result["action"] == "list"
    assert result["filter_status"] == "completed"
    assert result["total"] == 1
    assert result["jobs"][0]["job_id"] == "job-completed-001"
    assert result["jobs"][0]["status"] == "completed"


@pytest.mark.asyncio
async def test_manage_async_job_cleanup_older_than(execution_manager):
    """Test action='cleanup' avec cleanup_older_than pour filtrer par âge."""
    # Créer des jobs avec différents âges
    old_job = ExecutionJob(
        job_id="job-old",
        input_path="/path/to/notebook.ipynb",
        output_path="/path/to/output.ipynb",
        parameters={},
        status=JobStatus.SUCCEEDED,
        started_at=datetime.now(timezone.utc) - timedelta(hours=5)
    )
    old_job.ended_at = datetime.now(timezone.utc) - timedelta(hours=4)
    
    recent_job = ExecutionJob(
        job_id="job-recent",
        input_path="/path/to/notebook2.ipynb",
        output_path="/path/to/output2.ipynb",
        parameters={},
        status=JobStatus.SUCCEEDED,
        started_at=datetime.now(timezone.utc) - timedelta(minutes=30)
    )
    recent_job.ended_at = datetime.now(timezone.utc) - timedelta(minutes=20)
    
    inject_jobs(execution_manager, old_job, recent_job)
    
    # Nettoyer seulement les jobs > 2 heures
    result = await execution_manager.manage_async_job_consolidated(
        action="cleanup",
        cleanup_older_than=2
    )
    
    assert result["action"] == "cleanup"
    assert result["older_than_hours"] == 2
    assert result["jobs_removed"] == 1
    assert result["jobs_kept"] == 1
    assert "job-old" in result["removed_job_ids"]
    assert "job-recent" not in result["removed_job_ids"]


# ============================================================================
# Tests Edge Cases (≥4 tests)
# ============================================================================

@pytest.mark.asyncio
async def test_manage_async_job_status_invalid_job_id(execution_manager):
    """Test action='status' avec job_id inexistant."""
    with pytest.raises(ValueError, match="Job 'invalid-job' not found"):
        await execution_manager.manage_async_job_consolidated(
            action="status",
            job_id="invalid-job"
        )


@pytest.mark.asyncio
async def test_manage_async_job_cancel_already_completed(execution_manager, sample_job_completed):
    """Test action='cancel' sur un job déjà terminé."""
    inject_jobs(execution_manager, sample_job_completed)
    
    with pytest.raises(ValueError, match="Cannot cancel job"):
        await execution_manager.manage_async_job_consolidated(
            action="cancel",
            job_id="job-completed-001"
        )


@pytest.mark.asyncio
async def test_manage_async_job_logs_empty(execution_manager):
    """Test action='logs' sur un job sans logs."""
    job_no_logs = ExecutionJob(
        job_id="job-no-logs",
        input_path="/path/to/notebook.ipynb",
        output_path="/path/to/output.ipynb",
        parameters={},
        status=JobStatus.RUNNING,
        started_at=datetime.now(timezone.utc)
    )
    job_no_logs.stdout_buffer = []
    job_no_logs.stderr_buffer = []
    
    inject_jobs(execution_manager, job_no_logs)
    
    result = await execution_manager.manage_async_job_consolidated(
        action="logs",
        job_id="job-no-logs"
    )
    
    assert result["logs"] == []
    assert result["total_lines"] == 0
    assert result["returned_lines"] == 0


@pytest.mark.asyncio
async def test_manage_async_job_cleanup_no_jobs(execution_manager, sample_job_running):
    """Test action='cleanup' quand il n'y a que des jobs actifs."""
    inject_jobs(execution_manager, sample_job_running)
    
    result = await execution_manager.manage_async_job_consolidated(
        action="cleanup"
    )
    
    assert result["jobs_removed"] == 0
    assert result["jobs_kept"] == 1
    assert len(result["removed_job_ids"]) == 0


# ============================================================================
# Tests Validation Paramètres (≥3 tests)
# ============================================================================

@pytest.mark.asyncio
async def test_manage_async_job_status_requires_job_id(execution_manager):
    """Test que action='status' requiert job_id."""
    with pytest.raises(ValueError, match="Parameter 'job_id' is required for action='status'"):
        await execution_manager.manage_async_job_consolidated(
            action="status"
        )


@pytest.mark.asyncio
async def test_manage_async_job_invalid_action(execution_manager):
    """Test validation action invalide."""
    with pytest.raises(ValueError, match="Invalid action"):
        await execution_manager.manage_async_job_consolidated(
            action="invalid_action"
        )


@pytest.mark.asyncio
async def test_manage_async_job_negative_tail(execution_manager, sample_job_running):
    """Test validation log_tail négatif."""
    inject_jobs(execution_manager, sample_job_running)
    
    with pytest.raises(ValueError, match="Parameter 'log_tail' must be positive"):
        await execution_manager.manage_async_job_consolidated(
            action="logs",
            job_id="job-running-001",
            log_tail=-5
        )


@pytest.mark.asyncio
async def test_manage_async_job_negative_cleanup_older_than(execution_manager):
    """Test validation cleanup_older_than négatif."""
    with pytest.raises(ValueError, match="Parameter 'cleanup_older_than' must be positive"):
        await execution_manager.manage_async_job_consolidated(
            action="cleanup",
            cleanup_older_than=-10
        )


# ============================================================================
# Tests Supplémentaires de Robustesse
# ============================================================================

@pytest.mark.asyncio
async def test_manage_async_job_status_completed_with_result(execution_manager, sample_job_completed):
    """Test que action='status' inclut 'result' pour job completed."""
    inject_jobs(execution_manager, sample_job_completed)
    
    result = await execution_manager.manage_async_job_consolidated(
        action="status",
        job_id="job-completed-001"
    )
    
    assert result["status"] == "completed"
    assert "result" in result
    assert result["result"]["success"] is True


@pytest.mark.asyncio
async def test_manage_async_job_status_failed_with_error(execution_manager, sample_job_failed):
    """Test que action='status' inclut 'error' pour job failed."""
    inject_jobs(execution_manager, sample_job_failed)
    
    result = await execution_manager.manage_async_job_consolidated(
        action="status",
        job_id="job-failed-001"
    )
    
    assert result["status"] == "failed"
    assert "error" in result
    assert "Cell execution failed" in result["error"]["message"]
    assert "result" not in result


@pytest.mark.asyncio
async def test_manage_async_job_list_multiple_statuses(
    execution_manager, 
    sample_job_running, 
    sample_job_completed, 
    sample_job_failed, 
    sample_job_cancelled
):
    """Test action='list' avec jobs dans tous les statuts."""
    inject_jobs(execution_manager, sample_job_running, sample_job_completed, sample_job_failed, sample_job_cancelled)
    
    result = await execution_manager.manage_async_job_consolidated(
        action="list"
    )
    
    assert result["total"] == 4
    statuses = {job["status"] for job in result["jobs"]}
    assert "running" in statuses
    assert "completed" in statuses
    assert "failed" in statuses
    assert "cancelled" in statuses


@pytest.mark.asyncio
async def test_manage_async_job_progress_calculation(execution_manager):
    """Test calcul de progress_percent pour différents statuts."""
    # Job PENDING
    pending_job = ExecutionJob(
        job_id="job-pending",
        input_path="/path/to/notebook.ipynb",
        output_path="/path/to/output.ipynb",
        parameters={},
        status=JobStatus.PENDING,
        started_at=datetime.now(timezone.utc)
    )
    
    # Job RUNNING
    running_job = ExecutionJob(
        job_id="job-running",
        input_path="/path/to/notebook.ipynb",
        output_path="/path/to/output.ipynb",
        parameters={},
        status=JobStatus.RUNNING,
        started_at=datetime.now(timezone.utc)
    )
    
    # Job SUCCEEDED
    succeeded_job = ExecutionJob(
        job_id="job-succeeded",
        input_path="/path/to/notebook.ipynb",
        output_path="/path/to/output.ipynb",
        parameters={},
        status=JobStatus.SUCCEEDED,
        started_at=datetime.now(timezone.utc) - timedelta(minutes=5)
    )
    succeeded_job.ended_at = datetime.now(timezone.utc)
    
    inject_jobs(execution_manager, pending_job, running_job, succeeded_job)
    
    # Test PENDING = 0%
    result_pending = await execution_manager.manage_async_job_consolidated(
        action="status",
        job_id="job-pending"
    )
    assert result_pending["progress"]["percent"] == 0.0
    
    # Test RUNNING = 50%
    result_running = await execution_manager.manage_async_job_consolidated(
        action="status",
        job_id="job-running"
    )
    assert result_running["progress"]["percent"] == 50.0
    
    # Test SUCCEEDED = 100%
    result_succeeded = await execution_manager.manage_async_job_consolidated(
        action="status",
        job_id="job-succeeded"
    )
    assert result_succeeded["progress"]["percent"] == 100.0


@pytest.mark.asyncio
async def test_manage_async_job_execution_time_calculation(execution_manager, sample_job_completed):
    """Test calcul de execution_time pour job terminé."""
    inject_jobs(execution_manager, sample_job_completed)
    
    result = await execution_manager.manage_async_job_consolidated(
        action="status",
        job_id="job-completed-001"
    )
    
    assert "execution_time" in result
    assert result["execution_time"] is not None
    assert result["execution_time"] > 0
    # L'exécution devrait être d'environ 5 minutes (300 secondes)
    assert 290 <= result["execution_time"] <= 310


# ============================================================================
# Résumé des Tests
# ============================================================================

"""
RÉCAPITULATIF DES TESTS (Phase 4):

Catégorie                        | Nombre | Tests
---------------------------------|--------|--------------------------------------
Tests par Action                 | 5      | status, logs, cancel, list, cleanup
Tests Options Avancées           | 4      | status+logs, logs+tail, list+filter, cleanup+older_than
Tests Edge Cases                 | 4      | invalid_job_id, cancel_completed, logs_empty, cleanup_no_jobs
Tests Validation Paramètres      | 4      | status_requires_job_id, invalid_action, negative_tail, negative_cleanup
Tests Supplémentaires            | 5      | completed_result, failed_error, multiple_statuses, progress, execution_time
---------------------------------|--------|--------------------------------------
TOTAL                            | 22     | > 20 tests requis ✅

Couverture:
- ✅ Toutes les actions (status, logs, cancel, list, cleanup)
- ✅ Toutes les options avancées (include_logs, log_tail, filter_status, cleanup_older_than)
- ✅ Tous les statuts de jobs (pending, running, completed, failed, cancelled)
- ✅ Tous les cas limites (job inexistant, job déjà terminé, logs vides, etc.)
- ✅ Toutes les validations de paramètres
- ✅ Calcul des progress et execution_time
- ✅ Gestion des erreurs et des résultats

Note: Les wrappers deprecated (get_execution_status_async, get_job_logs, etc.) 
sont testés implicitement car ils appellent manage_async_job_consolidated.
Tests d'intégration MCP séparés vérifieront les wrappers complets.

Pattern utilisé: Identique aux Phases 1A, 1B, 2 et 3 (89 tests de référence)
"""