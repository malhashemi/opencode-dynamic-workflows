// Directory-plugin TUI entrypoint (`<dir>/tui`), mirroring the package's `./tui` export. OpenCode resolves it by
// path for a plugin configured as a local directory. It re-exports the PRECOMPILED build: run `bun run build` first.
export { default } from "./dist/tui.js"
