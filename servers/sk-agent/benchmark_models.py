"""Benchmark suite for sk-agent models (#1748-H).

Defines benchmark tasks and report generation.
Actual execution is done via MCP call_agent tool by the Claude Code agent.

Tasks are designed to evaluate: reasoning, code review, structured output,
conciseness, and French technical writing.

Usage by agent:
    1. Import TASKS from this module
    2. For each model × task, call mcp__sk-agent__call_agent with model_override
    3. Collect results and call generate_benchmark_report()

Direct CLI execution also supported for ad-hoc testing.
"""

import json
import time
from pathlib import Path

TASKS = {
    "reasoning": {
        "prompt": (
            "A farmer has 17 sheep. All but 9 run away. How many sheep does the farmer have left? "
            "Think step by step and explain your reasoning."
        ),
        "expected": "answer=9",
        "judge_criteria": "correct answer (9), clear reasoning",
    },
    "code_review": {
        "prompt": (
            "Review this Python code change and identify any bugs:\n\n"
            "```diff\n"
            "- def calculate_total(items):\n"
            "-     return sum(item['price'] for item in items)\n"
            "+ def calculate_total(items, tax_rate=0.2):\n"
            "+     subtotal = sum(item['price'] * item['quantity'] for item in items)\n"
            "+     return subtotal + (subtotal * tax_rate)\n"
            "```\n\n"
            "List specific issues with severity (critical/major/minor)."
        ),
        "expected": "identifies KeyError risk for 'quantity'",
        "judge_criteria": "identifies missing 'quantity' key risk, structured output",
    },
    "technical_fr": {
        "prompt": (
            "Rédige un paragraphe technique (3-4 phrases) expliquant pourquoi les modèles de langage "
            "peuvent produire des hallucinations, avec un exemple concret. Réponds en français."
        ),
        "expected": "3-4 sentences, correct French, concrete example",
        "judge_criteria": "correct French, technically accurate, includes example",
    },
    "concise_summary": {
        "prompt": (
            "Summarize this text in exactly 2 sentences:\n\n"
            "The Model Context Protocol (MCP) is an open standard that enables developers to build "
            "secure, two-way connections between their data sources and AI-powered tools. The architecture "
            "is straightforward: developers can either expose their data through MCP servers or build "
            "AI applications (MCP clients) that consume data from these servers. MCP provides a universal, "
            "open standard for connecting AI systems with data sources, replacing fragmented integrations "
            "with a single protocol."
        ),
        "expected": "exactly 2 sentences",
        "judge_criteria": "exactly 2 sentences, captures MCP purpose",
    },
    "json_output": {
        "prompt": (
            'Analyze this code and output ONLY a valid JSON object with keys: "complexity" (Big-O), '
            '"bug_risk" (high/medium/low), "suggestion" (one improvement).\n\n'
            "```python\n"
            "def find_duplicates(items):\n"
            "    duplicates = []\n"
            "    for i in range(len(items)):\n"
            "        for j in range(i + 1, len(items)):\n"
            "            if items[i] == items[j] and items[i] not in duplicates:\n"
            "                duplicates.append(items[i])\n"
            "    return duplicates\n"
            "```"
        ),
        "expected": 'JSON: {"complexity": "O(n²)", "bug_risk": "low/medium", "suggestion": "use set"}',
        "judge_criteria": "valid JSON, O(n^2), suggests set/hash",
    },
}

MODELS = [
    "glm-5.1",
    "glm-5",
    "glm-5.1-not",
    "glm-5-not",
    "glm-4.7-flash",
]


def generate_benchmark_report(results: list[dict]) -> str:
    """Generate markdown benchmark report from collected results.

    Each result dict: {model, task, elapsed_seconds, response_length,
                       response_preview, error, quality_score (optional)}
    """
    lines = [
        "# sk-agent Model Benchmark Report (#1748-H)",
        "",
        f"**Date:** {time.strftime('%Y-%m-%d %H:%M')}",
        f"**Models tested:** {len(set(r['model'] for r in results))}",
        f"**Tasks:** {len(set(r['task'] for r in results))}",
        f"**Total runs:** {len(results)}",
        "",
        "## Results Matrix",
        "",
        "| Model | Task | Time (s) | Length | Quality | Error |",
        "|-------|------|----------|--------|---------|-------|",
    ]

    for r in sorted(results, key=lambda x: (x["model"], x["task"])):
        err = r.get("error", "") or ""
        err_display = err[:40] + "..." if len(err) > 40 else err
        quality = r.get("quality_score", "-")
        lines.append(
            f"| {r['model']} | {r['task']} | {r.get('elapsed_seconds', '-')} "
            f"| {r.get('response_length', '-')} | {quality} | {err_display or '-'} |"
        )

    # Latency summary
    lines.extend([
        "",
        "## Latency Summary by Model",
        "",
        "| Model | Avg (s) | Min (s) | Max (s) | Successful |",
        "|-------|---------|---------|---------|------------|",
    ])

    from collections import defaultdict
    model_times = defaultdict(list)
    for r in results:
        t = r.get("elapsed_seconds", -1)
        if t and t > 0 and not r.get("error"):
            model_times[r["model"]].append(t)

    for model in sorted(model_times):
        times = model_times[model]
        avg = sum(times) / len(times)
        lines.append(
            f"| {model} | {avg:.1f} | {min(times):.1f} | {max(times):.1f} | {len(times)}/{len([r for r in results if r['model'] == model])} |"
        )

    # Quality summary (if scores provided)
    scores = [r for r in results if r.get("quality_score")]
    if scores:
        lines.extend([
            "",
            "## Quality Summary by Model",
            "",
            "| Model | Avg Score | Tasks Scored |",
            "|-------|-----------|-------------|",
        ])
        model_scores = defaultdict(list)
        for r in scores:
            model_scores[r["model"]].append(r["quality_score"])
        for model in sorted(model_scores):
            s = model_scores[model]
            avg_s = sum(s) / len(s)
            lines.append(f"| {model} | {avg_s:.1f}/5 | {len(s)} |")

    return "\n".join(lines)


if __name__ == "__main__":
    # Just print task definitions for reference
    print(f"Tasks: {len(TASKS)}")
    for name, task in TASKS.items():
        print(f"  {name}: {task['expected']}")
    print(f"\nModels: {', '.join(MODELS)}")
    print(f"Total combinations: {len(TASKS) * len(MODELS)}")
