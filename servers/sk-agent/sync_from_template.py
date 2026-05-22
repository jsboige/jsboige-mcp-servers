"""Sync sk_agent_config.json from template, preserving local secrets.

Usage:
    python sync_from_template.py [--dry-run] [--local-additions LOCAL_ADDITIONS]

Reads sk_agent_config.template.json (git source of truth) and regenerates
sk_agent_config.json by injecting API keys from the existing local config.
Local-only additions (oracle agents, etc.) can be preserved via --local-additions.

Strategy:
- Models: Take from template, inject api_key from local by matching base_url patterns
- Agents: Take from template
- Conversations: Take from template
- MCPs: Take from template
- Embeddings/Qdrant/Sampling: Take structure from template, keys from local
- Oracle agents/models (claude-sonnet/opus): Local-only, appended if --local-additions
"""

import json
import sys
import argparse
from pathlib import Path
from copy import deepcopy

SCRIPT_DIR = Path(__file__).parent
TEMPLATE_PATH = SCRIPT_DIR / "sk_agent_config.template.json"
LOCAL_PATH = SCRIPT_DIR / "sk_agent_config.json"

# URL patterns to match for key injection
KEY_PATTERNS = {
    "z.ai": "ZAI_API_KEY",
    "mini.text-generation-webui": "MINI_API_KEY",
    "medium.text-generation-webui": "MEDIUM_API_KEY",
    "open-webui": "OWUI_API_KEY",
    "embeddings.myia.io": "EMBEDDINGS_API_KEY",
    "qdrant.myia.io": "QDRANT_API_KEY",
}

# Oracle models (local-only, not in template)
ORACLE_MODELS = ["claude-sonnet", "claude-opus"]

# Oracle agents (local-only)
ORACLE_AGENT_IDS = ["oracle-sonnet", "oracle-opus"]


def load_json(path: Path) -> dict:
    if not path.exists():
        print(f"ERROR: {path} not found")
        sys.exit(1)
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def extract_api_keys(local_config: dict) -> dict[str, str]:
    """Extract API keys from local config, keyed by model/section ID."""
    keys = {}

    # Model API keys
    for model in local_config.get("models", []):
        mid = model.get("id", "")
        api_key = model.get("api_key", "")
        if api_key and not api_key.startswith("YOUR_"):
            keys[f"model:{mid}"] = api_key

    # Embeddings key
    emb = local_config.get("embeddings", {})
    if emb.get("api_key") and not emb["api_key"].startswith("YOUR_"):
        keys["embeddings"] = emb["api_key"]

    # Qdrant key
    qd = local_config.get("qdrant", {})
    if qd.get("api_key") and not qd["api_key"].startswith("YOUR_"):
        keys["qdrant"] = qd["api_key"]

    # MCP env keys
    for mcp in local_config.get("mcps", []):
        mid = mcp.get("id", "")
        for env_key, env_val in mcp.get("env", {}).items():
            if env_val and not env_val.startswith("YOUR_"):
                keys[f"mcp:{mid}:{env_key}"] = env_val

    return keys


def match_api_key(model_id: str, model_config: dict, local_keys: dict) -> str:
    """Find the right API key for a model by checking local keys."""
    # Direct match by model ID
    direct = local_keys.get(f"model:{model_id}")
    if direct:
        return direct

    # Match by base_url pattern
    base_url = model_config.get("base_url", "")
    for pattern, _ in KEY_PATTERNS.items():
        if pattern in base_url:
            # Find any local model with same pattern
            for key_name, key_val in local_keys.items():
                if key_name.startswith("model:"):
                    # Check if local had a model with same base_url pattern
                    return key_val

    return "REPLACE_ME"


def inject_keys_into_template(template: dict, local_keys: dict, local_config: dict) -> dict:
    """Inject API keys from local config into template structure."""
    result = deepcopy(template)

    # Build a local model lookup by base_url pattern for better matching
    local_models_by_url = {}
    for model in local_config.get("models", []):
        base_url = model.get("base_url", "")
        api_key = model.get("api_key", "")
        if api_key and not api_key.startswith("YOUR_"):
            local_models_by_url[base_url] = api_key

    # Inject model API keys
    for model in result.get("models", []):
        mid = model.get("id", "")
        base_url = model.get("base_url", "")

        # Try exact base_url match first
        exact = local_models_by_url.get(base_url)
        if exact:
            model["api_key"] = exact
            continue

        # Try pattern match
        for local_url, local_key in local_models_by_url.items():
            # Same provider (same base_url prefix)
            if base_url.rstrip("/") == local_url.rstrip("/"):
                model["api_key"] = local_key
                break
        else:
            # Fallback: any key from same env var pattern
            env_var = model.get("api_key_env", "")
            if env_var:
                for pattern, expected_env in KEY_PATTERNS.items():
                    if pattern in base_url:
                        # Use any local key from same provider
                        for local_url, local_key in local_models_by_url.items():
                            if pattern in local_url:
                                model["api_key"] = local_key
                                break
                        break

    # Inject embeddings key
    if "embeddings" in result and "embeddings" in local_keys:
        result["embeddings"]["api_key"] = local_keys["embeddings"]

    # Inject qdrant key
    if "qdrant" in result and "qdrant" in local_keys:
        result["qdrant"]["api_key"] = local_keys["qdrant"]

    # Inject MCP env keys
    for mcp in result.get("mcps", []):
        mid = mcp.get("id", "")
        env = mcp.get("env", {})
        for env_key in env:
            mcp_key = f"mcp:{mid}:{env_key}"
            if mcp_key in local_keys:
                env[env_key] = local_keys[mcp_key]

    return result


