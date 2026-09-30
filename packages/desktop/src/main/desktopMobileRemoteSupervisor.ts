/* eslint-disable max-lines -- 手机远控的拉起/守护/回收与配对信息解析属于同一个桌面主进程托管边界，拆开反而打散状态机。 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { ISettingService } from "@zcode/services";

/**
 * ZCodium 自用版增强功能：手机远控托管（custom 分支）。
 *
 * 职责：跟随 setting.json 的 `mobileRemoteControl` 期望态，拉起并守护桥子进程
 * （zcodium-mobile-bridge），退出/关开关/改配置时整体回收。同进程直连改造
 * （2026-09-30）后不再拉起独立 `zcode --web` 后端——手机数据面由桌面 host 内的
 * mobileRpcBridgeServer 承载（见 host/index.ts syncMobileRpcBridge）。
 * 子进程用 Electron 自带 Node 运行时（ELECTRON_RUN_AS_NODE=1）执行，不依赖系统安装 node。
 * 轮询 settingService.get()（每次读盘）作为唯一触发源，渲染层保存设置最迟 5 秒生效。
 */

/** 桥默认端口；桌面 host RPC 桥服务端口见 host/mobileRpcBridgeServer（4311，与桥 desktopUrl 对齐）。 */
const DEFAULT_BRIDGE_PORT = 4310;
const MOBILE_RPC_URL = "ws://127.0.0.1:4311/mobile-rpc";
const SYNC_INTERVAL_MS = 5_000;
const RESTART_BACKOFF_MS = 5_000;

interface MobileRemoteSupervisorDeps {
  settingService: ISettingService;
  logger: {
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
  };
}

export interface MobileRemoteSupervisorHandle {
  /** 强制一次同步（设置保存后可调用；轮询本身也会兜底）。 */
  sync(): void;
  /** app 退出前回收桥进程树（数据面在 host 内，随 host 自身回收）。 */
  dispose(): Promise<void>;
}

interface TunnelDesiredState {
  domain: string;
  subdomainId: number;
  dnsheKey: string;
  dnsheSecret: string;
  cloudflaredPath: string;
  token: string;
}

interface DesiredState {
  token: string;
  port: number;
  workspacePath: string;
  tunnel: TunnelDesiredState | null;
}

