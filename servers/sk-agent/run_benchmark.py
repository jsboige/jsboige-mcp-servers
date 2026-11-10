#!/usr/bin/env python3
"""Run benchmark #1748-H: execute tasks against all models and generate report.

Calls models directly via OpenAI-compatible API (no MCP dependency).
Reads model config from sk_agent_config.json (the committed template when no
live config is installed), and benchmarks every model it marks enabled.
"""

import json
import time
import sys
import os
import httpx
from pathlib import Path

# Load config. sk_agent_config.json is seat-specific and not in git, so CI and
# fresh clones only ship the template; reading whichever is present keeps this
# module importable — and its model list testable — everywhere.
CONFIG_PATH = Path(__file__).parent / "sk_agent_config.json"
TEMPLATE_CONFIG_PATH = Path(__file__).parent / "sk_agent_config.template.json"
ACTIVE_CONFIG_PATH = CONFIG_PATH if CONFIG_PATH.exists() else TEMPLATE_CONFIG_PATH
with open(ACTIVE_CONFIG_PATH, "r", encoding="utf-8") as f:
    config = json.load(f)

# Import tasks from benchmark_models
sys.path.insert(0, str(Path(__file__).parent))
from benchmark_models import TASKS, generate_benchmark_report


def derive_benchmark_model_ids(cfg: dict) -> list[str]:
    """Model ids to benchmark: every model marked enabled in the loaded config.

    Derived from the config (#1748 H(i)), never a hardcoded list — a literal one
    goes stale silently: it kept benchmarking `glm-5`, `glm-5-not` and
    `glm-4.7-flash` after they had left the config, and never benchmarked the
    variants that replaced them.
    """
    return [m["id"] for m in cfg.get("models", []) if m.get("enabled", False)]


BENCHMARK_MODEL_IDS = derive_benchmark_model_ids(config)


def get_model_config(model_id: str) -> dict | None:
    for m in config["models"]:
        if m["id"] == model_id and m.get("enabled", False):
            return m
    return None


def resolve_benchmark_api_key(model_cfg: dict, environ=None) -> str:
    """Resolve the API key for a benchmark model, mirroring resolve_api_key()
    (sk_agent_config.py:280).

    #3401: when ``api_key_env`` is set, the env var is read FIRST and the
    ``api_key`` literal is only a fallback. The previous form (literal first,
    env only when the literal is empty) used the DECOY literals present in
    seat configs (po-2028): the benchmark then measured 401s, not the models.
    Exact parity with resolve_api_key: an env var that is SET but empty
    resolves to "" (no literal fallback) — the decoy fix targets a present
    env var, not an empty one.
    """
    if environ is None:
        environ = os.environ
    if model_cfg.get("api_key_env"):
        return environ.get(model_cfg["api_key_env"], model_cfg.get("api_key", ""))
    return model_cfg.get("api_key", "")


def call_model(model_cfg: dict, prompt: str, timeout: float = 120) -> dict:
    """Call a model via OpenAI-compatible chat completions API."""
    base_url = model_cfg["base_url"].rstrip("/")
    api_key = resolve_benchmark_api_key(model_cfg)

    model_id = model_cfg["model_id"]
    thinking = model_cfg.get("thinking", False)

    url = f"{base_url}/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    # Build messages — simple user prompt, no system message for benchmark fairness
    messages = [{"role": "user", "content": prompt}]

    payload = {
        "model": model_id,
        "messages": messages,
        "max_tokens": 2048,
        "temperature": 0.3,
    }

    # For z.ai thinking models, add thinking budget
    if thinking and "z.ai" in base_url:
        payload["extra_body"] = {"enable_thinking": True}

    start = time.time()
    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.post(url, json=payload, headers=headers)
            elapsed = time.time() - start

            if resp.status_code != 200:
                return {
                    "error": f"HTTP {resp.status_code}: {resp.text[:200]}",
                    "elapsed_seconds": round(elapsed, 1),
                }

            data = resp.json()
            content = ""
            if "choices" in data and data["choices"]:
                msg = data["choices"][0].get("message", {})
                content = msg.get("content") or ""
                # For thinking models, content might be in reasoning_content
                if not content and msg.get("reasoning_content"):
                    content = msg["reasoning_content"] or ""

            return {
                "response": content,
                "response_length": len(content),
                "response_preview": content[:200],
                "elapsed_seconds": round(elapsed, 1),
                "tokens_used": data.get("usage", {}).get("total_tokens", 0),
            }
    except httpx.TimeoutException:
        return {"error": f"Timeout after {timeout}s", "elapsed_seconds": round(time.time() - start, 1)}
    except Exception as e:
        return {"error": str(e)[:200], "elapsed_seconds": round(time.time() - start, 1)}


