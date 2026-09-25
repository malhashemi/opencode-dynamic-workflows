import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

// The Gateway serves `packages/plugin/dist/web` (see `defaultWebDir()` in the plugin's gateway). Assets are
// content-hashed, so the Gateway can cache them forever; only index.html is `no-store`.
//
// `vite dev` proxies `/v1` to a running Gateway (WF_GATEWAY, default http://127.0.0.1:4320). The Gateway checks
// Host and Origin, so the proxy rewrites both to the Gateway's own.
const gateway = process.env.WF_GATEWAY ?? "http://127.0.0.1:4320"

export default defineConfig({
  base: "/",
  plugins: [solid()],
  server: {
    fs: { allow: ["../.."] },
    proxy: {
      "/v1": {
        target: gateway,
        changeOrigin: true,
        headers: { origin: gateway },
      },
    },
  },
  build: {
    outDir: "../plugin/dist/web",
    emptyOutDir: true,
    target: "es2022",
    modulePreload: { polyfill: false },
  },
})
