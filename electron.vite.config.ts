import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { NodeGlobalsPolyfillPlugin } from '@esbuild-plugins/node-globals-polyfill'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({exclude: ['node-carplay']})]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    build: {
      rollupOptions: {
        input: {
          // The main Electron UI, and the standalone page served to remote
          // LAN viewers by src/main/Socket.ts (see remote-carplay.md) - both
          // get built into out/renderer/ so a single electron-vite build
          // produces everything the app needs.
          index: resolve('src/renderer/index.html'),
          remote: resolve('src/renderer/remote.html')
        }
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        stream: "stream-browserify",
        Buffer: "buffer",
      }
    },
    optimizeDeps: {
      esbuildOptions: {
        define: {
          global: 'globalThis'
        },
        plugins: [
          NodeGlobalsPolyfillPlugin({
            process: true,
            buffer: true
          })
        ]
      }
    },
    plugins: [react()]
  }
})
