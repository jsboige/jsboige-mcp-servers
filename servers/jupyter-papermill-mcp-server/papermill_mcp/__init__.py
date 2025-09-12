"""
Papermill MCP Server - A Python-based MCP server for Jupyter using Papermill.

This package provides a complete replacement for the Node.js Jupyter MCP server,
leveraging Papermill for notebook execution and jupyter_client for kernel management.
"""

__version__ = "1.0.0"
__author__ = "CoursIA Team"

from .main import main

__all__ = ["main"]