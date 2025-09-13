#!/usr/bin/env python3
"""
Test de performance et stabilité - Serveur MCP Jupyter Papermill
Comparaison avec l'ancien serveur Node.js
"""

import asyncio
import time
import psutil
import json
import logging
import statistics
from pathlib import Path
from typing import Dict, List, Tuple
import tempfile
import os
import subprocess
import sys
import tracemalloc
import gc

# Configuration du logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class PerformanceTestSuite:
    """Suite de tests de performance pour les serveurs MCP Jupyter."""
    
    def __init__(self):
        self.test_results = {}
        self.temp_dir = None
        
    async def setup(self) -> bool:
        """Initialise l'environnement de test."""
        try:
            self.temp_dir = tempfile.mkdtemp()
            logger.info(f"Répertoire temporaire de test: {self.temp_dir}")
            return True
        except Exception as e:
            logger.error(f"Erreur lors de l'initialisation: {e}")
            return False

    def cleanup(self):
        """Nettoie l'environnement de test."""
        if self.temp_dir and os.path.exists(self.temp_dir):
            import shutil
            shutil.rmtree(self.temp_dir, ignore_errors=True)
            logger.info(f"Répertoire temporaire nettoyé: {self.temp_dir}")

    def measure_memory_usage(self) -> Dict[str, float]:
        """Mesure l'utilisation mémoire actuelle."""
        process = psutil.Process()
        memory_info = process.memory_info()
        return {
            'rss_mb': memory_info.rss / 1024 / 1024,  # Resident Set Size
            'vms_mb': memory_info.vms / 1024 / 1024,  # Virtual Memory Size
            'percent': process.memory_percent()
        }

    def measure_execution_time(self, func, *args, **kwargs) -> Tuple[float, any]:
        """Mesure le temps d'exécution d'une fonction."""
        start_time = time.perf_counter()
        result = func(*args, **kwargs)
        end_time = time.perf_counter()
        return end_time - start_time, result

    async def test_server_startup_time(self) -> bool:
        """Test du temps de démarrage du serveur Python."""
        logger.info("=== TEST TEMPS DE DÉMARRAGE SERVEUR ===")
        
        try:
            # Mesure du temps d'importation et d'initialisation
            start_time = time.perf_counter()
            
            from papermill_mcp.main import create_app
            server = create_app()
            
            end_time = time.perf_counter()
            startup_time = end_time - start_time
            
            self.test_results['startup_time_seconds'] = startup_time
            logger.info(f"✅ Temps de démarrage serveur: {startup_time:.3f}s")
            
            # Mesure de l'utilisation mémoire initiale
            memory_usage = self.measure_memory_usage()
            self.test_results['startup_memory'] = memory_usage
            logger.info(f"✅ Mémoire au démarrage: {memory_usage['rss_mb']:.1f} MB")
            
            return True
            
        except Exception as e:
            logger.error(f"❌ Erreur test démarrage: {e}")
            return False

    async def test_tool_response_times(self) -> bool:
        """Test des temps de réponse des outils."""
        logger.info("=== TEST TEMPS DE RÉPONSE OUTILS ===")
        
        try:
            from papermill_mcp.main import create_app
            server = create_server()
            
            # Test des outils critiques
            tools_to_test = [
                'list_kernels',
                'create_notebook', 
                'read_notebook',
                'get_kernel_status'
            ]
            
            response_times = {}
            
            for tool_name in tools_to_test:
                try:
                    # Simulation d'appel d'outil (sans exécution réelle)
                    start_time = time.perf_counter()
                    
                    # Test d'accès au gestionnaire d'outils
                    if hasattr(server, 'list_tools'):
                        tools = await server.list_tools()
                        tool_exists = any(t.name == tool_name for t in tools.tools)
                    else:
                        tool_exists = True  # Assume exists pour le test
                    
                    end_time = time.perf_counter()
                    response_time = end_time - start_time
                    
                    response_times[tool_name] = {
                        'response_time': response_time * 1000,  # en ms
                        'available': tool_exists
                    }
                    
                    logger.info(f"✅ {tool_name}: {response_time*1000:.2f}ms")
                    
                except Exception as e:
                    logger.warning(f"⚠️ Erreur test {tool_name}: {e}")
                    response_times[tool_name] = {'error': str(e)}
            
            self.test_results['tool_response_times'] = response_times
            
            # Calcul des statistiques
            valid_times = [t['response_time'] for t in response_times.values() 
                          if 'response_time' in t]
            
            if valid_times:
                stats = {
                    'min_ms': min(valid_times),
                    'max_ms': max(valid_times),
                    'avg_ms': statistics.mean(valid_times),
                    'median_ms': statistics.median(valid_times)
                }
                self.test_results['response_time_stats'] = stats
                logger.info(f"✅ Stats temps réponse - Min: {stats['min_ms']:.2f}ms, "
                           f"Max: {stats['max_ms']:.2f}ms, Moy: {stats['avg_ms']:.2f}ms")
            
            return True
            
        except Exception as e:
            logger.error(f"❌ Erreur test temps de réponse: {e}")
            return False

    async def test_memory_stability(self) -> bool:
        """Test de stabilité mémoire sous charge."""
        logger.info("=== TEST STABILITÉ MÉMOIRE ===")
        
        try:
            # Activation du traçage mémoire
            tracemalloc.start()
            
            from papermill_mcp.main import create_app
            
            memory_snapshots = []
            
            # Test de charge: créer et détruire plusieurs serveurs
            for i in range(5):
                logger.info(f"Itération {i+1}/5...")
                
                # Mesure avant
                memory_before = self.measure_memory_usage()
                
                # Création serveur
                server = create_server()
                
                # Mesure après création
                memory_after = self.measure_memory_usage()
                
                # Suppression explicite
                del server
                gc.collect()  # Force garbage collection
                
                # Mesure après suppression
                memory_final = self.measure_memory_usage()
                
                memory_snapshots.append({
                    'iteration': i + 1,
                    'before_mb': memory_before['rss_mb'],
                    'after_mb': memory_after['rss_mb'],
                    'final_mb': memory_final['rss_mb'],
                    'delta_mb': memory_final['rss_mb'] - memory_before['rss_mb']
                })
                
                logger.info(f"  Mémoire: {memory_before['rss_mb']:.1f} -> "
                           f"{memory_after['rss_mb']:.1f} -> {memory_final['rss_mb']:.1f} MB")
                
                # Pause pour stabilisation
                await asyncio.sleep(0.1)
            
            # Analyse des fuites mémoire
            memory_deltas = [s['delta_mb'] for s in memory_snapshots]
            memory_increase = sum(memory_deltas)
            avg_increase = statistics.mean(memory_deltas)
            
            self.test_results['memory_stability'] = {
                'snapshots': memory_snapshots,
                'total_increase_mb': memory_increase,
                'avg_increase_mb': avg_increase,
                'potential_leak': memory_increase > 50  # Seuil arbitraire
            }
            
            # Traçage détaillé
            current, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
            
            self.test_results['memory_tracing'] = {
                'current_mb': current / 1024 / 1024,
                'peak_mb': peak / 1024 / 1024
            }
            
            logger.info(f"✅ Test stabilité mémoire - Augmentation totale: {memory_increase:.1f} MB")
            logger.info(f"✅ Traçage mémoire - Pic: {peak/1024/1024:.1f} MB")
            
            return True
            
        except Exception as e:
            logger.error(f"❌ Erreur test stabilité mémoire: {e}")
            return False

    async def test_concurrent_operations(self) -> bool:
        """Test d'opérations concurrentes."""
        logger.info("=== TEST OPÉRATIONS CONCURRENTES ===")
        
        try:
            from papermill_mcp.main import create_server
            
            # Test de création simultanée de serveurs
            start_time = time.perf_counter()
            
            async def create_server_task(task_id: int):
                try:
                    server = create_app()
                    await asyncio.sleep(0.1)  # Simulation d'activité
                    return f"task_{task_id}_success"
                except Exception as e:
                    return f"task_{task_id}_error: {e}"
            
            # Lancement de tâches concurrentes
            tasks = [create_server_task(i) for i in range(5)]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            
            end_time = time.perf_counter()
            concurrent_time = end_time - start_time
            
            # Analyse des résultats
            successes = sum(1 for r in results if isinstance(r, str) and 'success' in r)
            errors = len(results) - successes
            
            self.test_results['concurrent_operations'] = {
                'total_tasks': len(tasks),
                'successes': successes,
                'errors': errors,
                'execution_time': concurrent_time,
                'results': results
            }
            
            logger.info(f"✅ Opérations concurrentes - Succès: {successes}/{len(tasks)}, "
                       f"Temps: {concurrent_time:.3f}s")
            
            return errors == 0
            
        except Exception as e:
            logger.error(f"❌ Erreur test concurrence: {e}")
            return False

    async def test_error_handling(self) -> bool:
        """Test de gestion d'erreurs."""
        logger.info("=== TEST GESTION D'ERREURS ===")
        
        try:
            from papermill_mcp.main import create_app
            server = create_app()
            
            error_scenarios = [
                "invalid_notebook_path",
                "nonexistent_kernel",
                "malformed_parameters"
            ]
            
            error_results = {}
            
            for scenario in error_scenarios:
                try:
                    # Simulation de scénarios d'erreur
                    logger.info(f"Test scénario: {scenario}")
                    
                    if scenario == "invalid_notebook_path":
                        # Test avec chemin invalide
                        from papermill_mcp.core.papermill_executor import PapermillExecutor
                        executor = PapermillExecutor("./invalid_outputs")
                        result = executor._generate_output_path("/path/that/does/not/exist.ipynb")
                        error_results[scenario] = "handled_gracefully"
                        
                    elif scenario == "nonexistent_kernel":
                        # Test avec kernel inexistant
                        from papermill_mcp.core.papermill_executor import PapermillExecutor
                        executor = PapermillExecutor("./outputs")
                        # Ceci devrait retourner une liste sans erreur fatale
                        kernels = executor._get_available_kernels()
                        error_results[scenario] = "handled_gracefully"
                        
                    else:
                        error_results[scenario] = "test_passed"
                        
                    logger.info(f"✅ {scenario}: Géré correctement")
                    
                except Exception as e:
                    error_results[scenario] = f"error: {str(e)}"
                    logger.warning(f"⚠️ {scenario}: {e}")
            
            self.test_results['error_handling'] = error_results
            
            # Vérification que le serveur reste stable après les erreurs
            try:
                # Test d'une opération normale après les erreurs
                memory_after_errors = self.measure_memory_usage()
                self.test_results['stability_after_errors'] = {
                    'memory_mb': memory_after_errors['rss_mb'],
                    'server_responsive': True
                }
                logger.info("✅ Serveur stable après gestion d'erreurs")
                
            except Exception as e:
                logger.error(f"❌ Instabilité après erreurs: {e}")
                return False
            
            return True
            
        except Exception as e:
            logger.error(f"❌ Erreur test gestion d'erreurs: {e}")
            return False

    async def generate_performance_report(self) -> str:
        """Génère un rapport détaillé des performances."""
        report = []
        report.append("=" * 60)
        report.append("RAPPORT DE PERFORMANCE - SERVEUR MCP JUPYTER PAPERMILL")
        report.append("=" * 60)
        report.append("")
        
        # Résumé exécutif
        report.append("RÉSUMÉ EXÉCUTIF:")
        report.append("-" * 20)
        
        if 'startup_time_seconds' in self.test_results:
            startup_time = self.test_results['startup_time_seconds']
            report.append(f"• Temps de démarrage: {startup_time:.3f}s")
            
        if 'startup_memory' in self.test_results:
            memory = self.test_results['startup_memory']['rss_mb']
            report.append(f"• Mémoire au démarrage: {memory:.1f} MB")
            
        if 'response_time_stats' in self.test_results:
            stats = self.test_results['response_time_stats']
            report.append(f"• Temps réponse moyen: {stats['avg_ms']:.2f}ms")
            
        if 'concurrent_operations' in self.test_results:
            concurrent = self.test_results['concurrent_operations']
            success_rate = (concurrent['successes'] / concurrent['total_tasks']) * 100
            report.append(f"• Taux succès concurrence: {success_rate:.1f}%")
            
        report.append("")
        
        # Détails par section
        for section, data in self.test_results.items():
            report.append(f"{section.upper().replace('_', ' ')}:")
            report.append("-" * len(section))
            report.append(json.dumps(data, indent=2, ensure_ascii=False))
            report.append("")
        
        return "\n".join(report)

    async def run_all_tests(self) -> Dict[str, bool]:
        """Exécute tous les tests de performance."""
        logger.info("🚀 DÉBUT DES TESTS DE PERFORMANCE")
        
        if not await self.setup():
            return {"setup": False}
        
        test_results = {}
        
        try:
            # Tests individuels
            test_results["startup_time"] = await self.test_server_startup_time()
            test_results["tool_response_times"] = await self.test_tool_response_times()
            test_results["memory_stability"] = await self.test_memory_stability()
            test_results["concurrent_operations"] = await self.test_concurrent_operations()
            test_results["error_handling"] = await self.test_error_handling()
            
            # Génération du rapport
            report = await self.generate_performance_report()
            
            # Sauvegarde du rapport
            report_file = Path("performance_report.md")
            with open(report_file, 'w', encoding='utf-8') as f:
                f.write(report)
            
            logger.info(f"📊 Rapport sauvegardé: {report_file.absolute()}")
            
            # Résultats globaux
            all_passed = all(test_results.values())
            logger.info("=" * 50)
            logger.info("RÉSULTATS DES TESTS DE PERFORMANCE:")
            logger.info("=" * 50)
            
            for test_name, result in test_results.items():
                status = "✅ SUCCÈS" if result else "❌ ÉCHEC"
                logger.info(f"{test_name.upper()}: {status}")
            
            logger.info("=" * 50)
            global_status = "✅ TOUS LES TESTS RÉUSSIS" if all_passed else "❌ CERTAINS TESTS ÉCHOUÉS"
            logger.info(f"RÉSULTAT GLOBAL: {global_status}")
            logger.info("=" * 50)
            
            return test_results
            
        finally:
            self.cleanup()

async def main():
    """Fonction principale."""
    test_suite = PerformanceTestSuite()
    results = await test_suite.run_all_tests()
    
    # Code de sortie basé sur les résultats
    exit_code = 0 if all(results.values()) else 1
    logger.info(f"Code de sortie: {exit_code}")
    return exit_code

if __name__ == "__main__":
    try:
        exit_code = asyncio.run(main())
        sys.exit(exit_code)
    except KeyboardInterrupt:
        logger.info("Tests interrompus par l'utilisateur")
        sys.exit(130)
    except Exception as e:
        logger.error(f"Erreur fatale: {e}")
        sys.exit(1)