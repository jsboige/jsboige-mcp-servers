#!/usr/bin/env python3
"""
Serveur MCP pour Jupyter et Papermill utilisant FastMCP
"""

import asyncio
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional, Any

from mcp.server.fastmcp import FastMCP
from mcp.types import Tool
from pydantic import Field


# Initialisation du serveur MCP avec FastMCP
mcp = FastMCP("Jupyter-Papermill MCP Server")


@mcp.tool()
def list_kernels() -> List[Dict[str, Any]]:
    """Liste tous les kernels Jupyter disponibles en utilisant l'API Python directe"""
    try:
        # Utiliser l'API Python de jupyter_client au lieu de subprocess
        from jupyter_client.kernelspec import KernelSpecManager
        
        ksm = KernelSpecManager()
        specs = ksm.get_all_specs()
        
        kernels = []
        for name, spec_info in specs.items():
            spec = spec_info.get("spec", {})
            kernels.append({
                "name": name,
                "display_name": spec.get("display_name", name),
                "language": spec.get("language", "unknown"),
                "resource_dir": spec_info.get("resource_dir", "")
            })
        
        return kernels
    except Exception as e:
        return [{"error": f"Erreur lors de la récupération des kernels: {str(e)}"}]

@mcp.tool()
def create_notebook(
    notebook_path: str = Field(description="Chemin du notebook à créer"),
    kernel_name: str = Field(default="python3", description="Nom du kernel à utiliser")
) -> Dict[str, Any]:
    """Crée un nouveau notebook Jupyter"""
    try:
        notebook_structure = {
            "cells": [],
            "metadata": {
                "kernelspec": {
                    "display_name": kernel_name,
                    "language": "python",
                    "name": kernel_name
                },
                "language_info": {
                    "name": "python"
                }
            },
            "nbformat": 4,
            "nbformat_minor": 4
        }
        
        # Créer le répertoire parent si nécessaire
        Path(notebook_path).parent.mkdir(parents=True, exist_ok=True)
        
        with open(notebook_path, 'w', encoding='utf-8') as f:
            json.dump(notebook_structure, f, indent=2)
        
        return {"status": "success", "notebook_path": notebook_path, "message": "Notebook créé avec succès"}
    except Exception as e:
        return {"status": "error", "error": str(e)}


@mcp.tool()
def add_cell_to_notebook(
    notebook_path: str = Field(description="Chemin du notebook"),
    cell_type: str = Field(default="code", description="Type de cellule (code, markdown, raw)"),
    content: str = Field(description="Contenu de la cellule")
) -> Dict[str, Any]:
    """Ajoute une cellule à un notebook existant"""
    try:
        # Charger le notebook
        with open(notebook_path, 'r', encoding='utf-8') as f:
            notebook = json.load(f)
        
        # Créer la nouvelle cellule
        lines = content.split('\n')
        # Pour Jupyter, chaque ligne doit se terminer par \n SAUF la dernière ligne
        formatted_lines = []
        for i, line in enumerate(lines):
            if i == len(lines) - 1:  # Dernière ligne - pas de \n
                formatted_lines.append(line)
            else:  # Toutes les autres lignes - avec \n
                formatted_lines.append(line + '\n')
        
        new_cell = {
            "cell_type": cell_type,
            "metadata": {},
            "source": formatted_lines
        }
        
        if cell_type == "code":
            new_cell["execution_count"] = None
            new_cell["outputs"] = []
        
        # Ajouter la cellule
        notebook["cells"].append(new_cell)
        
        # Sauvegarder
        with open(notebook_path, 'w', encoding='utf-8') as f:
            json.dump(notebook, f, indent=2)
        
        return {"status": "success", "message": "Cellule ajoutée avec succès"}
    except Exception as e:
        return {"status": "error", "error": str(e)}


