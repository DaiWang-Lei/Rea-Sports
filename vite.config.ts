import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@': r('./src') },
  },
  // 固定端口：WebHID 授权按 origin 记忆，端口变了就要重新授权
  server: { port: 5288, strictPort: true },
  preview: { port: 5288, strictPort: true },
  build: {
    target: 'es2022',
    // three.js 本身就有 ~600KB，本地应用不需要拆包
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        main: r('./index.html'),
        imu: r('./imu-debug.html'),
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
