# 适配层目录与扩展点

## 目标矩阵

| Agent 运行时 \ 消息渠道 | 飞书（首版） | 其他渠道（后续） |
|---|---|---|
| DSH 原生 Agent | ✅ `runtimes/dsh/native.js` | 复用 bridge-core，新增 channel |
| DSH 子 Agent | ✅ `runtimes/dsh/subagent.js` | 复用 bridge-core，新增 channel |
| Qoder / Claude Code / Codex 等 | 复用 bridge-core，新增 runtime | 两者分别扩展 |

核心原则：**bridge-core 不认识飞书，也不认识 DSH**；渠道适配层只负责“平台消息 ↔ 统一消息”，运行时适配层只负责“统一消息 ↔ Agent”。团队协议、名册、角色、记忆、防环全部在 bridge-core。

## 目录

```
lib/
├── bridge-core/              # 与平台、Agent 无关
│   ├── config.js             # 配置归一化
│   ├── contracts.js          # ChannelAdapter / AgentRuntime 契约
│   ├── dedup.js              # 消息幂等
│   ├── guard.js              # hop / 冷却 / 指纹 / 预算
│   ├── memory.js             # 按 binding 的持久团队记忆
│   ├── prompt.js             # 身份、名册、协议、工作方式、记忆提示词
│   ├── protocol.js           # trace/hop 信封、富文本、分片、解析
│   ├── roster.js             # 名册与 open_id 合并
│   ├── store.js              # 原子 JSON 状态
│   └── team.js               # 绑定控制器：命令、交接、防环、记忆
├── channels/
│   ├── feishu/               # 飞书渠道适配层
│   │   ├── api.js            # tenant token / OpenAPI
│   │   ├── channel.js        # WSClient 长连接 + 发送
│   │   └── normalize.js      # 事件 → InboundMessage
│   └── mock/                 # 测试/本地渠道
│       └── channel.js
├── runtimes/
│   └── dsh/                  # DSH 运行时适配层
│       ├── native.js         # ctx.agents 常驻 Agent
│       └── subagent.js       # 子 Agent 兜底（每条消息一个子 Agent）
└── index.js                  # 组合：bridge-core + channel + runtime
```

## 渠道契约

实现 `ChannelAdapter`（见 `lib/bridge-core/contracts.js`）：

- `start()`：建立连接、读取 self 身份。
- `send({ chatId, msgType, content, uuid, replyTo })`：发送消息。
- `stop()`：关闭连接。
- 事件经 `normalize.ts/js` 归一化为 `InboundMessage`，交给 `TeamController.handleInbound`。

新增渠道步骤：

1. 新建 `lib/channels/<platform>/`；
2. 实现 channel + normalize；
3. 在 `index.js` 的渠道工厂里增加分支；
4. 在 `lib/bridge-core/config.js` 增加该渠道的账号字段；
5. 用 `channels/mock` 写契约测试，再接真实平台。

## 运行时契约

实现 `AgentRuntime`：

- `ensure()`：创建/恢复会话；
- `submit(text)`：投递一条消息；
- `cancel()` / `waitForTurn()` / `dispose()`；
- `info()`：诊断信息。

新增运行时步骤：

1. 新建 `lib/runtimes/<tool>/`；
2. 实现上述方法；
3. 在 `index.js` 的运行时工厂里增加分支；
4. 账号配置增加 `runtime: '<id>'`；
5. 用 mock runtime 验证 bridge-core 的协作流程。

## 命名与迁移

`agent-team` 作为**项目/仓库的 umbrella 名**是可行的，但直接作为 npm 包名不可行：

- npm 上 `agent-team` 已被占用（`agent-team` v0.2.0，Multi-agent CLI orchestrator via ACP）；
- GitHub 上 `agent-team` 相关仓库有 6000+，可发现性差；
- 更要注意 `NanmiCoder/dsh-agent-teams` 已经是一个知名的 DSH 多 Agent 插件（2.8k+ stars），用 `dsh-agent-team(s)` 容易混淆。

推荐：

- **仓库 / 项目名**：`agent-team` 或 `agent-team-bridge`（后者更具体，npm 上也未被占用）；
- **npm 包名**：`agent-team-bridge`，或 `@你的scope/agent-team`；
- **内部核心目录/包名**：`bridge-core`（即 `lib/bridge-core`，未来拆包时 `packages/bridge-core`）。

现状：

- npm 包名与 profile 安装名仍是 `dsh-feishu-team`（v0.1），避免破坏已安装实例与本地状态目录；
- 目录已按 `bridge-core` / `channels` / `runtimes` 分层，后续加渠道或运行时不需要动核心。

v0.2 迁移步骤（等最终名字确定后执行）：

1. `package.json` 改名（`agent-team-bridge` 或 scoped 名），版本 `0.2.0`；
2. `cordis.patch.yml` 的 row `name` 改为新包名，id 改为 `agent-team`；
3. 状态目录从 `~/.dsh/dsh-feishu-team` 迁移到 `~/.dsh/agent-team`（首次启动可自动复制旧配置/凭据）；
4. 卸载旧 bundle、安装新 bundle；
5. 更新 README、市场索引条目、GitHub 仓库名。
