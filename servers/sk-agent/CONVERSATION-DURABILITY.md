# Conversation durability — the intent, and where it stands

**Why this file exists.** The intent was carried by an issue filed in the *vLLM* repository
(`jsboige/vllm#66`, 2026-05-10) while the sk-agent code lived there. The harness moved to this
repository on 2026-11-22. An intent left in the old repository becomes an orphan: nobody reads it
where the code now lives. **User instruction of 2026-11-27** (answering registry Q71): *« faites en
sorte que l'intention persiste même après migration du harnais dans sk-agent »* — so the intent lives
here, versioned, and the old issue is closed on this file.

## The intent (unchanged since 2026-05-10)

A long agent turn must not be lost by a cut: a server restart, an API interruption, a timeout, a
paused loop. Concretely, a lane that comes back must be able to continue **the same** conversation —
same history, same already-executed tools, no re-execution, no silent re-payment of the work already
done — and long threads must condense themselves by **size**, not by guesswork.

## What is implemented (measured 2026-11-27, read-only)

| Part of the intent | State | Where |
|---|---|---|
| Resumable pause, no replayed tools | **Implemented** | `sk_agent_turns.py:14-20` — a paused turn returns `status:"paused"`, `resumable:true`; the next `call_agent` with `options={"continue": true}` re-enters the loop over the committed history |
| Idempotent defer **across restarts** | **Implemented** | `sk_agent_turns.py:21-27` — every executed tool call of the turn epoch is journaled (name + arguments → result); after a restart the filter answers journaled calls from the journal instead of re-executing them. Replay stops at the first genuinely new invoke |
| Durable conversations (messages + turn counter + journal) | **Implemented, opt-in** | `sk_agent_turns.py:28-30` and `ConversationStore` (`sk_agent_turns.py:394+`): `<id>.json` and `<id>.journal.json`, atomic writes (`tmp` + `os.replace`), UTF-8 without BOM (`:430-436`) |
| Condensation driven by thread size | **Implemented** | `sk_context_condensation.py:14-37` — threshold-driven passes, `trigger_tokens` / `summarise_max_tokens` configurable per agent (`:109`, `:130-150`), with presets |

## What is *not* in place — the part that decides whether a cut actually loses a session

1. **The durable store is `disabled` by default** (`README.md:516`) and is enabled only by pointing
   `SK_AGENT_CONVERSATION_DIR` at a directory (`sk_agent_turns.py:50`, `:411-415`; when the variable is
   unset, `ConversationStore.root` is `None` and `enabled()` is false — nothing is written).
   **Measured on `myia-ai-01`: the variable is not set** in the MCP server configuration, so on that
   seat a restart still loses the conversation. The capability exists; the deployment does not use it.
2. **The store is a local directory**, so it is per-process/per-seat by construction. There is **no
   registry shared between lanes**: a session started on one seat cannot be listed or continued from
   another. Nothing in the code claims otherwise.
3. **No retention/GC policy** for the store directory: enabling it without a bound creates unbounded
   growth (the same failure mode the KV fs-tier pruner exists to prevent on the vLLM side).

## Decision (user, 2026-11-27)

The vLLM issue is **closed on the result** (option *recadrer*), not on a promise. What remains
open is exactly the gap above and belongs here:

- **Actionable now, no new code**: enable `SK_AGENT_CONVERSATION_DIR` on the seats where a long turn
  matters, behind a bounded directory with a GC (point 1 + point 3).
- **Named remainder, not started**: a registry shared between lanes (point 2) is a *new* piece —
  it engages a common protocol and a storage location outside any repository. It must not be built
  on a supposition: it starts only with a lane that actually needs cross-seat continuation.

## How to verify the claim above (no trust required)

```bash
# 1. durability is implemented, and opt-in
grep -n "SK_AGENT_CONVERSATION_DIR" servers/sk-agent/sk_agent_turns.py servers/sk-agent/README.md

# 2. it is disabled unless the variable is set
grep -n "enabled\|self.root" servers/sk-agent/sk_agent_turns.py | head

# 3. on a given seat: is it actually set?
grep -o 'SK_AGENT_CONVERSATION_DIR[^,]*' ~/.claude.json      # empty = disabled
```

*Written 2026-11-27 by `myia-ai-01:vllm`, from a read-only review of `main` at `d3cfda2`. Line
numbers are from that commit; re-read before quoting them later.*
