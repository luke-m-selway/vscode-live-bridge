---
name: vscode-live-bridge
description: Safely inspect, edit, explicitly execute notebook cells, and explicitly save live VS Code buffers through the vscode-live-bridge CLI using freshness snapshots and conflict-aware retries.
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

## Read before state-changing actions

Always obtain a fresh live snapshot before constructing an edit, executing a cell, or saving a notebook.

- For text, use `read` and retain the returned document `version` and `hash`.
- For notebooks, use `read-notebook` and identify the target by the returned session-stable `cellId`, not by index alone. When existing rendered/executed output matters, use `read-notebook --include-outputs`; this reads live VS Code output state and never executes cells. If `outputRead.truncated` is true, treat the output read as incomplete rather than inferring that omitted output is absent.
- Treat snapshot values as the basis for one edit decision. For notebook `replace-cell`, `insert-cell`, and `delete-cell`, a successful response contains a stabilized post-edit snapshot that may be used directly for the immediate next chained notebook edit if the intended change is still valid. Reread whenever time/user activity intervenes or the next decision needs semantic reconciliation beyond that returned snapshot.
- Notebook cell IDs are only stable for the current open VS Code session. Never persist them as durable notebook identifiers or assume they survive reload/reopen.

## Freshness requirements

Every write must carry the snapshot expectations required by the protocol.

- Text replacement requires the document version and document hash from the preceding live read.
- Notebook cell replacement requires the notebook version, target cell ID, target cell hash, and target cell document version.
- Notebook insertion or deletion requires the notebook version plus the reference/target cell ID and cell hash.
- Notebook cell execution requires the notebook version, target cell ID, target cell hash, and target cell document version.
- Notebook save requires the notebook version from the live snapshot that the caller intends to persist.

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

The extension applies cell replacement, insertion, and deletion through VS Code notebook edit APIs. Bridge edits remain unsaved, preserve the normal dirty state, and participate in VS Code Undo. Cell replacement preserves bridge-relevant cell identity plus notebook metadata/outputs/execution summary as defined by the implementation. After each successful notebook mutation, the bridge waits briefly for provider-driven version changes to quiesce before returning its post-edit snapshot.

Cell execution and notebook save are explicit bridge operations, never implicit side effects of reads or edits. `execute-cell` is scoped to Microsoft Jupyter notebooks: it runs only the identified fresh code cell after confirming Jupyter already has a selected Python environment or live kernel, and must not be used as a substitute general shell channel; it does not save. If the bridge reports `NO_SELECTED_JUPYTER_KERNEL`, select the intended kernel in VS Code/Jupyter and reread before retrying. `save-notebook` saves only the identified fresh notebook through VS Code and never performs Save All. The bridge never opens the kernel picker or chooses a kernel for the caller.

Treat notebook code execution as real code execution: use it only when running that live cell is within the task's authority. After `execute-cell`, inspect the returned/live outputs before making dependent decisions. On `EXECUTION_TIMEOUT`, do not blindly retry; reread the notebook/output state first because the timeout does not prove kernel-side work was cancelled.

## Preserve user state and Undo

Make the smallest edit that satisfies the task and preserve unrelated live user changes.

- Do not save as part of a bridge edit or execution. Use `save-notebook` only as a separate deliberate step after the intended live state is ready to persist.
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