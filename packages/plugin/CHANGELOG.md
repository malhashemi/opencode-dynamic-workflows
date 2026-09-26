# Changelog

## [0.1.0](https://github.com/malhashemi/opencode-dynamic-workflows/compare/v0.1.0...v0.1.0) (2026-09-26)


### Bug fixes

* a live Run owner is not mistaken for a gone one on Linux VMs ([6101590](https://github.com/malhashemi/opencode-dynamic-workflows/commit/61015908a313a994ca53d3cd917dc9e437f2e303))

## 0.1.0 (2026-09-26)


### Features

* 5 Units per Run and 5 Runs at once by default ([1b692f6](https://github.com/malhashemi/opencode-dynamic-workflows/commit/1b692f67c6d3504f3ea1ca88228933573fb27969))
* background notifications, cross-Run limits, nested Workflows, worktree isolation, transcripts ([9612afe](https://github.com/malhashemi/opencode-dynamic-workflows/commit/9612afe77a47b696d7c41a664d553172ce4fafc3))
* port the engine to OpenCode V2 (protocol v1, service, RPC, gateway) ([9f133ea](https://github.com/malhashemi/opencode-dynamic-workflows/commit/9f133eae123d533fd142dbbc022bdf4a83f3f050))
* run defaulted-args Workflows with no args; dogfooding guide ([6764027](https://github.com/malhashemi/opencode-dynamic-workflows/commit/676402709a97c60094d6063c98b8411b91acfcfb))
* script capabilities, protocol docs and examples ([f1a8e9c](https://github.com/malhashemi/opencode-dynamic-workflows/commit/f1a8e9cc75d15bf9ee5130e0f064b438aebfe0e0))
* ship the dynamic-workflows authoring skill; shorter tool descriptions ([0f2c748](https://github.com/malhashemi/opencode-dynamic-workflows/commit/0f2c74894363b0e2f2c74ef85874594b46ee9953))
* **tui:** the workflows TUI plugin, packaging and acceptance ([45aae3e](https://github.com/malhashemi/opencode-dynamic-workflows/commit/45aae3e5409566de401f9a2117a02b53f534caf0))
* **web:** the workflows web app, served by the gateway ([6a1301b](https://github.com/malhashemi/opencode-dynamic-workflows/commit/6a1301baf5123a73b6985a5ae8f8bcd5e9e9b9b2))


### Bug fixes

* ctx.$ stops the whole command on Linux and Windows; check out text with LF ([8042aeb](https://github.com/malhashemi/opencode-dynamic-workflows/commit/8042aeb31bac089e36f09c756626e1c00b7c65d4))
* **engine:** close the engine-audit findings ([6881cec](https://github.com/malhashemi/opencode-dynamic-workflows/commit/6881cec2cc062d68f2167f65286750a43c41b885))
* **engine:** close the fifth engine-audit round ([ba50e51](https://github.com/malhashemi/opencode-dynamic-workflows/commit/ba50e5136a793b38082f4e44c8be983ab9de873b))
* **engine:** close the fourth engine-audit round ([1a21022](https://github.com/malhashemi/opencode-dynamic-workflows/commit/1a21022a893360903e91672e45db2b297923024b))
* **engine:** close the second engine-audit round ([e2ee145](https://github.com/malhashemi/opencode-dynamic-workflows/commit/e2ee1457ed37f2f185fb560fe2726c7ce639596a))
* **engine:** close the third engine-audit round ([f40dee1](https://github.com/malhashemi/opencode-dynamic-workflows/commit/f40dee1c8034de2fe6b9979da786a3373b91856b))
* **engine:** verify interactions, stop/resume and restart live on V2 ([24837bc](https://github.com/malhashemi/opencode-dynamic-workflows/commit/24837bcdb3aaa7628b98f1e0b767853d4b0fcb3a))
* workflow paths and the bundled authoring import use / on every platform ([45ba1b9](https://github.com/malhashemi/opencode-dynamic-workflows/commit/45ba1b9d0694105f5684e92cd402fd18860f0d5a))


### Build

* publish as @malhashemi/opencode-dynamic-workflows; run capabilities on Windows ([f9207a3](https://github.com/malhashemi/opencode-dynamic-workflows/commit/f9207a395d0f2c2d9438beb962dadf5ec0affd9e))
* release setup; drop V1 compatibility; fix the minified TUI crash ([653996a](https://github.com/malhashemi/opencode-dynamic-workflows/commit/653996a5e4e0df0be422dc4c7f0774c87b720910))
