# Qoder 接入调研

> 调研时间：2026-11-12
> 目标：判断 Qoder 能否作为 `im-agent-team` 的第二个 Agent 运行时，与飞书群协作层对接。
> 结论：**支持，而且接入面比预期更完整**。推荐优先用官方 Agent SDK，ACP 作为备选，CLI headless 用于快速验证。

## 1. 结论摘要

Qoder 提供了三层可编程入口：

1. **Qoder Agent SDK**（TypeScript / Python / Java）——把驱动 Qoder 产品的 Harness 以 SDK 开放，支持 `query()`、多轮会话、流式输出、权限回调、会话恢复、MCP、Subagent、记忆。
2. **ACP（Agent Client Protocol）**——`qoder --acp` / `qodercn --acp` 以 JSON-RPC over stdio 暴露 Agent 服务，可被任何 ACP 客户端驱动。
3. **Headless CLI**——`qoder -p "..."`，支持 `text` / `json` / `stream-json` 输出，以及 `--resume` / `--session-id` / `--cwd` / `--append-system-prompt` 等参数。

这三层都能映射到 `im-agent-team` 现有的 `AgentRuntime` 契约。Qoder 还区分国际版与 CN 版：二进制、SDK 包名、PAT 环境变量都不同，需要适配层同时支持。

## 2. Qoder 平台能力

### 2.1 Agent SDK

官方文档把 SDK 定位为“面向应用的接口”，Qoder CLI 是底层 Agent 运行时：

```
TypeScript / Python / Java 应用
        │  Qoder Agent SDK
        ▼
   qodercli / qoderclicn
        ├── Qoder 模型服务
        └── 文件、命令、MCP、Subagent
```

关键能力：

| 能力 | 说明 |
|---|---|
| 一次性任务 | `query({ prompt, options })`，完成本轮后关闭 |
| 多轮会话 | 向 `query()` 传异步消息流；Python 用 `QoderSDKClient`；Java 用 `openSession()` |
| 流式输出 | `includePartialMessages`，消费 `stream_event` / `text_delta` / `thinking_delta` |
| 会话控制 | `sessionId`、`resume`、`continue`、`fork`；`init` 消息带 `session_id` |
| 权限 | `permissionMode`、工具白名单、应用侧审批回调 |
| 工具 | 内置文件/命令工具、自定义工具、MCP、Skills、Plugins、Subagent |
| 记忆 | 原生用户级/项目级记忆，也可由应用接管 |
| 系统提示 | 覆盖或追加系统提示、输出风格、模型选择 |
| 运行环境 | Node.js 18+；TypeScript/Python SDK 内置兼容的 CLI 运行时 |

认证方式：

- `QODER_PERSONAL_ACCESS_TOKEN` → `accessTokenFromEnv()`
- Service Account Key（组织工作负载）
- 复用本机 `qodercli` 登录态

### 2.2 ACP

