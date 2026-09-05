---
name: mem0-memory
description: Use optional Mem0 memory tools for focused cross-session recall and short verified durable facts. Use when the user asks to remember or forget something, when resuming work that may need prior context, or after verified progress creates a stable fact worth retaining.
---

# Mem0 Memory

Mem0 is an optional associative-memory layer. Current task context, current
repository evidence and documentation, and the NLA private ledger are primary.
Mem0 can supply a useful lead, but it is not authoritative live state.

If `memory_*` tools are absent or a call fails, continue the primary task. When
the user explicitly requested persistence or deletion, say that it could not be
confirmed. Never treat an empty or failed search as proof that a fact is false
or never existed.

## Retrieve narrowly

- Use `memory_search` with a focused query and normally `limit: 3` to `5`.
- Do not bulk-dump memory. Avoid `memory_list` unless focused search cannot
  identify a record; if listing is necessary, keep its limit small.
- Use `memory_get` only to inspect an identified record exactly. Use
  `memory_history` only when how that record changed matters.
- Recheck paths, commits, repository behavior, and service state in their
  canonical sources before relying on them.

Bounded retrieval matters especially for 4B models: return only records needed
for the current decision.

## Store, update, or delete carefully

1. Accept only a short, atomic, self-contained, confirmed, durable fact.
2. Never store secrets, credentials, tokens, private keys, raw transcripts,
   large logs, source files, whole documents, guesses, or transient reasoning.
3. Before `memory_add`, run a precise duplicate `memory_search` with a small
   limit. Update the matching record with `memory_update` instead of creating a
   near-duplicate.
4. For exact technical facts, identifiers, paths, commits, or explicit wording,
   call `memory_add` with `infer: false`.
5. When the user explicitly asks to remember something, write synchronously and
   verify it with `memory_get` using the returned ID or a focused
   `memory_search`. Report honestly if verification fails.
6. Use `memory_delete` only for the exact identified record the user asked to
   forget or that is confirmed obsolete.

The namespace is configured outside the agent and owned by the server/plugin.
Do not invent or pass `user_id`, `namespace`, `agent_id`, or any other scope
override; those are not memory-tool arguments.

## Tool surface

Use only the available NLA tools: `memory_search`, `memory_list`, `memory_get`,
`memory_add`, `memory_update`, `memory_delete`, and `memory_history`.
