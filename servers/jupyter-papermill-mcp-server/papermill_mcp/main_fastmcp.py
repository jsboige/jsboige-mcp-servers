#!/usr/bin/env python3
"""
[WARNING]  API OBSOL?TE - UTILISER main.py POUR LA NOUVELLE ARCHITECTURE [WARNING]

Serveur MCP pour Jupyter et Papermill utilisant FastMCP (OBSOL?TE)

? MIGRATION REQUISE :
- Ancienne API: main_fastmcp.py (FastMCP simple) - OBSOL?TE
- Nouvelle API: main.py (FastMCP consolide) - Architecture layered 31 outils

? CORRECTIONS SDDD D?J? INT?GR?ES dans main.py :
- parameterize_notebook: Support JSON parsing automatique
- execute_notebook_solution_a: Timestamps uniques anti-conflits

[START] UTILISER : python -m papermill_mcp.main (architecture consolidee)
[ERROR] ?VITER : python -m papermill_mcp.main_fastmcp (obsolete)

Date d'obsolescence : 23 septembre 2025
Agent : Debug - Reconsolidation SDDD sur architecture FastMCP consolidee
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

# Import nest_asyncio at the top to handle nested event loops
try:
    import nest_asyncio
    nest_asyncio.apply()
    # Silent success - stdout reserved for MCP protocol
except ImportError:
    # Silent failure - stdout reserved for MCP protocol
    pass

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
        return [{"error": f"Erreur lors de la recuperation des kernels: {str(e)}"}]

@mcp.tool()
def create_notebook(
    notebook_path: str = Field(description="Chemin du notebook a creer"),
    kernel_name: str = Field(default="python3", description="Nom du kernel a utiliser")
) -> Dict[str, Any]:
    """Cree un nouveau notebook Jupyter"""
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
        
        # Creer le repertoire parent si necessaire
        Path(notebook_path).parent.mkdir(parents=True, exist_ok=True)
        
        with open(notebook_path, 'w', encoding='utf-8') as f:
            json.dump(notebook_structure, f, indent=2)
        
        return {"status": "success", "notebook_path": notebook_path, "message": "Notebook cree avec succes"}
    except Exception as e:
        return {"status": "error", "error": str(e)}


@mcp.tool()
def add_cell_to_notebook(
    notebook_path: str = Field(description="Chemin du notebook"),
    cell_type: str = Field(default="code", description="Type de cellule (code, markdown, raw)"),
    content: str = Field(description="Contenu de la cellule")
) -> Dict[str, Any]:
    """Ajoute une cellule a un notebook existant"""
    try:
        # Charger le notebook
        with open(notebook_path, 'r', encoding='utf-8') as f:
            notebook = json.load(f)
        
        # Creer la nouvelle cellule
        lines = content.split('\n')
        # Pour Jupyter, chaque ligne doit se terminer par \n SAUF la derniere ligne
        formatted_lines = []
        for i, line in enumerate(lines):
            if i == len(lines) - 1:  # Derniere ligne - pas de \n
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
        
        return {"status": "success", "message": "Cellule ajoutee avec succes"}
    except Exception as e:
        return {"status": "error", "error": str(e)}


@mcp.tool()
def execute_notebook_solution_a(
    notebook_path: str = Field(description="Chemin du notebook a executer"),
    output_path: str = Field(default="", description="Chemin de sortie (optionnel)")
) -> Dict[str, Any]:
    """SOLUTION A - API Papermill directe (remplace subprocess conda run)"""
    try:
        # CORRECTION BUG INSTABILIT? : ?viter conflits de fichiers avec timestamps
        if not output_path:
            timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
            output_path = notebook_path.replace('.ipynb', f'_executed_{timestamp}.ipynb')
        
        # Diagnostic avant execution
        diagnostic_info = {
            "method": "conda_subprocess_isolation",
            "conda_env": "mcp-jupyter-py310",
            "cwd": os.getcwd(),
            "python_env": sys.executable
        }
        
        # CORRECTION WORKING DIRECTORY - Solution basee sur papermill_executor.py
        notebook_dir = os.path.dirname(os.path.abspath(notebook_path))
        original_cwd = os.getcwd()
        
        try:
            # Changer vers le repertoire du notebook pour resoudre les chemins relatifs NuGet
            os.chdir(notebook_dir)
            
            # Execution directe avec l'API Papermill
            start_time = datetime.datetime.now()
            
            pm.execute_notebook(
                input_path=notebook_path,
                output_path=output_path,
                kernel_name=None,   # Auto-detection du kernel
                progress_bar=True,
                log_output=True,
                cwd=None,
                store_widget_state=True  # Support ipywidgets for interactive notebooks
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
            "message": "Notebook execute avec succes via API Papermill directe",
            "method": "papermill_direct_api",
            "execution_time_seconds": execution_time,
            "diagnostic": diagnostic_info,
            "timestamp": end_time.isoformat()
        }
        
    except PapermillExecutionError as e:
        return {
            "status": "error",
            "error": f"Erreur d'execution Papermill: {str(e)}",
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
    notebook_path: str = Field(description="Chemin du notebook a executer"),
    output_path: str = Field(default="", description="Chemin de sortie (optionnel)")
) -> Dict[str, Any]:
    """Execute notebook via subprocess isolation conda avec environnement mcp-jupyter-py310"""
    try:
        if not os.path.exists(notebook_path):
            return {"error": f"Le notebook {notebook_path} n'existe pas"}
            
        if not output_path:
            output_path = notebook_path.replace('.ipynb', '_executed.ipynb')
        
        # Changement du repertoire de travail vers le repertoire du notebook
        notebook_dir = os.path.dirname(os.path.abspath(notebook_path))
        original_cwd = os.getcwd()
        
        try:
            os.chdir(notebook_dir)
            
            cmd = [
                "conda", "run", "-n", "mcp-jupyter-py310",
                "python", "-m", "papermill",
                notebook_path,
                output_path,
                "--progress-bar"
            ]
            
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=False
            )
        finally:
            os.chdir(original_cwd)
            
        # Traitement du resultat...
        return {
            "success": True,
            "input_path": notebook_path,
            "output_path": output_path,
            "stdout": result.stdout,
            "stderr": result.stderr if result.stderr else None,
            "return_code": result.returncode,
            "method": "papermill_direct_api"
        }
        
    except Exception as e:
        return {
            "error": f"Erreur lors de l'execution : {str(e)}",
            "success": False
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
    parameters: Dict[str, Any] = Field(description="Parametres pour le notebook"),
    output_path: str = Field(default="", description="Chemin de sortie (optionnel)")
) -> Dict[str, Any]:
    """Execute un notebook avec des parametres via Papermill API directe (SOLUTION A - Bypass Conda Subprocess)"""
    try:
        # CORRECTION BUG PYDANTIC : Gerer serialisation JSON via Roo
        if isinstance(parameters, str):
            # Roo peut envoyer les parametres comme string JSON
            try:
                params = json.loads(parameters) if parameters else {}
            except json.JSONDecodeError:
                # Si ce n'est pas du JSON valide, retourner erreur explicite
                return {
                    "status": "error",
                    "error": f"Parametres invalides - JSON attendu: {parameters}",
                    "error_type": "InvalidParametersFormat",
                    "method": "papermill_direct_api_with_parameters"
                }
        else:
            # Parametres deja sous forme de dictionnaire (cas normal)
            params = parameters if parameters else {}
        
        if not output_path:
            output_path = notebook_path.replace('.ipynb', '_parameterized.ipynb')
        
        # SOLUTION A: Appel direct API Papermill avec parametres (remplace subprocess conda)
        # Avantages: Plus rapide, injection native parametres, gestion d'erreurs robuste
        
        # Diagnostic avant execution
        diagnostic_info = {
            "method": "papermill_direct_api_with_parameters",
            "cwd": os.getcwd(),
            "python_env": sys.executable,
            "papermill_version": getattr(pm, '__version__', 'unknown'),
            "parameters_count": len(params)
        }
        
        # CORRECTION WORKING DIRECTORY - Solution basee sur papermill_executor.py
        notebook_dir = os.path.dirname(os.path.abspath(notebook_path))
        original_cwd = os.getcwd()
        
        try:
            # Changer vers le repertoire du notebook pour resoudre les chemins relatifs NuGet
            os.chdir(notebook_dir)
            
            # Execution directe avec Papermill Python API et injection parametres
            start_time = datetime.datetime.now()
            
            pm.execute_notebook(
                input_path=notebook_path,
                output_path=output_path,
                parameters=params,  # Injection directe des parametres Python
                kernel_name=None,   # Auto-detection du kernel
                progress_bar=True,
                log_output=True,
                cwd=None,
                store_widget_state=True  # Support ipywidgets for interactive notebooks
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
            "message": "Notebook parametrise et execute avec succes via API Papermill directe",
            "method": "papermill_direct_api_with_parameters",
            "execution_time_seconds": execution_time,
            "diagnostic": diagnostic_info,
            "timestamp": end_time.isoformat()
        }
        
    except json.JSONDecodeError as e:
        # Erreur de parsing JSON des parametres
        return {
            "status": "error",
            "error": f"Erreur de format JSON dans les parametres: {str(e)}",
            "error_type": "JSONDecodeError",
            "method": "papermill_direct_api_with_parameters"
        }
    except PapermillExecutionError as e:
        # Erreur specifique d'execution Papermill (kernel crash, erreur code, etc.)
        try:
            safe_params = json.loads(parameters) if parameters else {}
        except Exception:
            safe_params = {"error": "parameters_not_parseable", "raw_type": type(parameters).__name__}
        
        return {
            "status": "error",
            "error": f"Erreur d'execution Papermill: {str(e)}",
            "error_type": "PapermillExecutionError",
            "method": "papermill_direct_api_with_parameters",
            "parameters": safe_params,
            "diagnostic": locals().get('diagnostic_info', {"error": "diagnostic_info not available"})
        }
    except PapermillException as e:
        # Autres erreurs Papermill (format notebook, parametres invalides, etc.)
        try:
            safe_params = params if 'params' in locals() else {"error": "params_not_initialized"}
        except Exception:
            safe_params = {"error": "parameters_not_accessible", "raw_type": type(parameters).__name__}
        
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
            "error": f"Fichier notebook non trouve: {str(e)}",
            "error_type": "FileNotFoundError",
            "method": "papermill_direct_api_with_parameters"
        }
    except Exception as e:
        # Gestion securisee pour eviter double exception
        try:
            safe_params = params if 'params' in locals() else {"error": "params_not_initialized"}
        except Exception:
            safe_params = {"error": "parameters_not_accessible", "raw_type": type(parameters).__name__}
        
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
    """Recupere les metadonnees d'un notebook"""
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
                    
                    # Extraire un apercu des donnees de sortie
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
        
        # Verifications de base
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
    """Informations systeme rapides et fiables"""
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

