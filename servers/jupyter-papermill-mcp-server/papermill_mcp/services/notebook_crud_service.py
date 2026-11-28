"""
Notebook CRUD Service.

Handles basic Create, Read, Update, Delete operations for notebooks and cells.
Extracted from notebook_service.py for better modularity.
"""

import hashlib
import logging
import os
import threading
from pathlib import Path
from typing import Dict, List, Optional, Any, Union

import nbformat

from ..utils.file_utils import FileUtils

logger = logging.getLogger(__name__)

# The echo of the overwritten source is bounded so a large cell cannot flood
# the caller's context; the sha256 of the FULL source is what proves what was
# there, and it is never truncated (#4969).
PREVIOUS_SOURCE_ECHO_LIMIT = 4000


class NotebookCRUDService:
    """
    Service for notebook CRUD operations.

    Delegates low-level file operations to FileUtils but handles
    business logic, path resolution validation, and high-level structure.
    """

    def __init__(self, workspace_dir: str):
        """
        Initialize the CRUD service.

        Args:
            workspace_dir: Root workspace directory for path resolution
        """
        self.workspace_dir = workspace_dir
        # #4716 (second defect, measured 14/11 by ai-01:vllm): every mutating
        # method does read -> mutate -> write with no serialization. Two
        # concurrent writers on the same notebook (MCP tool calls run in
        # separate OS threads) both report success while the last writer
        # silently discards the other's edit. One lock per resolved path
        # serializes the whole cycle at the single choke point every writer
        # of this server goes through.
        self._path_locks: Dict[str, threading.Lock] = {}
        self._path_locks_guard = threading.Lock()

    def _lock_for(self, resolved_path: Union[str, Path]) -> "threading.Lock":
        """
        Return the write lock for one notebook path (#4716).

        Callers pass the already-resolved absolute path. The key is normcased
        so case variants of one Windows path share a single lock. Locks are
        never pruned: one small object per notebook ever written is an
        accepted cost for a long-lived server.

        Args:
            resolved_path: Absolute path (as returned by resolve_path)

        Returns:
            The threading.Lock guarding that notebook's read-modify-write cycle
        """
        key = os.path.normcase(os.path.abspath(str(resolved_path)))
        with self._path_locks_guard:
            lock = self._path_locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._path_locks[key] = lock
            return lock

    def path_write_lock(self, path: Union[str, Path]) -> "threading.Lock":
        """
        Return the write lock for one notebook path, resolved the same way
        the CRUD mutators resolve it (#4716, third defect).

        Writers OUTSIDE this service (kernel output persistence in
        KernelService) must take this lock instead of duplicating the lock
        map: the key has to be derived identically (resolve_path against the
        workspace, then normcase(abspath)) or the two "locks" guard nothing.

        Args:
            path: Notebook path exactly as the external writer knows it
                (absolute, or workspace-relative like the tool layer's input)

        Returns:
            The threading.Lock shared with every CRUD mutator of that notebook
        """
        return self._lock_for(self.resolve_path(path))

    def resolve_path(self, path: Union[str, Path]) -> str:
        """
        Resolve path to absolute path, handling workspace-relative paths.

        Args:
            path: Input path (relative or absolute)

        Returns:
            Absolute path string
        """
        path_str = str(path)

        # If already absolute, return as-is
        if os.path.isabs(path_str):
            # logger.debug(f"Path resolution (absolute): {path_str}")
            return path_str

        # If relative, resolve against workspace directory
        workspace_path = os.path.join(self.workspace_dir, path_str)
        absolute_path = os.path.abspath(workspace_path)

        # logger.debug(f"Path resolution: {path_str} -> {absolute_path}")
        return absolute_path

    async def read_notebook(self, path: Union[str, Path]) -> Dict[str, Any]:
        """
        Read a notebook from file and return its content.

        Args:
            path: Path to the notebook file

        Returns:
            Dictionary with notebook content and metadata

        Raises:
            FileNotFoundError: If notebook file doesn't exist
            ValueError: If notebook format is invalid
        """
        try:
            # Resolve path against workspace
            resolved_path = Path(self.resolve_path(path))
            logger.info(f"Reading notebook: {path} -> {resolved_path}")

            # Read notebook using FileUtils
            notebook = FileUtils.read_notebook(resolved_path)

            # Get file stats
            stat = resolved_path.stat()

            # Convert notebook to dictionary format
            result = {
                "nbformat": notebook.nbformat,
                "nbformat_minor": notebook.nbformat_minor,
                "metadata": dict(notebook.metadata),
                "cells": [],
            }

            # Convert cells to dictionary format
            for cell in notebook.cells:
                cell_dict = {
                    "cell_type": cell.cell_type,
                    "source": cell.source,
                    "metadata": dict(cell.metadata),
                }

                if "id" in cell:
                    cell_dict["id"] = cell["id"]

                # Add execution-specific fields for code cells
                if cell.cell_type == "code":
                    cell_dict["execution_count"] = getattr(
                        cell, "execution_count", None
                    )
                    cell_dict["outputs"] = getattr(cell, "outputs", [])

                result["cells"].append(cell_dict)

            # Add file information
            result["file_info"] = {
                "path": str(resolved_path),
                "size": stat.st_size,
                "modified": stat.st_mtime,
                "cell_count": len(notebook.cells),
            }

            logger.info(f"Successfully read notebook with {len(notebook.cells)} cells")
            return result

        except Exception as e:
            logger.error(f"Error reading notebook {path}: {e}")
            raise

    async def write_notebook(
        self, path: Union[str, Path], content: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Write notebook content to a file.

        Args:
            path: Path where to save the notebook
            content: Notebook content in dictionary format

        Returns:
            Dictionary with operation result

        Raises:
            ValueError: If notebook content is invalid
        """
        try:
            # Resolve path against workspace
            resolved_path = Path(self.resolve_path(path))
            logger.info(f"Writing notebook: {path} -> {resolved_path}")

            with self._lock_for(resolved_path):
                # Convert dictionary to NotebookNode
                from nbformat.v4 import new_notebook

                notebook = new_notebook()
                notebook.nbformat = content.get("nbformat", 4)
                notebook.nbformat_minor = content.get("nbformat_minor", 5)
                notebook.metadata.update(content.get("metadata", {}))

                # Add cells
                from nbformat.v4 import new_code_cell, new_markdown_cell, new_raw_cell

                for cell_data in content.get("cells", []):
                    cell_type = cell_data["cell_type"]
                    source = cell_data["source"]
                    metadata = cell_data.get("metadata", {})

                    if cell_type == "code":
                        cell = new_code_cell(source=source, metadata=metadata)
                        # Restore execution info if present
                        if "execution_count" in cell_data:
                            cell.execution_count = cell_data["execution_count"]
                        if "outputs" in cell_data:
                            # JSON-RPC delivers plain dicts; the v4 writer reads
                            # output.output_type as an attribute (rwbase.split_lines).
                            cell.outputs = [
                                nbformat.from_dict(o) for o in cell_data["outputs"]
                            ]
                    elif cell_type == "markdown":
                        cell = new_markdown_cell(source=source, metadata=metadata)
                    elif cell_type == "raw":
                        cell = new_raw_cell(source=source, metadata=metadata)
                    else:
                        raise ValueError(f"Unknown cell type: {cell_type}")
                    if cell_type in ("markdown", "raw") and "attachments" in cell_data:
                        cell["attachments"] = nbformat.from_dict(
                            cell_data["attachments"]
                        )

                    if "id" in cell_data:
                        cell["id"] = cell_data["id"]
                    notebook.cells.append(cell)

                # Write notebook using FileUtils
                written_path = FileUtils.write_notebook(notebook, resolved_path)

                # Get file stats
                stat = written_path.stat()

                result = {
                    "path": str(written_path),
                    "size": stat.st_size,
                    "cell_count": len(notebook.cells),
                    "success": True,
                }

            logger.info(f"Successfully wrote notebook with {len(notebook.cells)} cells")
            return result

        except Exception as e:
            logger.error(f"Error writing notebook {path}: {e}")
            raise

    async def create_notebook(
        self, path: Union[str, Path], kernel: str = "python3"
    ) -> Dict[str, Any]:
        """
        Create a new empty notebook.

        Args:
            path: Path for the new notebook
            kernel: Kernel name to use

        Returns:
            Dictionary with creation result
        """
        try:
            # Resolve path against workspace
            resolved_path = Path(self.resolve_path(path))
            logger.info(f"Creating new notebook: {path} -> {resolved_path}")

            with self._lock_for(resolved_path):
                # Create empty notebook using FileUtils
                notebook = FileUtils.create_empty_notebook(kernel)

                # Write to file
                written_path = FileUtils.write_notebook(notebook, resolved_path)

                # Get file stats
                stat = written_path.stat()

                result = {
                    "path": str(written_path),
                    "kernel": kernel,
                    "size": stat.st_size,
                    "cell_count": 0,
                    "success": True,
                }

            logger.info(f"Successfully created empty notebook with kernel {kernel}")
            return result

        except Exception as e:
            logger.error(f"Error creating notebook {path}: {e}")
            raise

    async def add_cell(
        self,
        path: Union[str, Path],
        cell_type: str,
        source: str,
        metadata: Optional[Dict[str, Any]] = None,
        index: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        Add a cell to an existing notebook.

        Args:
            path: Path to the notebook file
            cell_type: Type of cell to add ('code', 'markdown', 'raw')
            source: Cell content
            metadata: Optional cell metadata
            index: Optional position to insert cell

        Returns:
            Dictionary with operation result
        """
        try:
            resolved_path = self.resolve_path(path)
            path = Path(resolved_path)
            logger.info(f"Adding {cell_type} cell to notebook: {path}")

            with self._lock_for(resolved_path):
                # Read existing notebook
                notebook = FileUtils.read_notebook(path)

                # Add cell using FileUtils
                notebook = FileUtils.add_cell(notebook, cell_type, source, metadata, index)

                # Write back to file
                FileUtils.write_notebook(notebook, path)

                result = {
                    "path": str(path),
                    "cell_type": cell_type,
                    "cell_count": len(notebook.cells),
                    "success": True,
                }

            logger.info(
                f"Successfully added {cell_type} cell, total cells: {len(notebook.cells)}"
            )
            return result

        except Exception as e:
            logger.error(f"Error adding cell to notebook {path}: {e}")
            raise

    async def remove_cell(self, path: Union[str, Path], index: int) -> Dict[str, Any]:
        """
        Remove a cell from a notebook.

        Args:
            path: Path to the notebook file
            index: Index of cell to remove

        Returns:
            Dictionary with operation result
        """
        try:
            resolved_path = self.resolve_path(path)
            path = Path(resolved_path)
            logger.info(f"Removing cell {index} from notebook: {path}")

            with self._lock_for(resolved_path):
                # Read existing notebook
                notebook = FileUtils.read_notebook(path)

                # Check bounds
                if index < 0 or index >= len(notebook.cells):
                    raise IndexError(
                        f"Cell index {index} out of range (0-{len(notebook.cells)-1})"
                    )

                # Remove cell using FileUtils
                notebook = FileUtils.remove_cell(notebook, index)

                # Write back to file
                FileUtils.write_notebook(notebook, path)

                result = {
                    "path": str(path),
                    "removed_index": index,
                    "cell_count": len(notebook.cells),
                    "success": True,
                }

            logger.info(
                f"Successfully removed cell {index}, remaining cells: {len(notebook.cells)}"
            )
            return result

        except Exception as e:
            logger.error(f"Error removing cell from notebook {path}: {e}")
            raise

    async def update_cell(
        self,
        path: Union[str, Path],
        index: Optional[int] = None,
        source: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        cell_id: Optional[str] = None,
        dry_run: bool = False,
    ) -> Dict[str, Any]:
        """
        Update a cell in a notebook, addressed by index and/or cell id.

        #4969: the result echoes the cell that was actually written (index, id,
        previous source, previous/new sha256). A caller holding a stale index
        map can then compare what it expected against what it overwrote
        instead of losing content silently. Addressing by ``cell_id`` is immune
        to index shifts caused by an insertion or a removal between two calls;
        passing both is accepted only when they designate the same cell.

        Args:
            path: Path to the notebook file
            index: Index of cell to update (required unless cell_id is given)
            source: New cell content (required unless dry_run is True)
            metadata: Optional new metadata
            cell_id: ``id`` of the cell to update (alternative or complement
                to ``index``)
            dry_run: Validate the addressing and return the echo without
                writing anything

        Returns:
            Dictionary with operation result and the echo of the target cell

        Raises:
            ValueError: Neither index nor cell_id given, unknown cell_id, or
                no source in a non dry-run call
            IndexError: Index out of range, or index and cell_id disagree
        """
        try:
            resolved_path = self.resolve_path(path)
            path = Path(resolved_path)
            logger.info(
                f"Updating cell (index={index}, cell_id={cell_id}, dry_run={dry_run}) "
                f"in notebook: {path}"
            )

            with self._lock_for(resolved_path):
                # Read existing notebook
                notebook = FileUtils.read_notebook(path)

                resolved_index = self._resolve_cell_address(notebook, index, cell_id)
                cell = notebook.cells[resolved_index]
                previous_source = cell.get("source", "")
                written_id = cell.get("id")

                if not dry_run and source is None:
                    raise ValueError(
                        "update_cell requires 'source' when dry_run is False"
                    )

                echo = self._echo_of_cell(
                    previous_source,
                    new_source=None if dry_run else source,
                )

                if dry_run:
                    result = {
                        "path": str(path),
                        "index": resolved_index,
                        "updated_index": resolved_index,
                        "id": written_id,
                        "cell_count": len(notebook.cells),
                        "dry_run": True,
                        "success": True,
                        **echo,
                    }
                else:
                    # Update cell using FileUtils
                    notebook = FileUtils.update_cell(
                        notebook, resolved_index, source, metadata
                    )

                    # Write back to file
                    FileUtils.write_notebook(notebook, path)

                    result = {
                        "path": str(path),
                        "index": resolved_index,
                        "updated_index": resolved_index,
                        "id": written_id,
                        "cell_count": len(notebook.cells),
                        "dry_run": False,
                        "success": True,
                        **echo,
                    }

            logger.info(
                f"Successfully {'validated' if dry_run else 'updated'} cell "
                f"{resolved_index} (id={written_id})"
            )
            return result

        except Exception as e:
            logger.error(f"Error updating cell in notebook {path}: {e}")
            raise

    @staticmethod
    def _echo_of_cell(
        previous_source: str, new_source: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Build the echo of the cell that was addressed (#4969).

        The echo is what lets a caller prove what it overwrote without
        re-reading the notebook: ``previous_source`` is the source that was
        there before the write, bounded to
        ``PREVIOUS_SOURCE_ECHO_LIMIT`` characters (with
        ``previous_source_truncated`` telling the caller that it was cut), and
        ``previous_sha256`` / ``new_sha256`` are the sha256 of the FULL
        previous source and of the source just written.

        The hashes are the proof; the truncated text is the readable part.

        Args:
            previous_source: Source of the cell before the write
            new_source: Source just written, or None in a dry run

        Returns:
            The echo fields
        """
        if not isinstance(previous_source, str):
            previous_source = ""

        truncated = len(previous_source) > PREVIOUS_SOURCE_ECHO_LIMIT
        echo: Dict[str, Any] = {
            "previous_source": (
                previous_source[:PREVIOUS_SOURCE_ECHO_LIMIT] if truncated else previous_source
            ),
            "previous_source_truncated": truncated,
            "previous_sha256": hashlib.sha256(
                previous_source.encode("utf-8")
            ).hexdigest(),
        }

        if new_source is not None:
            echo["new_sha256"] = hashlib.sha256(
                new_source.encode("utf-8")
            ).hexdigest()
        else:
            echo["new_sha256"] = None

        return echo

    @staticmethod
    def _resolve_cell_address(
        notebook, index: Optional[int], cell_id: Optional[str]
    ) -> int:
        """
        Resolve the addressed cell to a concrete index (#4969).

        Args:
            notebook: Parsed notebook
            index: Requested index, or None
            cell_id: Requested cell id, or None

        Returns:
            The index of the targeted cell

        Raises:
            ValueError: No address given, or cell_id not found
            IndexError: Index out of range, or index/cell_id disagree
        """
        if index is None and cell_id is None:
            raise ValueError(
                "update_cell requires either 'index' or 'cell_id'"
            )

        total = len(notebook.cells)
        resolved = index

        if cell_id is not None:
            id_index = next(
                (
                    position
                    for position, cell in enumerate(notebook.cells)
                    if cell.get("id") == cell_id
                ),
                None,
            )
            if id_index is None:
                available = [
                    cell.get("id") for cell in notebook.cells[:10] if cell.get("id")
                ]
                raise ValueError(
                    f"Cell id {cell_id!r} not found in notebook "
                    f"({total} cells, first ids: {available})"
                )
            if index is not None and index != id_index:
                raise IndexError(
                    f"Addressing mismatch: cell id {cell_id!r} is at index "
                    f"{id_index}, but index={index} was requested; refusing "
                    f"to guess which one to overwrite"
                )
            resolved = id_index

        if resolved < 0 or resolved >= total:
            raise IndexError(f"Cell index {resolved} out of range (0-{total-1})")

        return resolved

    async def list_notebooks(
        self, directory: Union[str, Path], recursive: bool = False
    ) -> List[Dict[str, Any]]:
        """
        List notebook files in a directory.

        Args:
            directory: Directory to search (relative to workspace or absolute)
            recursive: Whether to search recursively

        Returns:
            List of notebook information
        """
        try:
            resolved_dir = Path(self.resolve_path(directory))
            logger.info(f"Listing notebooks in: {resolved_dir} (recursive={recursive})")

            notebooks = FileUtils.list_notebooks(resolved_dir, recursive)

            logger.info(f"Found {len(notebooks)} notebooks")
            return notebooks

        except Exception as e:
            logger.error(f"Error listing notebooks in {directory}: {e}")
            raise

    async def read_cells(
        self,
        path: Union[str, Path],
        mode: str = "list",
        index: Optional[int] = None,
        start_index: Optional[int] = None,
        end_index: Optional[int] = None,
        include_preview: bool = True,
        preview_length: int = 100,
    ) -> Dict[str, Any]:
        """
        🆕 OUTIL CONSOLIDÉ - Lecture flexible de cellules d'un notebook.

        Remplace: read_cell, read_cells_range, list_notebook_cells

        Args:
            path: Chemin du fichier notebook
            mode: Mode de lecture
                - "single": Une seule cellule (requiert index)
                - "range": Plage de cellules (requiert start_index, end_index optionnel)
                - "list": Liste avec preview de toutes les cellules (défaut)
                - "all": Toutes les cellules complètes
            index: Index de la cellule pour mode="single" (0-based)
            start_index: Index de début pour mode="range" (0-based, inclus)
            end_index: Index de fin pour mode="range" (0-based, inclus, None = jusqu'à la fin)
            include_preview: Inclure preview dans mode="list" (défaut: True)
            preview_length: Longueur du preview (défaut: 100 caractères)

        Returns:
            Dictionary with cells data based on mode

        Raises:
            ValueError: If parameters are inconsistent with mode
            IndexError: If cell index is out of range
        """
        try:
            # Resolve path against workspace
            resolved_path = Path(self.resolve_path(path))
            logger.info(
                f"Reading cells from notebook (mode={mode}): {path} -> {resolved_path}"
            )

            # Validation des paramètres selon le mode
            if mode == "single":
                if index is None:
                    raise ValueError("mode='single' requires 'index' parameter")
            elif mode == "range":
                if start_index is None:
                    raise ValueError("mode='range' requires 'start_index' parameter")

            # Read notebook — use lightweight parse for list mode (#2108)
            if mode == "list":
                notebook = FileUtils.read_notebook_light(resolved_path)
            else:
                notebook = FileUtils.read_notebook(resolved_path)
            total_cells = len(notebook.cells)

            # Mode SINGLE: Retourner une seule cellule
            if mode == "single":
                if index < 0 or index >= total_cells:
                    raise IndexError(
                        f"Cell index {index} out of range (0 to {total_cells - 1})"
                    )

                cell = notebook.cells[index]
                cell_data = {
                    "index": index,
                    "cell_type": cell.cell_type,
                    "source": cell.source,
                    "metadata": dict(cell.metadata),
                }
                if "id" in cell:
                    cell_data["id"] = cell["id"]

                # Add execution info for code cells
                if cell.cell_type == "code":
                    cell_data["execution_count"] = getattr(
                        cell, "execution_count", None
                    )
                    if hasattr(cell, "outputs") and cell.outputs:
                        cell_data["outputs"] = cell.outputs

                result = {
                    "path": str(path),
                    "mode": "single",
                    "cell": cell_data,
                    "index": index,
                    "success": True,
                }

                logger.info(f"Successfully read cell {index}")
                return result

            # Mode RANGE: Retourner une plage de cellules
            elif mode == "range":
                # Handle end_index
                if end_index is None:
                    end_index = total_cells - 1

                # Validate indices
                if start_index < 0 or start_index >= total_cells:
                    raise IndexError(
                        f"Start index {start_index} out of range (0 to {total_cells - 1})"
                    )
                if end_index < 0 or end_index >= total_cells:
                    raise IndexError(
                        f"End index {end_index} out of range (0 to {total_cells - 1})"
                    )
                if start_index > end_index:
                    raise ValueError(
                        f"Start index {start_index} must be <= end index {end_index}"
                    )

                # Extract cells in range
                cells_data = []
                for i in range(start_index, end_index + 1):
                    cell = notebook.cells[i]
                    cell_data = {
                        "index": i,
                        "cell_type": cell.cell_type,
                        "source": cell.source,
                        "metadata": dict(cell.metadata),
                    }
                    if "id" in cell:
                        cell_data["id"] = cell["id"]

                    # Add execution info for code cells
                    if cell.cell_type == "code":
                        cell_data["execution_count"] = getattr(
                            cell, "execution_count", None
                        )
                        if hasattr(cell, "outputs") and cell.outputs:
                            cell_data["outputs"] = cell.outputs

                    cells_data.append(cell_data)

                result = {
                    "path": str(path),
                    "mode": "range",
                    "cells": cells_data,
                    "start_index": start_index,
                    "end_index": end_index,
                    "cell_count": len(cells_data),
                    "success": True,
                }

                logger.info(f"Successfully read {len(cells_data)} cells")
                return result

            # Mode LIST: Liste avec preview
            elif mode == "list":
                cells_info = []
                for i, cell in enumerate(notebook.cells):
                    # Get source text
                    source_text = (
                        "".join(cell.source)
                        if isinstance(cell.source, list)
                        else cell.source
                    )

                    cell_info = {
                        "index": i,
                        "cell_type": cell.cell_type,
                        "full_length": len(source_text),
                    }

                    if "id" in cell:
                        cell_info["id"] = cell["id"]

                    # Add preview if requested
                    if include_preview:
                        preview = (
                            source_text[:preview_length] + "..."
                            if len(source_text) > preview_length
                            else source_text
                        )
                        cell_info["preview"] = preview

                    # Add execution info for code cells
                    if cell.cell_type == "code":
                        cell_info["execution_count"] = getattr(
                            cell, "execution_count", None
                        )
                        cell_info["has_outputs"] = hasattr(cell, "outputs") and bool(
                            cell.outputs
                        )

                    cells_info.append(cell_info)

                result = {
                    "path": str(path),
                    "mode": "list",
                    "cells": cells_info,
                    "cell_count": len(cells_info),
                    "success": True,
                }

                logger.info(f"Successfully listed {len(cells_info)} cells")
                return result

            # Mode ALL: Toutes les cellules complètes
            elif mode == "all":
                cells_data = []
                for i, cell in enumerate(notebook.cells):
                    cell_data = {
                        "index": i,
                        "cell_type": cell.cell_type,
                        "source": cell.source,
                        "metadata": dict(cell.metadata),
                    }
                    if "id" in cell:
                        cell_data["id"] = cell["id"]

                    # Add execution info for code cells
                    if cell.cell_type == "code":
                        cell_data["execution_count"] = getattr(
                            cell, "execution_count", None
                        )
                        if hasattr(cell, "outputs") and cell.outputs:
                            cell_data["outputs"] = cell.outputs

                    cells_data.append(cell_data)

                result = {
                    "path": str(path),
                    "mode": "all",
                    "cells": cells_data,
                    "cell_count": len(cells_data),
                    "success": True,
                }

                logger.info(f"Successfully read all {len(cells_data)} cells")
                return result

            else:
                raise ValueError(
                    f"Invalid mode: {mode}. Must be 'single', 'range', 'list', or 'all'"
                )

        except Exception as e:
            logger.error(f"Error reading cells from notebook {path}: {e}")
            raise
