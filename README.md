# VS Code Live Bridge

A local, agent-agnostic bridge for reading and editing the live in-memory state of trusted VS Code workspaces. It contains no model, provider, chat, execution, Git, or network integration.

The VS Code extension owns editor state and applies edits through VS Code APIs. The `vscode-live-bridge` CLI writes local filesystem requests to `~/.vscode-live-bridge/` and waits for responses. Protocol details are defined in [`docs/protocol.md`](docs/protocol.md).

## Install

```sh
npm install
npm run compile
npm run package
code --install-extension vscode-live-bridge-0.1.0.vsix
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
```

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

Reads come from `workspace.textDocuments` and `workspace.notebookDocuments`, so unsaved user edits are visible. Existing cell source is changed through the cell's live `TextDocument`; insertion/deletion uses `NotebookEdit`. The extension never rewrites an open `.ipynb` file as JSON.

Every edit must carry the snapshot it was based on. A changed document version/hash, notebook version, cell ID, cell hash, or cell document version returns:

```json
{"status":"conflict","reason":"STALE_SNAPSHOT"}
```

The bridge never auto-merges stale edits. The caller must reread and decide how to retry.

No bridge operation saves a document. Edits therefore remain dirty and participate in normal VS Code Undo through `workspace.applyEdit`.

## Security

The bridge has no network listener, telemetry, cloud dependency, API key, model invocation, shell execution, or arbitrary command operation. The IPC root is created with user-only permissions where the platform supports POSIX modes. Targets must either belong to the current trusted workspace or already be open in VS Code. When the bridge is disabled, non-status requests are rejected.

Request logs at `~/.vscode-live-bridge/logs/bridge.log` contain only request ID, timestamp, target, operation, outcome, and error reason; document contents are not logged.

## Troubleshooting and control

Use the Command Palette commands **VS Code Live Bridge: Enable**, **Disable**, **Status**, and **Show Log**. `vscode-live-bridge status` distinguishes an active extension from `NO_EXTENSION_RESPONSE`; a disabled extension reports `BRIDGE_DISABLED` for editor operations.

If a CLI edit returns `STALE_SNAPSHOT`, reread the target and build a new request from the returned state. If a path is rejected, confirm that it is inside the trusted workspace or already open in the current VS Code window.

Uninstall with:

```sh
code --uninstall-extension luke-m-selway.vscode-live-bridge
rm -f ~/.local/bin/vscode-live-bridge
rm -rf ~/.vscode-live-bridge
```

## External-agent integration

External tools need only shell access to the CLI and must follow a read → reason → edit flow. They should treat exit code `3` / `STALE_SNAPSHOT` as a required reread, never as permission to force an overwrite. Day Shift or Goose integration should document when to call this CLI and how to surface conflicts; no integration logic belongs in this repository.

## Current limitation

The MVP assumes a single enabled VS Code extension host owns a given `~/.vscode-live-bridge/` request queue. Running multiple enabled VS Code windows against the same queue is not yet coordinated.