@mcp.tool()
def execute_notebook(
    notebook_path: str = Field(description="Chemin du notebook à exécuter"),
    output_path: str = Field(default="", description="Chemin de sortie (optionnel)")
) -> Dict[str, Any]:
    """Exécute un notebook Jupyter avec Papermill"""
    try:
        import papermill as pm
        
        if not output_path:
            output_path = notebook_path.replace('.ipynb', '_executed.ipynb')
        
        # Configurer l'environnement pour Papermill
        # S'assurer que Papermill peut trouver les kernels
        python_path = Path(sys.executable)
        conda_env_path = python_path.parent
        scripts_path = conda_env_path / "Scripts"
        
        # Mettre à jour temporairement le PATH pour cette exécution
        current_env = os.environ.copy()
        if scripts_path.exists():
            current_env["PATH"] = str(scripts_path) + os.pathsep + current_env.get("PATH", "")
        
        # Utiliser un contexte temporaire avec l'environnement modifié
        original_environ = os.environ.copy()
        try:
            os.environ.update(current_env)
            
            pm.execute_notebook(
                notebook_path,
                output_path,
                progress_bar=False
            )
            
        finally:
            # Restaurer l'environnement original
            os.environ.clear()
            os.environ.update(original_environ)
        
        return {
            "status": "success",
            "input_path": notebook_path,
            "output_path": output_path,
            "message": "Notebook exécuté avec succès"
        }
    except Exception as e:
        return {"status": "error", "error": str(e)}

@mcp.tool()
def parameterize_notebook(
    notebook_path: str = Field(description="Chemin du notebook"),
    parameters: str = Field(description="Paramètres JSON pour le notebook"),
    output_path: str = Field(default="", description="Chemin de sortie (optionnel)")
) -> Dict[str, Any]:
    """Exécute un notebook avec des paramètres via Papermill"""
    try:
        import papermill as pm
        
        # Parser les paramètres JSON
        params = json.loads(parameters)
        
        if not output_path:
            output_path = notebook_path.replace('.ipynb', '_parameterized.ipynb')
        
        # Configurer l'environnement pour Papermill (même logique qu'execute_notebook)
        python_path = Path(sys.executable)
        conda_env_path = python_path.parent
        scripts_path = conda_env_path / "Scripts"
        
        # Mettre à jour temporairement le PATH pour cette exécution
        current_env = os.environ.copy()
        if scripts_path.exists():
            current_env["PATH"] = str(scripts_path) + os.pathsep + current_env.get("PATH", "")
        
        # Utiliser un contexte temporaire avec l'environnement modifié
        original_environ = os.environ.copy()
        try:
            os.environ.update(current_env)
            
            pm.execute_notebook(
                notebook_path,
                output_path,
                parameters=params,
                progress_bar=False
            )
            
        finally:
            # Restaurer l'environnement original
            os.environ.clear()
            os.environ.update(original_environ)
        
        return {
            "status": "success",
            "input_path": notebook_path,
            "output_path": output_path,
            "parameters": params,
            "message": "Notebook paramétrisé et exécuté avec succès"
        }
    except Exception as e:
        return {"status": "error", "error": str(e)}


@mcp.tool()
def list_notebook_cells(
    notebook_path: str = Field(description="Chemin du notebook")
) -> Dict[str, Any]:
    """Liste les cellules d'un notebook"""
    try:
        with open(notebook_path, 'r', encoding='utf-8') as f:
            notebook = json.load(f)
        
        cells_info = []
        for i, cell in enumerate(notebook.get("cells", [])):
            cell_info = {
                "index": i,
                "cell_type": cell.get("cell_type", "unknown"),
                "source_preview": ''.join(cell.get("source", []))[:100] + "..." if len(''.join(cell.get("source", []))) > 100 else ''.join(cell.get("source", []))
            }
            
            if cell.get("cell_type") == "code":
                cell_info["execution_count"] = cell.get("execution_count")
                cell_info["has_outputs"] = bool(cell.get("outputs", []))
            
            cells_info.append(cell_info)
        
        return {
            "status": "success",
            "notebook_path": notebook_path,
            "total_cells": len(cells_info),
            "cells": cells_info
        }
    except Exception as e:
        return {"status": "error", "error": str(e)}