def add_oracle_additions(config: dict, local_config: dict) -> dict:
    """Add oracle models and agents (local-only, not in template)."""
    # Add oracle models
    local_models_by_id = {m["id"]: m for m in local_config.get("models", [])}
    existing_ids = {m["id"] for m in config.get("models", [])}

    for oracle_id in ORACLE_MODELS:
        if oracle_id not in existing_ids and oracle_id in local_models_by_id:
            config["models"].append(local_models_by_id[oracle_id])

    # Add oracle agents
    local_agents_by_id = {a["id"]: a for a in local_config.get("agents", [])}
    existing_agent_ids = {a["id"] for a in config.get("agents", [])}

    for oracle_agent_id in ORACLE_AGENT_IDS:
        if oracle_agent_id not in existing_agent_ids and oracle_agent_id in local_agents_by_id:
            config["agents"].append(local_agents_by_id[oracle_agent_id])

    return config


def main():
    parser = argparse.ArgumentParser(description="Sync sk_agent_config.json from template")
    parser.add_argument("--dry-run", action="store_true", help="Print diff instead of writing")
    parser.add_argument("--local-additions", action="store_true",
                        help="Preserve local-only additions (oracle agents/models)")
    args = parser.parse_args()

    template = load_json(TEMPLATE_PATH)
    local = load_json(LOCAL_PATH)

    # Extract secrets from local
    local_keys = extract_api_keys(local)

    # Build new config from template + local secrets
    new_config = inject_keys_into_template(template, local_keys, local)

    # Optionally add local-only additions
    if args.local_additions:
        new_config = add_oracle_additions(new_config, local)

    # Report changes
    template_models = {m["id"] for m in template.get("models", [])}
    local_models = {m["id"] for m in local.get("models", [])}
    new_models = {m["id"] for m in new_config.get("models", [])}

    template_agents = {a["id"] for a in template.get("agents", [])}
    local_agents = {a["id"] for a in local.get("agents", [])}
    new_agents = {a["id"] for a in new_config.get("agents", [])}

    print("=== Sync Report ===")
    print(f"Models: local={len(local_models)} template={len(template_models)} new={len(new_models)}")
    added = new_models - local_models
    removed = local_models - new_models
    if added:
        print(f"  Added: {sorted(added)}")
    if removed:
        print(f"  Removed: {sorted(removed)}")

    print(f"Agents: local={len(local_agents)} template={len(template_agents)} new={len(new_agents)}")
    added_a = new_agents - local_agents
    removed_a = local_agents - new_agents
    if added_a:
        print(f"  Added: {sorted(added_a)}")
    if removed_a:
        print(f"  Removed: {sorted(removed_a)}")

    # Check for missing keys
    missing = []
    for model in new_config.get("models", []):
        if model.get("api_key", "").startswith("YOUR_") or model.get("api_key", "") == "REPLACE_ME":
            missing.append(model["id"])
    if missing:
        print(f"\nWARNING: Missing API keys for: {missing}")
        print("  → Set them manually in the generated config")

    if args.dry_run:
        print("\n[DRY RUN] No changes written.")
        return

    # Backup local config
    backup_path = LOCAL_PATH.with_suffix(".json.bak")
    with open(backup_path, "w", encoding="utf-8") as f:
        json.dump(local, f, indent=2, ensure_ascii=False)
    print(f"\nBackup: {backup_path}")

    # Write new config
    with open(LOCAL_PATH, "w", encoding="utf-8") as f:
        json.dump(new_config, f, indent=2, ensure_ascii=False)
    print(f"Written: {LOCAL_PATH}")
    print("\nRestart sk-agent MCP to load the new config.")


if __name__ == "__main__":
    main()
