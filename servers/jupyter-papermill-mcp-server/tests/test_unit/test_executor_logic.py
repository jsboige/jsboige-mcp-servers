"""
Tests unitaires pour papermill_executor.py
Niveau 1 SDDD : Tests avec mocks, sans dépendances externes
"""

import json
import os
import pytest
from datetime import datetime
from pathlib import Path
from unittest.mock import Mock, patch, MagicMock, mock_open

from papermill_mcp.core.papermill_executor import (
    PapermillExecutor, 
    ExecutionMetrics, 
    ExecutionResult,
    get_papermill_executor,
    close_papermill_executor
)
from papermill_mcp.config import MCPConfig
from papermill.exceptions import PapermillExecutionError


class TestExecutionMetrics:
    """Tests unitaires pour la classe ExecutionMetrics"""
    
    def test_metrics_initialization(self):
        """Test l'initialisation des métriques"""
        metrics = ExecutionMetrics()
        assert metrics.total_cells == 0
        assert metrics.executed_cells == 0
        assert metrics.failed_cells == 0
        assert metrics.execution_time_seconds == 0.0
        assert metrics.kernel_used is None
        assert not metrics.is_complete
        
    def test_metrics_completion(self):
        """Test la détection de completion"""
        metrics = ExecutionMetrics()
        assert not metrics.is_complete
        
        metrics.end_time = datetime.now()
        assert metrics.is_complete
        
    def test_success_rate_calculation(self):
        """Test le calcul du taux de succès"""
        metrics = ExecutionMetrics()
        
        # Cas de base - aucune cellule exécutée
        assert metrics.success_rate == 0.0
        
        # Cas normal - 10 cellules, 2 échecs
        metrics.executed_cells = 10
        metrics.failed_cells = 2
        assert metrics.success_rate == 80.0
        
        # Cas parfait - aucun échec
        metrics.failed_cells = 0
        assert metrics.success_rate == 100.0


class TestExecutionResult:
    """Tests unitaires pour la classe ExecutionResult"""
    
    def test_result_to_dict(self):
        """Test la sérialisation en dictionnaire"""
        metrics = ExecutionMetrics()
        metrics.execution_time_seconds = 5.5
        metrics.cells_per_second = 2.0
        metrics.kernel_used = "python3"
        metrics.total_cells = 10
        metrics.executed_cells = 10
        metrics.failed_cells = 1
        
        result = ExecutionResult(
            success=True,
            input_path="/test/input.ipynb",
            output_path="/test/output.ipynb",
            metrics=metrics,
            errors=["warning1"],
            warnings=["warn1"]
        )
        
        result_dict = result.to_dict()
        assert result_dict['success'] is True
        assert result_dict['input_path'] == "/test/input.ipynb"
        assert result_dict['output_path'] == "/test/output.ipynb"
        assert result_dict['metrics']['execution_time'] == 5.5
        assert result_dict['metrics']['cells_per_second'] == 2.0
        assert result_dict['metrics']['kernel'] == "python3"
        assert result_dict['metrics']['success_rate'] == 90.0
        assert len(result_dict['errors']) == 1
        assert len(result_dict['warnings']) == 1


