# Architecture Document: MCP Python Papermill Server

## 1. Overview

This document outlines the architecture for the new Python-based MCP server for Jupyter, which replaces the existing Node.js implementation. The core execution engine will be Papermill, supplemented by `jupyter_client` for fine-grained kernel and session management.

## 2. Goals

-   Achieve 100% feature parity with the 17 tools from the Node.js MCP.
-   Leverage modern Python tooling (`FastMCP`, `asyncio`, `pydantic`).
-   Create a modular, testable, and maintainable codebase.
-   Use Papermill for robust, production-ready notebook execution.

## 3. Directory and File Structure

```
D:/dev/roo-extensions/mcps/internal/servers/jupyter-papermill-mcp-server/
│
├── papermill_mcp/
│   ├── __init__.py
│   ├── main.py                 # Entry point, FastMCP server initialization
│   │
│   ├── core/
│   │   ├── __init__.py
│   │   ├── papermill_executor.py # Papermill-based execution logic
│   │   └── jupyter_manager.py    # Kernel/session manager (for non-Papermill tasks)
│   │
│   ├── services/
│   │   ├── __init__.py
│   │   ├── notebook_service.py   # Service for notebook CRUD operations
│   │   └── kernel_service.py     # Service for kernel lifecycle management
│   │
│   ├── tools/
│   │   ├── __init__.py
│   │   ├── notebook_tools.py     # MCP tool definitions for notebooks
│   │   ├── kernel_tools.py       # MCP tool definitions for kernels
│   │   └── execution_tools.py    # MCP tool definitions for execution
│   │
│   ├── utils/
│   │   ├── __init__.py
│   │   └── file_utils.py         # File manipulation utilities
│   │
│   └── config.py                 # Configuration management
│
├── tests/
│   ├── __init__.py
│   └── ... (test files)
│
├── .gitignore
├── pyproject.toml              # Project dependencies and configuration
└── README.md
```

## 4. Module Specifications

### `main.py`
-   **Role:** Initializes and runs the `FastMCP` server.
-   **Responsibilities:**
    -   Import and register all tool functions from the `tools/` directory.
    -   Handle the main application lifecycle and stdio transport.

### `core/papermill_executor.py`
-   **Role:** A wrapper around the Papermill library.
-   **Responsibilities:**
    -   Provide an `async` function to execute notebooks using `papermill.execute_notebook`.
    -   Handle Papermill-specific exceptions and logging.

### `core/jupyter_manager.py`
-   **Role:** Direct interaction with Jupyter kernels when Papermill is not suitable.
-   **Dependencies:** `jupyter_client`.
-   **Responsibilities:**
    -   Manage the lifecycle of kernels (start, stop, restart).
    -   Maintain a state of active kernels (`dict`).
    -   Execute code snippets on a specific kernel and handle `IOPub` messages to stream back results.

### `services/`
-   **Role:** Business logic layer, orchestrating calls to `core` modules.
-   **`notebook_service.py`:** Handles file-based operations: `create`, `read`, `update` (using `nbformat`), `delete`, `list`.
-   **`kernel_service.py`:** Manages higher-level kernel logic, using `jupyter_manager`.

### `tools/`
-   **Role:** The MCP API layer. Defines functions exposed as tools.
-   **Responsibilities:**
    -   Functions are decorated with `@mcp.tool()`.
    -   Functions should be lightweight wrappers that call the appropriate `services`.
    -   Use Python type hints and docstrings to auto-generate schemas.

## 5. Architecture Diagram

```mermaid
graph TD
    subgraph "MCP Host (Roo)"
        A[Agent LLM]
    end

    subgraph "jupyter-papermill-mcp-server"
        B[main.py: FastMCP Server]
        
        subgraph "Tooling Layer [tools/]"
            C[notebook_tools.py]
            D[kernel_tools.py]
            E[execution_tools.py]
        end
        
        subgraph "Service Layer [services/]"
            F[notebook_service.py]
            G[kernel_service.py]
        end
        
        subgraph "Core Logic [core/]"
            H[papermill_executor.py]
            I[jupyter_manager.py using jupyter_client]
        end
        
        subgraph "Utilities"
            J[config.py]
            K[utils/file_utils.py]
        end
    end

    subgraph "External Systems"
        L[File System (.ipynb files)]
        M[Jupyter Kernels (Python, .NET, ...)]
    end

    A -- JSON-RPC over stdio --> B
    B -- dispatches calls --> C & D & E
    C & E -- uses --> F
    D & E -- uses --> G
    F -- for execution --> H
    F -- for file ops --> L
    G -- for kernel management --> I
    H -- executes via --> M
    I -- interacts with --> M
end

## 6. Integration Strategy and Porting Plan

### Technology Mapping

-   **Notebook Execution (`execute_notebook`):** Will be handled exclusively by **Papermill** for robustness. The `core/papermill_executor.py` module will abstract its usage.
-   **Notebook File Operations (`create`, `read`, `update`, `list`):** Standard Python file I/O (`pathlib`) and the `nbformat` library will be used. These do not require a running Jupyter server.
-   **Kernel Lifecycle (`start`, `stop`, `list`, `status`):** Will be managed by the **`jupyter_client`** Python library. This provides the necessary low-level control. The `core/jupyter_manager.py` module will encapsulate this logic, maintaining a state of active kernels.
-   **Interactive Code Execution (`execute_code`, `execute_cell`):** This also requires **`jupyter_client`** to connect to a specific kernel and manage the `IOPub` message stream to capture real-time output.
-   **Session Management (`list_sessions`, `create_session`, etc.):** Will be handled by direct asynchronous calls to the **Jupyter Server REST API** using the `httpx` library.

### Porting Plan by Priority

The 17 tools will be implemented in prioritized tiers to allow for incremental development and testing.

**Tier 1: Filesystem Operations (No Jupyter dependency)**
1.  `create_notebook`
2.  `read_notebook`
3.  `update_notebook`
4.  `list_notebooks`

**Tier 2: Discovery & Simple Execution (Papermill & Subprocess dependency)**
5.  `list_kernels` (via `subprocess 'jupyter kernelspec list --json'`)
6.  `execute_notebook` (via `papermill`)

**Tier 3: Basic Kernel Management (`jupyter_client` dependency)**
7.  `start_kernel`
8.  `stop_kernel`
9.  `kernel_status`
10. `get_kernel_info`

**Tier 4: Interactive Code Execution (Advanced `jupyter_client`)**
11. `execute_code`
12. `execute_cell`

**Tier 5: Session Management & Finalization (Jupyter REST API dependency)**
13. `list_sessions`
14. `create_session`
15. `delete_session`
16. `get_session_info`
17. `restart_kernel`