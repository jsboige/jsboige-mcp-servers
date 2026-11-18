<!-- provenance (roo-extensions #4781 harness mutualisation)
     This file is authored here (harness index), not a copy.
     The copied modules below are tracked against jsboige/vllm @ 231c9ad8e9281ee162fc641a11889fc5600f4827
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

## Model per step — spec / coder / verifier (#4831)

Choosing the model of each step is a first-level parameter — never a source edit:

| Step | Driver flag | Env default | Serves |
|---|---|---|---|
| spec (optional pre-chew) | `--spec-model` + `--spec-mode run\|skip` | `NBCODER_SPEC_MODEL` / `NBCODER_SPEC_MODE` | the turn that rewrites a rough issue into a hyper-detailed one |
| coder (plan, build, segments, repairs) | `--coder-model` | `NBCODER_CODER_MODEL` | every producing turn |
| verifier (stage 4 audit) | `--verifier-model` | `NBCODER_VERIFIER_MODEL` | the independent audit |

Unset = the `--agent` / `--verifier-agent` preset's own model (seat default, unchanged
behavior before #4831). sk-agent validates the ref against its config (enabled models
only) and every call trace carries `model_used` — the envelope's proof of what actually
served the turn.

### Spec short-circuit

`--spec-mode skip` (the default) is a **declared choice of the calling lane** — the lane
judged the issue detailed enough — never a harness heuristic, and it traces on the run
record:

```json
"spec": {"mode": "skip", "skipped": true, "declared": "--spec-mode skip", "issue_body_chars": 4213}
```

`--spec-mode run` (requires `--spec-model`) adds stage ½: the model pre-chews the raw
issue (+ thread, conventions, notebook view) into a hyper-detailed issue that becomes
stage 1's issue body. The spec lands in `<out-dir>/spec-<issue>.md`, its trace on the
record (`mode: run`, model, chars, conversation id), and the ledger line carries
`"spec": "run" | "skip"`. A dead spec turn fails loud (`spec-<cause>`) instead of
falling back to the rough issue — the coder would burn its pass on the exact failure
mode the spec step exists to prevent.

### Difficulty → model mapping (documented, never hardcoded)

Guidance for the calling lane, which decides per pass or per grain; the harness never
encodes it. Names below are fleet roles — the actual ids are the **seat's sk-agent
config** (e.g. ai-01: `nb-minimax`, `glm-5.3`, `swift-1.5-27b`); only enabled models
pass server-side validation.

| Difficulty | coder | verifier | spec |
|---|---|---|---|
| simple (corrections simples, prose) | Luna ou swift | tier flash (GLM-5.3-flash) | skip |
| standard | MiniMax | GLM | skip, ou GLM si l'issue est vague |
| difficile (grains de parité C# SMT/Z3…) | GLM ou Terra, ou rôle Sonnet | GLM ou au-dessus | GLM ou Sonnet |
| très difficile | rôle Opus — Opus ou Sol | au-dessus du coder | Sonnet/Opus |

Measured terrain (18/11, source ai-01:vllm, issue roo-extensions#4831): C# SMT/Z3
parity grains are **difficile+** — Swift 0/7 (5× `built-execution-failed`, the repair
loop regenerating the identical error 3 rounds in a row), MiniMax 2/2 content-green on
the same class. Never the simple tier on parity grains. Swift keeps its wins on simple
corrections/prose.

### Invocation

```bash
# standard grain: MiniMax producer + GLM audit; issue detailed enough -> spec skipped (declared, traced)
<sk-agent venv python> harness/nb_coder/nb_coder_driver.py \
    --issue 27106 --notebook Ser/Z3-10-CSharp.ipynb --repo D:/CoursIA \
    --lane myia-po-2028:nb-coder \
    --coder-model nb-minimax --verifier-model glm-5.3 --spec-mode skip

# rough issue: pre-chew it with GLM first, then code with MiniMax
    --spec-mode run --spec-model glm-5.3 --coder-model nb-minimax
```

Through the scheduler, the queue keys `coder_model` / `verifier_model` / `spec_model` /
`spec_mode` override the scheduler-level defaults per grain; `--spec-mode` is always
forwarded so the skip is declared on every driver command line.

## Tests

`test_harness_portable.py` (at `servers/sk-agent/`, added to the closed list of the
`test-sk-agent` CI job) is the guard that the copy carries **no seat binding**: it loads
the modules from this tree, asserts the sibling resolution, the env override, and the
writer contract that keeps notebook sources in list-of-lines form (CoursIA convention).