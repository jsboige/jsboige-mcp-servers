<!-- provenance (roo-extensions #4781 harness mutualisation)
     This file is authored here (harness index), not a copy.
     The copied modules below are tracked against jsboige/vllm @ 7416ac16c91e150aae5a75dd251d0c1a4c2f5c2c
     Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
     re-copy, do not diverge silently. -->

# Harness — nb_coder + nb_audit

Deterministic harnesses that extend sk-agent: they drive the local model through
`call_agent` (stdio MCP) over a **fresh conversation per grain**, so a work unit can never
approach the model window, and they keep the engine work bounded and observable.

Moved here from `jsboige/vllm` under roo-extensions **#4781** (user arbitration 2026-11-16:
"le harnais qui étend les capacités de sk-agent y a toute sa place"). The copy is verbatim;
the only added lines are the provenance headers.

## Layout

| path | role |
|---|---|
| `nb_coder/INVOCATION.md` | **the single invocation doc** (#4832): steps, closed param sets, envelope, presets |
| `nb_coder/nb_coder_invoke.py` | the ONE entry for every caller — spec/code/audit, JSON in, envelope JSON out (#4832) |
| `nb_coder/nb_coder_driver.py` | stages 0-5 of issue → notebook → PR (claim, plan, build, gates, verify, harness PR) |
| `nb_coder/nb_coder_scheduler.py` | capacity-aware batch scheduler above the driver (in-flight cap against the live engine gauge, ramp, STOP file) |
| `nb_coder/nb_coder_verify.py` | stage 4 — independent verifier (producer ≠ verifier) |
| `nb_coder/issue_from_finding.py` | deterministic issue body from an nb_audit finding |
| `nb_audit/nb_audit_runner.py` | hourly pre-audit runner (series scoping, PR-skip, record writing) |
| `nb_audit/nb_audit_driver.py` | per-notebook audit driver through sk-agent (sk-agent stdio) |
| `nb_audit/nb_audit_deliver.py` | delivers new records to the owning bot (DM) |
| `nb_audit/sk_call.py` | one-shot `call_agent` smoke tool |
| `nb_audit/nb_audit_hourly.ps1` | scheduled wrapper (runner + deliver + durable state file) |
| `nb_audit/register_hourly.ps1` | registers the hourly task, **generates** the invisible VBS launcher outside the tree |
| `nb_audit/auditor_system_prompt.md` | system prompt of the `notebook-auditor` agent |
| `nb_audit/agent_entry.example.json` | sanitized example of the sk-agent config entries these tools need |

## Path resolution (no seat binding)

Every path the harness needs resolves in this order:

1. environment — `NB_AUDIT_SK_DIR` / `NB_AUDIT_SK_PY` / `NB_AUDIT_SK_CONFIG`,
   `NBCODER_SK_DIR` / `NBCODER_SK_PY` / `NBCODER_SK_CONFIG`,
   `NBCODER_PM_PY` / `NBCODER_PM_CWD`, `NBCODER_GATE`, `NBCODER_LANE`,
   `NBCODER_ENGINE_METRICS`;
2. **the sibling layout this copy lives in** — the sk-agent root is `../..` from
   `harness/nb_coder/` and `harness/nb_audit/`, recognised by the presence of `sk_agent.py`
   (so an unrelated `../..` cannot shadow it), and the papermill MCP server is
   `../../../jupyter-papermill-mcp-server`;
3. the legacy absolute paths of the original seat, kept only until the cutover completes.

The hourly wrapper's interpreter cascade is the same spirit: `-Python`, then
`NB_AUDIT_PYTHON`, then the sibling venv (only when `../../sk_agent.py` exists), then
whatever `python` resolves to.

**One path is deliberately NOT resolved here: the CoursIA checkout.** `--repo` (or
`NB_AUDIT_REPO` / `NBCODER_REPO`) is an **input of the run**, not a harness binding — the
harness refuses to start without it rather than inventing a per-seat default. Same for the
claim lane: `NBCODER_LANE` has no default, so `--claim` fails loud instead of claiming under
another seat's identity (vllm#438). The hourly wrapper carries the seat's checkout as its
own `-Repo` parameter — launcher configuration, not harness configuration.

## Requirements

- Python 3.11+; the **sk-agent venv** is the intended interpreter (it carries `mcp`).
- `gh` CLI authenticated for the claim / PR stages (`nb_coder`), REST only.
- For `nb_coder`: a jupyter-papermill MCP server reachable — `NBCODER_PM_PY` (defaults to
  the ai-01 conda env when present, else the running interpreter) and `NBCODER_PM_CWD`.

## Running

```bash
# pre-audit, one pass (dry-run: nothing written)
<sk-agent venv python> harness/nb_audit/nb_audit_runner.py --series 17107 --per-series 2 --dry-run

# audit one notebook through sk-agent
<sk-agent venv python> harness/nb_audit/nb_audit_driver.py --records-dir <dir> NB_PATH

# nb_coder, full stage 1-2 pass (dry)
<sk-agent venv python> harness/nb_coder/nb_coder_driver.py --issue N --notebook MyIA.AI.Notebooks/... --claim

# hourly task (dry-run by default)
powershell.exe -NoProfile -File harness/nb_audit/register_hourly.ps1
```

## Tests

`test_harness_portable.py` (at `servers/sk-agent/`, added to the closed list of the
`test-sk-agent` CI job) is the guard that the copy carries **no seat binding**: it loads
the modules from this tree, asserts the sibling resolution, the env override, and the
writer contract that keeps notebook sources in list-of-lines form (CoursIA convention).