class TestPapermillExecutor:
    """Tests unitaires pour la classe PapermillExecutor"""
    
    @pytest.mark.unit
    @patch('papermill_mcp.core.papermill_executor.get_config')
    @patch('pathlib.Path.mkdir')
    def test_executor_initialization(self, mock_mkdir, mock_get_config):
        """Test l'initialisation du PapermillExecutor"""
        # Créer des mocks appropriés pour les sous-objets Pydantic
        mock_papermill = Mock()
        mock_papermill.output_dir = "/test/output"
        mock_papermill.timeout = 300
        
        mock_config = Mock()
        mock_config.papermill = mock_papermill
        mock_get_config.return_value = mock_config
        
        executor = PapermillExecutor()
        
        assert executor.config == mock_config
        mock_mkdir.assert_called_once()
        assert executor._available_kernels is None
        
    @pytest.mark.unit
    @patch('subprocess.run')
    def test_get_available_kernels_success(self, mock_subprocess):
        """Test la détection des kernels disponibles"""
        mock_result = Mock()
        mock_result.returncode = 0
        mock_result.stdout = '{"kernelspecs": {"python3": {"spec": {"display_name": "Python 3"}}, "dotnet": {"spec": {"display_name": ".NET"}}}}'
        mock_subprocess.return_value = mock_result
        
        with patch('papermill_mcp.core.papermill_executor.get_config') as mock_get_config:
            mock_papermill = Mock()
            mock_papermill.output_dir = "/test"
            mock_config = Mock()
            mock_config.papermill = mock_papermill
            mock_get_config.return_value = mock_config
            
            executor = PapermillExecutor()
            kernels = executor._get_available_kernels()
            
            assert 'python3' in kernels
            assert 'dotnet' in kernels
            mock_subprocess.assert_called_once()
    
    @pytest.mark.unit
    @patch('subprocess.run')
    def test_get_available_kernels_failure(self, mock_subprocess):
        """Test la gestion d'échec de détection des kernels"""
        mock_result = Mock()
        mock_result.returncode = 1
        mock_result.stderr = "Command failed"
        mock_subprocess.return_value = mock_result
        
        with patch('papermill_mcp.core.papermill_executor.get_config') as mock_get_config:
            mock_papermill = Mock()
            mock_papermill.output_dir = "/test"
            mock_config = Mock()
            mock_config.papermill = mock_papermill
            mock_get_config.return_value = mock_config
            
            executor = PapermillExecutor()
            kernels = executor._get_available_kernels()
            
            assert kernels == {}
    
    @pytest.mark.unit
    @patch('builtins.open', new_callable=mock_open, read_data='{"metadata": {"kernelspec": {"name": "python3"}}}')
    def test_auto_detect_kernel_from_metadata(self, mock_file):
        """Test la détection automatique de kernel depuis les métadonnées"""
        with patch('papermill_mcp.core.papermill_executor.get_config') as mock_get_config:
            mock_papermill = Mock()
            mock_papermill.output_dir = "/test"
            mock_config = Mock()
            mock_config.papermill = mock_papermill
            mock_get_config.return_value = mock_config
            
            executor = PapermillExecutor()
            executor._available_kernels = {"python3": {}, "dotnet": {}}
            
            kernel = executor._auto_detect_kernel("/test/notebook.ipynb")
            assert kernel == "python3"
    
    @pytest.mark.unit
    def test_generate_output_path(self):
        """Test la génération de chemin de sortie"""
        with patch('papermill_mcp.core.papermill_executor.get_config') as mock_get_config:
            mock_papermill = Mock()
            mock_papermill.output_dir = "/test/output"
            mock_config = Mock()
            mock_config.papermill = mock_papermill
            mock_get_config.return_value = mock_config
            
            executor = PapermillExecutor()
            
            with patch('papermill_mcp.core.papermill_executor.datetime') as mock_datetime:
                mock_datetime.now.return_value.strftime.return_value = "20231201_120000"
                output_path = executor._generate_output_path("/input/test.ipynb", "-executed")
                
                assert "test-executed_20231201_120000.ipynb" in output_path
                assert "/test/output" in output_path.replace("\\", "/")
    
    @pytest.mark.unit
    @patch('os.path.exists')
    @pytest.mark.asyncio
    async def test_execute_notebook_file_not_found(self, mock_exists):
        """Test l'exécution avec fichier introuvable"""
        mock_exists.return_value = False
        
        with patch('papermill_mcp.core.papermill_executor.get_config') as mock_get_config:
            mock_papermill = Mock()
            mock_papermill.output_dir = "/test"
            mock_papermill.timeout = 300
            mock_config = Mock()
            mock_config.papermill = mock_papermill
            mock_get_config.return_value = mock_config
            
            executor = PapermillExecutor()
            result = await executor.execute_notebook("/non/existent.ipynb")
            
            assert result.success is False
            assert len(result.errors) == 1
            assert "not found" in result.errors[0]
    
    @pytest.mark.unit
    def test_extract_error_context(self):
        """Test l'extraction de contexte d'erreur"""
        with patch('papermill_mcp.core.papermill_executor.get_config') as mock_get_config:
            mock_papermill = Mock()
            mock_papermill.output_dir = "/test"
            mock_config = Mock()
            mock_config.papermill = mock_papermill
            mock_get_config.return_value = mock_config
            
            executor = PapermillExecutor()
            
            # Test ModuleNotFoundError
            error = PapermillExecutionError(
                exec_count=1,
                source="import pandas",
                ename="ModuleNotFoundError",
                evalue="No module named 'pandas'",
                traceback=["ModuleNotFoundError: No module named 'pandas'"],
                cell_index=0
            )
            context = executor._extract_error_context(error)
            assert any("packages are installed" in msg for msg in context)
            
            # Test TimeoutError
            error = PapermillExecutionError(
                exec_count=2,
                source="long_running_code()",
                ename="TimeoutError",
                evalue="Timeout occurred during execution",
                traceback=["TimeoutError: Timeout occurred during execution"],
                cell_index=1
            )
            context = executor._extract_error_context(error)
            assert any("timeout" in msg for msg in context)
            
            # Test FileNotFoundError
            error = PapermillExecutionError(
                exec_count=3,
                source="pd.read_csv('data.csv')",
                ename="FileNotFoundError",
                evalue="data.csv not found",
                traceback=["FileNotFoundError: data.csv not found"],
                cell_index=2
            )
            context = executor._extract_error_context(error)
            assert any("file paths" in msg for msg in context)


