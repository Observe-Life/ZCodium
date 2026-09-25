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
        "在本地显示命令中心帮助，不会创建会话，也不会向模型发送提示。",
        "传入命令名（可带或不带开头的斜杠）可查看该命令的专项帮助。",
      ],
      name: "help",
      summary: "显示本斜杠命令帮助。",
      usage: "/help [command]",
    },
    {
      details: ["执行核心的手动压缩流程，并转发可选的摘要说明。"],
      name: "compact",
      summary: "压缩当前对话，可附加说明。",
      usage: "/compact [instructions]",
    },
    {
      details: [
        "运行一次常规的 agent 回合：检查当前工作区并创建或更新 AGENTS.md。",
        "已存在的 AGENTS.md 应在其基础上编辑，而不是覆盖重写。",
        "本命令作用于工作区根目录，而不是用户默认的 ~/.zcodium/AGENTS.md。",
      ],
      name: "init",
      summary: "创建或更新工作区的 AGENTS.md 说明。",
      usage: "/init [notes]",
    },
    {
      details: [
        "带任务调用时，以 yolo 模式启动一个持久的专家工作流。",
        "用 status、resume 或 stop 管理最近一次或指定名称的工作流运行。",
      ],
      name: "expert",
      summary: "运行或管理专家工作流。",
      usage: "/expert [status|resume|stop|<task>]",
    },
    {
      aliases: ["variant"],
      details: [
        "在终端界面中输入 /effort 或 /variant 可打开输入框建议列表。",
        "不带参数提交或使用 list 会以文本列出当前及可选的推理强度。",
        "使用列表中的等级可切换当前会话的推理强度。",
      ],
      name: "effort",
      summary: "查看或切换当前会话的推理强度。",
      usage: "/effort [list|<level>]",
    },
    {
      details: [
        "列出本会话的动态工作流运行，状态与可恢复性由服务端判定。",
        "cancel 不带运行 id 时：若只有一个进行中的运行则取消它，若有多个则列出候选。",
        "resume 会向服务端发起请求；服务端拒绝时会返回结构化的原因。",
      ],
      name: "dwf",
      summary: "列出、取消或恢复动态工作流运行。",
      usage: "/dwf [list|cancel [runId]|resume <runId>]",
    },
    {
      details: [
        "在终端界面中，不带参数调用会打开检查点选择器。",
        "使用 latest 或指定检查点 id 可跳过选择器。",
      ],
      name: "fork",
      summary: "从工作区检查点派生一个新会话。",
      usage: "/fork [latest|checkpointId]",
    },
    {
      aliases: ["language"],
      details: [
        "不带参数调用时显示当前界面语言。",
        "使用 auto、en-US 或 zh-CN 切换并持久保存界面语言。",
      ],
      name: "locale",
      summary: "查看或切换界面语言。",
      usage: "/locale [auto|en-US|zh-CN]",
    },
    {
      details: [
        "默认列出 MCP 服务器状态。",
        "用 connect 或 disconnect 加上已配置的服务器名来管理本会话的连接。",
      ],
      name: "mcp",
      summary: "查看或管理已配置的 MCP 服务器。",
      usage: "/mcp [list|status|connect <server>|disconnect <server>]",
    },
    {
      aliases: ["plugin"],
      details: [
        "不带参数调用时打开终端界面的插件面板。",
        "列表中 ✓ 表示已启用，○ 表示已禁用。",
        "用 enable 或 disable 加上插件 id 可把开关持久保存到用户配置。",
        "插件能力的变化对新会话生效。",
      ],
      name: "plugins",
      summary: "打开插件管理器。",
      usage: "/plugins [list|enable <plugin>|disable <plugin>]",
    },
    {
      details: [
        "不带参数提交时显示当前权限模式。",
        "在终端界面输入框中会先打开本地选择器，再提交。",
        "可切换的模式有 plan、build、edit 和 yolo。",
        "选择器各行与手动输入都会提交 /mode <mode> 命令。",
      ],
      name: "mode",
      summary: "查看或切换当前权限模式。",
      usage: "/mode [plan|build|edit|yolo]",
    },
    {
      details: [
        "不带参数或使用 list 时，显示当前模型与可选模型。",
        "使用 供应商/模型 id 选择模型（采用其默认推理强度）；用 /effort 调整推理强度。",
      ],
      name: "model",
      summary: "查看或切换当前会话模型。",
      usage: "/model [list|provider/model]",
    },
    {
      aliases: ["clear"],
      details: ["开启一个新的根会话，并重置终端界面的会话视图。"],
      name: "new",
      summary: "在终端界面中开启一个新会话。",
      usage: "/new",
    },
    {
      aliases: ["continue"],
      details: [
        "在终端界面中，不带参数调用会打开会话选择器。",
        "提供会话 id 时恢复指定会话。",
        "/continue 恢复当前目录下最近的根会话。",
      ],
      name: "resume",
      summary: "恢复已保存的会话。",
      usage: "/resume [sessionId]",
    },
    {
      details: [
        "在终端界面中，不带参数调用会打开检查点选择器。",
        "用 status 显示最近检查点；用 latest 或检查点 id 直接恢复。",
      ],
      name: "rewind",
      summary: "查看或恢复工作区检查点。",
      usage: "/rewind [latest|checkpointId]",
    },
    {
      details: [
        "不带名称时，列出当前工作目录中可发现的技能。",
        "带名称时，会改写下一条提示，使 Skill 工具必须先加载该技能。",
      ],
      name: "skill",
      summary: "列出技能，或让下一条提示强制加载指定技能。",
      usage: "/skill [<skill-name> [task]]",
    },
    {
      aliases: ["target"],
      details: [
        "不带参数调用时显示当前会话目标。",
        "设置新目标会覆盖已有目标；replace 是显式写法。",
        "用 pause、resume 或 clear 管理当前目标。",
      ],
      name: "goal",
      summary: "查看或设置当前会话目标。",
      usage: "/goal [pause|resume|clear|replace <objective>|<objective>]",
    },
    {
      details: [
        "加载 dynamic-workflows 技能，然后编写工作流脚本并通过 CreateWorkflow 提交。",
        "以常规 agent 回合运行；只有你确认脚本后工作流才会启动。",
        "在桌面应用中，仅当本客户端启用了动态工作流时才会提供此命令。",
      ],
      name: "workflow",
      summary: "为任务设计并启动一个动态工作流。",
      usage: "/workflow [what the workflow should accomplish]",
    },
  ] as const;
