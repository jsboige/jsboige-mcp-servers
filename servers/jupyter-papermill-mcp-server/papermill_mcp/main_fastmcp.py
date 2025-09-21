#!/usr/bin/env python3
"""
Serveur MCP pour Jupyter et Papermill utilisant FastMCP
"""

import asyncio
import datetime
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional, Any

import papermill as pm
from papermill.exceptions import PapermillException, PapermillExecutionError

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
def execute_notebook_solution_a(
    notebook_path: str = Field(description="Chemin du notebook à exécuter"),
    output_path: str = Field(default="", description="Chemin de sortie (optionnel)")
) -> Dict[str, Any]:
    """SOLUTION A - API Papermill directe (remplace subprocess conda run)"""
    try:
        if not output_path:
            output_path = notebook_path.replace('.ipynb', '_executed_solution_a.ipynb')
        
        # Diagnostic avant exécution
        diagnostic_info = {
            "method": "papermill_direct_api",
            "cwd": os.getcwd(),
            "python_env": sys.executable,
            "papermill_version": getattr(pm, '__version__', 'unknown')
        }
        
        # CORRECTION WORKING DIRECTORY - Solution basée sur papermill_executor.py
        notebook_dir = os.path.dirname(os.path.abspath(notebook_path))
        original_cwd = os.getcwd()
        
        try:
            # Changer vers le répertoire du notebook pour résoudre les chemins relatifs NuGet
            os.chdir(notebook_dir)
            
            # Exécution directe avec l'API Papermill
            start_time = datetime.datetime.now()
            
            pm.execute_notebook(
                input_path=notebook_path,
                output_path=output_path,
                kernel_name=None,   # Auto-détection du kernel
                progress_bar=True,
                log_output=True,
                cwd=None
            )
        finally:
            # Restaurer le working directory original
            os.chdir(original_cwd)
        
        end_time = datetime.datetime.now()
        execution_time = (end_time - start_time).total_seconds()
        
        return {
            "status": "success",
            "input_path": notebook_path,
            "output_path": output_path,
            "message": "Notebook exécuté avec succès via API Papermill directe",
            "method": "papermill_direct_api",
            "execution_time_seconds": execution_time,
            "diagnostic": diagnostic_info,
            "timestamp": end_time.isoformat()
        }
        
    except PapermillExecutionError as e:
        return {
            "status": "error",
            "error": f"Erreur d'exécution Papermill: {str(e)}",
            "error_type": "PapermillExecutionError",
            "method": "papermill_direct_api"
        }
    except PapermillException as e:
        return {
            "status": "error",
            "error": f"Erreur Papermill: {str(e)}",
            "error_type": "PapermillException",
            "method": "papermill_direct_api"
        }
    except Exception as e:
        return {
            "status": "error",
            "error": f"Erreur: {str(e)}",
            "error_type": type(e).__name__,
            "method": "papermill_direct_api"
        }

@mcp.tool()
def execute_notebook(
    notebook_path: str = Field(description="Chemin du notebook à exécuter"),
    output_path: str = Field(default="", description="Chemin de sortie (optionnel)")
) -> Dict[str, Any]:
    """Exécute notebook via API Papermill directe (remplace subprocess conda run)"""
    try:
        if not output_path:
            output_path = notebook_path.replace('.ipynb', '_executed.ipynb')
        
        # Diagnostic avant exécution
        diagnostic_info = {
            "method": "papermill_direct_api",
            "cwd": os.getcwd(),
            "python_env": sys.executable,
            "papermill_version": getattr(pm, '__version__', 'unknown')
        }
        
        # CORRECTION WORKING DIRECTORY - Solution basée sur papermill_executor.py
        notebook_dir = os.path.dirname(os.path.abspath(notebook_path))
        original_cwd = os.getcwd()
        
        try:
            # Changer vers le répertoire du notebook pour résoudre les chemins relatifs NuGet
            os.chdir(notebook_dir)
            
            # Exécution directe avec l'API Papermill
            start_time = datetime.datetime.now()
            
            pm.execute_notebook(
                input_path=notebook_path,
                output_path=output_path,
                kernel_name=None,   # Auto-détection du kernel
                progress_bar=True,
                log_output=True,
                cwd=None
            )
        finally:
            # Restaurer le working directory original
            os.chdir(original_cwd)
        
        end_time = datetime.datetime.now()
        execution_time = (end_time - start_time).total_seconds()
        
        return {
            "status": "success",
            "input_path": notebook_path,
            "output_path": output_path,
            "message": "Notebook exécuté avec succès via API Papermill directe",
            "method": "papermill_direct_api",
            "execution_time_seconds": execution_time,
            "diagnostic": diagnostic_info,
            "timestamp": end_time.isoformat()
        }
        
    except PapermillExecutionError as e:
        return {
            "status": "error",
            "error": f"Erreur d'exécution Papermill: {str(e)}",
            "error_type": "PapermillExecutionError",
            "method": "papermill_direct_api"
        }
    except PapermillException as e:
        return {
            "status": "error",
            "error": f"Erreur Papermill: {str(e)}",
            "error_type": "PapermillException",
            "method": "papermill_direct_api"
        }
    except Exception as e:
        return {
            "status": "error",
            "error": f"Erreur: {str(e)}",
            "error_type": type(e).__name__,
            "method": "papermill_direct_api"
        }

