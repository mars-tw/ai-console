import path from "path"
import react from "@vitejs/plugin-react"
// 從 vitest/config 取 defineConfig，不是 vite —— 這樣 test 區塊才有型別，
// tsc -b 也不會抱怨「UserConfig 上沒有 test 這個屬性」
import { defineConfig } from "vitest/config"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [inspectAttr(), react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5177',
        changeOrigin: false,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // 目前的測試都是純函式與戰鬥流程，不碰 DOM，用 node 環境最省啟動時間。
  // 之後要測元件再另外加 jsdom 的 environmentMatchGlobs，不用改這裡的預設。
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
