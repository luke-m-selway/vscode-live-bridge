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

Notebook reads return URI, notebook version, dirty state, and ordered cells. Each cell includes a session-stable cell ID, current index, kind, language ID, cell document version, source, and SHA-256 hash. Cell IDs are not persisted into the notebook file. By default `readNotebook` remains source-only. With `params.includeOutputs: true`, code cells also include the current in-memory output groups and execution summary exposed by VS Code; the bridge does not execute cells to obtain them.

Included output groups preserve group metadata and item order. Each represented item reports MIME type and raw `byteLength`; textual/JSON/XML/SVG and VS Code stdout/stderr/error MIME data use UTF-8, while other binary MIME data use base64. One notebook read shares limits of 1 MiB raw included output bytes, 100 output groups, and 100 output items. Items whose payload cannot fit the byte limit are represented with `omitted: true` and `reason: OUTPUT_LIMIT_EXCEEDED` where the item record itself still fits the item/group caps. The top-level `outputRead` summary reports the limits plus included/omitted byte, item, and group counts and `truncated`, so clients can distinguish no outputs from bounded omission.

After a successful notebook mutation, the extension waits for a short bounded quiescence period in notebook change events before capturing the returned snapshot. That stabilized success snapshot may be used as the freshness basis for an immediate chained notebook operation; any later user/editor change still invalidates it normally.

## Freshness

`replaceText` requires the text document version and hash from the prior read.

`replaceCell` requires notebook version, cell ID, cell hash, and cell document version.

`insertCell` and `deleteCell` require notebook version, reference/target cell ID, and cell hash.

`executeCell` requires notebook version, target cell ID, cell hash, and cell document version. `saveNotebook` requires the notebook version from the live snapshot that the caller intends to persist.

Any mismatch returns `status: conflict` with `reason: STALE_SNAPSHOT`. Missing expectations return `MISSING_SNAPSHOT_EXPECTATION`. The bridge never force-applies or auto-merges a stale edit.

## Operations

- `status` reports enabled/trusted state and IPC root.
- `list` reports live file-backed text documents and notebooks.
- `readText` and `readNotebook` return live snapshots; `readNotebook` can opt into bounded live output inspection with `includeOutputs`.
- `saveNotebook` explicitly saves one fresh, file-backed live notebook through `NotebookDocument.save()`. It never saves unrelated documents.
- `executeCell` explicitly asks VS Code to run one fresh code cell in a Microsoft Jupyter notebook. Before invoking VS Code's Run Cell path, the bridge checks the Jupyter extension for a selected Python environment or an already-live Jupyter kernel; it never opens the kernel picker or chooses a kernel. A missing Jupyter extension returns `JUPYTER_EXTENSION_UNAVAILABLE`, unsupported notebook types return `UNSUPPORTED_NOTEBOOK_TYPE`, unavailable Jupyter kernel-state APIs return `JUPYTER_KERNEL_STATE_UNAVAILABLE`, and no selected/live Jupyter kernel returns `NO_SELECTED_JUPYTER_KERNEL`. Because that preflight can yield while Jupyter activates, the bridge revalidates the notebook/cell snapshot immediately before execution. A successful response contains `execution.completed`, derived `execution.success`, optional execution order, the bounded live notebook snapshot with outputs, and the executed cell snapshot. The default execution timeout is 30 seconds and the accepted range is 1–300 seconds. A timeout returns `EXECUTION_TIMEOUT`; it is a watchdog, not proof that a kernel-side computation was cancelled. If VS Code returns without observable execution-summary or output change, the bridge returns `EXECUTION_NOT_CONFIRMED`. Reread the notebook before deciding whether to retry.
- `replaceText` replaces a UTF-16 offset range or the complete text.
- `replaceCell` replaces one live notebook cell through `NotebookEdit.replaceCells`, preserving its metadata, outputs, execution summary, and bridge session cell ID.
- `insertCell` inserts a code or Markdown cell before or after a fresh reference cell.
- `deleteCell` deletes a fresh target cell.

Edits use VS Code edit APIs and remain unsaved until an explicit `saveNotebook` request. Visible text edits receive explicit undo stops; notebook edits participate in the notebook undo stack. `executeCell` is the only execution operation and is scoped to a fresh live notebook code cell; the protocol provides no general process/shell command, network, model, or Git operation.

## Target policy

The VS Code window must be trusted and the bridge enabled. A file is eligible only when it belongs to an open workspace folder or is already open in that extension host. Other paths are rejected.

## Response status

`ok` means completed. `conflict` means reread before retrying. `error` means the request or target is invalid or VS Code rejected the edit. `unavailable` means the bridge cannot perform editor operations, for example because it is disabled, untrusted, or no extension responded before the CLI timeout.