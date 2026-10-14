"""Sync sk_agent_config.json from template, preserving local secrets.

Usage:
    python sync_from_template.py [--dry-run] [--local-additions]
                                 [--prune-local ID[,ID...]]

Reads sk_agent_config.template.json (git source of truth) and regenerates
sk_agent_config.json by injecting API keys from the existing local config.
Local-only agents (absent from the template) are PRESERVED by default with
the model and MCP entries they reference; removal is a written gesture via
--prune-local. Oracle additions stay behind --local-additions.

Exit code: 0 when every template model got a real key; 1 when at least one api_key
is still a template placeholder (the config IS written — the non-zero code makes the
silent degradation detectable by callers).

Strategy:
- Models: Take from template, inject api_key from local (same id first, then
  base_url patterns); local-only agents carry their template-absent models over
- Agents: Take from template, plus every local-only agent (dropped only via
  --prune-local, together with their template-absent dependencies)
- Conversations: Take from template
- MCPs: Take from template, plus those a preserved local-only agent references
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


def inject_keys_into_template(
    template: dict, local_keys: dict, local_config: dict
) -> tuple[dict, list[str]]:
    """Inject API keys from local config into template structure.

    Returns (config, preserved_endpoint_notes) — each note names a model whose
    local base_url was kept over the template's (same-id off-LAN seats,
    #3411 web2; or a declared successor inheriting its alias's endpoint,
    ms#1421).
    """
    result = deepcopy(template)
    preserved_endpoint_notes: list[str] = []

    # Build a local model lookup by base_url pattern for better matching
    local_models_by_url = {}
    for model in local_config.get("models", []):
        base_url = model.get("base_url", "")
        api_key = model.get("api_key", "")
        if api_key and not api_key.startswith("YOUR_"):
            local_models_by_url[base_url] = api_key

    # Same-id lookup: the strongest match. A local model with the SAME id and
    # a real key authenticates against its own base_url by construction — the
    # seat's endpoint and enabled flag are its network reality (web2 is an
    # off-LAN VPS serving glm-5.3 via models.myia.io while the template points
    # at the LAN hub; a plain sync left the key a placeholder AND regressed
    # the URL to one unreachable from that seat — #3411 web2 cell).
    local_models_by_id = {}
    for model in local_config.get("models", []):
        mid = model.get("id", "")
        api_key = model.get("api_key", "")
        if mid and api_key and not api_key.startswith("YOUR_"):
            local_models_by_id[mid] = model

    # Inject model API keys
    for model in result.get("models", []):
        mid = model.get("id", "")
        base_url = model.get("base_url", "")

        # 0. Same model id with a real local key: local endpoint wins
        local_same_id = local_models_by_id.get(mid)
        if local_same_id is not None:
            model["api_key"] = local_same_id["api_key"]
            if local_same_id.get("base_url") and local_same_id["base_url"] != base_url:
                model["base_url"] = local_same_id["base_url"]
                preserved_endpoint_notes.append(
                    f"{mid}: base_url kept from local (diverges from template)"
                )
            if "enabled" in local_same_id:
                model["enabled"] = local_same_id["enabled"]
            continue

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

        # 4. Declared successor of a local alias (template field "succeeds"):
        # a renamed id inherits the alias's local key AND base_url. Reached
        # only when steps 0-3 all missed — e.g. a seat whose local medium
        # endpoint diverges from the template (ai-01 host.docker.internal) —
        # where the renamed id would otherwise deploy keyless against a URL
        # the seat may not even reach (#3411 option A, ms#1421 review).
        succeeds = model.get("succeeds", "")
        if succeeds and model.get("api_key", "").startswith("YOUR_"):
            alias_local = local_models_by_id.get(succeeds)
            if alias_local is not None:
                model["api_key"] = alias_local["api_key"]
                if alias_local.get("base_url") and alias_local["base_url"] != base_url:
                    model["base_url"] = alias_local["base_url"]
                    preserved_endpoint_notes.append(
                        f"{mid}: key+base_url inherited from local alias "
                        f"'{succeeds}' (diverges from template)"
                    )

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

    return result, preserved_endpoint_notes


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


def preserve_local_agents(
    config: dict, local_config: dict, prune_ids: set[str]
) -> tuple[dict, list[str]]:
    """Keep local-only agents (absent from the template) + their dependencies.

    #3411 (ai-01 spec, c.6105550181): a seat's local agent with a live caller
    (e.g. ai-01's ``notebook-auditor``) must survive a sync instead of being
    silently deleted by the template-only agent strategy. Every local agent
    whose id is not in the template is appended, together with the model and
    MCP entries it references when the template lacks them. Removal is a
    written gesture: ``--prune-local <id,...>`` names the agents to drop —
    their template-absent dependencies go with them when no surviving agent
    references them (dependencies are collected from surviving agents only).

    Returns ``(config, preserved_ids)`` — ids only, never values.
    """
    template_agent_ids = {a.get("id") for a in config.get("agents", [])}
    local_only = [
        a for a in local_config.get("agents", [])
        if a.get("id") and a.get("id") not in template_agent_ids
    ]
    kept = [a for a in local_only if a["id"] not in prune_ids]

    preserved: list[str] = []
    if not kept:
        return config, preserved

    config["agents"].extend(deepcopy(kept))
    preserved.extend(sorted(a["id"] for a in kept))

    # Dependencies the template does not carry: the kept agents' model and
    # MCP references, copied verbatim from local when absent from the result.
    config_model_ids = {m.get("id") for m in config.get("models", [])}
    local_models_by_id = {m.get("id"): m for m in local_config.get("models", [])}
    needed_models = sorted({a.get("model") for a in kept if a.get("model")})
    for mid in needed_models:
        if mid not in config_model_ids and mid in local_models_by_id:
            config["models"].append(deepcopy(local_models_by_id[mid]))
            preserved.append(f"model:{mid}")

    config_mcp_ids = {m.get("id") for m in config.get("mcps", [])}
    local_mcps_by_id = {m.get("id"): m for m in local_config.get("mcps", [])}
    needed_mcps: set[str] = set()
    for a in kept:
        needed_mcps.update(a.get("mcps") or [])
    for mid in sorted(needed_mcps):
        if mid not in config_mcp_ids and mid in local_mcps_by_id:
            config["mcps"].append(deepcopy(local_mcps_by_id[mid]))
            preserved.append(f"mcp:{mid}")

    return config, preserved


# MCP install-path placeholders (#4085): the template's self-inclusion
# declaration ships symbolic paths that a blind sync left verbatim — every
# seat's sk_agent tool then died at spawn (c.218 dogfood). The sync derives
# the real paths from its own location: it lives beside sk_agent.py and its
# venv/ by construction. Token -> relative dir under SCRIPT_DIR.
MCP_PATH_PLACEHOLDERS = {
    "VENV_PATH": "venv",      # -> <script_dir>/venv
    "INSTALLATION_PATH": "",  # -> <script_dir>
}


def _replace_path_placeholders(value: str, script_dir: Path) -> str:
    for token, rel in MCP_PATH_PLACEHOLDERS.items():
        if token in value:
            value = value.replace(token, str(script_dir / rel) if rel else str(script_dir))
    return value


def inject_mcp_install_paths(config: dict, script_dir: Path) -> int:
    """Rewrite MCP install-path placeholders with script-dir-derived paths.

    Covers command, args items and env values of every MCP declaration —
    template-derived AND preserved-local: fleet seats synced before this fix
    carry placeholder MCPs that preserve_local_agents copies verbatim, so the
    cure must run over the final config, not just the template half. Returns
    the number of rewritten fields (report only).
    """
    rewritten = 0

    def _rewrite(value):
        nonlocal rewritten
        new = _replace_path_placeholders(value, script_dir)
        if new != value:
            rewritten += 1
        return new

    for mcp in config.get("mcps", []):
        if isinstance(mcp.get("command"), str):
            mcp["command"] = _rewrite(mcp["command"])
        if isinstance(mcp.get("args"), list):
            mcp["args"] = [_rewrite(a) if isinstance(a, str) else a for a in mcp["args"]]
        if isinstance(mcp.get("env"), dict):
            mcp["env"] = {
                k: _rewrite(v) if isinstance(v, str) else v for k, v in mcp["env"].items()
            }
    return rewritten


def main():
    parser = argparse.ArgumentParser(description="Sync sk_agent_config.json from template")
    parser.add_argument("--dry-run", action="store_true", help="Print diff instead of writing")
    parser.add_argument("--local-additions", action="store_true",
                        help="Preserve local-only additions (oracle agents/models)")
    parser.add_argument("--prune-local", default="",
                        help="Comma-separated local-only agent ids to DROP "
                             "instead of preserving (their template-absent "
                             "model/MCP dependencies go with them)")
    args = parser.parse_args()
    prune_ids = {p.strip() for p in args.prune_local.split(",") if p.strip()}

    template = load_json(TEMPLATE_PATH)
    local = load_json(LOCAL_PATH)

    # Extract secrets from local
    local_keys = extract_api_keys(local)

    # Build new config from template + local secrets
    new_config, preserved_endpoint_notes = inject_keys_into_template(
        template, local_keys, local
    )

    # Local-only agents survive the sync (#3411): preserve them and their
    # template-absent dependencies unless explicitly pruned.
    new_config, preserved_agent_ids = preserve_local_agents(
        new_config, local, prune_ids
    )
    if preserved_agent_ids:
        print("", file=sys.stderr)
        print("=" * 62, file=sys.stderr)
        print("PRESERVED LOCAL-ONLY AGENTS (+deps; ids only, never values):", file=sys.stderr)
        for pid in preserved_agent_ids:
            print(f"  - {pid}", file=sys.stderr)
        if prune_ids:
            print(f"Pruned via --prune-local: {sorted(prune_ids)}", file=sys.stderr)
        else:
            print("Remove deliberately via --prune-local <id,...>", file=sys.stderr)
        print("=" * 62, file=sys.stderr)

    # Off-LAN endpoint visibility (#3411): a preserved base_url is a seat
    # divergence from the template — say so on stderr so the operator sees
    # it next to the sync report, never silently (ids and field names only,
    # per review: no endpoint values on output).
    if preserved_endpoint_notes:
        print("", file=sys.stderr)
        print("=" * 62, file=sys.stderr)
        print("PRESERVED LOCAL ENDPOINTS (local key set — same id or declared successor):", file=sys.stderr)
        for note in preserved_endpoint_notes:
            print(f"  - {note}", file=sys.stderr)
        print("=" * 62, file=sys.stderr)

    # Optionally add local-only additions
    if args.local_additions:
        new_config = add_oracle_additions(new_config, local)

    # MCP install-path cure (#4085): runs over the FINAL config (template +
    # preserved-local + additions) so seats synced before the fix heal too.
    rewritten_path_fields = inject_mcp_install_paths(new_config, SCRIPT_DIR)

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

    print(
        f"MCPs: {len(new_config.get('mcps', []))} declarations, "
        f"{rewritten_path_fields} install-path placeholder field(s) rewritten"
    )

    # Missing-keys guard (sk-agent thread 27/09): a template placeholder left in the
    # WRITTEN api_key is how the medium-key incident shipped — the old warning drowned
    # in stdout and the script exited 0. The file is still written (operators may fix
    # keys by hand; refusing would break the resync flow), but the warning goes to
    # stderr as a banner and the exit code is non-zero so callers can detect it.
    missing = []
    for model in new_config.get("models", []):
        api_key = model.get("api_key", "")
        if api_key.startswith("YOUR_") or api_key == "REPLACE_ME":
            missing.append(model)

    # Residual-placeholder tripwire (#4085): the rewriter covers command/args/
    # env; a placeholder surfacing ANYWHERE else in an MCP declaration (future
    # field, new shape) means the rewrite missed it — same refusal contract as
    # missing keys: loud stderr banner, non-zero exit, config still written.
    residual: list[tuple[str, str]] = []
    for mcp in new_config.get("mcps", []):
        dumped = json.dumps(mcp)
        for token in MCP_PATH_PLACEHOLDERS:
            if token in dumped:
                residual.append((str(mcp.get("id", "?")), token))

    exit_code = 1 if (missing or residual) else 0
    if missing:
        print("", file=sys.stderr)
        print("=" * 62, file=sys.stderr)
        print("MISSING API KEYS — the generated config will NOT authenticate:", file=sys.stderr)
        print("=" * 62, file=sys.stderr)
        for model in missing:
            hint = f" (provision {model['api_key_env']})" if model.get("api_key_env") else ""
            print(f"  - {model['id']}: api_key is a template placeholder{hint}", file=sys.stderr)
        print("Config still written — fix these keys or the server will 401 on them.", file=sys.stderr)
        print("=" * 62, file=sys.stderr)
    if residual:
        print("", file=sys.stderr)
        print("=" * 62, file=sys.stderr)
        print("UNREPLACED MCP PATH PLACEHOLDERS — the generated config has dead MCP commands:", file=sys.stderr)
        print("=" * 62, file=sys.stderr)
        for mcp_id, token in residual:
            print(f"  - {mcp_id}: {token} still present after rewrite", file=sys.stderr)
        print("Config still written — fix these paths or the MCP will fail to spawn.", file=sys.stderr)
        print("=" * 62, file=sys.stderr)

    if args.dry_run:
        print("\n[DRY RUN] No changes written.")
        sys.exit(exit_code)

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
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
