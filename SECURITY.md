# Security Policy

## Experimental Alpha

Next Level Agent is experimental Alpha software. It coordinates tools exposed
by OpenCode; it is not an operating-system sandbox or a hardened security
boundary. Run it only in repositories and provider accounts whose access you
understand. Review the current limitations in
[`docs/PROJECT_STATUS_AND_USAGE.md`](docs/PROJECT_STATUS_AND_USAGE.md) before use.

## Reporting a vulnerability

Do not include credentials, private repository content, session transcripts,
or exploit details in a public issue. Email
[`pickleshell.plugin@gmail.com`](mailto:pickleshell.plugin@gmail.com) with:

- the affected commit or release;
- the impact and required preconditions;
- minimal reproduction steps using synthetic data;
- any suggested mitigation.

Ordinary bugs and feature requests can use the public GitHub issue tracker.

## Data and credential boundaries

NLA does not require credentials in this repository. Configure provider
authentication through supported user-level provider configuration. Never put
API keys in `opencode.json`, model-pool files, prompts, Notebook pages, session
ledgers, telemetry, benchmark artifacts, or issue reports.

Runtime telemetry and capability caches are ignored by Git, but users remain
responsible for checking their own target repositories before publication.

NLA-owned telemetry omits command, prompt, request/response, environment and
header fields and redacts common secret assignments. This does not control
OpenCode's internal logs, terminal scrollback, shell history, provider logs, or
other host telemetry. Avoid full environment dumps and keep provider credentials
out of command lines and task content.

## Privilege and workspace boundaries

Do not give NLA/OpenCode `sudo` for normal development or acceptance runs. A
role-level tool policy or an external-directory restriction cannot contain a
process that can invoke `sudo`, switch users, or read the host filesystem with
another privileged tool. Use an unprivileged dedicated account, a task-owned
worktree, minimal provider credentials, and a separately reviewed provisioning
harness for any operation that genuinely requires elevated privileges.

NLA blocks several common environment-dump forms, nested shell launchers and
direct privilege tools (`sudo`, `doas`, `runuser`, `su`) in NLA-managed
sessions, but this is defense in depth around OpenCode's coarse `bash`
capability—not a complete shell parser or a security sandbox.
