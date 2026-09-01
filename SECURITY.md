# Security Policy

## Experimental Alpha

Next Level Agent is experimental Alpha software. It coordinates tools exposed
by OpenCode; it is not an operating-system sandbox or a hardened security
boundary. Run it only in repositories and provider accounts whose access you
understand. Review the current limitations in
[`docs/PROJECT_STATUS_AND_USAGE.md`](docs/PROJECT_STATUS_AND_USAGE.md) before use.

## Supported version

Security fixes are applied to the current `main` branch and the newest Alpha
release only. Historical snapshots and inherited upstream integrations may not
receive NLA-specific fixes.

## Reporting a vulnerability

Do not include credentials, private repository content, session transcripts,
or exploit details in a public issue. Email
[`pickleshell.plugin@gmail.com`](mailto:pickleshell.plugin@gmail.com) with:

- the affected commit or release;
- the impact and required preconditions;
- minimal reproduction steps using synthetic data;
- any suggested mitigation.

Allow reasonable time for triage before public disclosure. Ordinary bugs and
feature requests can use the public GitHub issue tracker.

## Data and credential boundaries

NLA does not require credentials in this repository. Configure provider
authentication through supported user-level provider configuration. Never put
API keys in `opencode.json`, model-pool files, prompts, Notebook pages, session
ledgers, telemetry, benchmark artifacts, or issue reports.

Runtime telemetry and capability caches are ignored by Git, but users remain
responsible for checking their own target repositories before publication.
