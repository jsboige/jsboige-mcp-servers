"""Runtime-name and container-override validation — single source (#4755).

Both validation layers import these helpers: the dataclass facade
(``sk_agent_config.McpConfig.from_dict``) and the Pydantic layer
(``sk_agent_schemas.ToolSpec`` field validators). Before #4755 each carried
its own copy and could only drift apart (ms#1773 review W2.4); the module is
dependency-free so the facade keeps working when pydantic is absent.
"""

from __future__ import annotations

from typing import Any

#: Runtime names a config may declare (#4755 W2.1). ``current_runtime`` pins
#: the process to one of these; a misspelled name ("stdoi") used to be
#: accepted silently and silently excluded the plugin from every runtime.
KNOWN_RUNTIMES = frozenset({"stdio", "container"})


def parse_runtimes(raw: Any) -> list[str] | None:
    """Validate an MCP entry's ``runtimes`` list (#4741, #4755 W2.1).

    None (absent) or an empty list -> None (all runtimes, legacy behaviour).
    A list of non-empty strings -> that list, lowercased and stripped. Any
    other shape raises ValueError. Runtime names are compared
    case-insensitively (``current_runtime`` lowercases), so the validation
    stores them lowercased too. An unknown name is refused with the known
    set quoted — a typo must not silently mask a plugin everywhere.
    """
    if raw is None:
        return None
    if not isinstance(raw, list) or not all(
        isinstance(r, str) and r.strip() for r in raw
    ):
        raise ValueError(
            'runtimes must be a list of non-empty strings (e.g. ["stdio"])'
        )
    names = [r.strip().lower() for r in raw]
    unknown = sorted({r for r in names if r not in KNOWN_RUNTIMES})
    if unknown:
        raise ValueError(
            f"runtimes contains unknown name(s) {unknown}; "
            f"known runtimes: {sorted(KNOWN_RUNTIMES)}"
        )
    return names or None


def parse_container_override(raw: Any) -> dict[str, Any] | None:
    """Validate an MCP entry's ``container`` override (``#4741``).

    None or an empty mapping means "no override" (legacy behaviour). A
    mapping must carry a non-empty string ``command`` and may carry an
    ``args`` list of strings — the same shapes ``McpConfig.command`` /
    ``McpConfig.args`` already accept. Raises ValueError otherwise: a typo in
    this key would otherwise only surface as a silent spawn failure inside
    the container, the exact defect #4741 exists to make visible.
    """
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError(
            f"container must be an object of {{command, args}} "
            f"(got {type(raw).__name__})"
        )
    if not raw:
        return None
    command = raw.get("command")
    if not isinstance(command, str) or not command.strip():
        raise ValueError("container.command must be a non-empty string")
    args = raw.get("args", [])
    if not isinstance(args, list) or any(not isinstance(a, str) for a in args):
        raise ValueError("container.args must be a list of strings")
    override: dict[str, Any] = {"command": command, "args": list(args)}
    extra = set(raw) - {"command", "args"}
    if extra:
        raise ValueError(
            f"container has unknown keys {sorted(extra)}; "
            "only command and args are accepted"
        )
    return override
