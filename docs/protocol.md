---
type: reference
status: current
---

# Local bridge protocol

This document owns the request/response contract. Exact TypeScript field names are defined in `src/protocol.ts`; installation and CLI usage are in the repository README.

## Transport

The default IPC root is `~/.vscode-live-bridge/` with `requests/`, `responses/`, `logs/`, and `state/`. Requests and responses are JSON files written atomically by temporary-file rename. Protocol version is `1`.

## Snapshots

Text reads return URI, language ID, document version, dirty state, complete text, and SHA-256 hash.

Notebook reads return URI, notebook version, dirty state, and ordered cells. Each cell includes a session-stable cell ID, current index, kind, language ID, cell document version, source, and SHA-256 hash. Cell IDs are not persisted into the notebook file.

After a successful notebook mutation, the extension waits for a short bounded quiescence period in notebook change events before capturing the returned snapshot. That stabilized success snapshot may be used as the freshness basis for an immediate chained notebook operation; any later user/editor change still invalidates it normally.

## Freshness

`replaceText` requires the text document version and hash from the prior read.

`replaceCell` requires notebook version, cell ID, cell hash, and cell document version.

`insertCell` and `deleteCell` require notebook version, reference/target cell ID, and cell hash.

Any mismatch returns `status: conflict` with `reason: STALE_SNAPSHOT`. Missing expectations return `MISSING_SNAPSHOT_EXPECTATION`. The bridge never force-applies or auto-merges a stale edit.

## Operations

- `status` reports enabled/trusted state and IPC root.
- `list` reports live file-backed text documents and notebooks.
- `readText` and `readNotebook` return live snapshots.
- `replaceText` replaces a UTF-16 offset range or the complete text.
- `replaceCell` replaces one live notebook cell through `NotebookEdit.replaceCells`, preserving its metadata, outputs, execution summary, and bridge session cell ID.
- `insertCell` inserts a code or Markdown cell before or after a fresh reference cell.
- `deleteCell` deletes a fresh target cell.

All edits use VS Code edit APIs and remain unsaved. Visible text edits receive explicit undo stops; notebook edits participate in the notebook undo stack. The protocol provides no save, process execution, network, model, Git, or notebook-execution operation.

## Target policy

The VS Code window must be trusted and the bridge enabled. A file is eligible only when it belongs to an open workspace folder or is already open in that extension host. Other paths are rejected.

## Response status

`ok` means completed. `conflict` means reread before retrying. `error` means the request or target is invalid or VS Code rejected the edit. `unavailable` means the bridge cannot perform editor operations, for example because it is disabled, untrusted, or no extension responded before the CLI timeout.
