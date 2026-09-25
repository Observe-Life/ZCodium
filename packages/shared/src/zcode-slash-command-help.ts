export type BuiltinZCodeSlashCommandHelpEntry = {
  aliases?: readonly string[];
  details: readonly string[];
  name: string;
  summary: string;
  usage: string;
};

export const BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES: readonly BuiltinZCodeSlashCommandHelpEntry[] =
  [
    {
      details: [
        "Shows command-center help locally without creating a session or sending a model prompt.",
        "Pass a command name with or without the leading slash for command-specific help.",
      ],
      name: "help",
      summary: "显示本斜杠命令帮助。",
      usage: "/help [command]",
    },
    {
      details: ["Runs the core manual compaction path and forwards optional summary instructions."],
      name: "compact",
      summary: "压缩当前对话，可附加说明。",
      usage: "/compact [instructions]",
    },
    {
      details: [
        "Runs a normal agent turn that inspects the current workspace and creates or updates AGENTS.md.",
        "Existing AGENTS.md files should be edited rather than overwritten.",
        "This command targets the workspace root, not the user default ~/.zcodium/AGENTS.md.",
      ],
      name: "init",
      summary: "创建或更新工作区的 AGENTS.md 说明。",
      usage: "/init [notes]",
    },
    {
      details: [
        "Starts a durable expert workflow in yolo mode when called with a task.",
        "Use status, resume, or stop to manage the latest or a named workflow run.",
      ],
      name: "expert",
      summary: "运行或管理专家工作流。",
      usage: "/expert [status|resume|stop|<task>]",
    },
    {
      aliases: ["variant"],
      details: [
        "In the TUI, type /effort or /variant to open composer suggestions.",
        "Submitting the empty command or list shows the current and selectable efforts as text.",
        "Use a listed level to switch the current session reasoning effort.",
      ],
      name: "effort",
      summary: "查看或切换当前会话的推理强度。",
      usage: "/effort [list|<level>]",
    },
    {
      details: [
        "Lists this session's dynamic workflow runs with server-decided status and resumability.",
        "cancel without a run id cancels the only in-flight run, or lists candidates when there are several.",
        "resume asks the server; a run the server refuses reports the structured reason.",
      ],
      name: "dwf",
      summary: "列出、取消或恢复动态工作流运行。",
      usage: "/dwf [list|cancel [runId]|resume <runId>]",
    },
    {
      details: [
        "In the TUI, opens a checkpoint picker when called without arguments.",
        "Use latest or a specific checkpoint id to bypass the picker.",
      ],
      name: "fork",
      summary: "从工作区检查点派生一个新会话。",
      usage: "/fork [latest|checkpointId]",
    },
    {
      aliases: ["language"],
      details: [
        "Shows the current UI locale when called without arguments.",
        "Use auto, en-US, or zh-CN to switch and persist the UI locale.",
      ],
      name: "locale",
      summary: "查看或切换界面语言。",
      usage: "/locale [auto|en-US|zh-CN]",
    },
    {
      details: [
        "Lists MCP server status by default.",
        "Use connect or disconnect with a configured server name to manage the session connection.",
      ],
      name: "mcp",
      summary: "查看或管理已配置的 MCP 服务器。",
      usage: "/mcp [list|status|connect <server>|disconnect <server>]",
    },
    {
      aliases: ["plugin"],
      details: [
        "Opens a TUI plugin panel when called without arguments.",
        "Rows show ✓ for enabled plugins and ○ for disabled plugins.",
        "Use enable or disable with a plugin id to persist the switch in user config.",
        "Plugin capability changes apply to new sessions.",
      ],
      name: "plugins",
      summary: "打开插件管理器。",
      usage: "/plugins [list|enable <plugin>|disable <plugin>]",
    },
    {
      details: [
        "Shows the current permission mode when submitted without arguments.",
        "Interactive TUI composer input opens a local picker before submit.",
        "Switchable modes are plan, build, edit, and yolo.",
        "Picker rows and explicit input submit /mode <mode> commands.",
      ],
      name: "mode",
      summary: "查看或切换当前权限模式。",
      usage: "/mode [plan|build|edit|yolo]",
    },
    {
      details: [
        "Shows the current and selectable models when called without arguments or with list.",
        "Use a provider/model id to select a model with its default reasoning effort; use /effort to change the effort.",
      ],
      name: "model",
      summary: "查看或切换当前会话模型。",
      usage: "/model [list|provider/model]",
    },
    {
      aliases: ["clear"],
      details: ["Starts a fresh root session and resets the TUI session projection."],
      name: "new",
      summary: "在终端界面中开启一个新会话。",
      usage: "/new",
    },
    {
      aliases: ["continue"],
      details: [
        "In the TUI, opens a session picker when called without arguments.",
        "Resumes a specific session id when provided.",
        "/continue resumes the latest root session for the current directory.",
      ],
      name: "resume",
      summary: "恢复已保存的会话。",
      usage: "/resume [sessionId]",
    },
    {
      details: [
        "In the TUI, opens a checkpoint picker when called without arguments.",
        "Use status to show the latest checkpoint, or latest/a checkpoint id to restore directly.",
      ],
      name: "rewind",
      summary: "查看或恢复工作区检查点。",
      usage: "/rewind [latest|checkpointId]",
    },
    {
      details: [
        "Without a name, lists discoverable skills for the current working directory.",
        "With a name, rewrites the next prompt so the Skill tool must load that skill first.",
      ],
      name: "skill",
      summary: "列出技能，或让下一条提示强制加载指定技能。",
      usage: "/skill [<skill-name> [task]]",
    },
    {
      aliases: ["target"],
      details: [
        "Shows the current session goal when called without arguments.",
        "Setting a new objective overwrites an existing goal; replace is an explicit alias.",
        "Use pause, resume, or clear to manage the current goal.",
      ],
      name: "goal",
      summary: "查看或设置当前会话目标。",
      usage: "/goal [pause|resume|clear|replace <objective>|<objective>]",
    },
    {
      details: [
        "Loads the dynamic-workflows skill, then writes a workflow script and submits it with CreateWorkflow.",
        "Runs as a normal agent turn; the workflow starts only after you confirm the script.",
        "In the desktop app the command is offered only while dynamic workflows are enabled for this client.",
      ],
      name: "workflow",
      summary: "为任务设计并启动一个动态工作流。",
      usage: "/workflow [what the workflow should accomplish]",
    },
  ] as const;
