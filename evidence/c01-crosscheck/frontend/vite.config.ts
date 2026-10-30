import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // 固定本地开发地址：http://127.0.0.1:5173
    //
    // - host 显式写 127.0.0.1，避免只监听 IPv6 的 [::1] 导致 127.0.0.1 打不开；
    // - strictPort 让端口被占用时直接报错，而不是悄悄换到 5174——
    //   后端 CORS 只放开了 5173 这两个来源，换端口会静默失效。
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
})