@mcp.tool()
def read_cell(
    notebook_path: str = Field(description="Chemin du notebook"),
    index: int = Field(description="Index de la cellule a lire (0-based)")
) -> Dict[str, Any]:
    """Lit une cellule specifique d'un notebook"""
    try:
        with open(notebook_path, 'r', encoding='utf-8') as f:
            notebook = json.load(f)
        
        cells = notebook.get("cells", [])
        
        # Verifier l'index
        if index < 0 or index >= len(cells):
            return {
                "status": "error",
                "error": f"Index {index} hors limites (0 a {len(cells) - 1})"
            }
        
        cell = cells[index]
        
        # Extraire les informations de la cellule
        cell_info = {
            "index": index,
            "cell_type": cell.get("cell_type", "unknown"),
            "source": ''.join(cell.get("source", [])),
            "metadata": cell.get("metadata", {}),
            "has_outputs": bool(cell.get("outputs", []))
        }
        
        # Ajouter les informations d'execution pour les cellules de code
        if cell.get("cell_type") == "code":
            cell_info["execution_count"] = cell.get("execution_count")
            if cell.get("outputs"):
                cell_info["outputs"] = cell.get("outputs", [])
                cell_info["output_count"] = len(cell.get("outputs", []))
        
        return {
            "status": "success",
            "notebook_path": notebook_path,
            "cell": cell_info,
            "total_cells": len(cells)
        }
        
    except Exception as e:
        return {"status": "error", "error": str(e)}


