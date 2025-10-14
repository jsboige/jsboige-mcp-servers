"""
Phase 3 Consolidation: execute_notebook unified method.

This module contains the consolidated execute_notebook implementation
that replaces 5 redundant Papermill execution tools.
"""

import asyncio
import logging
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Literal, Optional

import nbformat

logger = logging.getLogger(__name__)


class ExecuteNotebookConsolidated:
    """
    Consolidated notebook execution logic for Phase 3.
    
    This class encapsulates the unified execute_notebook method that replaces:
    - execute_notebook_papermill
    - execute_notebook_solution_a
    - parameterize_notebook
    - execute_notebook_sync
    - start_notebook_async
    """
    
    def __init__(self, notebook_service):
        """
        Initialize with reference to NotebookService.
        
        Args:
            notebook_service: Parent NotebookService instance
        """
        self.notebook_service = notebook_service
    
    async def execute_notebook(
        self,
        input_path: str,
        output_path: Optional[str] = None,
        parameters: Optional[Dict[str, Any]] = None,
        mode: Literal["sync", "async"] = "sync",
        kernel_name: Optional[str] = None,
        timeout: Optional[int] = None,
        log_output: bool = True,
        progress_bar: bool = False,
        report_mode: Literal["full", "summary", "minimal"] = "summary"
    ) -> Dict[str, Any]:
        """
        🆕 OUTIL CONSOLIDÉ - Exécution de notebook avec Papermill.
        
        Remplace: execute_notebook_papermill, parameterize_notebook, 
                  execute_notebook_solution_a, execute_notebook_sync, start_notebook_async
        
        Args:
            input_path: Chemin du notebook source
            output_path: Chemin du notebook de sortie (optionnel, auto-généré si None)
            parameters: Paramètres à injecter dans le notebook (dict clé-valeur)
            mode: Mode d'exécution
                - "sync": Exécution synchrone (bloquant, pour notebooks courts)
                - "async": Exécution asynchrone (non-bloquant, retourne job_id)
            kernel_name: Nom du kernel à utiliser (auto-détecté si None)
            timeout: Timeout global en secondes (None = illimité)
            log_output: Activer logging des outputs pendant exécution
            progress_bar: Afficher barre de progression (mode sync uniquement)
            report_mode: Niveau de détail du rapport
                - "full": Toutes les cellules avec outputs
                - "summary": Statistiques + erreurs
                - "minimal": Status uniquement
            
        Returns:
            Mode "sync":
            {
                "status": "success" | "error",
                "mode": "sync",
                "input_path": str,
                "output_path": str,
                "execution_time": float,
                "cells_executed": int,
                "cells_succeeded": int,
                "cells_failed": int,
                "parameters_injected": Dict[str, Any],
                "kernel_name": str,
                "report": {...},
                "error": Optional[dict]
            }
            
            Mode "async":
            {
                "status": "submitted",
                "mode": "async",
                "job_id": str,
                "input_path": str,
                "output_path": str,
                "parameters_injected": Dict[str, Any],
                "kernel_name": str,
                "submitted_at": str,
                "estimated_duration": Optional[float],
                "message": "..."
            }
        
        Validation:
            - input_path doit exister
            - parameters doit être dict ou None
            - mode="async" incompatible avec progress_bar=True
            - timeout doit être positif si spécifié
        """
        start_time = time.time()
        
        try:
            # Validation des paramètres
            validation_result = self._validate_parameters(
                input_path=input_path,
                parameters=parameters,
                mode=mode,
                progress_bar=progress_bar,
                timeout=timeout,
                report_mode=report_mode
            )
            
            if not validation_result["valid"]:
                return {
                    "status": "error",
                    "mode": mode,
                    "error": {
                        "type": "ValidationError",
                        "message": validation_result["error"],
                        "traceback": ""
                    },
                    "input_path": input_path,
                    "timestamp": datetime.now(timezone.utc).isoformat()
                }
            
            # Résoudre input_path
            resolved_input_path = Path(self.notebook_service.resolve_path(input_path))
            
            # Auto-générer output_path si nécessaire
            if output_path is None:
                output_path = self._generate_output_path(resolved_input_path)
            else:
                output_path = self.notebook_service.resolve_path(output_path)
            
            logger.info(f"Execute notebook (mode={mode}): {input_path} -> {output_path}")
            
            # Dispatcher selon le mode
            if mode == "sync":
                return await self._execute_sync(
                    input_path=str(resolved_input_path),
                    output_path=output_path,
                    parameters=parameters,
                    kernel_name=kernel_name,
                    timeout=timeout,
                    log_output=log_output,
                    progress_bar=progress_bar,
                    report_mode=report_mode,
                    start_time=start_time
                )
            elif mode == "async":
                return await self._execute_async(
                    input_path=str(resolved_input_path),
                    output_path=output_path,
                    parameters=parameters,
                    kernel_name=kernel_name,
                    timeout=timeout,
                    start_time=start_time
                )
            else:
                raise ValueError(f"Invalid mode: {mode}. Must be 'sync' or 'async'")
        
        except Exception as e:
            execution_time = time.time() - start_time
            logger.error(f"Error in execute_notebook: {e}")
            return {
                "status": "error",
                "mode": mode,
                "input_path": input_path,
                "output_path": output_path,
                "execution_time": execution_time,
                "error": {
                    "type": type(e).__name__,
                    "message": str(e),
                    "traceback": traceback.format_exc()
                },
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
    
    def _validate_parameters(
        self,
        input_path: str,
        parameters: Optional[Dict[str, Any]],
        mode: str,
        progress_bar: bool,
        timeout: Optional[int],
        report_mode: str
    ) -> Dict[str, Any]:
        """Valide tous les paramètres d'entrée."""
        # Vérifier input_path existe
        resolved_path = Path(self.notebook_service.resolve_path(input_path))
        if not resolved_path.exists():
            return {
                "valid": False,
                "error": f"Input notebook not found: {resolved_path}"
            }
        
        # Vérifier parameters est dict ou None
        if parameters is not None and not isinstance(parameters, dict):
            return {
                "valid": False,
                "error": f"Parameters must be a dictionary, got {type(parameters).__name__}"
            }
        
        # Vérifier mode valide
        if mode not in ["sync", "async"]:
            return {
                "valid": False,
                "error": f"Invalid mode: {mode}. Must be 'sync' or 'async'"
            }
        
        # Vérifier progress_bar incompatible avec async
        if mode == "async" and progress_bar:
            return {
                "valid": False,
                "error": "progress_bar=True is not compatible with mode='async'"
            }
        
        # Vérifier timeout positif
        if timeout is not None and timeout <= 0:
            return {
                "valid": False,
                "error": f"Timeout must be positive, got {timeout}"
            }
        
        # Vérifier report_mode valide
        if report_mode not in ["full", "summary", "minimal"]:
            return {
                "valid": False,
                "error": f"Invalid report_mode: {report_mode}. Must be 'full', 'summary', or 'minimal'"
            }
        
        return {"valid": True}
    
    def _generate_output_path(self, input_path: Path) -> str:
        """Génère automatiquement un output_path avec timestamp."""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        output_name = f"{input_path.stem}_output_{timestamp}.ipynb"
        output_path = input_path.parent / output_name
        return str(output_path)
    
    async def _execute_sync(
        self,
        input_path: str,
        output_path: str,
        parameters: Optional[Dict[str, Any]],
        kernel_name: Optional[str],
        timeout: Optional[int],
        log_output: bool,
        progress_bar: bool,
        report_mode: str,
        start_time: float
    ) -> Dict[str, Any]:
        """
        Exécution synchrone avec architecture hybride.
        
        Réutilise execute_notebook_solution_a qui gère :
        - Sync rapide pour notebooks courts
        - Bascule async automatique pour notebooks longs
        """
        try:
            # Utiliser l'architecture hybride éprouvée
            sync_timeout = timeout or 60  # Défaut 1 minute pour sync
            total_timeout = (timeout * 2) if timeout else 120
            
            result = await self.notebook_service.execute_notebook_solution_a(
                input_path=input_path,
                output_path=output_path,
                timeout=total_timeout,
                sync_timeout_seconds=sync_timeout
            )
            
            # Si paramètres fournis, injecter via parameterize
            if parameters:
                logger.info(f"Injecting parameters: {list(parameters.keys())}")
                result = await self.notebook_service.parameterize_notebook(
                    input_path=input_path,
                    parameters=parameters,
                    output_path=output_path
                )
            
            execution_time = time.time() - start_time
            
            # Analyser le notebook de sortie si disponible
            if result.get("success") and Path(output_path).exists():
                analysis = self._analyze_notebook_output(output_path)
                report = self._format_report(output_path, analysis, report_mode)
                
                return {
                    "status": "success",
                    "mode": "sync",
                    "input_path": input_path,
                    "output_path": output_path,
                    "execution_time": execution_time,
                    "cells_executed": analysis["cells_executed"],
                    "cells_succeeded": analysis["cells_succeeded"],
                    "cells_failed": analysis["cells_failed"],
                    "parameters_injected": parameters or {},
                    "kernel_name": kernel_name or "auto",
                    "report": report,
                    "timestamp": datetime.now(timezone.utc).isoformat()
                }
            else:
                # Échec ou in_progress (notebook long)
                return {
                    "status": result.get("execution_mode", "unknown"),
                    "mode": "sync",
                    "input_path": input_path,
                    "output_path": output_path,
                    "execution_time": execution_time,
                    "parameters_injected": parameters or {},
                    "kernel_name": kernel_name or "auto",
                    "message": result.get("message", "Execution in progress or failed"),
                    "job_id": result.get("job_id"),
                    "timestamp": datetime.now(timezone.utc).isoformat()
                }
        
        except Exception as e:
            execution_time = time.time() - start_time
            logger.error(f"Error in sync execution: {e}")
            return {
                "status": "error",
                "mode": "sync",
                "input_path": input_path,
                "output_path": output_path,
                "execution_time": execution_time,
                "error": {
                    "type": type(e).__name__,
                    "message": str(e),
                    "traceback": traceback.format_exc()
                },
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
    
    async def _execute_async(
        self,
        input_path: str,
        output_path: str,
        parameters: Optional[Dict[str, Any]],
        kernel_name: Optional[str],
        timeout: Optional[int],
        start_time: float
    ) -> Dict[str, Any]:
        """
        Exécution asynchrone via ExecutionManager.
        
        Délègue à start_notebook_async qui gère le job-based execution.
        """
        try:
            # Démarrer l'exécution asynchrone
            result = await self.notebook_service.start_notebook_async(
                input_path=input_path,
                output_path=output_path,
                parameters=parameters,
                timeout_seconds=timeout,
                wait_seconds=2  # Attendre 2s pour confirmation
            )
            
            if not result.get("success"):
                return {
                    "status": "error",
                    "mode": "async",
                    "input_path": input_path,
                    "error": {
                        "type": "AsyncStartError",
                        "message": result.get("error", "Failed to start async execution"),
                        "traceback": ""
                    },
                    "timestamp": datetime.now(timezone.utc).isoformat()
                }
            
            # Estimer la durée
            estimated_duration = self._estimate_duration(Path(input_path))
            
            return {
                "status": "submitted",
                "mode": "async",
                "job_id": result["job_id"],
                "input_path": input_path,
                "output_path": output_path,
                "parameters_injected": parameters or {},
                "kernel_name": kernel_name or "auto",
                "submitted_at": datetime.now(timezone.utc).isoformat(),
                "estimated_duration": estimated_duration,
                "timeout_seconds": result.get("timeout_seconds"),
                "message": f"Job submitted successfully. Use get_execution_status_async(job_id='{result['job_id']}') to check status."
            }
        
        except Exception as e:
            logger.error(f"Error in async execution: {e}")
            return {
                "status": "error",
                "mode": "async",
                "input_path": input_path,
                "output_path": output_path,
                "error": {
                    "type": type(e).__name__,
                    "message": str(e),
                    "traceback": traceback.format_exc()
                },
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
    
    def _analyze_notebook_output(self, output_path: str) -> Dict[str, Any]:
        """Analyse le notebook de sortie pour extraire les statistiques."""
        try:
            with open(output_path, 'r', encoding='utf-8') as f:
                notebook = nbformat.read(f, as_version=4)
            
            cells_executed = 0
            cells_succeeded = 0
            cells_failed = 0
            
            for cell in notebook.cells:
                if cell.cell_type == "code":
                    if cell.get("execution_count") is not None:
                        cells_executed += 1
                        
                        # Vérifier les erreurs dans les outputs
                        has_error = False
                        if hasattr(cell, 'outputs'):
                            for output in cell.outputs:
                                if output.get("output_type") == "error":
                                    has_error = True
                                    break
                        
                        if has_error:
                            cells_failed += 1
                        else:
                            cells_succeeded += 1
            
            return {
                "cells_executed": cells_executed,
                "cells_succeeded": cells_succeeded,
                "cells_failed": cells_failed
            }
        
        except Exception as e:
            logger.warning(f"Error analyzing notebook output: {e}")
            return {
                "cells_executed": 0,
                "cells_succeeded": 0,
                "cells_failed": 0
            }
    
    def _format_report(
        self,
        output_path: str,
        analysis: Dict[str, Any],
        report_mode: str
    ) -> Dict[str, Any]:
        """Formate le rapport selon le mode demandé."""
        if report_mode == "minimal":
            return {
                "mode": "minimal",
                "cells_executed": analysis["cells_executed"],
                "success": analysis["cells_failed"] == 0
            }
        
        elif report_mode == "summary":
            return {
                "mode": "summary",
                "cells_executed": analysis["cells_executed"],
                "cells_succeeded": analysis["cells_succeeded"],
                "cells_failed": analysis["cells_failed"],
                "success_rate": (
                    analysis["cells_succeeded"] / analysis["cells_executed"]
                    if analysis["cells_executed"] > 0 else 0.0
                )
            }
        
        elif report_mode == "full":
            # Pour le mode full, lire et retourner tous les détails
            try:
                with open(output_path, 'r', encoding='utf-8') as f:
                    notebook = nbformat.read(f, as_version=4)
                
                cells_details = []
                for i, cell in enumerate(notebook.cells):
                    if cell.cell_type == "code":
                        cell_detail = {
                            "index": i,
                            "execution_count": cell.get("execution_count"),
                            "source": cell.source[:200] + "..." if len(cell.source) > 200 else cell.source
                        }
                        
                        # Ajouter outputs si présents
                        if hasattr(cell, 'outputs') and cell.outputs:
                            cell_detail["outputs"] = [
                                {
                                    "output_type": output.get("output_type"),
                                    "has_data": "data" in output
                                }
                                for output in cell.outputs
                            ]
                        
                        cells_details.append(cell_detail)
                
                return {
                    "mode": "full",
                    "cells_executed": analysis["cells_executed"],
                    "cells_succeeded": analysis["cells_succeeded"],
                    "cells_failed": analysis["cells_failed"],
                    "cells_details": cells_details
                }
            
            except Exception as e:
                logger.warning(f"Error reading full report: {e}")
                # Fallback to summary
                return self._format_report(output_path, analysis, "summary")
        
        else:
            raise ValueError(f"Invalid report_mode: {report_mode}")
    
    def _estimate_duration(self, notebook_path: Path) -> Optional[float]:
        """Estime la durée d'exécution en minutes."""
        try:
            # Réutiliser la logique d'estimation existante
            timeout_seconds = self.notebook_service._calculate_optimal_timeout(notebook_path)
            return round(timeout_seconds / 60, 1)
        except Exception as e:
            logger.warning(f"Error estimating duration: {e}")
            return None