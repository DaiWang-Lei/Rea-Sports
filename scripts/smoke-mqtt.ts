/** 连公共 MQTT 服务器，自己订阅、自己发布，测往返时间。用法：pnpm smoke:mqtt */
import WebSocket from 'ws';
import { MqttClient, PUBLIC_BROKERS } from '../src/net/MqttClient';

for (const broker of PUBLIC_BROKERS) {
  const topic = `rea-sports/smoke/${Math.random().toString(36).slice(2)}`;
  const c = new MqttClient(`rea-smoke-${Math.random().toString(36).slice(2, 8)}`, {
    brokers: [broker],
    WebSocketImpl: WebSocket as unknown as new (
      u: string,
      p?: string | string[]
    ) => globalThis.WebSocket,
  });
  const result = await new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve('超时（10 秒内没收到）'), 10000);
    let sentAt = 0;
    const t0 = performance.now();
    c.onStatus = (ok) => {
      if (!ok) return;
      c.subscribe(topic);
      setTimeout(() => {
        sentAt = performance.now();
        c.publish(topic, JSON.stringify({ hi: '你好' }));
      }, 300);
    };
    c.onMessage = (t, payload) => {
      if (t !== topic) return;
      clearTimeout(timer);
      resolve(
        `连接 ${(sentAt - t0 - 300).toFixed(0)}ms，往返 ${(performance.now() - sentAt).toFixed(0)}ms，内容 ${payload}`
      );
    };
    c.connect();
  });
  console.log(`${broker}：${result}`);
  c.close();
}
process.exit(0);