@mcp.tool()
def parameterize_notebook(
    notebook_path: str = Field(description="Chemin du notebook"),
    parameters: Dict[str, Any] = Field(description="Paramètres pour le notebook"),
    output_path: str = Field(default="", description="Chemin de sortie (optionnel)")
) -> Dict[str, Any]:
    """Exécute un notebook avec des paramètres via Papermill API directe (SOLUTION A - Bypass Conda Subprocess)"""
    try:
        # Roo transforme automatiquement les strings JSON en dict
        params = parameters if parameters else {}
        
        if not output_path:
            output_path = notebook_path.replace('.ipynb', '_parameterized.ipynb')
        
        # SOLUTION A: Appel direct API Papermill avec paramètres (remplace subprocess conda)
        # Avantages: Plus rapide, injection native paramètres, gestion d'erreurs robuste
        
        # Diagnostic avant exécution
        diagnostic_info = {
            "method": "papermill_direct_api_with_parameters",
            "cwd": os.getcwd(),
            "python_env": sys.executable,
            "papermill_version": getattr(pm, '__version__', 'unknown'),
            "parameters_count": len(params)
        }
        
        # CORRECTION WORKING DIRECTORY - Solution basée sur papermill_executor.py
        notebook_dir = os.path.dirname(os.path.abspath(notebook_path))
        original_cwd = os.getcwd()
        
        try:
            # Changer vers le répertoire du notebook pour résoudre les chemins relatifs NuGet
            os.chdir(notebook_dir)
            
            # Exécution directe avec Papermill Python API et injection paramètres
            start_time = datetime.datetime.now()
            
            pm.execute_notebook(
                input_path=notebook_path,
                output_path=output_path,
                parameters=params,  # Injection directe des paramètres Python
                kernel_name=None,   # Auto-détection du kernel
                progress_bar=True,
                log_output=True,
                cwd=None
            )
        finally:
            # Restaurer le working directory original
            os.chdir(original_cwd)
        
        end_time = datetime.datetime.now()
        execution_time = (end_time - start_time).total_seconds()
        
        return {
            "status": "success",
            "input_path": notebook_path,
            "output_path": output_path,
            "parameters": params,
            "message": "Notebook paramétrisé et exécuté avec succès via API Papermill directe",
            "method": "papermill_direct_api_with_parameters",
            "execution_time_seconds": execution_time,
            "diagnostic": diagnostic_info,
            "timestamp": end_time.isoformat()
        }
        
    except json.JSONDecodeError as e:
        # Erreur de parsing JSON des paramètres
        return {
            "status": "error",
            "error": f"Erreur de format JSON dans les paramètres: {str(e)}",
            "error_type": "JSONDecodeError",
            "method": "papermill_direct_api_with_parameters"
        }
    except PapermillExecutionError as e:
        # Erreur spécifique d'exécution Papermill (kernel crash, erreur code, etc.)
        try:
            safe_params = json.loads(parameters) if parameters else {}
        except:
            safe_params = {"error": "parameters_not_parseable", "raw": parameters}
        
        return {
            "status": "error",
            "error": f"Erreur d'exécution Papermill: {str(e)}",
            "error_type": "PapermillExecutionError",
            "method": "papermill_direct_api_with_parameters",
            "parameters": safe_params,
            "diagnostic": locals().get('diagnostic_info', {"error": "diagnostic_info not available"})
        }
    except PapermillException as e:
        # Autres erreurs Papermill (format notebook, paramètres invalides, etc.)
        try:
            safe_params = json.loads(parameters) if parameters else {}
        except:
            safe_params = {"error": "parameters_not_parseable", "raw": parameters}
        
        return {
            "status": "error",
            "error": f"Erreur Papermill: {str(e)}",
            "error_type": "PapermillException",
            "method": "papermill_direct_api_with_parameters",
            "parameters": safe_params,
            "diagnostic": locals().get('diagnostic_info', {"error": "diagnostic_info not available"})
        }
    except FileNotFoundError as e:
        return {
            "status": "error",
            "error": f"Fichier notebook non trouvé: {str(e)}",
            "error_type": "FileNotFoundError",
            "method": "papermill_direct_api_with_parameters"
        }
    except Exception as e:
        # Gestion sécurisée pour éviter double exception
        try:
            safe_params = json.loads(parameters) if parameters else {}
        except:
            safe_params = {"error": "parameters_not_parseable", "raw": parameters}
        
        return {
            "status": "error",
            "error": f"Erreur inattendue: {str(e)}",
            "error_type": type(e).__name__,
            "method": "papermill_direct_api_with_parameters",
            "parameters": safe_params
        }


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


@mcp.tool()
def system_info() -> Dict[str, Any]:
    """Informations système rapides et fiables"""
    try:
        # Informations de base (toujours rapides)
        info = {
            "status": "success",
            "timestamp": datetime.datetime.now().isoformat(),
            "python": {
                "version": platform.python_version(),
                "executable": sys.executable
            },
            "system": {
                "os": os.name,
                "platform": platform.system(),
                "cwd": os.getcwd()
            },
            "environment": {
                "conda_env": os.environ.get("CONDA_DEFAULT_ENV", "NOT_SET"),
                "conda_prefix": os.environ.get("CONDA_PREFIX", "NOT_SET"),
                "userprofile": os.environ.get("USERPROFILE", "NOT_SET"),
                "total_env_vars": len(os.environ)
            }
        }
        
        # Kernels Jupyter (API directe rapide)
        try:
            from jupyter_client.kernelspec import KernelSpecManager
            ksm = KernelSpecManager()
            specs = ksm.get_all_specs()
            info["jupyter"] = {
                "kernels_available": list(specs.keys()),
                "kernel_count": len(specs)
            }
        except Exception as e:
            info["jupyter"] = {"error": str(e)}
        
        return info
        
    except Exception as e:
        return {
            "status": "error",
            "error": str(e),
            "timestamp": datetime.datetime.now().isoformat()
        }


def main():
    """Point d'entrée principal du serveur"""
    # FastMCP gère automatiquement l'initialisation et l'exécution
    mcp.run()


if __name__ == "__main__":
    main()