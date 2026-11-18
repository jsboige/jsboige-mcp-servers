#!/usr/bin/env python3
# --- provenance ---------------------------------------------------------------
# Canonical home is sk-agent: new harness fixes belong here, not in vllm.
# Authored here (#4832 on-demand invocation layer) — no vllm counterpart.
# -----------------------------------------------------------------------------
"""nb_coder_invoke — the ONE documented entry into the nb_coder workflows (roo-extensions #4832).

Every caller — scheduled seat, on-demand MCP agent, human shell — goes through
this contract. The step scripts (issue_from_finding / nb_coder_driver /
nb_coder_verify) stay the source of truth for behaviour; this wrapper only:

  * validates the invocation against a CLOSED field set per step (a typo'd key
    refuses loudly instead of silently falling back to a default);
  * maps JSON params to each script's CLI (snake_case key -> --kebab-case flag);
  * runs the step with the interpreter it was invoked with (the sk-agent venv
    python — the same requirement as the driver itself);
  * prints ONE JSON envelope line the caller can trust verbatim:

    {"step","ok","verdict","exit","issue","notebook","pr","pr_url","trace",
     "out_dir","seconds","command","tail"}

No credential ever transits the params: keys ride the environment
(NBCODER_GH_APP_ID / NBCODER_GH_KEY / NBCODER_LANE / ...), inherited as-is.

Usage:
    <sk-agent venv python> nb_coder_invoke.py --step code --params '{"issue":26997,
        "notebook":"MyIA.AI.Notebooks/Physique/X.ipynb","repo":"D:/CoursIA",
        "lane":"myia-ai-01:nb-coder","max_stage":2}'
    <sk-agent venv python> nb_coder_invoke.py --step audit --params -   # JSON on stdin
    <sk-agent venv python> nb_coder_invoke.py --step code --params '{...}' --dry-run

Exit code: 0 when the envelope says ok=true, 1 otherwise, 2 on invocation
refusal (bad params, unknown step). The envelope is ALWAYS the last stdout line.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent

STEPS = ("spec", "code", "audit")

# Closed field sets, snake_case -> (CLI flag, type). A key outside the set is a
# typo or an injection attempt: refuse, never ignore. Types are coerced before
# the spawn so the child never sees a malformed flag value.
_BOOL, _INT, _STR = bool, int, str
#: sentinel: the key is a POSITIONAL argument of the step script (spec's record).
_POSITIONAL = "__positional__"

CODE_FIELDS = {
    "issue": (None, _INT),            # required, positional to the driver's --issue
    "notebook": (None, _STR),         # required
    "source_nb": ("--source-nb", _STR),
    "repo": ("--repo", _STR),
    "allow_foreign_origin": ("--allow-foreign-origin", _BOOL),
    "worktree": ("--worktree", _STR),
    "fresh_worktree": ("--fresh-worktree", _BOOL),
    "out_dir": ("--out-dir", _STR),
    "agent": ("--agent", _STR),
    "conventions": ("--conventions", _STR),
    "intention": ("--intention", _STR),
    "claim": ("--claim", _BOOL),
    "gate_mode": ("--gate-mode", _STR),
    "gate": ("--gate", _STR),
    "lane": ("--lane", _STR),
    "grain_tier": ("--grain-tier", _STR),
    "write_mode": ("--write-mode", _STR),
    "kernel_override": ("--kernel-override", _STR),
    "exec_mode": ("--exec-mode", _STR),
    "max_stage": ("--max-stage", _INT),
    "verifier_agent": ("--verifier-agent", _STR),
    "verify_timeout": ("--verify-timeout", _INT),
    "pr_base": ("--pr-base", _STR),
    "pr_repo": ("--pr-repo", _STR),
    "pr_branch": ("--pr-branch", _STR),
    "timeout": ("--timeout", _INT),
    "max_tokens": ("--max-tokens", _INT),
    "repair_rounds": ("--repair-rounds", _INT),
}

AUDIT_FIELDS = {
    "issue": (None, _INT),            # required
    "source_nb": ("--source-nb", _STR),   # required
    "built_nb": ("--built-nb", _STR),     # required
    "facts": ("--facts", _STR),
    "conventions": ("--conventions", _STR),
    "agent": ("--agent", _STR),
    "out_dir": ("--out-dir", _STR),
    "timeout": ("--timeout", _INT),
    "max_tokens": ("--max-tokens", _INT),
}

SPEC_FIELDS = {
    "record": (_POSITIONAL, _STR),    # required (nb_audit record JSON path)
    "notebook": ("--notebook", _STR),     # required
    "ref": ("--ref", _STR),               # required
    "out": ("--out", _STR),
}

STEP_SPECS = {
    "spec": ("issue_from_finding.py", SPEC_FIELDS, ("record", "notebook", "ref")),
    "code": ("nb_coder_driver.py", CODE_FIELDS, ("issue", "notebook")),
    "audit": ("nb_coder_verify.py", AUDIT_FIELDS, ("issue", "source_nb", "built_nb")),
}

# The driver's own success verdicts (its exit-0 list) — imported lazily so this
# wrapper stays importable without the scheduler's argparse side effects.
_CODE_OK_SUFFIXES = (
    "built-executed-ok", "gates-ok", "stage0-only", "stage1-only",
    "verify-approved", "pr-created", "built-notebook-ok",
)


def _coerce(value, wanted, key):
    if wanted is _BOOL:
        if isinstance(value, bool):
            return value
        raise ValueError(f"{key}: boolean expected, got {type(value).__name__}")
    if wanted is _INT:
        if isinstance(value, bool) or not isinstance(value, int):
            # tolerate "12" from JSON-string callers, refuse 1.5 / true
            if isinstance(value, str) and value.strip().lstrip("-").isdigit():
                return int(value)
            raise ValueError(f"{key}: integer expected, got {type(value).__name__}")
        return value
    if not isinstance(value, str):
        raise ValueError(f"{key}: string expected, got {type(value).__name__}")
    return value


def build_command(step: str, params: dict) -> list[str]:
    """Validate against the closed set and map to the step script's argv."""
    script, fields, required = STEP_SPECS[step]
    unknown = [k for k in params if k not in fields]
    if unknown:
        raise ValueError(f"unknown {step} param(s): {', '.join(sorted(unknown))} — "
                         f"closed set: {', '.join(sorted(fields))}")
    missing = [k for k in required if params.get(k) in (None, "")]
    if missing:
        raise ValueError(f"missing required {step} param(s): {', '.join(missing)}")
    argv = [str(HERE / script)]
    for key, (flag, wanted) in fields.items():
        if key not in params or params[key] is None or params[key] is False:
            continue
        value = _coerce(params[key], wanted, key)
        if flag == _POSITIONAL:               # spec's record: positional value
            argv.append(str(value))
        elif flag is None:                    # required key -> CLI flag of same name
            argv += ["--" + key.replace("_", "-"), str(value)]
        elif wanted is _BOOL:                 # store_true flag
            argv.append(flag)
        else:
            argv += [flag, str(value)]
    return argv


