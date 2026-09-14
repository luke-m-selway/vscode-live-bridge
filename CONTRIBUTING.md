# Contributing

Keep changes small, generic, and consistent with the bridge's local-only safety model.

## Before changing behavior

- Read [`docs/protocol.md`](docs/protocol.md) for the request/response contract.
- Read [`.agents/skills/vscode-live-bridge/SKILL.md`](.agents/skills/vscode-live-bridge/SKILL.md) for the caller operating procedure.
- Preserve read-before-edit freshness checks, trusted-workspace targeting, normal VS Code Undo, and the absence of network/model/shell execution features.
- Do not bypass `STALE_SNAPSHOT` or add force-overwrite behavior.
- Notebook edits must use VS Code notebook APIs rather than rewriting an open `.ipynb` file as JSON.

## Development

```sh
npm install
npm test
npm run package
```

`npm run test:vscode` runs the full extension-host acceptance suite and additionally requires the VS Code Jupyter extension to be installed locally.

Do not commit generated `dist*` directories, `.vsix` packages, editor caches, local IPC state, credentials, private file paths, or real user documents. Test fixtures should remain synthetic.

If a change modifies protocol behavior, update `docs/protocol.md` in the same change. If it changes caller safety behavior, update the canonical skill as well.

## Security issues

Follow [`SECURITY.md`](SECURITY.md). Do not open a public issue containing exploit details or sensitive local data.
