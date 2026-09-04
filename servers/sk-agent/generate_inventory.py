#!/usr/bin/env python3
"""
Generate sk-agent inventory documentation from the canonical template config.

Source of truth: sk_agent_config.template.json (validated via Pydantic-style
dataclasses in sk_agent_config.py).

This script produces:
  1. docs/sk-agent/AGENT_INVENTORY.md (re-derived every time)
  2. A drift report comparing the generated doc to the existing one
  3. A check mode (--check) that exits non-zero if the doc has drifted

Usage:
  python generate_inventory.py                # regenerate
  python generate_inventory.py --check        # fail if drift detected
  python generate_inventory.py --json-out     # emit machine-readable counts

Issue: #3410
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

# Locate files relative to this script
HERE = Path(__file__).resolve().parent
TEMPLATE_PATH = HERE / "sk_agent_config.template.json"
DEFAULT_DOC_PATH = (
    HERE.parent.parent.parent.parent / "docs" / "sk-agent" / "AGENT_INVENTORY.md"
)


def load_template() -> dict[str, Any]:
    """Load and validate the canonical template config."""
    if not TEMPLATE_PATH.exists():
        print(f"ERROR: template not found at {TEMPLATE_PATH}", file=sys.stderr)
        sys.exit(2)
    with open(TEMPLATE_PATH, encoding="utf-8") as f:
        return json.load(f)


def collect_inventory(cfg: dict[str, Any]) -> dict[str, Any]:
    """Derive a structured inventory from the config."""
    models = cfg.get("models", [])
    mcps = cfg.get("mcps", [])
    agents = cfg.get("agents", [])
    conversations = cfg.get("conversations", [])

    inline_agents = []
    for conv in conversations:
        for ia in conv.get("inline_agents", []):
            inline_agents.append({**ia, "_conversation": conv["id"]})

    enabled_models = [m for m in models if m.get("enabled", True)]
    memory_agents = [
        a for a in agents if a.get("memory", {}).get("enabled", False)
    ]

    return {
        "models_total": len(models),
        "models_enabled": len(enabled_models),
        "models_disabled": len(models) - len(enabled_models),
        "agents_total": len(agents),
        "agents_inline": len(inline_agents),
        "agents_memory_enabled": len(memory_agents),
        "mcps_total": len(mcps),
        "conversations_total": len(conversations),
        "conversation_types": sorted(
            {c.get("type", "sequential") for c in conversations}
        ),
        "models": models,
        "agents": agents,
        "inline_agents": inline_agents,
        "mcps": mcps,
        "conversations": conversations,
    }


def render_markdown(inv: dict[str, Any], source: str) -> str:
    """Render the canonical inventory as Markdown."""
    cfg_version_match = re.search(r"sk_agent_config\.template\.json", source)
    today = "2026-09-04"  # Generated-by date; intentional static for reproducibility

    out = []
    out.append("# SK-Agent Complete Agent Inventory")
    out.append("")
    out.append("**Issue:** #3410 — generated from `sk_agent_config.template.json`")
    out.append("**Source:** `mcps/internal/servers/sk-agent/sk_agent_config.template.json`")
    out.append(f"**Generated:** {today}")
    out.append("")
    out.append("> **Source of truth.** This file is generated. Do NOT edit by hand — "
               "edit the template config and re-run `python generate_inventory.py`.")
    out.append("")
    out.append("---")
    out.append("")
    out.append("## Summary")
    out.append("")
    out.append("| Metric | Count |")
    out.append("|--------|-------|")
    out.append(f"| **Total models** | {inv['models_total']} ({inv['models_enabled']} enabled, "
               f"{inv['models_disabled']} disabled) |")
    out.append(f"| **Top-level agents** | {inv['agents_total']} |")
    out.append(f"| **Inline agents** (conversation-scoped) | {inv['agents_inline']} |")
    out.append(f"| **Memory-enabled agents** | {inv['agents_memory_enabled']} |")
    out.append(f"| **MCP plugins** | {inv['mcps_total']} |")
    out.append(f"| **Conversations** | {inv['conversations_total']} "
               f"({', '.join(inv['conversation_types'])}) |")
    out.append("")
    out.append("---")
    out.append("")

    # Models
    out.append("## Models")
    out.append("")
    out.append("| ID | Provider / Base URL | Context | Vision | Thinking | Enabled | Description |")
    out.append("|----|---------------------|---------|--------|----------|---------|-------------|")
    for m in inv["models"]:
        url = m.get("base_url", "")
        # Truncate URL
        url_short = url.replace("https://", "").replace("http://", "")
        if len(url_short) > 35:
            url_short = url_short[:32] + "..."
        out.append(
            f"| `{m['id']}` | {url_short} | {m.get('context_window', '-')} | "
            f"{'Y' if m.get('vision') else 'N'} | "
            f"{'Y' if m.get('thinking') else 'N'} | "
            f"{'Y' if m.get('enabled', True) else 'N'} | "
            f"{m.get('description', '').replace(chr(10), ' ')} |"
        )
    out.append("")

    # Agents
    out.append("## Agents")
    out.append("")
    out.append("| ID | Model | MCPs | Memory | Description |")
    out.append("|----|-------|------|--------|-------------|")
    for a in inv["agents"]:
        mcps_str = ", ".join(a.get("mcps", [])) or "—"
        mem = "Y" if a.get("memory", {}).get("enabled") else "N"
        out.append(
            f"| `{a['id']}` | `{a.get('model', '-')}` | {mcps_str} | {mem} | "
            f"{a.get('description', '').replace(chr(10), ' ')} |"
        )
    out.append("")

    # Inline agents
    if inv["inline_agents"]:
        out.append("## Inline Agents (conversation-scoped)")
        out.append("")
        out.append("| Conversation | ID | Model | Description |")
        out.append("|--------------|----|-------|-------------|")
        for ia in inv["inline_agents"]:
            out.append(
                f"| `{ia['_conversation']}` | `{ia['id']}` | "
                f"`{ia.get('model', '-')}` | {ia.get('description', '').replace(chr(10), ' ')} |"
            )
        out.append("")

    # MCPs
    out.append("## MCP Plugins")
    out.append("")
    out.append("| ID | Command | Description |")
    out.append("|----|---------|-------------|")
    for m in inv["mcps"]:
        cmd = m.get("command", "")
        args = " ".join(m.get("args", []))
        out.append(
            f"| `{m['id']}` | `{cmd} {args}` | {m.get('description', '')} |"
        )
    out.append("")

    # Conversations
    out.append("## Conversations")
    out.append("")
    out.append("| ID | Type | Agents | Rounds | Description |")
    out.append("|----|------|--------|--------|-------------|")
    for c in inv["conversations"]:
        agents_list = c.get("agents", [])
        inline_ids = [ia["id"] for ia in c.get("inline_agents", [])]
        all_agents = agents_list + [f"{a} (inline)" for a in inline_ids
                                    if a not in agents_list]
        out.append(
            f"| `{c['id']}` | {c.get('type', 'sequential')} | "
            f"{', '.join(all_agents) or '—'} | "
            f"{c.get('max_rounds', 10)} | "
            f"{c.get('description', '').replace(chr(10), ' ')} |"
        )
    out.append("")

    out.append("---")
    out.append("")
    out.append("## How to regenerate")
    out.append("")
    out.append("```bash")
    out.append("cd mcps/internal/servers/sk-agent")
    out.append("python generate_inventory.py")
    out.append("")
    out.append("# CI: fail if doc has drifted from config")
    out.append("python generate_inventory.py --check")
    out.append("```")
    out.append("")
    out.append("See `docs/services/sk-agent-deployment.md` for the deployment and "
               "transport recipes.")
    out.append("")
    return "\n".join(out)


def check_drift(existing: str, generated: str) -> list[str]:
    """Compare existing doc to generated one. Returns list of drift issues."""
    issues = []

    # Extract key counts from existing doc
    def find_count(text: str, pattern: str) -> int | None:
        m = re.search(pattern, text)
        if m:
            try:
                return int(m.group(1))
            except (ValueError, IndexError):
                return None
        return None

    # Numbers that should match
    checks = [
        (r"Total models[^\d]*(\d+)", "models_total"),
        (r"Top-level agents[^\d]*(\d+)", "agents_total"),
        (r"Inline agents[^\d]*(\d+)", "agents_inline"),
        (r"MCP plugins[^\d]*(\d+)", "mcps_total"),
        (r"Conversations[^\d]*(\d+)", "conversations_total"),
    ]

    # Re-parse generated to get the truth
    for pattern, key in checks:
        new_count = find_count(generated, pattern)
        old_count = find_count(existing, pattern)
        if new_count is None:
            continue
        if old_count is None:
            issues.append(
                f"[{key}] count not found in existing doc (expected {new_count})"
            )
        elif old_count != new_count:
            issues.append(
                f"[{key}] drift: existing={old_count}, generated={new_count}"
            )

    # Also check for the "this doc is generated" header in existing doc
    if "do NOT edit by hand" not in existing and "Generated:" not in existing:
        issues.append(
            "[marker] existing doc is not marked as generated — stale hand-written doc"
        )

    return issues


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--check", action="store_true",
                   help="Exit non-zero if doc has drifted from config")
    p.add_argument("--json-out", action="store_true",
                   help="Emit JSON summary of counts to stdout")
    p.add_argument("--doc-path", default=str(DEFAULT_DOC_PATH),
                   help=f"Path to AGENT_INVENTORY.md (default: {DEFAULT_DOC_PATH})")
    args = p.parse_args()

    cfg = load_template()
    inv = collect_inventory(cfg)

    if args.json_out:
        summary = {
            "models_total": inv["models_total"],
            "models_enabled": inv["models_enabled"],
            "agents_total": inv["agents_total"],
            "agents_inline": inv["agents_inline"],
            "mcps_total": inv["mcps_total"],
            "conversations_total": inv["conversations_total"],
        }
        print(json.dumps(summary, indent=2))
        return 0

    generated = render_markdown(inv, str(TEMPLATE_PATH))
    doc_path = Path(args.doc_path)

    if args.check:
        if not doc_path.exists():
            print(f"ERROR: doc not found at {doc_path}", file=sys.stderr)
            return 2
        existing = doc_path.read_text(encoding="utf-8")
        issues = check_drift(existing, generated)
        if issues:
            print("DRIFT DETECTED between template config and inventory doc:", file=sys.stderr)
            for issue in issues:
                print(f"  - {issue}", file=sys.stderr)
            print(f"\nRegenerate with: python {Path(__file__).name}", file=sys.stderr)
            return 1
        print("OK: inventory doc matches template config")
        return 0

    # Default: regenerate the doc
    doc_path.parent.mkdir(parents=True, exist_ok=True)
    doc_path.write_text(generated, encoding="utf-8")
    print(f"Wrote {doc_path}")
    print(f"  Models: {inv['models_total']} ({inv['models_enabled']} enabled)")
    print(f"  Agents: {inv['agents_total']} top-level + {inv['agents_inline']} inline")
    print(f"  MCPs: {inv['mcps_total']}")
    print(f"  Conversations: {inv['conversations_total']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
