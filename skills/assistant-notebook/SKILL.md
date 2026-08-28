---
name: assistant-notebook
description: Consult and maintain the user's persistent Assistant Notebook in ChatGPT Library or on the local filesystem as a secondary recall aid and index. The current conversation and other available context are primary and usually more complete. Consult it once when starting a substantive working context or restoring continuity, then reuse the recovered context without rereading the notebook on every request. Reconsult only when needed for a missing fact, older decision, project switch, or context loss. Update it after meaningful progress with verified outcomes, decisions, files, blockers, and next steps.
---

# Assistant Notebook

Use the first available supported backend as the persistent working notebook:

- ChatGPT: use ChatGPT Library when Library operations are available;
- Codex or another local agent: use the local filesystem at
  `$ASSISTANT_NOTEBOOK_DIR`, then `$CODEX_HOME/assistant-notebook`, then
  `~/.codex/assistant-notebook`.

The local backend uses the same filenames and page structure as the Library
backend. Do not copy or export ChatGPT conversation history or personal memory
into either backend. Never place the notebook in a repository unless the user
explicitly chooses that location.

## Context priority

Use the active conversation and other currently available context as the
primary working source. The full context may contain everything: discussion,
reasoning, alternatives, intermediate details, and transient remarks. Treat the
notebook as a compact secondary recall aid and index containing only the most
important durable facts, decisions, preferences, corrections, status, and
retrieval cues needed to locate and reconstruct the fuller context. The
notebook must not copy or attempt to replace the full context.

Current verified evidence and explicit current user instructions override stale
or conflicting notebook notes. The notebook should restore missing context, not
narrow, replace, or discard richer context already available in the
conversation, attached files, repositories, tools, or other current sources.
Treat notebook entries as retrieval cues and routing prompts, not
self-contained context. Use project names, people, companies, decisions,
statuses, dates, links, and artifact references to identify which fuller prior
context is relevant.

When a cue points to prior work, recover the fuller available context from
conversation/interaction history, personal context, attached files, Library or
local artifacts, repositories, tools, and other current sources before deciding
or acting. The notebook initiates retrieval; it does not bound what may be
recalled.

## Contents page

`Assistant Notebook - Contents.md` is a table of contents and routing map for
the user's broader context. Use it to switch contexts quickly and locate fuller
context in subject pages, source artifacts, repositories, tools, or the active
conversation. Keep detailed context on the appropriate subject page or source
artifact; keep `Contents.md` routing-only.

## Context initialization and re-entry

Consult the notebook once when starting a new substantive working context or
when continuity needs to be restored. After reading it, keep the recovered
information in the active working context and continue from that context.

Do not search, scan, or reread the notebook before every message or task in the
same continuous working context. Reconsult it only when a relevant fact or
older decision is missing, the user switches to a different project or stable
subject, available context has been compacted or lost, or a conflict requires
checking the durable record. This avoids unnecessary retrieval and token use
and prevents stale notes from repeatedly displacing current context.

1. In ChatGPT, search the Library by the exact title `Assistant Notebook - Contents.md`.
   In Codex/local mode, locate that exact filename under the selected notebook
   directory.
2. Read the contents page; never rely on a search snippet alone.
3. Follow its routing table and read only the relevant notebook page or pages.
4. Use relevant notebook entries as retrieval cues to recover fuller related context from the active conversation, available history, personal context, attached files, Library or local artifacts, repositories, tools, and other current sources. Then reconcile that recovered context with the active conversation and other currently available context, keeping available context primary and the notebook secondary. Merge useful notebook recall without assuming it is complete or current. Never replace or narrow the current context to what the notebook contains.
5. Treat notebook entries as orientation, not proof that an external action succeeded. Verify repositories, services, forms, correspondence, or source files when factual completion matters.
6. Expect the common case that recent discussion or progress exists in the active context but was not written to the notebook. Use it for the task and add durable missing information to the appropriate page as soon as the gap is noticed, including during the task rather than waiting until the end.
7. Resolve discrepancies by current user instructions, verified evidence, recency, specificity, and status. Verified current evidence and explicit current instructions win over stale notes. If a discrepancy cannot be resolved safely, preserve the uncertainty instead of silently overwriting either account.

If the contents page is unavailable, say so briefly and continue from verified
available context. Do not create a second notebook automatically. Create a
local notebook only during explicit setup or when the user explicitly asks for
one.

## During and after work

Write short notebook notes during a substantive discussion whenever an
important durable detail emerges that would help reconstruct the context later.
Capture decisions, corrected assumptions, preferences, constraints, status
changes, and important rationale while they are fresh; do not wait for the task
to finish or for the user to ask whether the notebook was updated. Keep these
notes compact retrieval cues rather than transcripts.

Update the relevant existing page after meaningful progress. Record concise, durable facts:

- confirmed result and date;
- decision and important rationale;
- current status or blocker;
- exact Library filename/folder or local relative path for related artifacts;
- next action;
- evidence or verification source when useful.

Keep planned, attempted, and completed actions explicitly distinct. Mark
replaced information as superseded instead of silently leaving contradictions.
Preserve unrelated page content and Library file identity/version history; for
local files, preserve unrelated pages and use atomic replacement.

Update `Assistant Notebook - Contents.md` only when adding, renaming, or removing a page, or when its one-line status summary changes materially. Do not use it as an activity log.

When older relevant context is recovered during normal work, incrementally
backfill durable decisions, facts, artifact references, status, and next
actions into the appropriate subject page. Do not bulk-import history, copy
whole conversations, or put detailed history in `Contents.md`.

## Notes and artifacts

- Store resumes, company materials, project documents, and correspondence in the relevant Library folder or local notebook page directory.
- Refer to attachments by exact Library filename/folder or local relative path; do not embed large file contents into notes.
- Prefer one maintained page per stable subject over many timestamped fragments.
- Never store passwords, API keys, authentication tokens, recovery codes, government identifiers, or other secrets in the notebook.
- Do not record casual conversation, transient reasoning, or facts already represented adequately by an attached source file.

## Write discipline

For Library mode, use the available OpenAI Library skill/tool for every read or
write. Search and read before replacing a page. Replace the same
`library_file_id`; never create a duplicate merely because a local edit
produced a new path. Use version guards when the current version is known, and
reconcile version conflicts before retrying. For local mode, use filesystem
reads/writes, preserve the same page filenames, write atomically, and do not
commit notebook contents unless explicitly requested.
