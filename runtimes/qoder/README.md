# im-agent-team · Qoder Plugin

把 Qoder 接到 `im-agent-team` 的飞书机器人。安装后：

- 在 Qoder 里 `@feishu`（Agent）初始化、查看状态、发送测试消息；
- 用 `/connect` 或 `/status`（命令）执行同样的流程；
- MCP 工具由 `bin/im-agent-team-mcp.mjs` 提供。

## 安装

Qoder IDE：

1. 在 `runtimes/qoder` 里执行 `node build.mjs`，产出 `dist/im-agent-team-qoder-plugin-0.4.0.zip`；
2. **Extensions → Plugins → Add Plugins → Upload Plugin** 选择 zip；
3. 安装后新开任务，输入 `@feishu` 或 `/connect`。

Qoder CLI：

```bash
qoder plugins install C:\path\to\im-agent-team\runtimes\qoder
qoder plugins list
```

## 当前能力

| 工具/命令 | 状态 |
|---|---|
| `feishu_status` / `/status` | ✅ 读取本机配置、绑定、连接器状态和 Qoder 运行时 |
| `feishu_onboard` | ✅ 启动官方扫码 onboarding，返回授权链接 |
| `feishu_send` | ✅ 通过已配置机器人发文本 |
| `feishu_connect` / `/connect` | ✅ 启动连接器；使用 Qoder Agent SDK + Qoder 自带 worker runtime |
| `feishu_disconnect` | ✅ 停止连接器并关闭 SDK daemon |
| 实时飞书 ↔ Qoder 长连接 | ✅ 已实现；不依赖用户安装 Qoder CLI |
| 审批 / AskUserQuestion | ✅ 飞书交互卡片 + 文本回退 |

## 飞书命令与交互

在飞书群里 @ 机器人后发送：

| 命令 | 作用 |
|---|---|
| `/mode [plan\|default\|acceptEdits\|auto\|bypass]` | 查看/切换权限模式 |
| `/plan [on\|off]` | 切换 Plan 模式 |
| `/model [name]` | 查看/切换模型 |
| `/stop` | 中断当前任务并取消待处理交互 |
| `/sessions` | 查看最近 Qoder 会话 |
| `/models` | 查看可用模型 |
| `/usage` | 查看额度 |
| `/goal [objective\|clear]` | 设置/清除目标 |
| `/status` | 查看当前会话状态 |
| `/help` | 显示帮助 |

审批与提问：

- 工具审批通过飞书卡片或文本：`1 允许一次 / 2 本会话允许 / 3 拒绝`；超时自动拒绝。
- `AskUserQuestion` 支持单选、多选和自定义文本；答案通过 `canUseTool.updatedInput.answers` 回填。
- `/mode bypass` 会先发确认卡片；确认后默认 30 分钟自动回退到 `plan`。
- 所有审批、提问、模式切换写入 `~/.dsh/im-agent-team/audit.jsonl`。
- 卡片按钮依赖飞书 `card.action.trigger` 回调；老应用需要在开发者后台补上。发送卡片失败会自动降级为文本。

## 运行时：Agent SDK + Qoder worker runtime

`runtime/sdk.mjs` 通过 `@qoder-ai/qoder-agent-sdk` 驱动 Qoder：

- 用 `startDaemon({ launchMode: 'worker', pathToQoderWorkerRuntime })` 启动 Qoder 安装目录里的 `qoder-worker-runtime.obf.mjs`；
- 用 `qodercliAuth()` 复用 Qoder 本机登录态，也可用 `QODER_PERSONAL_ACCESS_TOKEN`；
- 自动发现 worker runtime：`QODER_WORKER_RUNTIME` → `process.resourcesPath` → `QODER_NODE_RUNTIME` / `process.execPath` → 常见安装路径；
- `feishu_status` 会显示 `sdk-worker`、worker 版本和平台。

它**不是**“把飞书消息注入当前 Qoder 聊天窗口”：每条飞书会话创建独立的 Qoder session，会出现在 Qoder 历史里。
它也**不需要 Qoder CLI**。首次接入直接对 Agent 说“帮我接上飞书”：Agent 会调用 `feishu_connect` / `feishu_onboard` 启动官方扫码，用户打开链接/扫码即可，不需要终端。CLI onboarding 仍保留为备用。

## 为什么不是“@插件”

Qoder 的 `@` 用于选择 **Agent**，`/` 用于选择 Plugin / Skill / Command / Connector。因此本插件同时提供：

- `agents/feishu.md` → `@feishu`
- `commands/connect.md` → `/connect`
- `commands/status.md` → `/status`

## 实时收发

1. 维护飞书 WebSocket；
2. 收到消息后通过 SDK daemon 调用 `query()`；
3. `canUseTool` / `onElicitation` 把审批和提问转发到飞书卡片或文本；
4. 用 `resume` 维持每个群的会话；
5. 把结果发回飞书。

## 配置

`~/.dsh/im-agent-team/config.json` 的 `qoderConnector`：

```json
{
  "qoderConnector": {
    "cwd": "C:/work",
    "permissionMode": "plan",
    "maxTurns": 8,
    "timeoutMs": 180000,
    "fullAccessTtlMinutes": 30,
    "allowedTools": [],
    "disallowedTools": ["Bash"]
  }
}
```

- `permissionMode: "plan"` 会映射为 SDK 的 `planMode: true`（只看/规划，不执行工具），这是默认值。
- 需要执行工具时改成 `default` / `acceptEdits` / `auto`；`bypassPermissions`（或 `yolo`）是完全访问，建议只用 `/mode bypass` 的二次确认入口。
- `fullAccessTtlMinutes` 控制完全访问的自动回退时间。
- `cwd` 是 Agent 的工作目录；不设置时用插件进程的 cwd。

## 打包

`build.mjs` 会生成自包含的插件 ZIP：

```bash
cd runtimes/qoder
node build.mjs
# dist/im-agent-team-qoder-plugin-0.4.0.zip
```

ZIP 内包含：

- `.qoder-plugin/`、`agents/`、`commands/`、`skills/`
- `bin/` MCP server
- `connector/` 飞书 WS
- `runtime/` Agent SDK 运行时
- `node_modules/` 飞书 SDK、Qoder Agent SDK、zod

`node_modules` 由 npm 在 staging 目录重新安装为真实文件，不使用 pnpm 的绝对符号链接；`QODER_SKIP_DOWNLOAD=1` + `--ignore-scripts` 确保不会把 qodercli 二进制打进插件。发布包的 `package.json` 不声明运行时依赖，依赖全部 vendored 在 `node_modules`，安装时不需要 npm registry。

## 依赖

- Qoder IDE 已安装并登录（插件运行在 Qoder 内）；
- 不需要 Qoder CLI；
- 可选 `QODER_WORKER_RUNTIME`：非标准安装路径时指定 worker runtime；
- 可选 `QODER_PERSONAL_ACCESS_TOKEN`：没有本机登录态时使用 PAT；
- 没有配置时，Agent 调用 `feishu_connect` / `feishu_onboard` 启动扫码；CLI onboarding 可选。
