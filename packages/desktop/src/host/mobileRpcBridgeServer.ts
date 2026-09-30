// ZCodium 自用版（custom 分支）：手机远控的本地 RPC 桥服务（host 进程内）。
//
// 职责边界：把手机远控页面所需的通道方法（call）与事件订阅（listen/unlisten）经
// 127.0.0.1 WebSocket 暴露给自建桥（zcodium-mobile-bridge.mjs），使手机数据面与
// 桌面 UI 复用**同一批 host 服务实例**——一本账、一份事件源，替代原「独立
// `zcode --web` 后端 + 第二个 Agent」的跨进程链路（转圈/会话空白/新会话不显示的
// 共同根因）。本文件只做鉴权、通道映射与序列化，零业务逻辑。
//
// 安全模型：token 是唯一边界，与配对令牌同源（Bearer 头 + timingSafeEqual）；
// 仅监听回环地址；方法面限于「服务实例 prototype 上可枚举的函数属性」。
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  ServiceCollection,
  IBroadcastService,
  IBotsService,
  IClientScenesService,
  ICodingPlanSubscriptionService,
  ICredentialService,
  IGitService,
  IModelSelectionService,
  IProviderSettingsService,
  ISettingService,
  ISettingsSyncService,
  ISubagentsService,
  ISystemService,
  IWindowControllerService,
  IZCodeAgentService,
  IZCodeSessionService,
  IZCodeTaskService,
} from "@zcode/services";

/** 手机 RPC 桥的固定回环端口（与桥配置 BRIDGE_DESKTOP_URL 同步）。 */
export const MOBILE_RPC_DEFAULT_PORT = 4311;
export const MOBILE_RPC_PATH = "/mobile-rpc";
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

interface MobileRpcDisposable {
  dispose(): void;
}

export interface MobileRpcBridgeOptions {
  services: ServiceCollection;
  /** 与 setting.json `mobileRemoteControl.token` 同值的配对令牌。 */
  token: string;
  logger: {
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
  };
  port?: number;
}

export interface MobileRpcBridgeHandle {
  readonly port: number;
  close(): Promise<void>;
}

type RpcRequestFrame =
  | { t: "call"; id: number; ch: string; me: string; args?: unknown[] }
  | { t: "listen"; id: number; ch: string; me: string; args?: unknown[]; mode?: "curried" | "direct" }
  | { t: "unlisten"; id: number };

function serializeJson(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => {
      if (Buffer.isBuffer(item) || item instanceof Uint8Array) {
        return { __b64: Buffer.from(item).toString("base64") };
      }
      return item;
    }),
  );
}

function reviveJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reviveJson);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.__b64 === "string" && Object.keys(record).length === 1) {
      return Buffer.from(record.__b64, "base64");
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) out[key] = reviveJson(item);
    return out;
  }
  return value;
}

/** 方法面守卫：只接受 prototype 链（Object.prototype 之前）上的函数属性。 */
function resolveMethod(service: object, me: string): ((...args: unknown[]) => unknown) | undefined {
  if (me === "constructor" || me === "prototype" || me === "__proto__") return undefined;
  let cursor: object | null = service;
  while (cursor && cursor !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, me);
    if (descriptor) {
      if (descriptor.get) return undefined; // getter 有副作用风险，一律拒绝
      const value = descriptor.value;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown) : undefined;
    }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  return undefined;
}