@mcp.tool()
def get_notebook_metadata(
    notebook_path: str = Field(description="Chemin du notebook")
) -> Dict[str, Any]:
    """Récupère les métadonnées d'un notebook"""
    try:
        with open(notebook_path, 'r', encoding='utf-8') as f:
            notebook = json.load(f)
        
        return {
            "status": "success",
            "notebook_path": notebook_path,
            "metadata": notebook.get("metadata", {}),
            "nbformat": notebook.get("nbformat"),
            "nbformat_minor": notebook.get("nbformat_minor"),
            "cell_count": len(notebook.get("cells", []))
        }
    except Exception as e:
        return {"status": "error", "error": str(e)}


@mcp.tool()
def inspect_notebook_outputs(
    notebook_path: str = Field(description="Chemin du notebook")
) -> Dict[str, Any]:
    """Inspecte les sorties des cellules d'un notebook"""
    try:
        with open(notebook_path, 'r', encoding='utf-8') as f:
            notebook = json.load(f)
        
        outputs_info = []
        for i, cell in enumerate(notebook.get("cells", [])):
            if cell.get("cell_type") == "code":
                outputs = cell.get("outputs", [])
                if outputs:
                    cell_outputs = {
                        "cell_index": i,
                        "execution_count": cell.get("execution_count"),
                        "output_count": len(outputs),
                        "output_types": [out.get("output_type") for out in outputs]
                    }
                    
                    # Extraire un aperçu des données de sortie
                    for j, output in enumerate(outputs):
                        if output.get("output_type") == "execute_result":
                            data = output.get("data", {})
                            cell_outputs[f"output_{j}_data_keys"] = list(data.keys())
                        elif output.get("output_type") == "stream":
                            text = ''.join(output.get("text", []))
                            cell_outputs[f"output_{j}_text_preview"] = text[:200] + "..." if len(text) > 200 else text
                    
                    outputs_info.append(cell_outputs)
        
        return {
            "status": "success",
            "notebook_path": notebook_path,
            "cells_with_outputs": len(outputs_info),
            "outputs": outputs_info
        }
    except Exception as e:
        return {"status": "error", "error": str(e)}


@mcp.tool()
def validate_notebook(
    notebook_path: str = Field(description="Chemin du notebook")
) -> Dict[str, Any]:
    """Valide la structure d'un notebook Jupyter"""
    try:
        with open(notebook_path, 'r', encoding='utf-8') as f:
            notebook = json.load(f)
        
        issues = []
        
        # Vérifications de base
        if "nbformat" not in notebook:
            issues.append("Champ 'nbformat' manquant")
        elif notebook.get("nbformat") < 4:
            issues.append(f"Version nbformat ancienne: {notebook.get('nbformat')}")
        
        if "cells" not in notebook:
            issues.append("Champ 'cells' manquant")
        elif not isinstance(notebook["cells"], list):
            issues.append("Le champ 'cells' n'est pas une liste")
        
        # Validation des cellules
        cell_issues = []
        for i, cell in enumerate(notebook.get("cells", [])):
            cell_problems = []
            
            if "cell_type" not in cell:
                cell_problems.append("Type de cellule manquant")
            elif cell["cell_type"] not in ["code", "markdown", "raw"]:
                cell_problems.append(f"Type de cellule invalide: {cell['cell_type']}")
            
            if "source" not in cell:
                cell_problems.append("Source manquante")
            
            if cell_problems:
                cell_issues.append({"cell_index": i, "issues": cell_problems})
        
        return {
            "status": "success",
            "notebook_path": notebook_path,
            "is_valid": len(issues) == 0 and len(cell_issues) == 0,
            "notebook_issues": issues,
            "cell_issues": cell_issues
        }
    except json.JSONDecodeError as e:
        return {"status": "error", "error": f"JSON invalide: {str(e)}"}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def main():
    """Point d'entrée principal du serveur"""
    # FastMCP gère automatiquement l'initialisation et l'exécution
    mcp.run()


if __name__ == "__main__":
    main()