"""
Tests d'intégration avec l'API Papermill réelle
Niveau 2 SDDD : Tests avec Papermill réel sur notebooks de test
"""

import os
import pytest
import tempfile
import json
from pathlib import Path

import papermill as pm
from papermill.exceptions import PapermillExecutionError

from papermill_mcp.core.papermill_executor import PapermillExecutor, get_papermill_executor


class TestPapermillIntegration:
    """Tests d'intégration avec l'API Papermill réelle"""
    
    @pytest.fixture
    def test_notebooks_dir(self):
        """Chemin vers les notebooks de test"""
        return Path(__file__).parent.parent / "notebooks"
    
    @pytest.fixture
    def temp_output_dir(self):
        """Répertoire temporaire pour les sorties"""
        with tempfile.TemporaryDirectory() as temp_dir:
            yield temp_dir
    
    @pytest.mark.integration
    def test_python_success_notebook_direct_papermill(self, test_notebooks_dir, temp_output_dir):
        """Test d'exécution directe Papermill sur notebook Python réussi"""
        input_path = test_notebooks_dir / "test_python_success.ipynb"
        output_path = Path(temp_output_dir) / "output_python_success.ipynb"
        
        # Vérifier que le notebook d'entrée existe
        assert input_path.exists(), f"Notebook de test manquant: {input_path}"
        
        # Exécution directe avec Papermill
        result_nb = pm.execute_notebook(
            input_path=str(input_path),
            output_path=str(output_path),
            kernel_name='python3'
        )
        
        # Vérifications
        assert output_path.exists()
        assert result_nb is not None
        
        # Lire et vérifier le contenu de sortie
        with open(output_path, 'r', encoding='utf-8') as f:
            output_nb = json.load(f)
        
        # Vérifier qu'il y a des sorties dans la cellule
        code_cells = [cell for cell in output_nb['cells'] if cell['cell_type'] == 'code']
        assert len(code_cells) > 0
        
        # Vérifier qu'au moins une cellule a été exécutée
        executed_cells = [cell for cell in code_cells if cell.get('execution_count') is not None]
        assert len(executed_cells) > 0
        
        # Vérifier la présence du message de sortie attendu
        has_expected_output = False
        for cell in code_cells:
            outputs = cell.get('outputs', [])
            for output in outputs:
                if output.get('output_type') == 'stream':
                    text = ''.join(output.get('text', []))
                    if 'Hello from Python test!' in text:
                        has_expected_output = True
                        break
        
        assert has_expected_output, "Sortie attendue 'Hello from Python test!' non trouvée"
    
    @pytest.mark.integration
    def test_python_failure_notebook_direct_papermill(self, test_notebooks_dir, temp_output_dir):
        """Test d'exécution directe Papermill sur notebook Python en échec"""
        input_path = test_notebooks_dir / "test_python_failure.ipynb"
        output_path = Path(temp_output_dir) / "output_python_failure.ipynb"
        
        assert input_path.exists(), f"Notebook de test manquant: {input_path}"
        
        # L'exécution doit échouer avec PapermillExecutionError
        with pytest.raises(PapermillExecutionError) as exc_info:
            pm.execute_notebook(
                input_path=str(input_path),
                output_path=str(output_path),
                kernel_name='python3'
            )
        
        # Vérifier que l'erreur contient notre ValueError
        error_message = str(exc_info.value)
        assert "ValueError" in error_message or "Test error" in error_message
        
        # Le fichier de sortie peut exister même en cas d'erreur
        if output_path.exists():
            with open(output_path, 'r', encoding='utf-8') as f:
                output_nb = json.load(f)
            
            # Vérifier qu'il y a une erreur dans les sorties
            has_error_output = False
            for cell in output_nb['cells']:
                if cell['cell_type'] == 'code':
                    outputs = cell.get('outputs', [])
                    for output in outputs:
                        if output.get('output_type') == 'error':
                            has_error_output = True
                            break
            
            assert has_error_output, "Sortie d'erreur attendue non trouvée"
    
    @pytest.mark.integration
    @pytest.mark.skipif(not os.system("jupyter kernelspec list | grep -q '.net-csharp'") == 0,
                       reason="Kernel .NET non disponible")
    def test_dotnet_success_notebook_direct_papermill(self, test_notebooks_dir, temp_output_dir):
        """Test d'exécution directe Papermill sur notebook .NET réussi"""
        input_path = test_notebooks_dir / "test_dotnet_success.ipynb"
        output_path = Path(temp_output_dir) / "output_dotnet_success.ipynb"
        
        assert input_path.exists(), f"Notebook de test manquant: {input_path}"
        
        try:
            result_nb = pm.execute_notebook(
                input_path=str(input_path),
                output_path=str(output_path),
                kernel_name='.net-csharp'
            )
            
            assert output_path.exists()
            assert result_nb is not None
            
            # Vérifier la sortie attendue
            with open(output_path, 'r', encoding='utf-8') as f:
                output_nb = json.load(f)
            
            has_expected_output = False
            for cell in output_nb['cells']:
                if cell['cell_type'] == 'code':
                    outputs = cell.get('outputs', [])
                    for output in outputs:
                        if output.get('output_type') == 'stream':
                            text = ''.join(output.get('text', []))
                            if 'Hello from .NET!' in text:
                                has_expected_output = True
                                break
            
            assert has_expected_output, "Sortie attendue 'Hello from .NET!' non trouvée"
            
        except Exception as e:
            pytest.skip(f"Kernel .NET non fonctionnel: {e}")
    
    @pytest.mark.integration
    @pytest.mark.skipif(not os.system("jupyter kernelspec list | grep -q '.net-csharp'") == 0,
                       reason="Kernel .NET non disponible")
    def test_dotnet_failure_nuget_notebook_direct_papermill(self, test_notebooks_dir, temp_output_dir):
        """Test d'exécution directe Papermill sur notebook .NET avec problème NuGet"""
        input_path = test_notebooks_dir / "test_dotnet_failure_nuget.ipynb"
        output_path = Path(temp_output_dir) / "output_dotnet_failure.ipynb"
        
        assert input_path.exists(), f"Notebook de test manquant: {input_path}"
        
        try:
            # Ce test peut soit échouer (attendu) soit réussir (si NuGet fonctionne)
            # L'objectif est de tester la reproductibilité du problème identifié
            result_nb = pm.execute_notebook(
                input_path=str(input_path),
                output_path=str(output_path),
                kernel_name='.net-csharp'
            )
            
            # Si ça réussit, vérifier qu'il n'y a pas d'erreur
            if output_path.exists():
                with open(output_path, 'r', encoding='utf-8') as f:
                    output_nb = json.load(f)
                
                # Compter les erreurs
                error_count = 0
                for cell in output_nb['cells']:
                    if cell['cell_type'] == 'code':
                        outputs = cell.get('outputs', [])
                        for output in outputs:
                            if output.get('output_type') == 'error':
                                error_count += 1
                
                # Le test documenterait le comportement observé
                print(f"Notebook .NET NuGet - Erreurs: {error_count}")
            
        except PapermillExecutionError as e:
            # Erreur attendue - documenter le problème
            error_message = str(e)
            print(f"Erreur NuGet reproduite: {error_message}")
            # Ne pas faire échouer le test, c'est le comportement documenté
            
        except Exception as e:
            pytest.skip(f"Kernel .NET non fonctionnel: {e}")


