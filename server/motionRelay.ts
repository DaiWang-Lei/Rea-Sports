/**
 * 开发服务器插件：手机体感数据的 WebSocket 中转 + 局域网地址查询。
 *
 *  - wss://<主机>/motion?role=phone&id=…&name=…   手机连上来，发 imu / btn / meta 等消息
 *  - wss://<主机>/motion?role=game                 游戏页 / 调试页连上来，收所有手机的消息
 *  - GET /api/lan                                  返回本机局域网 IPv4 地址，用来生成二维码
 *
 * 消息都是 JSON。手机 → 游戏：服务器加上 from（手机 id）原样转发；
 * 游戏 → 手机：{ type: 'to-phone', id, msg }，服务器把 msg 转给对应手机。
 */
import os from 'node:os';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Plugin } from 'vite';
import { type RawData, WebSocket, WebSocketServer } from 'ws';

interface PhoneConn {
  ws: WebSocket;
  id: string;
  name: string;
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  // 家用网络常见网段排前面
  const rank = (ip: string) =>
    ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3;
  return out.sort((x, y) => rank(x) - rank(y));
}

function attachRelay(httpServer: {
  on(event: 'upgrade', cb: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
}): void {
  const wss = new WebSocketServer({ noServer: true });
  const games = new Set<WebSocket>();
  const phones = new Map<string, PhoneConn>();

  const toGames = (msg: object) => {
    const text = JSON.stringify(msg);
    for (const g of games) if (g.readyState === WebSocket.OPEN) g.send(text);
  };

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/motion') return; // 其他（如 Vite 热更新）不管
    wss.handleUpgrade(req, socket, head, (ws) => {
      const role = url.searchParams.get('role');
      if (role === 'game') {
        games.add(ws);
        ws.send(
          JSON.stringify({
            type: 'phones',
            list: [...phones.values()].map((p) => ({ id: p.id, name: p.name })),
          })
        );
        ws.on('message', (data: RawData) => {
          let msg: { type?: string; id?: string; msg?: unknown };
          try {
            msg = JSON.parse(data.toString());
          } catch {
            return;
          }
          if (msg.type === 'to-phone' && msg.id) {
            const p = phones.get(msg.id);
            if (p && p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify(msg.msg));
          }
        });
        ws.on('close', () => games.delete(ws));
      } else if (role === 'phone') {
        const id = url.searchParams.get('id') || Math.random().toString(36).slice(2, 10);
        const name = (url.searchParams.get('name') || '手机').slice(0, 40);
        phones.get(id)?.ws.close();
        phones.set(id, { ws, id, name });
        toGames({ type: 'phone-on', id, name });
        ws.on('message', (data: RawData) => {
          // 原样转发，加上来源；为了省事直接拼字符串，避免每个样本都 parse 再 stringify
          const text = data.toString();
          if (!text.startsWith('{')) return;
          const forwarded = `{"from":${JSON.stringify(id)},${text.slice(1)}`;
          for (const g of games) if (g.readyState === WebSocket.OPEN) g.send(forwarded);
        });
        ws.on('close', () => {
          if (phones.get(id)?.ws === ws) {
            phones.delete(id);
            toGames({ type: 'phone-off', id });
          }
        });
      } else {
        ws.close();
      }
    });
  });
}

export function motionRelay(): Plugin {
  const lanHandler = (
    port: number | undefined,
    https: boolean
  ): ((req: IncomingMessage, res: import('node:http').ServerResponse) => void) => {
    return (_req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ addresses: lanAddresses(), port, https }));
    };
  };
  return {
    name: 'rea-motion-relay',
    configureServer(server) {
      if (server.httpServer) attachRelay(server.httpServer);
      server.middlewares.use(
        '/api/lan',
        lanHandler(server.config.server.port, !!server.config.server.https)
      );
    },
    configurePreviewServer(server) {
      attachRelay(server.httpServer);
      server.middlewares.use(
        '/api/lan',
        lanHandler(server.config.preview.port, !!server.config.preview.https)
      );
    },
  };
}