@mcp.tool()
def read_cells_range(
    notebook_path: str = Field(description="Chemin du notebook"),
    start_index: int = Field(description="Index de debut (0-based, inclus)"),
    end_index: Optional[int] = Field(default=None, description="Index de fin (0-based, inclus). Si None, lit jusqu'a la fin")
) -> Dict[str, Any]:
    """Lit une plage de cellules d'un notebook"""
    try:
        with open(notebook_path, 'r', encoding='utf-8') as f:
            notebook = json.load(f)
        
        cells = notebook.get("cells", [])
        total_cells = len(cells)
        
        # Gerer end_index
        if end_index is None:
            end_index = total_cells - 1
        
        # Verifier les indices
        if start_index < 0 or start_index >= total_cells:
            return {
                "status": "error",
                "error": f"Index de debut {start_index} hors limites (0 a {total_cells - 1})"
            }
        if end_index < 0 or end_index >= total_cells:
            return {
                "status": "error", 
                "error": f"Index de fin {end_index} hors limites (0 a {total_cells - 1})"
            }
        if start_index > end_index:
            return {
                "status": "error",
                "error": f"Index de debut {start_index} doit etre <= index de fin {end_index}"
            }
        
        # Extraire les cellules dans la plage
        cells_data = []
        for i in range(start_index, end_index + 1):
            cell = cells[i]
            cell_info = {
                "index": i,
                "cell_type": cell.get("cell_type", "unknown"),
                "source": ''.join(cell.get("source", [])),
                "metadata": cell.get("metadata", {}),
                "has_outputs": bool(cell.get("outputs", []))
            }
            
            # Ajouter les informations d'execution pour les cellules de code
            if cell.get("cell_type") == "code":
                cell_info["execution_count"] = cell.get("execution_count")
                if cell.get("outputs"):
                    cell_info["outputs"] = cell.get("outputs", [])
                    cell_info["output_count"] = len(cell.get("outputs", []))
            
            cells_data.append(cell_info)
        
        return {
            "status": "success",
            "notebook_path": notebook_path,
            "start_index": start_index,
            "end_index": end_index,
            "cells": cells_data,
            "cells_count": len(cells_data),
            "total_cells": total_cells
        }
        
    except Exception as e:
        return {"status": "error", "error": str(e)}


