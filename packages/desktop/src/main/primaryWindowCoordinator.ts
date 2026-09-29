import type { StartupWindowBootstrap } from "./startupWorkspace.js";

interface WindowLike {
  destroy?(): void;
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized?(): boolean;
  isRendererCrashed?(): boolean;
  webContents?: {
    isCrashed?: () => boolean;
  };
  restore?(): void;
  show(): void;
  focus?(): void;
}

interface PrimaryWindowCoordinatorDeps {
  listWindows(): WindowLike[];
  resolveStartupWindowBootstrap(): Promise<StartupWindowBootstrap>;
  createWindow(startupBootstrap: StartupWindowBootstrap): void;
  canCreateWindow?: (reason: string) => boolean;
  logger: {
    info(message: string): void;
  };
}

export function createPrimaryWindowCoordinator(deps: PrimaryWindowCoordinatorDeps) {
  let pendingEnsurePromise: Promise<void> | null = null;

  function isRendererCrashed(window: WindowLike): boolean {
    return Boolean(window.isRendererCrashed?.() || window.webContents?.isCrashed?.());
  }

  function revealExistingWindow(): boolean {
    for (const existingWindow of deps.listWindows()) {
      if (existingWindow.isDestroyed()) {
        continue;
      }

      if (isRendererCrashed(existingWindow)) {
        // renderer native crash 后 BrowserWindow 仍可能存活；继续复用会让 macOS 激活时只显示白屏空壳。
        existingWindow.destroy?.();
        deps.logger.info("[primary-window] discarded crashed renderer window");
        continue;
      }

      /*
       * 用户要求（2026-09-30）：任何外部触发都不得把 ZCodium 窗口自动带到前台。
       * 实测根因链：手机打开会话 → 代理下发 desktop-command（打开工作区）→ 渲染层请求
       * ActivateOrSetWorkspace，以及深链路径 ensurePrimaryWindow("open-url-workspace") 走到这里
       * restore/show/focus，把正在用别的软件的用户反复强制切回。
       * 因此此处**只复用窗口、不激活**；"双击桌面图标把窗口带到最前"由 second-instance 处理器里
       * 的另一段内联激活负责（无路径的纯启动才会走到那里），notification/tray 等用户主动操作也不受影响。
       */
      return true;
    }

    return false;
  }

  async function ensurePrimaryWindow(reason: string) {
    if (deps.canCreateWindow && !deps.canCreateWindow(reason)) {
      // 强制升级是进程级 gate，activate/dock/tray/open-url 等入口也必须共享同一阻断边界。
      deps.logger.info(`[primary-window] window creation blocked (${reason})`);
      return;
    }

    if (revealExistingWindow()) {
      deps.logger.info(`[primary-window] reused existing window (${reason})`);
      return;
    }

    if (pendingEnsurePromise) {
      deps.logger.info(`[primary-window] window creation already pending (${reason})`);
      return pendingEnsurePromise;
    }

    // macOS 上应用冷启动时，app.activate 可能和启动阶段异步并发到达。
    // 如果 ready 和 activate 都各自 resolveStartupWindowBootstrap 后直接 createWindow，
    // 最新版首次启动就可能并发创建两个主窗口。这里用单飞 promise 收敛成一次创建。
    deps.logger.info(`[primary-window] creating main window (${reason})`);
    pendingEnsurePromise = deps
      .resolveStartupWindowBootstrap()
      .then((startupBootstrap) => {
        if (revealExistingWindow()) {
          deps.logger.info(`[primary-window] window became available before create (${reason})`);
          return;
        }

        deps.createWindow(startupBootstrap);
      })
      .finally(() => {
        pendingEnsurePromise = null;
      });

    return pendingEnsurePromise;
  }

  return {
    ensurePrimaryWindow,
  };
}
