#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7416ac16c91e150aae5a75dd251d0c1a4c2f5c2c
# original path: myia_vllm/scripts/adoption/nb_coder/nb_coder_detach.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Start a command OUTSIDE the caller's process tree, print its pid, exit at once.

Usage: nb_coder_detach.py <log-file> -- <cmd> [args...]

Why (measured 21/11 00:45Z): stopping the scheduler's background task killed both
nb_coder drivers it had launched (MGS-25 at 1,464 s, MGS-28 at 283 s), and the hot
adoption found them dead. The kill walks the process tree: a probe sleeper spawned
directly died with plain flags, with CREATE_NEW_PROCESS_GROUP and with
CREATE_BREAKAWAY_FROM_JOB alike. Only a sleeper started by an INTERMEDIATE process
that exited at once survived. This file is that intermediate: its child's parent is
gone by the time anyone walks the tree, so the driver finishes its grain whatever
happens to the scheduler, and a restarted scheduler adopts it by pid.

The command's stdout and stderr are appended to <log-file>; stdin is closed.
Prints one JSON line {"pid": N} on success, {"error": "..."} and exit 1 otherwise.
"""
import json
import subprocess
import sys

CREATE_BREAKAWAY_FROM_JOB = 0x01000000
CREATE_NO_WINDOW = 0x08000000


def detach(log_path: str, cmd: list[str]) -> int:
    with open(log_path, "ab") as log:
        common = dict(stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                      close_fds=True)
        if sys.platform != "win32":
            return subprocess.Popen(cmd, start_new_session=True, **common).pid
        # CREATE_NO_WINDOW, not DETACHED_PROCESS: the driver's own MCP children would
        # otherwise each allocate a visible console.
        base = subprocess.CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        try:
            return subprocess.Popen(cmd, creationflags=base | CREATE_BREAKAWAY_FROM_JOB,
                                    **common).pid
        except OSError:
            # a job that forbids breakaway refuses the flag; the orphaning still holds
            return subprocess.Popen(cmd, creationflags=base, **common).pid


def main(argv: list[str]) -> int:
    if len(argv) < 3 or argv[1] != "--":
        print(json.dumps({"error": "usage: nb_coder_detach.py <log-file> -- <cmd> ..."}))
        return 1
    try:
        pid = detach(argv[0], argv[2:])
    except Exception as e:                      # reported, never raised: the caller parses
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
        return 1
    print(json.dumps({"pid": pid}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
