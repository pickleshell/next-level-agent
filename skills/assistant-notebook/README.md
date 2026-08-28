# Assistant Notebook for ChatGPT and Codex

## What problem does it solve?

When you work with ChatGPT or Codex for a long time, important information can
become scattered across conversations and sessions. Assistant Notebook keeps
short, durable working notes that help an agent continue without asking you to
reconstruct the whole project.

ChatGPT uses ChatGPT Library. Codex and other local agents use a matching
notebook directory on the local filesystem. The workflow and page structure are
the same in both modes.

The current conversation and other available context remain the primary source
for the work at hand. The notebook is compact secondary memory: it helps recall
missing context and find durable notes, but it should not replace richer current
context or override verified current instructions.
It also acts as a retrieval cue that helps the agent identify and recover the
fuller relevant context; it is not a self-contained replacement for that
context.

The notebook is useful for:

- long-running projects;
- job searches and applications;
- company research;
- legal and administrative matters;
- plans and recurring tasks;
- any work that continues across multiple conversations or sessions.

The skill does not copy your complete chat history. It keeps only short working
notes and never stores passwords, API keys, authentication tokens, recovery
codes, government identifiers, or other secrets.

## What do I need?

- ChatGPT or Codex with personal Skills support;
- ChatGPT Library for ChatGPT mode; or
- a writable local filesystem for Codex/local mode.

## Install and configure it

You do not need to download files or understand how skills work.

Copy the complete text below, paste it into ChatGPT or Codex, and send it:

```text
Install and configure Assistant Notebook for me.

The skill is located here:
https://github.com/pickleshell/skills/tree/main/assistant-notebook

Use the skill-creator workflow to download, validate, and install assistant-notebook as my personal skill. Do not modify the skill.

After installation, use $assistant-notebook to create my primary Assistant Notebook. In ChatGPT, create it in ChatGPT Library. In Codex/local mode, create it at $ASSISTANT_NOTEBOOK_DIR, or at $CODEX_HOME/assistant-notebook when that variable is set, or at ~/.codex/assistant-notebook. Create one notebook directory, one index file named Assistant Notebook - Contents.md, and one Notebook Protocol.md page. Ask me what projects or areas I want to keep in the notebook before creating any subject pages. Create only the pages I actually need.

Do not copy my complete conversation history, passwords, API keys, tokens, government identifiers, or other secrets into the notebook.

When everything is ready, tell me which notebook pages were created and confirm that assistant-notebook is installed and available in my Skills directory.
```

ChatGPT or Codex will install the skill, ask what you want to track, and create
the initial notebook pages in the selected backend.

For local mode, set `ASSISTANT_NOTEBOOK_DIR` when you want an explicit path.
Otherwise the skill uses `$CODEX_HOME/assistant-notebook` and then
`~/.codex/assistant-notebook`.

## How do I use it afterward?

Use ChatGPT or Codex normally. The skill is designed to consult the notebook
before meaningful work and update it after important progress.

If you want to invoke it explicitly, write:

```text
Use $assistant-notebook, restore the context for this project, and tell me the current status and next step.
```

You can also ask:

```text
Use $assistant-notebook and show me what projects and open tasks are currently in my notebook.
```

The operational instructions used by both products are in [`SKILL.md`](SKILL.md).