def _default_out_dir(step: str, params: dict) -> Path | None:
    """Effective out-dir, for trace enrichment (mirrors the driver's default)."""
    if params.get("out_dir"):
        return Path(params["out_dir"])
    if step in ("code", "audit"):
        import nb_coder_driver as nbcd
        return Path(nbcd.VLLM_ROOT) / ".tmp/nbcoder"
    return None


def _last_json_object(text: str) -> dict | None:
    """Last top-level JSON object in the child's output, whatever its layout.

    The driver's final line is compact JSON; the verifier's final print is
    INDENTED (json.dumps(..., indent=1)) — a line-based extractor would miss
    it. Brace-depth scanning picks both, newest block first; non-JSON noise
    never parses. A verdict string containing braces is filtered by the
    json.loads check, not by the scan.
    """
    depth, start, blocks = 0, None, []
    for i, ch in enumerate(text or ""):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}" and depth:
            depth -= 1
            if depth == 0 and start is not None:
                blocks.append(text[start:i + 1])
                start = None
    for cand in reversed(blocks):
        try:
            obj = json.loads(cand)
            if isinstance(obj, dict):
                return obj
        except Exception:
            continue
    return None


def run_step(step: str, params: dict, timeout: int, dry_run: bool = False) -> dict:
    argv = build_command(step, params)
    env_note = "env: NBCODER_* inherited"
    if dry_run:
        return {"step": step, "ok": None, "verdict": "dry-run", "exit": None,
                "command": argv, "note": env_note}
    t0 = time.time()
    proc = subprocess.Popen(
        [sys.executable, *argv], cwd=str(HERE), stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    timed_out = False
    try:
        out, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        proc.kill()
        out, _ = proc.communicate()
    seconds = round(time.time() - t0, 1)
    envelope = {
        "step": step,
        "exit": proc.returncode,
        "seconds": seconds,
        "command": argv,
        "tail": (out or "").strip()[-600:],
    }
    if timed_out:
        envelope |= {"ok": False, "verdict": "wrapper-timeout"}
        return envelope

    child = _last_json_object(out)
    if step == "code":
        verdict = (child or {}).get("verdict") or f"child-exit-{proc.returncode}"
        envelope |= {"issue": params.get("issue"), "notebook": params.get("notebook"),
                     "pr": (child or {}).get("pr"), "verdict": verdict}
        ok = any(verdict.endswith(s) for s in _CODE_OK_SUFFIXES)
        # enrich from the run record when it landed (pr_url, trace path)
        out_dir = _default_out_dir(step, params)
        rec_path = out_dir / f"issue-{params['issue']}.json" if out_dir else None
        if rec_path and rec_path.is_file():
            envelope["trace"] = str(rec_path)
            try:
                rec = json.loads(rec_path.read_text(encoding="utf-8"))
                pr = rec.get("pr") or {}
                envelope["pr"] = pr.get("number", envelope.get("pr"))
                envelope["pr_url"] = pr.get("url")
            except Exception:
                pass
    elif step == "audit":
        verdict = (child or {}).get("verdict") or f"child-exit-{proc.returncode}"
        envelope |= {"issue": params.get("issue"), "verdict": verdict,
                     "trace": (child or {}).get("trace")}
        ok = verdict == "approve"
        # exit 2 = instrument error, NEVER a reject (driver contract, stage 4)
        envelope["instrument_error"] = proc.returncode == 2
    else:  # spec
        envelope |= {"notebook": params.get("notebook"),
                     "verdict": "draft-produced" if proc.returncode == 0 else "spec-failed"}
        envelope["draft_chars"] = len(out or "")
        if params.get("out"):
            envelope["draft"] = params["out"]
        ok = proc.returncode == 0
    envelope["ok"] = bool(ok)
    return envelope


def main() -> int:
    ap = argparse.ArgumentParser(description="One documented entry into the nb_coder "
                                             "workflows (spec/code/audit) — envelope JSON out.")
    ap.add_argument("--step", required=True, choices=STEPS)
    ap.add_argument("--params", required=True,
                    help="JSON object of step params ('-' reads stdin). Closed set per step — "
                         "see INVOCATION.md. Credentials never go here: env only.")
    ap.add_argument("--timeout", type=int, default=3600,
                    help="wall-clock cap on the step child (default 3600 s)")
    ap.add_argument("--dry-run", action="store_true",
                    help="print the would-be command envelope, spawn nothing")
    args = ap.parse_args()
    raw = sys.stdin.read() if args.params == "-" else args.params
    try:
        params = json.loads(raw)
        if not isinstance(params, dict):
            raise ValueError("params must be a JSON object")
    except Exception as exc:
        print(json.dumps({"step": args.step, "ok": False,
                          "verdict": f"refused-params-unparsable:{exc}"}, ensure_ascii=False))
        return 2
    try:
        envelope = run_step(args.step, params, args.timeout, args.dry_run)
    except ValueError as exc:                       # closed-set / required-key refusal
        print(json.dumps({"step": args.step, "ok": False,
                          "verdict": f"refused:{exc}"}, ensure_ascii=False))
        return 2
    print(json.dumps(envelope, ensure_ascii=False))
    if envelope.get("ok") is None:                  # dry-run
        return 0
    return 0 if envelope.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
