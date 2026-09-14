# Security policy

## Supported code

Security fixes target the current `main` branch and the latest source release. This project is currently an early public release rather than a published Marketplace or npm package.

## Trust model

VS Code Live Bridge is local same-user IPC, not an authentication boundary.

- The bridge has no network listener and exposes no remote service.
- The IPC root defaults to `~/.vscode-live-bridge/` and uses user-only POSIX permissions where supported.
- While the bridge is enabled, another process already running as the same operating-system user may be able to submit bridge requests.
- Editor operations require a trusted VS Code workspace and are limited to files in that workspace or files already open in the extension host.
- Requests can read live unsaved document content and can edit eligible buffers through VS Code APIs.
- Logs contain request metadata and target paths, but not document contents.

Do not enable the bridge in a local environment where same-user processes are not trusted.

## Reporting a vulnerability

Do not publish exploit details, sensitive paths, document contents, or proof-of-concept payloads in a public issue.

Use GitHub's private vulnerability reporting / Security Advisory flow for this repository when available. If that option is unavailable, contact the repository owner through the GitHub profile and request a private reporting channel before sharing sensitive details.

Useful reports include the affected version or commit, operating system, VS Code version, reproduction steps, security impact, and whether the issue crosses one of the documented trust boundaries.

Examples of security-relevant issues include workspace-boundary bypasses, unsafe path handling, request-queue permission failures, stale-snapshot bypasses that overwrite newer user edits, unintended process/network execution, or document contents being written to logs.
