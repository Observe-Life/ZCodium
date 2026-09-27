/* oxlint-disable max-lines -- 手机远控设置分区：开关/状态探针/隧道配置同属一个设置页边界，拆分会让状态与草稿同步更难保证。 */
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
 * r6 起统一走公网隧道：不再提供局域网配对地址，也不再需要防火墙放行；
 * 手机端只需在 App 里填固定域名（App 会自动寻址当前隧道）。
 */

type MobileRemoteConfig = NonNullable<AppSettings["mobileRemoteControl"]>;
type TunnelConfig = NonNullable<MobileRemoteConfig["tunnel"]>;

const DEFAULT_BRIDGE_PORT = 4310;
const DEFAULT_BACKEND_CLI_PATH = "D:\\ZCodium\\zcode-cli\\zcode\\bin\\zcode.mjs";
const DEFAULT_CLOUDFLARED_PATH = "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe";

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

interface TunnelProbeInfo {
  enabled?: boolean;
  mode?: string | null;
  publicUrl?: string | null;
  lastError?: string | null;
}

export function MobileRemoteSection({ config, dataBaseDir, onUpdate }: MobileRemoteSectionProps) {
  const { intl } = useZCodeIntl();
  const [status, setStatus] = useState<BridgeStatus>("unknown");
  const [tunnelInfo, setTunnelInfo] = useState<TunnelProbeInfo | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const [portDraft, setPortDraft] = useState(String(config?.port ?? DEFAULT_BRIDGE_PORT));
  const [workspaceDraft, setWorkspaceDraft] = useState(
    config?.workspacePath ?? defaultWorkspacePath(dataBaseDir),
  );
  const [backendDraft, setBackendDraft] = useState(
    config?.backendCliPath ?? DEFAULT_BACKEND_CLI_PATH,
  );
  const [domainDraft, setDomainDraft] = useState(config?.tunnel?.domain ?? "");
  const [subdomainIdDraft, setSubdomainIdDraft] = useState(
    String(config?.tunnel?.subdomainId ?? ""),
  );
  const [dnsheKeyDraft, setDnsheKeyDraft] = useState(config?.tunnel?.dnsheKey ?? "");
  const [dnsheSecretDraft, setDnsheSecretDraft] = useState(config?.tunnel?.dnsheSecret ?? "");
  const [tunnelTokenDraft, setTunnelTokenDraft] = useState(config?.tunnel?.token ?? "");
  const [cloudflaredDraft, setCloudflaredDraft] = useState(
    config?.tunnel?.cloudflaredPath ?? DEFAULT_CLOUDFLARED_PATH,
  );
  useEffect(() => {
    if (config?.port) setPortDraft(String(config.port));
    if (config?.workspacePath) setWorkspaceDraft(config.workspacePath);
    if (config?.backendCliPath) setBackendDraft(config.backendCliPath);
    if (config?.tunnel?.domain) setDomainDraft(config.tunnel.domain);
    if (config?.tunnel?.subdomainId) setSubdomainIdDraft(String(config.tunnel.subdomainId));
    if (config?.tunnel?.dnsheKey) setDnsheKeyDraft(config.tunnel.dnsheKey);
    if (config?.tunnel?.dnsheSecret) setDnsheSecretDraft(config.tunnel.dnsheSecret);
    if (config?.tunnel?.token) setTunnelTokenDraft(config.tunnel.token);
    if (config?.tunnel?.cloudflaredPath) setCloudflaredDraft(config.tunnel.cloudflaredPath);
  }, [
    config?.port,
    config?.workspacePath,
    config?.backendCliPath,
    config?.tunnel?.domain,
    config?.tunnel?.subdomainId,
    config?.tunnel?.dnsheKey,
    config?.tunnel?.dnsheSecret,
    config?.tunnel?.token,
    config?.tunnel?.cloudflaredPath,
  ]);

  const enabled = config?.enabled === true;
  const port = config?.port ?? DEFAULT_BRIDGE_PORT;
  const tunnelEnabled = config?.tunnel?.enabled === true;

  // 桥与隧道状态：直接问桥的 /pair（回环），5s 轮询。
  useEffect(() => {
    const token = config?.token;
    if (!enabled || !token) {
      setStatus("stopped");
      setTunnelInfo(null);
      return;
    }
    const currentPort = port;
    let cancelled = false;
    const probe = async () => {
      try {
        const res = await fetch(
          `http://127.0.0.1:${currentPort}/pair?token=${encodeURIComponent(token)}`,
          { signal: AbortSignal.timeout(2_500) },
        );
        const data: { tunnel?: TunnelProbeInfo } | null = res.ok ? await res.json() : null;
        if (cancelled) return;
        if (data) {
          setStatus("running");
          setTunnelInfo(data.tunnel ?? null);
        } else {
          setStatus("stopped");
        }
      } catch {
        if (!cancelled) {
          setStatus("stopped");
        }
      }
    };
    void probe();
    const timer = setInterval(probe, 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, config?.token, port]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      if (!next) {
        await onUpdate({ enabled: false });
        return;
      }
      await onUpdate({
        enabled: true,
        token: config?.token || generateToken(),
        port: config?.port ?? DEFAULT_BRIDGE_PORT,
        workspacePath: config?.workspacePath || defaultWorkspacePath(dataBaseDir),
        backendCliPath: config?.backendCliPath || DEFAULT_BACKEND_CLI_PATH,
      });
    },
    [config, dataBaseDir, onUpdate],
  );

  const updateTunnel = useCallback(
    async (patch: Partial<TunnelConfig>) => {
      const current = config?.tunnel ?? {};
      await onUpdate({
        tunnel: {
          enabled: current.enabled === true,
          domain: current.domain ?? "",
          subdomainId: current.subdomainId ?? 0,
          dnsheKey: current.dnsheKey ?? "",
          dnsheSecret: current.dnsheSecret ?? "",
          cloudflaredPath: current.cloudflaredPath ?? DEFAULT_CLOUDFLARED_PATH,
          token: current.token ?? "",
          ...patch,
        },
      });
    },
    [config?.tunnel, onUpdate],
  );

  const handleCommitPort = useCallback(async () => {
    const next = Number.parseInt(portDraft, 10);
    if (Number.isFinite(next) && next > 0 && next <= 65_535 && next !== config?.port) {
      await onUpdate({ port: next });
    } else {
      setPortDraft(String(config?.port ?? DEFAULT_BRIDGE_PORT));
    }
  }, [portDraft, config?.port, onUpdate]);

  const handleCommitText = useCallback(
    async (field: "workspacePath" | "backendCliPath", value: string) => {
      const trimmed = value.trim();
      if (!trimmed || trimmed === config?.[field]) return;
      await onUpdate(
        field === "workspacePath" ? { workspacePath: trimmed } : { backendCliPath: trimmed },
      );
    },
    [config, onUpdate],
  );

  const handleCommitTunnelField = useCallback(
    async (field: keyof TunnelConfig, value: string | number, current: string | number | undefined) => {
      if (value === current) return;
      await updateTunnel({ [field]: value } as Partial<TunnelConfig>);
    },
    [updateTunnel],
  );

  const handleCopy = useCallback(async (text: string | null, key: string) => {
    if (!text) return;
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(key);
    setTimeout(() => setCopied(null), 1_500);
  }, []);

  const statusLabel =
    status === "running"
      ? intl.formatMessage({ id: "settings.enhanced.mobileRemote.running" })
      : enabled
        ? intl.formatMessage({ id: "settings.enhanced.mobileRemote.starting" })
        : intl.formatMessage({ id: "settings.enhanced.mobileRemote.stopped" });

  const tunnelStatusLabel = !tunnelInfo?.enabled
    ? intl.formatMessage({ id: "settings.enhanced.mobileRemote.tunnel.stopped" })
    : tunnelInfo.lastError
      ? intl.formatMessage(
          { id: "settings.enhanced.mobileRemote.tunnel.error" },
          { error: tunnelInfo.lastError },
        )
      : tunnelInfo.publicUrl
        ? intl.formatMessage(
            { id: "settings.enhanced.mobileRemote.tunnel.running" },
            { mode: tunnelInfo.mode === "named" ? "命名隧道" : "快速隧道" },
          )
        : intl.formatMessage({ id: "settings.enhanced.mobileRemote.tunnel.starting" });

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
          <SettingsRow
            label={intl.formatMessage({ id: "settings.enhanced.mobileRemote.token" })}
            description={intl.formatMessage({ id: "settings.enhanced.mobileRemote.tokenDesc" })}
            control={
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1 break-all font-mono text-ui-sm text-foreground-subtle">
                  {config?.token ?? "—"}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleCopy(config?.token ?? null, "token")}
                >
                  {copied === "token" ? <Check className="size-4" /> : <Copy className="size-4" />}
                </Button>
                <Button variant="outline" size="sm" onClick={() => void onUpdate({ token: generateToken() })}>
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
                className="w-[420px]"
                value={workspaceDraft}
                onChange={(event) => setWorkspaceDraft(event.target.value)}
                onBlur={() => void handleCommitText("workspacePath", workspaceDraft)}
              />
            }
          />
          <SettingsRow
            label={intl.formatMessage({ id: "settings.enhanced.mobileRemote.backend" })}
            description={intl.formatMessage({ id: "settings.enhanced.mobileRemote.backendDesc" })}
            control={
              <Input
                className="w-[420px]"
                value={backendDraft}
                onChange={(event) => setBackendDraft(event.target.value)}
                onBlur={() => void handleCommitText("backendCliPath", backendDraft)}
              />
            }
          />
        </SettingsGroupCard>
      )}

      {!enabled ? null : (
        <SettingsGroupCard>
          <SettingsRow
            label={intl.formatMessage({ id: "settings.enhanced.mobileRemote.tunnel.title" })}
            description={intl.formatMessage({ id: "settings.enhanced.mobileRemote.tunnel.desc" })}
            detail={<span className="text-ui-base text-foreground-subtle">{tunnelStatusLabel}</span>}
            control={
              <Switch
                aria-label={intl.formatMessage({ id: "settings.enhanced.mobileRemote.tunnel.title" })}
                checked={tunnelEnabled}
                onCheckedChange={(checked) => {
                  void updateTunnel({ enabled: checked });
                }}
              />
            }
          />
          {!tunnelEnabled ? null : (
            <>
              {tunnelInfo?.publicUrl ? (
                <SettingsRow
                  label={intl.formatMessage({ id: "settings.enhanced.mobileRemote.tunnel.publicUrl" })}
                  description={intl.formatMessage({
                    id: "settings.enhanced.mobileRemote.tunnel.publicUrlDesc",
                  })}
                  control={
                    <div className="flex w-[520px] items-start gap-2">
                      <span className="min-w-0 flex-1 break-all font-mono text-ui-sm text-foreground-subtle">
                        {tunnelInfo.publicUrl}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleCopy(tunnelInfo.publicUrl ?? null, "tunnel")}
                      >
                        {copied === "tunnel" ? <Check className="size-4" /> : <Copy className="size-4" />}
                      </Button>
                    </div>
                  }
                />
              ) : null}
              <SettingsRow
                label={intl.formatMessage({ id: "settings.enhanced.mobileRemote.tunnel.domain" })}
                description={intl.formatMessage({ id: "settings.enhanced.mobileRemote.tunnel.domainDesc" })}
                control={
                  <Input
                    className="w-[300px]"
                    placeholder="qnszyg.de5.net"
                    value={domainDraft}
                    onChange={(event) => setDomainDraft(event.target.value)}
                    onBlur={() =>
                      void handleCommitTunnelField("domain", domainDraft.trim(), config?.tunnel?.domain)
                    }
                  />
                }
              />
              <SettingsRow
                label={intl.formatMessage({ id: "settings.enhanced.mobileRemote.tunnel.subdomainId" })}
                control={
                  <Input
                    className="w-[180px]"
                    value={subdomainIdDraft}
                    onChange={(event) => setSubdomainIdDraft(event.target.value)}
                    onBlur={() => {
                      const next = Number.parseInt(subdomainIdDraft, 10);
                      if (Number.isFinite(next) && next >= 0) {
                        void handleCommitTunnelField("subdomainId", next, config?.tunnel?.subdomainId);
                      } else {
                        setSubdomainIdDraft(String(config?.tunnel?.subdomainId ?? ""));
                      }
                    }}
                  />
                }
              />
              <SettingsRow
                label={intl.formatMessage({ id: "settings.enhanced.mobileRemote.tunnel.dnsheKey" })}
                control={
                  <Input
                    className="w-[420px]"
                    value={dnsheKeyDraft}
                    onChange={(event) => setDnsheKeyDraft(event.target.value)}
                    onBlur={() =>
                      void handleCommitTunnelField("dnsheKey", dnsheKeyDraft.trim(), config?.tunnel?.dnsheKey)
                    }
                  />
                }
              />
              <SettingsRow
                label={intl.formatMessage({ id: "settings.enhanced.mobileRemote.tunnel.dnsheSecret" })}
                control={
                  <Input
                    className="w-[420px]"
                    value={dnsheSecretDraft}
                    onChange={(event) => setDnsheSecretDraft(event.target.value)}
                    onBlur={() =>
                      void handleCommitTunnelField(
                        "dnsheSecret",
                        dnsheSecretDraft.trim(),
                        config?.tunnel?.dnsheSecret,
                      )
                    }
                  />
                }
              />
              <SettingsRow
                label={intl.formatMessage({ id: "settings.enhanced.mobileRemote.tunnel.token" })}
                description={intl.formatMessage({ id: "settings.enhanced.mobileRemote.tunnel.tokenDesc" })}
                control={
                  <Input
                    className="w-[420px]"
                    value={tunnelTokenDraft}
                    onChange={(event) => setTunnelTokenDraft(event.target.value)}
                    onBlur={() =>
                      void handleCommitTunnelField(
                        "token",
                        tunnelTokenDraft.trim(),
                        config?.tunnel?.token,
                      )
                    }
                  />
                }
              />
              <SettingsRow
                label={intl.formatMessage({ id: "settings.enhanced.mobileRemote.tunnel.cloudflared" })}
                control={
                  <Input
                    className="w-[420px]"
                    value={cloudflaredDraft}
                    onChange={(event) => setCloudflaredDraft(event.target.value)}
                    onBlur={() =>
                      void handleCommitTunnelField(
                        "cloudflaredPath",
                        cloudflaredDraft.trim(),
                        config?.tunnel?.cloudflaredPath,
                      )
                    }
                  />
                }
              />
            </>
          )}
        </SettingsGroupCard>
      )}
    </div>
  );
}
