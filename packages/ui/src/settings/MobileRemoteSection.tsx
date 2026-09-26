import { useCallback, useEffect, useState } from "react";
import type { AppSettings } from "@zcode/shared";
import { Check, Copy, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * ZCodium 自用版「增强功能」分区（custom 分支）：手机远控开关托管。
 * 开关写入 setting.json 的 mobileRemoteControl；桌面主进程的 supervisor 轮询该期望态，
 * 自动拉起/回收 `zcode --web` 后端与 mobile-bridge。本页只做配置与状态展示。
 */

type MobileRemoteConfig = NonNullable<AppSettings["mobileRemoteControl"]>;

const DEFAULT_BRIDGE_PORT = 4310;
/** 自用版默认值（本机安装的 CLI 发行版入口），可在高级项里改。 */
const DEFAULT_BACKEND_CLI_PATH = "D:\\ZCodium\\zcode-cli\\zcode\\bin\\zcode.mjs";

function defaultWorkspacePath(dataBaseDir: string | undefined): string {
  const base = dataBaseDir?.trim().replace(/[\\/]+$/, "") || "D:\\ZCodium";
  return `${base}\\.zcodium\\workspace\\default`;
}

function generateToken(): string {
  return `mr-${crypto.randomUUID().replace(/-/g, "")}`;
}

interface MobileRemoteSectionProps {
  config: MobileRemoteConfig | undefined;
  dataBaseDir: string | undefined;
  onUpdate: (patch: Partial<MobileRemoteConfig>) => Promise<void>;
}

type BridgeStatus = "unknown" | "running" | "stopped";

export function MobileRemoteSection({ config, dataBaseDir, onUpdate }: MobileRemoteSectionProps) {
  const { intl } = useZCodeIntl();
  const [status, setStatus] = useState<BridgeStatus>("unknown");
  const [pairingUrl, setPairingUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // 本地编辑态：失焦才提交，避免每次按键都写盘并重启桥。
  const [portDraft, setPortDraft] = useState(String(config?.port ?? DEFAULT_BRIDGE_PORT));
  const [workspaceDraft, setWorkspaceDraft] = useState(
    config?.workspacePath ?? defaultWorkspacePath(dataBaseDir),
  );
  const [backendDraft, setBackendDraft] = useState(
    config?.backendCliPath ?? DEFAULT_BACKEND_CLI_PATH,
  );
  useEffect(() => {
    if (config?.port) setPortDraft(String(config.port));
    if (config?.workspacePath) setWorkspaceDraft(config.workspacePath);
    if (config?.backendCliPath) setBackendDraft(config.backendCliPath);
  }, [config?.port, config?.workspacePath, config?.backendCliPath]);

  const enabled = config?.enabled === true;

  // 状态与配对 URL：直接问桥的 /pair（桥由 supervisor 拉起后回 pairingUrl，
  // 内含 LAN 地址与令牌，主进程无需新增 IPC）。5s 轮询反映自动起停结果。
  useEffect(() => {
    const token = config?.token;
    if (!enabled || !token) {
      setStatus("stopped");
      setPairingUrl(null);
      return;
    }
    const port = config?.port ?? DEFAULT_BRIDGE_PORT;
    let cancelled = false;
    const probe = async () => {
      try {
        const res = await fetch(
          `http://127.0.0.1:${port}/pair?token=${encodeURIComponent(token)}`,
          { signal: AbortSignal.timeout(2_500) },
        );
        const data: { pairingUrl?: string } | null = res.ok ? await res.json() : null;
        if (cancelled) return;
        if (data?.pairingUrl) {
          setStatus("running");
          setPairingUrl(data.pairingUrl);
        } else {
          setStatus("stopped");
        }
      } catch {
        if (!cancelled) {
          setStatus("stopped");
          setPairingUrl(null);
        }
      }
    };
    void probe();
    const timer = setInterval(probe, 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, config?.token, config?.port]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      if (next) {
        await onUpdate({
          enabled: true,
          token: config?.token || generateToken(),
          port: config?.port ?? DEFAULT_BRIDGE_PORT,
          workspacePath: config?.workspacePath || defaultWorkspacePath(dataBaseDir),
          backendCliPath: config?.backendCliPath || DEFAULT_BACKEND_CLI_PATH,
        });
      } else {
        await onUpdate({ enabled: false });
      }
    },
    [config?.token, config?.port, config?.workspacePath, config?.backendCliPath, dataBaseDir, onUpdate],
  );

  const handleCommitPort = useCallback(async () => {
    const port = Number.parseInt(portDraft, 10);
    if (Number.isFinite(port) && port > 0 && port <= 65_535 && port !== config?.port) {
      await onUpdate({ port });
    } else {
      setPortDraft(String(config?.port ?? DEFAULT_BRIDGE_PORT));
    }
  }, [portDraft, config?.port, onUpdate]);

  const handleCommitWorkspace = useCallback(async () => {
    const value = workspaceDraft.trim();
    if (value && value !== config?.workspacePath) await onUpdate({ workspacePath: value });
  }, [workspaceDraft, config?.workspacePath, onUpdate]);

  const handleCommitBackend = useCallback(async () => {
    const value = backendDraft.trim();
    if (value && value !== config?.backendCliPath) await onUpdate({ backendCliPath: value });
  }, [backendDraft, config?.backendCliPath, onUpdate]);

  const handleResetToken = useCallback(async () => {
    await onUpdate({ token: generateToken() });
  }, [onUpdate]);

  const handleCopy = useCallback(async () => {
    if (!pairingUrl) return;
    await navigator.clipboard.writeText(pairingUrl).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1_500);
  }, [pairingUrl]);

  const statusLabel =
    status === "running"
      ? intl.formatMessage({ id: "settings.enhanced.mobileRemote.running" })
      : enabled
        ? intl.formatMessage({ id: "settings.enhanced.mobileRemote.starting" })
        : intl.formatMessage({ id: "settings.enhanced.mobileRemote.stopped" });

  return (
    <div className="space-y-6">
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.enhanced.mobileRemote.title" })}
          description={intl.formatMessage({ id: "settings.enhanced.mobileRemote.desc" })}
          detail={<span className="text-ui-base text-foreground-subtle">{statusLabel}</span>}
          control={
            <Switch
              aria-label={intl.formatMessage({ id: "settings.enhanced.mobileRemote.title" })}
              checked={enabled}
              onCheckedChange={(checked) => {
                void handleToggle(checked);
              }}
            />
          }
        />
      </SettingsGroupCard>

      {!enabled ? null : (
        <SettingsGroupCard>
          {pairingUrl ? (
            <SettingsRow
              label={intl.formatMessage({ id: "settings.enhanced.mobileRemote.pairUrl" })}
              description={intl.formatMessage({ id: "settings.enhanced.mobileRemote.pairUrlDesc" })}
              control={
                <div className="flex max-w-[420px] items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-ui-sm text-foreground-subtle">
                    {pairingUrl}
                  </span>
                  <Button variant="outline" size="sm" onClick={() => void handleCopy()}>
                    {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                  </Button>
                </div>
              }
            />
          ) : null}
          <SettingsRow
            label={intl.formatMessage({ id: "settings.enhanced.mobileRemote.token" })}
            description={intl.formatMessage({ id: "settings.enhanced.mobileRemote.tokenDesc" })}
            control={
              <div className="flex items-center gap-2">
                <span className="max-w-[220px] truncate font-mono text-ui-sm text-foreground-subtle">
                  {config?.token ?? "—"}
                </span>
                <Button variant="outline" size="sm" onClick={() => void handleResetToken()}>
                  <RefreshCw className="size-4" />
                </Button>
              </div>
            }
          />
          <SettingsRow
            label={intl.formatMessage({ id: "settings.enhanced.mobileRemote.port" })}
            control={
              <Input
                className="w-28"
                value={portDraft}
                onChange={(event) => setPortDraft(event.target.value)}
                onBlur={() => void handleCommitPort()}
              />
            }
          />
          <SettingsRow
            label={intl.formatMessage({ id: "settings.enhanced.mobileRemote.workspace" })}
            description={intl.formatMessage({ id: "settings.enhanced.mobileRemote.workspaceDesc" })}
            control={
              <Input
                className="w-[360px]"
                value={workspaceDraft}
                onChange={(event) => setWorkspaceDraft(event.target.value)}
                onBlur={() => void handleCommitWorkspace()}
              />
            }
          />
          <SettingsRow
            label={intl.formatMessage({ id: "settings.enhanced.mobileRemote.backend" })}
            description={intl.formatMessage({ id: "settings.enhanced.mobileRemote.backendDesc" })}
            control={
              <Input
                className="w-[360px]"
                value={backendDraft}
                onChange={(event) => setBackendDraft(event.target.value)}
                onBlur={() => void handleCommitBackend()}
              />
            }
          />
        </SettingsGroupCard>
      )}
    </div>
  );
}
