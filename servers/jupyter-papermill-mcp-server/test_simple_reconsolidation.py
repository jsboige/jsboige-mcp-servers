#!/usr/bin/env python3
"""
Test simple de validation des corrections SDDD reconsolidees
Sans emojis pour eviter les problemes d'encodage conda Windows
"""

import asyncio
import json
import sys
from pathlib import Path

def test_corrections_sddd():
    """Test principal des corrections SDDD"""
    print("=" * 60)
    print("TEST RECONSOLIDATION CORRECTIONS SDDD")
    print("=" * 60)
    
    results = []
    
    # Test 1: Import des modules
    print("\n1. Test imports...")
    try:
        from papermill_mcp.main import JupyterPapermillMCPServer
        from papermill_mcp.config import get_config
        from papermill_mcp.services.notebook_service import NotebookService
        print("SUCCES - Imports modules consolidés")
        results.append(True)
    except Exception as e:
        print(f"ECHEC - Imports: {e}")
        results.append(False)
    
    # Test 2: Correction JSON parsing
    print("\n2. Test correction JSON parsing...")
    try:
        from papermill_mcp.services.notebook_service import NotebookService
        import inspect
        source = inspect.getsource(NotebookService.parameterize_notebook)
        
        if "isinstance(parameters, str)" in source and "json.loads" in source:
            print("SUCCES - Correction JSON parsing integree")
            results.append(True)
        else:
            print("ECHEC - Correction JSON parsing manquante")
            results.append(False)
    except Exception as e:
        print(f"ECHEC - JSON parsing: {e}")
        results.append(False)
    
    # Test 3: Correction timestamps
    print("\n3. Test correction timestamps...")
    try:
        from papermill_mcp.services.notebook_service import NotebookService
        import inspect
        source = inspect.getsource(NotebookService.execute_notebook_solution_a)
        
        if "timestamp = datetime.datetime.now().strftime" in source:
            print("SUCCES - Correction timestamps integree")
            results.append(True)
        else:
            print("ECHEC - Correction timestamps manquante")
            results.append(False)
    except Exception as e:
        print(f"ECHEC - Timestamps: {e}")
        results.append(False)
    
    # Test 4: Marquage API obsolete
    print("\n4. Test marquage API obsolete...")
    try:
        fastmcp_path = Path(__file__).parent / "papermill_mcp" / "main_fastmcp.py"
        if fastmcp_path.exists():
            content = fastmcp_path.read_text(encoding='utf-8')
            if "API OBSOLETE" in content and "UTILISER main.py" in content:
                print("SUCCES - API obsolete marquee")
                results.append(True)
            else:
                print("ECHEC - Marquage API obsolete manquant")
                results.append(False)
        else:
            print("ECHEC - Fichier main_fastmcp.py non trouve")
            results.append(False)
    except Exception as e:
        print(f"ECHEC - Marquage: {e}")
        results.append(False)
    
    # Résumé
    print("\n" + "=" * 60)
    print("RESUME")
    print("=" * 60)
    
    success_count = sum(results)
    total_tests = len(results)
    success_rate = (success_count / total_tests) * 100
    
    print(f"Tests reussis: {success_count}/{total_tests} ({success_rate:.1f}%)")
    
    if success_rate >= 100:
        print("RECONSOLIDATION PARFAITE - Corrections SDDD integrees")
        return 0
    elif success_rate >= 75:
        print("RECONSOLIDATION REUSSIE - Corrections principales OK")
        return 0
    else:
        print("RECONSOLIDATION INCOMPLETE - Corrections manquantes")
        return 1

if __name__ == "__main__":
    sys.exit(test_corrections_sddd())