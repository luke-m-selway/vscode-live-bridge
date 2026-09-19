# VS Code Live Bridge

A local, agent-agnostic bridge for reading, editing, explicitly executing notebook cells, and explicitly saving live in-memory state in trusted VS Code workspaces. It contains no model, provider, chat, Git, network, or general shell/command integration.

The VS Code extension owns editor state and applies edits through VS Code APIs. The `vscode-live-bridge` CLI writes local filesystem requests to `~/.vscode-live-bridge/` and waits for responses. Protocol details are defined in [`docs/protocol.md`](docs/protocol.md).

> **Status:** early public release. The source is public, but the extension and CLI are not currently published to the VS Code Marketplace or npm. Build the local VSIX and CLI from source. The npm package is intentionally marked `private` to prevent accidental publication.

VS Code is a Microsoft product. This project is independent and is not affiliated with or endorsed by Microsoft.

## Requirements

- VS Code 1.99 or newer.
- Node.js 18 or newer for building and for the standalone CLI.
- A trusted VS Code workspace for editor operations.

## Install

```sh
npm install
npm run compile
npm run package
code --install-extension vscode-live-bridge-0.2.0.vsix
npm run install-cli
```

`npm run install-cli` installs a stable wrapper at `~/.local/bin/vscode-live-bridge`. Ensure `~/.local/bin` is on `PATH`.

In VS Code, open a trusted workspace and run **VS Code Live Bridge: Enable** from the Command Palette. The bridge is disabled until explicitly enabled.

## CLI

All commands emit one JSON response object. Read commands return the current in-memory VS Code state, including unsaved changes.

```sh
vscode-live-bridge status
vscode-live-bridge list
vscode-live-bridge read path/to/file.md
vscode-live-bridge read-notebook path/to/notebook.ipynb
vscode-live-bridge read-notebook path/to/notebook.ipynb --include-outputs
vscode-live-bridge execute-cell path/to/notebook.ipynb --notebook-version <version> --cell-id <id> --cell-hash <sha256> --document-version <version>
vscode-live-bridge save-notebook path/to/notebook.ipynb --notebook-version <version>
```

`read-notebook --include-outputs` adds the current live code-cell outputs and execution summary without executing cells. `execute-cell` is a separate, explicit Microsoft Jupyter action that requires the exact fresh cell snapshot and a Jupyter kernel/controller already selected by the user or notebook environment; the bridge never opens the kernel picker, chooses a kernel, or saves after execution. `save-notebook` is also separate and saves only the requested fresh notebook through VS Code. Output transport is bounded; inspect the top-level `outputRead.truncated` field before assuming the returned outputs are complete. Exact fields, freshness rules, kernel-state errors, and execution limits are defined in [`docs/protocol.md`](docs/protocol.md).

Text edits require the `version` and `hash` returned by the preceding read:

```sh
vscode-live-bridge replace-text note.md \
  --document-version 17 \
  --document-hash <sha256> \
  --start 12 --end 20 \
  --text 'replacement'
```

Notebook cell source replacement requires the notebook version plus the target cell ID, cell hash, and cell document version returned by `read-notebook`:

```sh
vscode-live-bridge replace-cell notebook.ipynb \
  --notebook-version 8 \
  --cell-id <id> \
  --cell-hash <sha256> \
  --document-version 4 \
  --text 'print("updated")'
```

Structural operations use the same reference-cell snapshot:

```sh
vscode-live-bridge insert-cell notebook.ipynb \
  --notebook-version 8 --cell-id <id> --cell-hash <sha256> \
  --kind markdown --position after --text '## New section'

vscode-live-bridge delete-cell notebook.ipynb \
  --notebook-version 9 --cell-id <id> --cell-hash <sha256>
```

## Live-buffer and conflict semantics