class TestSingletonFunctions:
    """Tests pour les fonctions singleton du module"""
    
    def teardown_method(self):
        """Nettoyage après chaque test"""
        close_papermill_executor()
    
    @pytest.mark.unit
    @patch('papermill_mcp.core.papermill_executor.PapermillExecutor')
    def test_get_papermill_executor_singleton(self, mock_executor_class):
        """Test le pattern singleton de get_papermill_executor"""
        mock_instance = Mock()
        mock_executor_class.return_value = mock_instance
        
        # Premier appel - crée l'instance
        executor1 = get_papermill_executor()
        assert executor1 == mock_instance
        
        # Deuxième appel - retourne la même instance
        executor2 = get_papermill_executor()
        assert executor2 == mock_instance
        assert executor1 is executor2
        
        # Vérifier qu'une seule instance a été créée
        mock_executor_class.assert_called_once()
    
    @pytest.mark.unit
    def test_close_papermill_executor(self):
        """Test la fermeture du singleton"""
        with patch('papermill_mcp.core.papermill_executor.PapermillExecutor') as mock_executor_class:
            mock_instance = Mock()
            mock_executor_class.return_value = mock_instance
            
            # Créer l'instance
            executor = get_papermill_executor()
            assert executor == mock_instance
            
            # Fermer
            close_papermill_executor()
            mock_instance.close.assert_called_once()
            
            # Vérifier qu'une nouvelle instance sera créée
            new_executor = get_papermill_executor()
            assert mock_executor_class.call_count == 2


@pytest.fixture
def mock_config():
    """Fixture pour la configuration mock"""
    mock_papermill = Mock()
    mock_papermill.output_dir = "/test/output"
    mock_papermill.timeout = 300
    config = Mock()
    config.papermill = mock_papermill
    return config


@pytest.fixture
def executor(mock_config):
    """Fixture pour PapermillExecutor mocké"""
    with patch('papermill_mcp.core.papermill_executor.get_config', return_value=mock_config):
        return PapermillExecutor(mock_config)


class TestIntegrationScenarios:
    """Tests d'intégration des scénarios complets avec mocks"""
    
    @pytest.mark.unit
    @pytest.mark.asyncio
    @patch('papermill_mcp.core.papermill_executor.pm.execute_notebook')
    @patch('os.path.exists')
    @patch('os.chdir')
    @patch('os.getcwd')
    async def test_successful_execution_flow(self, mock_getcwd, mock_chdir,
                                           mock_exists, mock_pm_execute, executor):
        """Test d'un flux d'exécution complet réussi"""
        # Configuration des mocks
        mock_exists.return_value = True
        mock_getcwd.return_value = "/original/dir"
        
        mock_notebook = Mock()
        mock_notebook.cells = [
            Mock(cell_type='code', execution_count=1, outputs=[]),
            Mock(cell_type='markdown'),
            Mock(cell_type='code', execution_count=2, outputs=[])
        ]
        mock_pm_execute.return_value = mock_notebook
        
        executor._available_kernels = {"python3": {}}
        
        # Mocker le fichier pour qu'il soit détecté comme existant
        with patch('builtins.open', mock_open(read_data='{"metadata": {"kernelspec": {"name": "python3"}}}')):
            # Exécution
            result = await executor.execute_notebook(
                input_path="/test/input.ipynb",
                parameters={"param1": "value1"}
            )
        
        # Vérifications
        assert result.success is True
        assert result.input_path == "/test/input.ipynb"
        assert result.metrics.total_cells == 3
        assert result.metrics.executed_cells == 2
        mock_pm_execute.assert_called_once()
        
        # Vérifier que les paramètres ont été passés
        call_args = mock_pm_execute.call_args
        assert call_args[1]['parameters'] == {"param1": "value1"}
        assert call_args[1]['kernel_name'] == "python3"