function resolveBridgeScriptPath(): string | null {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "mobile-bridge", "zcodium-mobile-bridge.mjs")]
    : [path.resolve(import.meta.dirname, "../../../../bridge/zcodium-mobile-bridge.mjs")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function startMobileRemoteSupervisor(deps: MobileRemoteSupervisorDeps): MobileRemoteSupervisorHandle {
  let disposed = false;
  let syncing = false;
  let bridgeChild: ChildProcess | null = null;
  let lastDesiredKey = "";
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  const stopChild = (child: ChildProcess | null): void => {
    if (!child) return;
    // 主动回收：先摘掉 exit/error 监听，避免被当成崩溃自愈重新拉起。
    child.removeAllListeners("exit");
    child.removeAllListeners("error");
    try {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        if (process.platform === "win32") {
          // 后端进程树挂着 agent 子进程；只 kill 直系会留下残留进程树。
          const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
          killer.unref();
        } else {
          child.kill("SIGTERM");
        }
      }
    } catch (error) {
      deps.logger.warn("[mobile-remote] stop child failed:", error);
    }
  };

  const stopAll = (): void => {
    stopChild(bridgeChild);
    bridgeChild = null;
  };

  const scheduleSync = (): void => {
    if (disposed || restartTimer) return;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      handle.sync();
    }, RESTART_BACKOFF_MS);
    restartTimer.unref?.();
  };

  const spawnNode = (
    label: "bridge",
    script: string,
    args: string[],
    extraEnv: Record<string, string | undefined>,
  ): ChildProcess | null => {
    try {
      const child = spawn(process.execPath, [script, ...args], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...extraEnv },
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("exit", (code) => {
        deps.logger.info(`[mobile-remote] ${label} exited code=${code ?? "null"}`);
        bridgeChild = null;
        if (!disposed) scheduleSync();
      });
      child.once("error", (error) => {
        deps.logger.warn(`[mobile-remote] ${label} spawn error:`, error);
        bridgeChild = null;
        if (!disposed) scheduleSync();
      });
      deps.logger.info(`[mobile-remote] ${label} started pid=${child.pid ?? "?"}`);
      return child;
    } catch (error) {
      deps.logger.error(`[mobile-remote] failed to spawn ${label}:`, error);
      return null;
    }
  };

  const readDesired = async (): Promise<DesiredState | null> => {
    const settings = await deps.settingService.get();
    const m = settings.mobileRemoteControl;
    if (!m?.enabled) return null;
    const token = m.token?.trim();
    if (!token) return null; // UI 首开还没生成 token：不启动
    return {
      token,
      port: m.port && m.port > 0 ? m.port : DEFAULT_BRIDGE_PORT,
      workspacePath: m.workspacePath?.trim() ?? "",
      tunnel:
        m.tunnel?.enabled === true
          ? {
              domain: m.tunnel.domain?.trim() ?? "",
              subdomainId: m.tunnel.subdomainId ?? 0,
              dnsheKey: m.tunnel.dnsheKey?.trim() ?? "",
              dnsheSecret: m.tunnel.dnsheSecret?.trim() ?? "",
              cloudflaredPath: m.tunnel.cloudflaredPath?.trim() ?? "",
              token: m.tunnel.token?.trim() ?? "",
            }
          : null,
    };
  };

  const handle: MobileRemoteSupervisorHandle = {
    sync(): void {
      if (disposed || syncing) return;
      syncing = true;
      void (async () => {
        try {
          const desired = await readDesired();
          if (!desired) {
            if (bridgeChild) {
              deps.logger.info("[mobile-remote] disabled: reclaiming children");
              stopAll();
            }
            lastDesiredKey = "";
            return;
          }
          if (!desired.workspacePath || !existsSync(desired.workspacePath)) {
            deps.logger.warn(
              "[mobile-remote] enabled but workspace missing; waiting for settings",
            );
            stopAll();
            return;
          }
          const bridgeScript = resolveBridgeScriptPath();
          if (!bridgeScript) {
            deps.logger.warn("[mobile-remote] bundled bridge script missing");
            stopAll();
            return;
          }
          const tunnelKey = desired.tunnel
            ? `${desired.tunnel.domain}|${desired.tunnel.subdomainId}|${desired.tunnel.dnsheKey ? "k" : ""}${desired.tunnel.dnsheSecret ? "s" : ""}|${desired.tunnel.cloudflaredPath}`
            : "off";
          const key = `${desired.token}|${desired.port}|${desired.workspacePath}|${tunnelKey}`;
          if (key !== lastDesiredKey) {
            if (lastDesiredKey !== "") {
              // 配置变更（含换令牌/端口/工作区）整体重建，避免桥与旧参数不一致。
              stopAll();
            }
            lastDesiredKey = key;
          }
          if (!bridgeChild) {
            bridgeChild = spawnNode("bridge", bridgeScript, [], {
              BRIDGE_TOKEN: desired.token,
              // r6：统一走公网隧道，桥只监听本机回环（不再对局域网开放、无需防火墙放行）。
              BRIDGE_HOST: "127.0.0.1",
              BRIDGE_PORT: String(desired.port),
              BRIDGE_WORKSPACE: desired.workspacePath,
              // 同进程直连改造：数据面=桌面 host 内的手机 RPC 桥（token 与配对令牌同源）。
              BRIDGE_DESKTOP_URL: MOBILE_RPC_URL,
              BRIDGE_DESKTOP_TOKEN: desired.token,
              ...(desired.tunnel
                ? {
                    BRIDGE_TUNNEL: "1",
                    BRIDGE_TUNNEL_DOMAIN: desired.tunnel.domain,
                    BRIDGE_TUNNEL_SUBDOMAIN_ID: String(desired.tunnel.subdomainId),
                    BRIDGE_DNSHE_KEY: desired.tunnel.dnsheKey,
                    BRIDGE_DNSHE_SECRET: desired.tunnel.dnsheSecret,
                    BRIDGE_CLOUDFLARED: desired.tunnel.cloudflaredPath,
                    BRIDGE_TUNNEL_TOKEN: desired.tunnel.token,
                  }
                : {}),
            });
          }
        } catch (error) {
          deps.logger.warn("[mobile-remote] sync failed:", error);
        } finally {
          syncing = false;
        }
      })();
    },

    async dispose(): Promise<void> {
      disposed = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      stopAll();
      // 给 taskkill 一个极短的落定窗口；不阻塞退出预算。
      await new Promise((resolve) => setTimeout(resolve, 200));
    },
  };

  const timer = setInterval(() => handle.sync(), SYNC_INTERVAL_MS);
  timer.unref?.();
  handle.sync();
  return handle;
}
