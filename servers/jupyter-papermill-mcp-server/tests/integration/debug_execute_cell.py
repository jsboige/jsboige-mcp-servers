#!/usr/bin/env python3
"""Script de diagnostic pour tracer le bug execute_cell"""

import asyncio
import sys
import traceback
from pathlib import Path

# Ajouter le répertoire parent au path
sys.path.insert(0, str(Path(__file__).parent))

async def test_execute_cell():
    """Test direct de la méthode execute_cell"""
    try:
        # Import des modules
        from papermill_mcp.core.jupyter_manager import JupyterManager
        from papermill_mcp.services.kernel_service import KernelService
        
        print("1. Initialisation des services...")
        
        # Créer le JupyterManager
        jupyter_manager = JupyterManager()
        print("   - JupyterManager créé")
        
        # Créer le KernelService
        kernel_service = KernelService(jupyter_manager)
        print("   - KernelService créé")
        
        # Démarrer un kernel
        print("\n2. Démarrage d'un kernel...")
        kernel_result = await kernel_service.start_kernel("python3")
        kernel_id = kernel_result["kernel_id"]
        print(f"   - Kernel démarré: {kernel_id}")
        
        # Tester l'exécution
        print("\n3. Test d'exécution de code...")
        code = "print('Test debug')\n2+2"
        print(f"   - Code à exécuter: {code}")
        
        try:
            # Appel direct à execute_cell
            result = await kernel_service.execute_cell(kernel_id, code)
            print(f"   - Résultat: {result}")
            print("   ✅ SUCCÈS!")
        except AttributeError as e:
            print(f"   ❌ AttributeError: {e}")
            print("\n4. Traceback complet:")
            traceback.print_exc()
            
            # Analyser l'erreur
            print("\n5. Analyse de l'erreur...")
            
            # Essayer d'appeler directement jupyter_manager
            print("\n6. Test direct avec JupyterManager...")
            try:
                exec_result = await jupyter_manager.execute_code(kernel_id, code)
                print(f"   - Type du résultat: {type(exec_result)}")
                print(f"   - Attributs disponibles: {dir(exec_result)}")
                
                # Vérifier les attributs
                if hasattr(exec_result, 'error'):
                    print("   ⚠️ L'objet a un attribut 'error'")
                else:
                    print("   ✅ L'objet n'a PAS d'attribut 'error'")
                    
                if hasattr(exec_result, 'error_name'):
                    print(f"   - error_name: {exec_result.error_name}")
                if hasattr(exec_result, 'error_value'):
                    print(f"   - error_value: {exec_result.error_value}")
                    
            except Exception as e2:
                print(f"   ❌ Erreur dans execute_code: {e2}")
                traceback.print_exc()
        
        # Arrêter le kernel
        print("\n7. Arrêt du kernel...")
        await kernel_service.stop_kernel(kernel_id)
        print("   - Kernel arrêté")
        
    except Exception as e:
        print(f"\n❌ Erreur générale: {e}")
        traceback.print_exc()
        return False
    
    return True

if __name__ == "__main__":
    print("=== DEBUG EXECUTE_CELL ===\n")
    success = asyncio.run(test_execute_cell())
    sys.exit(0 if success else 1)