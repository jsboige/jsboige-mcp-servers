<!-- provenance (roo-extensions #4781 harness mutualisation)
     This file is authored here (harness index), not a copy.
     The copied modules below are tracked against jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
     Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
     jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree. -->

# Harness — nb_coder + nb_audit

Deterministic harnesses that extend sk-agent: they drive the local model through
`call_agent` (stdio MCP) over a **fresh conversation per grain**, so a work unit can never
approach the model window, and they keep the engine work bounded and observable.

Moved here from `jsboige/vllm` under roo-extensions **#4781** (user arbitration 2026-11-16:
"le harnais qui étend les capacités de sk-agent y a toute sa place"). The copy is verbatim;
the only added lines are the provenance headers.

**Cutover (2026-11-22): this tree is the single codebase.** The last re-copy pinned
jsboige/vllm @ `7a09e1ca` (byte-proof 66/66 modulo header). From then on harness fixes land
here, by PR on this repo, and every seat runs from here. The vllm copy
(`myia_vllm/scripts/adoption/nb_coder` and `nb_audit`) is frozen and gets no new commits.
It is retired to a pointer once its last runner has switched. No change is mirrored back
to vllm, and no re-copy from vllm overwrites this tree. User, 22/11: three private copies
of one harness was the mistake this cutover ends.

## Layout

| path | role |
|---|---|
| `nb_coder/INVOCATION.md` | **the single invocation doc** (#4832): steps, closed param sets, envelope, presets |
| `nb_coder/nb_coder_invoke.py` | the ONE entry for every caller — spec/code/audit, JSON in, envelope JSON out (#4832) |
| `nb_coder/nb_coder_driver.py` | stages 0-5 of issue → notebook → PR (claim, plan, build, gates, verify, harness PR) |
| `nb_coder/nb_coder_scheduler.py` | capacity-aware batch scheduler above the driver (in-flight cap against the live engine gauge, ramp, STOP file) |
| `nb_coder/nb_coder_verify.py` | stage 4 — independent verifier (producer ≠ verifier) |
| `nb_coder/nb_coder_window_replay.py` | #4816 criterion 3 — the 262 144-token window witness: replays the CoursIA#27027 morphology through the REAL turn machinery (SK OpenAI connector over real HTTP) against an engine enforcing the incident contract; red (no condensation → 400 mid-turn) vs green (seat-entry condensation → turn completes under the window). `--live-probe` pins the modeled contract against a real engine with ONE over-window request |
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

## Preflight refusals (what a launch answers before it pays anything)

`nb_coder_driver.py` refuses at launch, writes a trace + ledger line, and exits 2 with the
remedy on stderr (a scheduled loop reads the refusal back instead of mistaking it for a
quiet run). Three families, each with its own verdict, asked in this order:

| verdict | what it means | the remedy it names |
|---|---|---|
| `refused-wiring-unresolved` | one of the five wired paths above does not exist here | point the env var at a real path |
| `refused-credential-unresolved` | a model this launch calls reads its key through `api_key_env`, and that variable is empty here (sk-agent would send `no-key` and the first call would answer `401 invalid proxy authentication`) | export the named variable in the launching shell |
| `refused-target-unresolved` | the launch's own target cannot be reached from a freshly fetched `origin/main` — absent with no twin, a named twin absent, a creation flag on an existing target, a `--meta-from` absent | fix the queue line (`--source-nb`, `--from-spec`, or the path) |

Only names are printed — role, agent, model entry, variable, path — never a value. Every
check fails OPEN on what it cannot read (unreadable config, unknown preset, literal key, a
git ref it cannot resolve, a path git reports as `exists on disk` with another spelling),
and it never speaks for a resume (`--revise-from` / `--verify-from` read their creation
mode from the trace). `NBCODER_PREFLIGHT_CREDENTIALS=0` disables the credential check
alone, for a seat whose endpoint deliberately serves without a key.

## Resuming a run

Two flags re-enter a trace, and each reads its creation mode from it (a resume is never
asked `--from-spec` / `--source-nb` / `--meta-from`, and the two flags exclude each
other):

- `--revise-from <trace>`: a fresh model round on the draft the trace already built.
- `--verify-from <trace>`: no model turn. On `verify-error` the scheduler requeues it
  once by itself (`--verify-recoveries`, default 1). On a stage-5 refusal of an APPROVED
  build -- `source-drifted`, `pr-branch-failed`, `pr-git-failed`, `pr-push-failed`,
  `pr-repo-unresolved`, `pr-create-failed`, `pr-rebase-failed` -- it re-runs stage 5
  alone, and **only a hand-written queue item reaches it**, one carrying
  `verify_from: <trace>`; the scheduler never writes that line.

The stage-5 resume is admitted on a proof that the build on disk is the one approved (the
`sha256` bound at approval, or written by the graft); an older trace is held to its last
verify record. It recreates its branch from today's `origin/main` and measures the drift
from the build's own base, never from wherever a previous attempt left the worktree. Its
push is leased: a resume from `pr-create-failed` finds the branch its previous attempt
pushed and replaces it only while origin still sits on the commit recorded at that push.

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