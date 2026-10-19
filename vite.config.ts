import { fileURLToPath } from 'node:url';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vitest/config';
import { motionRelay } from './server/motionRelay';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // https：手机浏览器只有在安全连接下才给体感数据（自签名证书，第一次打开要点「继续访问」）
  // motionRelay：手机 → 电脑的体感数据中转
  plugins: [basicSsl({ name: 'rea-sports' }), motionRelay()],
  resolve: {
    alias: { '@': r('./src') },
  },
  // 固定端口：WebHID 授权按网址记忆，端口变了就要重新授权；host: true 让同一 Wi-Fi 下的手机能访问
  server: { port: 5288, strictPort: true, host: true },
  preview: { port: 5288, strictPort: true, host: true },
  build: {
    target: 'es2022',
    // three.js 本身就有 ~600KB，本地应用不需要拆包
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        main: r('./index.html'),
        imu: r('./imu-debug.html'),
        phone: r('./phone.html'),
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