@mcp.tool()
def update_cell(
    notebook_path: str = Field(description="Chemin du notebook"),
    index: int = Field(description="Index de la cellule a modifier (0-based)"),
    source: str = Field(description="Nouveau contenu de la cellule")
) -> Dict[str, Any]:
    """Modifie le contenu d'une cellule specifique"""
    try:
        with open(notebook_path, 'r', encoding='utf-8') as f:
            notebook = json.load(f)
        
        cells = notebook.get("cells", [])
        
        # Verifier l'index
        if index < 0 or index >= len(cells):
            return {
                "status": "error",
                "error": f"Index {index} hors limites (0 a {len(cells) - 1})"
            }
        
        # Mettre a jour le contenu de la cellule
        lines = source.split('\n')
        formatted_lines = []
        for i, line in enumerate(lines):
            if i == len(lines) - 1:  # Derniere ligne - pas de \n
                formatted_lines.append(line)
            else:  # Toutes les autres lignes - avec \n
                formatted_lines.append(line + '\n')
        
        notebook["cells"][index]["source"] = formatted_lines
        
        # Reinitialiser execution_count et outputs pour les cellules de code
        if notebook["cells"][index].get("cell_type") == "code":
            notebook["cells"][index]["execution_count"] = None
            notebook["cells"][index]["outputs"] = []
        
        # Sauvegarder le notebook
        with open(notebook_path, 'w', encoding='utf-8') as f:
            json.dump(notebook, f, indent=2)
        
        return {
            "status": "success",
            "notebook_path": notebook_path,
            "updated_index": index,
            "cell_count": len(cells),
            "message": "Cellule mise a jour avec succes"
        }
        
    except Exception as e:
        return {"status": "error", "error": str(e)}


def main():
    """Point d'entree principal du serveur"""
    # FastMCP gere automatiquement l'initialisation et l'execution
    mcp.run()


if __name__ == "__main__":
    main()