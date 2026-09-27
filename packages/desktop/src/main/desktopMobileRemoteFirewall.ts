import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ipcMain } from "electron";
import { PlatformChannels } from "@zcode/shared";

/**
 * ZCodium 自用版（custom 分支）：手机远控的 Windows 防火墙放行。
 *
 * 手机不在本机回环上，必须让 Windows 防火墙放行远控端口（默认专用/域网络）。
 * 本模块只负责"查询状态"和"请求放行"两件事：
 *  - 已放行 → 直接返回，不动系统；
 *  - 未放行 → 通过 PowerShell `Start-Process -Verb RunAs` 触发系统提权确认，
 *    用户点"是"后由 netsh 写入放行规则，再复查状态回报给界面。
 * 规则名固定为 `ZCodium Mobile Remote (TCP <port>)`，便于以后换端口时并存/清理。
 */

const execFileAsync = promisify(execFile);

export function mobileRemoteFirewallRuleName(port: number): string {
  return `ZCodium Mobile Remote (TCP ${port})`;
}

export interface MobileRemoteFirewallStatus {
  supported: boolean;
  allowed: boolean;
}

export async function getMobileRemoteFirewallStatus(
  port: number,
): Promise<MobileRemoteFirewallStatus> {
  if (process.platform !== "win32" || !Number.isInteger(port) || port <= 0) {
    return { supported: false, allowed: true };
  }
  try {
    // 规则存在且可读时 netsh 退出码为 0；不存在时以非 0 退出（多语言环境无需解析文案）。
    await execFileAsync(
      "netsh",
      ["advfirewall", "firewall", "show", "rule", `name=${mobileRemoteFirewallRuleName(port)}`],
      { windowsHide: true, timeout: 15_000 },
    );
    return { supported: true, allowed: true };
  } catch {
    return { supported: true, allowed: false };
  }
}

export interface EnsureMobileRemoteFirewallResult extends MobileRemoteFirewallStatus {
  error?: string;
}

export async function ensureMobileRemoteFirewallRule(
  port: number,
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
): Promise<EnsureMobileRemoteFirewallResult> {
  const current = await getMobileRemoteFirewallStatus(port);
  if (!current.supported || current.allowed) return current;

  const ruleName = mobileRemoteFirewallRuleName(port);
  const netshArgs = [
    "advfirewall",
    "firewall",
    "add",
    "rule",
    `name=${ruleName}`,
    "dir=in",
    "action=allow",
    "protocol=TCP",
    `localport=${port}`,
    "profile=private,domain",
  ].join(" ");
  // netsh 参数整体作为单引号字符串传给 ArgumentList；内含的双引号原样保留给 netsh。
  const command = `Start-Process -FilePath 'netsh.exe' -ArgumentList '${netshArgs.replace(/'/g, "''")}' -Verb RunAs -Wait -WindowStyle Hidden`;
  try {
    logger.info(`[mobile-remote] requesting firewall rule for port ${port}`);
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", command],
      { windowsHide: true, timeout: 120_000 },
    );
  } catch (error) {
    logger.warn("[mobile-remote] firewall elevation failed or was cancelled:", error);
  }
  const after = await getMobileRemoteFirewallStatus(port);
  return after.allowed
    ? after
    : { ...after, error: "firewall_rule_not_applied" };
}

export function registerMobileRemoteFirewallIpcHandlers(logger: {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}): void {
  ipcMain.handle(PlatformChannels.GetMobileRemoteFirewallStatus, (_event, port: unknown) => {
    if (typeof port !== "number") return { supported: false, allowed: false };
    return getMobileRemoteFirewallStatus(port);
  });
  ipcMain.handle(PlatformChannels.EnsureMobileRemoteFirewallRule, (_event, port: unknown) => {
    if (typeof port !== "number") return { supported: false, allowed: false };
    return ensureMobileRemoteFirewallRule(port, logger);
  });
}