def score_response(task_name: str, task: dict, response: str) -> float:
    """Simple automated scoring (1-5) based on task criteria."""
    if not response:
        return 0.0

    score = 3.0  # baseline

    if task_name == "reasoning":
        if "9" in response and ("left" in response.lower() or "reste" in response.lower()):
            score += 1.0
        if "step" in response.lower() or "étape" in response.lower():
            score += 0.5
        if "8" in response and "9" not in response:
            score -= 2.0  # wrong answer

    elif task_name == "code_review":
        if "quantity" in response.lower() or "KeyError" in response:
            score += 1.0
        if "critical" in response.lower() or "major" in response.lower() or "minor" in response.lower():
            score += 0.5
        if "bug" in response.lower() or "issue" in response.lower():
            score += 0.3

    elif task_name == "technical_fr":
        sentences = [s.strip() for s in response.split(".") if len(s.strip()) > 10]
        if 3 <= len(sentences) <= 5:
            score += 0.5
        if "exemple" in response.lower() or "example" in response.lower():
            score += 0.5
        # Check for French-specific words
        french_markers = ["hallucination", "modèle", "langage", "génératif", "données"]
        if any(m in response.lower() for m in french_markers):
            score += 0.5

    elif task_name == "concise_summary":
        sentences = [s.strip() for s in response.replace("!", ".").replace("?", ".").split(".") if len(s.strip()) > 5]
        if len(sentences) == 2:
            score += 1.5
        elif len(sentences) == 1:
            score += 0.5
        elif len(sentences) == 3:
            score += 0.5

    elif task_name == "json_output":
        if '"complexity"' in response and '"bug_risk"' in response:
            score += 1.0
        if "n²" in response or "n^2" in response or "O(n" in response:
            score += 0.5
        if "set" in response.lower():
            score += 0.5
        # Try to parse JSON
        try:
            import re
            json_match = re.search(r'\{[^}]+\}', response)
            if json_match:
                parsed = json.loads(json_match.group())
                if "complexity" in parsed and "bug_risk" in parsed:
                    score += 0.5
        except (json.JSONDecodeError, ImportError):
            pass

    return max(0, min(5, score))


def main():
    results = []
    total = len(BENCHMARK_MODEL_IDS) * len(TASKS)
    done = 0

    print(f"# Benchmark #1748-H — {len(BENCHMARK_MODEL_IDS)} models × {len(TASKS)} tasks = {total} runs")
    print(f"# config: {ACTIVE_CONFIG_PATH.name}\n")

    for model_id in BENCHMARK_MODEL_IDS:
        model_cfg = get_model_config(model_id)
        if not model_cfg:
            print(f"  SKIP {model_id} (not found or disabled)")
            for task_name in TASKS:
                results.append({
                    "model": model_id,
                    "task": task_name,
                    "elapsed_seconds": 0,
                    "response_length": 0,
                    "response_preview": "",
                    "error": "model not found or disabled",
                    "quality_score": 0,
                })
                done += 1
            continue

        for task_name, task in TASKS.items():
            done += 1
            print(f"  [{done}/{total}] {model_id} × {task_name}...", end=" ", flush=True)

            result = call_model(model_cfg, task["prompt"])

            # Brief pause between calls to avoid rate limiting on shared APIs
            time.sleep(2)

            elapsed = result.get("elapsed_seconds", 0)
            response = result.get("response", "")
            error = result.get("error", "")

            quality = score_response(task_name, task, response) if not error else 0

            results.append({
                "model": model_id,
                "task": task_name,
                "elapsed_seconds": elapsed,
                "response_length": result.get("response_length", 0),
                "response_preview": result.get("response_preview", ""),
                "error": error,
                "quality_score": quality,
                "tokens_used": result.get("tokens_used", 0),
            })

            status = f"✓ {elapsed}s Q={quality:.1f}" if not error else f"✗ {error[:40]}"
            print(status)

    # Generate report
    report = generate_benchmark_report(results)

    # Save report
    report_path = Path(__file__).parent / "benchmark_report.md"
    report_path.write_text(report, encoding="utf-8")

    # Also save raw results as JSON
    results_path = Path(__file__).parent / "benchmark_results.json"
    results_path.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"\n{report}")
    print(f"\nReport saved to: {report_path}")
    print(f"Raw data saved to: {results_path}")


if __name__ == "__main__":
    main()