Qoder CLI 实现了 [Agent Client Protocol](https://agentclientprotocol.com/overview/introduction)：

```bash
qoder --acp       # 国际版
qodercn --acp     # CN 版
```

ACP 提供会话、流式消息、权限请求、工具调用、Subagent、MCP、上下文压缩、多模态。对 `im-agent-team` 来说，ACP 的价值是：

- 不需要把 Qoder SDK 作为依赖；
- 进程隔离，权限边界清楚；
- 协议稳定，未来接其他 ACP Agent（如 Zed 生态）可复用。

代价是要实现 ACP 客户端：`initialize`、`session/new`、`session/prompt`、`session/update`、`session/cancel`、权限响应等 JSON-RPC 方法。

### 2.3 Headless CLI

```bash
qoder -p "解释这个仓库的架构"
qoder -p "..." --output-format stream-json
qoder -p "..." --session-id <id> --cwd <dir>
```

适合做 POC 和轻量运行时：

- 一次进程一条消息，简单可靠；
- `stream-json` 可实时消费；
- `--resume` / `--session-id` 可恢复会话；
- 无 SDK 依赖，但每条消息有进程启动成本。

### 2.4 MCP 与 IDE 插件

Qoder 支持把外部 MCP 服务作为工具接入，也支持 `qoder mcp serve` 把自己作为 MCP 服务器。这不适合作为“群机器人运行时”的主路径：

- MCP 是工具协议，不是“投递一条用户消息并拿到 Agent 回复”的接口；
- 如果只把飞书发送做成 MCP 工具，Agent 无法主动感知群里的新消息，仍需要外部轮询/注入。

Qoder 的 IDE 扩展体系（Skills / Plugins / Connectors）用于扩展 Qoder 自身能力，也不是从外部驱动 Agent 的入口；驱动入口是 SDK / ACP / CLI。

## 3. 与 im-agent-team 的映射

`bridge-core` 的 `AgentRuntime` 契约：

| 契约方法 | Qoder SDK 实现 | Qoder ACP 实现 |
|---|---|---|
| `ensure()` | 校验 PAT / cwd，动态 import SDK，准备会话 | 启动 `qoder --acp`，`initialize` |
| `submit(text)` | `query({ prompt, options })`，消费消息流 | `session/prompt`，消费 `session/update` |
| `cancel()` | SDK 中断/关闭能力（POC 确认具体方法） | `session/cancel` |
| `waitForTurn()` | 等待 `result` 消息 | 等待 turn 完成通知 |
| `dispose()` | 关闭查询/会话 | 关闭子进程 |
| `info()` | session id、模型、状态、错误 | 进程、session id、状态 |

会话映射：

- 每个 binding（`appId + chatId`）对应一个 Qoder session；
- 首次 `submit` 生成/获取 `sessionId`；
- 后续消息用 `resume: sessionId` 恢复，或保持异步消息流；
- `state.json` 已有 `sessionId` 字段可复用，新增 `runtimeSessionId` 区分 DSH/Qoder。

提示词映射：

- 角色、名册、协议、工作方式、团队记忆 → Qoder 的 `appendSystemPrompt`（优先“追加”而不是覆盖，保留 Qoder 自己的工具/安全提示）；
- 用户/上游消息 → `prompt`；
- 群里的消息仍然按“数据而非指令”处理，权限收紧。

工具与权限：

- 飞书群消息是不可信输入，默认不要给 `Bash` / `Edit` / `Write`；
- 建议默认 `allowedTools: ['Read', 'Grep', 'Glob']`，`permissionMode: 'plan'` 或 `default`；
- 禁止 `bypass_permissions` / `--yolo`，除非用户明确在隔离环境开启；
- 需要写文件时，由用户在账号配置里显式放开，并配合 Qoder 的权限回调。

## 4. 推荐配置形态

```jsonc
{
  "id": "qoder-researcher",
  "channel": "feishu",
  "appId": "cli_xxx",
  "chatIds": ["oc_xxx"],
  "runtime": "qoder",
  "qoder": {
    "flavor": "global",              // global | cn
    "cwd": "C:\\work\\repo",
    "authEnv": "QODER_PERSONAL_ACCESS_TOKEN",
    "model": "auto",
    "permissionMode": "plan",
    "allowedTools": ["Read", "Grep", "Glob"],
    "appendSystemPrompt": true,
    "sessionPersistence": true
  },
  "role": { "name": "调研员", "mission": "..." }
}
```

CN 版：

```jsonc
{
  "qoder": {
    "flavor": "cn",
    "authEnv": "QODERCN_PERSONAL_ACCESS_TOKEN"
  }
}
```

SDK 选择：

- 国际版：`@qoder-ai/qoder-agent-sdk`（调研时 1.0.59）
- CN 版：`@qodercn-ai/qodercn-agent-sdk`（调研时 1.0.58）

建议把 SDK 作为 **optional peer dependency**，按 `flavor` 动态 import；不要同时打包两个 SDK，也不要把 PAT 写进配置仓库。

## 5. 目录与实现计划

新增：

```
lib/runtimes/qoder/
├── sdk.js       # 主实现：Qoder Agent SDK
├── acp.js       # 备选：ACP 客户端
├── cli.js       # POC/兜底：headless CLI
└── index.js     # flavor、SDK/二进制探测、统一入口
```

`bridge-core` 不需要改协议、名册、记忆、防环；只在 `index.js` 的运行时工厂增加 `runtime: 'qoder'` 分支，以及 `config.js` 的 `qoder` 字段归一化。

POC 顺序：

1. 安装 Qoder CLI（国际版 `qoder` 或 CN 版 `qodercn`），完成登录/PAT；
2. `qoder -p "只回复 OK" --output-format json` 验证认证与输出；
3. 用 `--session-id` + 第二轮 prompt 验证会话恢复；
4. 安装 SDK，在临时项目里跑 `query()` 一次性与多轮；
5. 实现 `QoderRuntime`，用 `channels/mock` 跑 bridge e2e；
6. 在真实飞书群接入一个 Qoder bot，验证 @、回传、防环；
7. 需要时再实现 ACP。

预估：

| 阶段 | 工作量 |
|---|---|
| CLI/SDK POC | 0.5–1 天 |
| SDK Runtime + 测试 | 1–2 天 |
| 会话/权限/记忆完善 | 2–3 天 |
| CN 版支持 | +1 天 |
| ACP 备选实现 | 3–5 天 |
| 真实飞书联调 | 1 天 |

## 6. 风险与限制

1. **SDK 许可证**：npm 元数据是 `SEE LICENSE IN LICENSE`，不是 MIT/Apache；引入前要确认 Qoder 的 SDK 条款，不能把 SDK 源码直接打进我们的 MIT 包。建议 optional peer + 用户自行安装。
2. **账号与计费**：需要 Qoder 账号/PAT，模型调用消耗 Qoder Credits；CN 版与国际版是两套账号/额度。
3. **网络**：Qoder CLI 需要访问 Qoder 模型服务；国内环境用 CN 版更稳。
4. **平台支持**：CLI/ACP 支持 macOS、Linux、Windows amd64；Windows arm64 暂不支持 ACP。Node 18+。
5. **权限**：Headless 下需要预先配置，否则需要确认的操作会被拒绝；群消息不可信，默认只读工具。
6. **会话/记忆重复**：Qoder 自己有 session/memory，桥接层也有团队记忆；需要明确“谁负责长期记忆”，避免双重注入。
7. **版本漂移**：SDK 1.x 仍在快速迭代，adapter 要做版本探测与降级。
8. **进程/资源**：CLI/ACP 每条消息一个进程或长驻进程，需要管理僵尸进程、超时、取消。

## 7. 最终建议

**可以做，且建议做。**

- 第一选择：**Qoder Agent SDK**，因为它最接近“嵌入式 Agent 运行时”，会话、流式、权限、记忆都齐全；
- 第二选择：**ACP**，如果 SDK 许可证/打包方式不适合，ACP 是更干净的进程边界；
- POC 先用 **headless CLI** 验证认证和输出，成本最低；
- 不建议把 MCP 或 IDE 插件体系当作主接入方式。

下一步只需确认两件事：使用 **国际版还是 CN 版**，以及是否接受把 Qoder SDK 作为可选 peer dependency。确认后即可按 `lib/runtimes/qoder/` 实施。

## 8. Qoder Plugin 落地（0.1）

已在仓库中提供 `qoder-plugin/`，把控制面做成 Qoder 原生插件：

```
qoder-plugin/
├── .qoder-plugin/plugin.json
├── agents/feishu.md          # @feishu
├── commands/connect.md       # /connect
├── commands/status.md        # /status
├── skills/feishu-bridge/     # Skill
├── .mcp.json                 # 本地 MCP server
└── bin/im-agent-team-mcp.mjs
```

已在本机通过：

```bash
qoder plugins validate qoder-plugin
# components: skills 1, agents 1, commands 2, mcp-servers 1

qoder plugins install qoder-plugin
# im-agent-team@local v0.1.0, enabled
```

当前 MCP 工具：

- `feishu_status`：读取本机 `~/.dsh/im-agent-team` 配置/状态；
- `feishu_send`：通过已配置机器人发文本；
- `feishu_connect`：有对应账号时启动实验性连接器；无账号时返回 onboarding 命令；
- `feishu_disconnect`：停止连接器。

**实验版**：常驻飞书 WebSocket + `qoder -p` 会话 + 回复飞书的 connector 已实现，但依赖 Qoder CLI 在 PATH 且已登录。它不符合“纯插件、无 CLI”的目标，只作为验证代码。

**目标方案**：改用 Qoder Plugin SDK 的 `chatSessions.submit/read`，让插件直接驱动 Qoder 会话。该能力在 Qoder 内部存在（consent scope 可在 `app.asar` 中找到），但没有公开文档/API。

详见 [Qoder 纯插件交接文档](qoder-plugin-handoff.md)。

设计要点：

- Qoder 的 `@` 选 Agent，`/` 选 Command/Plugin/Skill；所以插件同时提供 `agents/feishu.md` 和 `commands/connect.md`。
- 第三方插件没有文档化的“把飞书消息注入当前 Qoder 对话”接口；connector 需要为飞书消息创建/恢复自己的 Qoder 会话，并把回复发回飞书。当前 Qoder 对话是控制面。
- connector 实现后，插件整体仍是控制面 + 常驻进程；`@feishu` 负责初始化/状态，飞书负责实际协作。

## 参考

- [Qoder Agent SDK 概述](https://docs.qoder.com/zh/cli/sdk/overview)
- [Qoder Agent SDK 快速开始](https://docs.qoder.com/zh/cli/sdk/quick-start)
- [SDK 会话控制](https://docs.qoder.com/zh/cli/sdk/session-control)
- [SDK 流式输出](https://docs.qoder.com/zh/cli/sdk/streaming-output)
- [SDK 认证](https://docs.qoder.com/zh/cli/sdk/authentication)
- [Qoder ACP](https://docs.qoder.com/zh/cli/acp)
- [Qoder CLI 命令与参数](https://docs.qoder.com/zh/cli/cli-reference)
- [在脚本中运行（Headless）](https://docs.qoder.com/zh/cli/run-in-scripts)
- [Qoder CN ACP](https://docs.qoder.cn/zh/cli/acp)
- [Qoder CN Agent SDK](https://docs.qoder.cn/zh/cli/sdk/overview)
- [Qoder 扩展发布（Skills/Plugins/MCP）](https://docs.qoder.com/qoder/extension-publishing.md)