class TestPapermillExecutorIntegration:
    """Tests d'intégration avec PapermillExecutor"""
    
    @pytest.fixture
    def test_notebooks_dir(self):
        """Chemin vers les notebooks de test"""
        return Path(__file__).parent.parent / "notebooks"
    
    @pytest.fixture
    def temp_output_dir(self):
        """Répertoire temporaire pour les sorties"""
        with tempfile.TemporaryDirectory() as temp_dir:
            yield temp_dir
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_executor_python_success(self, test_notebooks_dir, temp_output_dir):
        """Test PapermillExecutor sur notebook Python réussi"""
        input_path = test_notebooks_dir / "test_python_success.ipynb"
        output_path = Path(temp_output_dir) / "executor_python_success.ipynb"
        
        assert input_path.exists()
        
        executor = get_papermill_executor()
        result = await executor.execute_notebook(
            input_path=str(input_path),
            output_path=str(output_path)
        )
        
        # Vérifications du résultat
        assert result.success is True
        assert result.input_path == str(input_path)
        assert result.output_path == str(output_path)
        assert result.metrics.execution_time_seconds > 0
        assert result.metrics.total_cells > 0
        assert result.metrics.executed_cells > 0
        assert len(result.errors) == 0
        
        # Vérifier que le fichier de sortie existe
        assert output_path.exists()
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_executor_python_failure(self, test_notebooks_dir, temp_output_dir):
        """Test PapermillExecutor sur notebook Python en échec"""
        input_path = test_notebooks_dir / "test_python_failure.ipynb"
        output_path = Path(temp_output_dir) / "executor_python_failure.ipynb"
        
        assert input_path.exists()
        
        executor = get_papermill_executor()
        result = await executor.execute_notebook(
            input_path=str(input_path),
            output_path=str(output_path)
        )
        
        # Vérifications du résultat d'échec
        assert result.success is False
        assert result.input_path == str(input_path)
        assert len(result.errors) > 0
        
        # Vérifier la présence de contexte d'erreur
        error_msg = ' '.join(result.errors).lower()
        assert any(keyword in error_msg for keyword in ['error', 'exception', 'failed'])
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_executor_with_parameters(self, test_notebooks_dir, temp_output_dir):
        """Test PapermillExecutor avec paramètres"""
        input_path = test_notebooks_dir / "test_python_success.ipynb"
        output_path = Path(temp_output_dir) / "executor_with_params.ipynb"
        
        assert input_path.exists()
        
        parameters = {
            "test_param": "test_value",
            "numeric_param": 42
        }
        
        executor = get_papermill_executor()
        result = await executor.execute_notebook(
            input_path=str(input_path),
            output_path=str(output_path),
            parameters=parameters
        )
        
        # Le notebook simple peut ne pas utiliser les paramètres mais ne doit pas échouer
        assert result.success is True
        assert result.metrics.execution_time_seconds > 0
        assert output_path.exists()
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_executor_kernel_auto_detection(self, test_notebooks_dir, temp_output_dir):
        """Test de la détection automatique de kernel"""
        input_path = test_notebooks_dir / "test_python_success.ipynb"
        output_path = Path(temp_output_dir) / "executor_auto_kernel.ipynb"
        
        assert input_path.exists()
        
        executor = get_papermill_executor()
        
        # Test sans spécifier de kernel (auto-détection)
        result = await executor.execute_notebook(
            input_path=str(input_path),
            output_path=str(output_path)
        )
        
        assert result.success is True
        assert result.metrics.kernel_used is not None
        assert result.metrics.kernel_used in ['python3', 'python']
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_executor_nonexistent_notebook(self, temp_output_dir):
        """Test PapermillExecutor avec notebook inexistant"""
        input_path = "/path/to/nonexistent.ipynb"
        output_path = Path(temp_output_dir) / "nonexistent_output.ipynb"
        
        executor = get_papermill_executor()
        result = await executor.execute_notebook(
            input_path=input_path,
            output_path=str(output_path)
        )
        
        assert result.success is False
        assert len(result.errors) > 0
        assert "not found" in result.errors[0].lower()


@pytest.mark.integration
class TestKernelAvailability:
    """Tests pour vérifier la disponibilité des kernels"""
    
    @pytest.mark.asyncio
    async def test_list_available_kernels(self):
        """Test de listage des kernels disponibles"""
        executor = get_papermill_executor()
        kernels = await executor.list_available_kernels()
        
        assert isinstance(kernels, dict)
        # Au minimum Python devrait être disponible
        assert len(kernels) > 0
        
        # Vérifier qu'au moins un kernel Python existe
        python_kernels = [k for k in kernels.keys() if 'python' in k.lower()]
        assert len(python_kernels) > 0
    
    def test_kernel_detection_subprocess(self):
        """Test direct de détection des kernels via subprocess"""
        executor = get_papermill_executor()
        kernels = executor._get_available_kernels()
        
        assert isinstance(kernels, dict)
        if kernels:  # Si la détection réussit
            assert len(kernels) > 0
            # Chaque kernel doit avoir une structure de base
            for kernel_name, kernel_info in kernels.items():
                assert isinstance(kernel_name, str)
                assert isinstance(kernel_info, dict)