export function startMobileRpcBridge(options: MobileRpcBridgeOptions): Promise<MobileRpcBridgeHandle> {
  const { services, token, logger } = options;
  const port = options.port ?? MOBILE_RPC_DEFAULT_PORT;

  const resolveChannel = (ch: string): object | undefined => {
    switch (ch) {
      case "zcode-agent":
        return services.getOptional(IZCodeAgentService) as object | undefined;
      case "zcode-task":
        return services.getOptional(IZCodeTaskService) as object | undefined;
      case "zcode-session":
        return services.getOptional(IZCodeSessionService) as object | undefined;
      case "window-controller":
        return services.getOptional(IWindowControllerService) as object | undefined;
      case "setting":
        return services.getOptional(ISettingService) as object | undefined;
      case "model-selection":
        return services.getOptional(IModelSelectionService) as object | undefined;
      case "provider-settings":
        return services.getOptional(IProviderSettingsService) as object | undefined;
      case "coding-plan-subscription":
        return services.getOptional(ICodingPlanSubscriptionService) as object | undefined;
      case "credential":
        return services.getOptional(ICredentialService) as object | undefined;
      case "broadcast":
        return services.getOptional(IBroadcastService) as object | undefined;
      case "git":
        return services.getOptional(IGitService) as object | undefined;
      case "settings-sync":
        return services.getOptional(ISettingsSyncService) as object | undefined;
      case "system":
        return services.getOptional(ISystemService) as object | undefined;
      case "subagents":
        return services.getOptional(ISubagentsService) as object | undefined;
      case "client-scenes":
        return services.getOptional(IClientScenesService) as object | undefined;
      case "bots":
        return services.getOptional(IBotsService) as object | undefined;
      default:
        return undefined;
    }
  };

  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end("not found");
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "", "http://127.0.0.1");
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== MOBILE_RPC_PATH) {
      socket.destroy();
      return;
    }
    const expected = Buffer.from(`Bearer ${token}`);
    const given = Buffer.from(req.headers.authorization ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket) => {
    ws.binaryType = "arraybuffer";
    const listens = new Map<number, MobileRpcDisposable>();
    const send = (frame: Record<string, unknown>) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify(frame));
      } catch (error) {
        logger.warn("[mobile-rpc] send failed:", error);
      }
    };

    ws.on("message", async (raw) => {
      let frame: RpcRequestFrame;
      try {
        frame = JSON.parse(String(raw)) as RpcRequestFrame;
      } catch {
        return;
      }
      if (!frame || typeof frame !== "object" || typeof (frame as { t?: unknown }).t !== "string") return;

      if (frame.t === "unlisten") {
        listens.get(frame.id)?.dispose();
        listens.delete(frame.id);
        return;
      }

      const service = resolveChannel(frame.ch);
      if (!service) {
        // unknown-channel 与旧链路（后端无此通道）行为一致：错误帧，页面自行兜底。
        send({ t: "err", id: frame.id, msg: `unknown-channel:${frame.ch}` });
        return;
      }
      const fn = resolveMethod(service, frame.me);
      if (!fn) {
        send({ t: "err", id: frame.id, msg: `no-such-method:${frame.ch}.${frame.me}` });
        return;
      }
      const args = (frame.args === undefined ? [] : (reviveJson(frame.args) as unknown[])) ?? [];

      try {
        if (frame.t === "call") {
          const data = await fn.apply(service, args);
          send({ t: "res", id: frame.id, ok: true, data: serializeJson(data ?? null) });
          return;
        }
        // listen：direct=首参即 listener；curried=先喂 args 再得 Event。
        const listener = (event: unknown) => send({ t: "evt", listenId: frame.id, data: serializeJson(event ?? null) });
        const disposable: MobileRpcDisposable | undefined =
          frame.mode === "direct"
            ? ((fn.call(service, listener) as MobileRpcDisposable | undefined) ?? undefined)
            : (() => {
                const factory = fn.apply(service, args) as unknown;
                if (typeof factory !== "function") {
                  throw new Error(`not-a-curried-event-factory:${frame.ch}.${frame.me}`);
                }
                return (factory as (l: unknown) => MobileRpcDisposable)(listener);
              })();
        if (!disposable || typeof disposable.dispose !== "function") {
          send({ t: "err", id: frame.id, msg: `bad-listener-registration:${frame.ch}.${frame.me}` });
          return;
        }
        listens.set(frame.id, disposable);
        send({ t: "res", id: frame.id, ok: true, data: null });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        send({ t: "err", id: frame.id, msg: msg.slice(0, 300) });
      }
    });

    ws.on("close", () => {
      for (const disposable of listens.values()) {
        try {
          disposable.dispose();
        } catch {
          // 释放失败不追溯
        }
      }
      listens.clear();
    });
  });

  return new Promise((resolve) => {
    server.once("error", (error) => {
      logger.warn(`[mobile-rpc] listen ${port} failed:`, error);
      resolve({
        port: 0,
        async close() {
          wss.close();
        },
      });
    });
    server.listen(port, "127.0.0.1", () => {
      logger.info(`[mobile-rpc] listening on 127.0.0.1:${port}${MOBILE_RPC_PATH}`);
      resolve({
        port,
        async close() {
          for (const client of wss.clients) client.terminate();
          await new Promise<void>((done) => wss.close(() => done()));
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}