Reads come from `workspace.textDocuments` and `workspace.notebookDocuments`, so unsaved user edits are visible. Visible text editors use `TextEditor.edit` with explicit undo stops; other eligible text documents use `WorkspaceEdit`. Notebook source replacement, insertion, and deletion use `NotebookEdit` transactions, and source replacement preserves the cell's metadata, outputs, execution summary, and bridge session ID. After a successful notebook mutation, the extension waits for a short bounded quiet period in notebook change events before returning its post-edit snapshot, reducing false conflicts from provider-driven version settling. The extension never rewrites an open `.ipynb` file as JSON.

Every edit must carry the snapshot it was based on. A changed document version/hash, notebook version, cell ID, cell hash, or cell document version returns:

```json
{"status":"conflict","reason":"STALE_SNAPSHOT"}
```

The bridge never auto-merges stale edits. The caller must reread and decide how to retry.

Edits and cell execution do not save automatically. They remain dirty until the user or an explicit fresh `save-notebook` request saves that notebook. Bridge edits participate in normal VS Code Undo through VS Code edit APIs.

## Security

The bridge has no network listener, telemetry, cloud dependency, API key, model invocation, general shell execution, or arbitrary command operation. `execute-cell` intentionally runs the already-present code of one fresh live notebook cell through VS Code's notebook controller, so that notebook code has the same side-effect capabilities it would have when run manually. The IPC root is created with user-only permissions where the platform supports POSIX modes. Targets must either belong to the current trusted workspace or already be open in VS Code. When the bridge is disabled, non-status requests are rejected.

The bridge is a **same-user local IPC** mechanism: any process already running as the same operating-system user may be able to submit requests while the bridge is enabled. Only enable it in workspaces and local environments you trust. Request logs at `~/.vscode-live-bridge/logs/bridge.log` contain file paths and request metadata, but not document contents.

See [`SECURITY.md`](SECURITY.md) for the trust model and vulnerability reporting guidance.

## Troubleshooting and control

Use the Command Palette commands **VS Code Live Bridge: Enable**, **Disable**, **Status**, and **Show Log**. `vscode-live-bridge status` distinguishes an active extension from `NO_EXTENSION_RESPONSE`; a disabled extension reports `BRIDGE_DISABLED` for editor operations.

If a CLI edit returns `STALE_SNAPSHOT`, reread the target and build a new request from the returned state. If a path is rejected, confirm that it is inside the trusted workspace or already open in the current VS Code window.

Uninstall with:

```sh
code --uninstall-extension luke-m-selway.vscode-live-bridge
rm -f ~/.local/bin/vscode-live-bridge
rm -rf ~/.vscode-live-bridge
```

## Tests

`npm test` runs deterministic protocol, IPC-permission, hash, and freshness tests. `npm run test:vscode` runs the end-to-end acceptance suite in an isolated VS Code Extension Development Host and requires the VS Code Jupyter extension to be installed locally so the runner can expose its notebook serializer.

The extension-host suite covers live unsaved text reads, in-place text edits and Undo, live notebook source/output reads, rejection when no Jupyter kernel is selected, real Microsoft Jupyter/Python execution without autosave, execution success/error output, explicit targeted notebook save, cell replacement and Undo, chained notebook edits from returned stabilized snapshots, stale-snapshot rejection, structural insert/delete and Undo, trusted-path enforcement, disabled behavior, and ordinary-shell CLI use.

## External-tool integration

External tools need only shell access to the CLI and must follow a read → reason → edit flow. They should treat exit code `3` / `STALE_SNAPSHOT` as a required reread, never as permission to force an overwrite. The canonical operating procedure is [`.agents/skills/vscode-live-bridge/SKILL.md`](.agents/skills/vscode-live-bridge/SKILL.md); the exact request/response contract remains owned by [`docs/protocol.md`](docs/protocol.md). Downstream integrations should point to those sources rather than duplicating bridge rules.

## Current limitation

The MVP assumes a single enabled VS Code extension host owns a given `~/.vscode-live-bridge/` request queue. Running multiple enabled VS Code windows against the same queue is not yet coordinated.

## Contributing

Contributions are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the small set of safety and validation requirements.

## License

MIT. See [`LICENSE`](LICENSE). Third-party development and test dependencies remain under their respective licenses and are not vendored into this repository.
