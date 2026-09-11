/**
 * Entry point: mount the app. Everything interesting — the token handoff, the connection, the panes — lives in
 * `app.tsx`; this file exists so `index.html` has one module to load.
 */
import { render } from "solid-js/web"
import App from "./app"
import "./theme.css"

const root = document.getElementById("root")
if (root) render(() => <App />, root)
