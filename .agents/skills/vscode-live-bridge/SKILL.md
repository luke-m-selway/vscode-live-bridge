---
name: vscode-live-bridge
description: Safely inspect and edit live unsaved VS Code text and notebook buffers through the vscode-live-bridge CLI using freshness snapshots and conflict-aware retries.
---

# VS Code Live Bridge

Apply this skill when work depends on the current in-memory state of a VS Code text document or notebook, especially when unsaved user edits may exist.

This skill owns the agent operating procedure. The exact request/response contract is defined in [`docs/protocol.md`](../../../docs/protocol.md), and installation plus CLI syntax are defined in the repository [`README.md`](../../../README.md). Do not create a second protocol specification in downstream repositories.

## Preconditions

1. Run `vscode-live-bridge status` before relying on live editor state.
2. Require an active extension in a trusted VS Code workspace and an enabled bridge before issuing editor operations.
3. If the extension is disabled, have the operator run **VS Code Live Bridge: Enable** in the target VS Code window, then check status again.
4. Treat `NO_EXTENSION_RESPONSE`, an untrusted workspace, a missing CLI, or another unavailable state as a blocker when live state is required. Report the exact state instead of guessing or silently falling back to disk edits.
5. Assume one enabled VS Code extension host per `~/.vscode-live-bridge/` queue. If multiple VS Code windows may be enabled against the same queue, do not edit until queue ownership is unambiguous.

Ordinary repository or filesystem tools remain appropriate when live VS Code state is not material. Do not use them as a fallback to bypass this skill when unsaved editor state must be preserved.

## Read before every edit

Always obtain a fresh live snapshot before constructing an edit.

- For text, use `read` and retain the returned document `version` and `hash`.
- For notebooks, use `read-notebook` and identify the target by the returned session-stable `cellId`, not by index alone.
- Treat snapshot values as the basis for one edit decision. After any successful edit, reread before constructing the next dependent edit because versions and hashes may have changed.
- Notebook cell IDs are only stable for the current open VS Code session. Never persist them as durable notebook identifiers or assume they survive reload/reopen.

## Freshness requirements

Every write must carry the snapshot expectations required by the protocol.

- Text replacement requires the document version and document hash from the preceding live read.
- Notebook cell replacement requires the notebook version, target cell ID, target cell hash, and target cell document version.
- Notebook insertion or deletion requires the notebook version plus the reference/target cell ID and cell hash.

Do not omit, weaken, fabricate, or reuse stale expectations to make an edit apply.

## Conflict handling

`STALE_SNAPSHOT` means the live editor state changed after the snapshot used to plan the edit.

On `STALE_SNAPSHOT` or CLI exit code `3`:

1. Discard the stale edit basis.
2. Reread the live target.
3. Reconcile the new user/editor state with the intended change.
4. Build a new edit from the fresh snapshot.
5. Retry only if the intended change is still valid.

Never force-overwrite, bypass freshness checks, or reconstruct a request with invented expectations. If repeated concurrent edits prevent a safe retry, stop and surface the conflict instead of racing the user.

## Notebook safety

Use the bridge notebook operations for live notebook changes. Do not rewrite an open `.ipynb` file as JSON to emulate a cell edit.

The extension applies cell replacement, insertion, and deletion through VS Code notebook edit APIs. Bridge edits remain unsaved, preserve the normal dirty state, and participate in VS Code Undo. Cell replacement preserves bridge-relevant cell identity plus notebook metadata/outputs/execution summary as defined by the implementation.

The bridge does not execute cells, run a kernel, save notebooks, or expose a general command/shell channel. Do not add those behaviors in a downstream integration.

## Preserve user state and Undo

Make the smallest edit that satisfies the task and preserve unrelated live user changes.

- Do not save as part of a bridge edit unless a separate workflow explicitly requires and owns saving.
- Do not combine a successful bridge edit with a direct disk rewrite of the same open document.
- Keep bridge edits reversible through normal VS Code Undo.
- If a user edit appears between read and write, rely on freshness rejection and reconcile from a new read rather than overwriting it.

## Unavailable bridge

When live state is required and the bridge cannot perform the operation, stop at the narrow blocker and report the operator action needed:

- missing CLI → install the bridge CLI;
- no extension response → ensure the extension is installed and the target VS Code window is running;
- disabled bridge → run **VS Code Live Bridge: Enable**;
- untrusted workspace → trust the intended workspace before enabling editor operations;
- target rejected → confirm it is inside the trusted workspace or already open in the target extension host;
- ambiguous multi-window ownership → leave only the intended window enabled for that queue.

Do not substitute a potentially stale on-disk read when the task specifically requires the live unsaved buffer.
