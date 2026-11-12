# 适配层目录与扩展点

## 目标矩阵

| Agent 运行时 \ 消息渠道 | 飞书（首版） | 其他渠道（后续） |
|---|---|---|
| DSH 原生 Agent | ✅ `runtimes/dsh/native.js` | 复用 bridge-core，新增 channel |
| DSH 子 Agent | ✅ `runtimes/dsh/subagent.js` | 复用 bridge-core，新增 channel |
| Qoder | ✅ Qoder Plugin 控制面已建（`qoder-plugin/`）；runtime/connector 待接 | 后续 |
| Claude Code / Codex 等 | 复用 bridge-core，新增 runtime | 两者分别扩展 |

核心原则：**bridge-core 不认识飞书，也不认识 DSH**；渠道适配层只负责“平台消息 ↔ 统一消息”，运行时适配层只负责“统一消息 ↔ Agent”。团队协议、名册、角色、记忆、防环全部在 bridge-core。

Qoder 的可行性已单独调研：[docs/qoder-integration.md](qoder-integration.md)。结论是 Agent SDK 最合适，ACP 备选，CLI headless 用于 POC。

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

最终采用 **`im-agent-team`**：

- 仓库：`https://github.com/minjorx/im-agent-team`
- npm 包：`im-agent-team`（当前不发布，先走 GitHub / tarball）
- DSH bundle row：`id: im-agent-team`、`name: im-agent-team`
- 内部核心：`bridge-core`（`lib/bridge-core`，未来拆包时 `packages/bridge-core`）

命名理由：`im` 点明团队是在 IM 群里形成的，`agent` 点明成员是 Agent，`team` 点明有角色分工与协作；不绑定飞书或 DSH 单一运行时。

没有采用的名字：

- `agent-team`：npm 已被占用（v0.2.0），GitHub 同名仓库很多；
- `agent-team-bridge`：可用，但不如 `im-agent-team` 直观；
- `dsh-agent-team(s)`：与已有的 DSH 多 Agent 项目容易混淆。

状态迁移：v0.2 首次加载时，把 `~/.dsh/dsh-feishu-team`（或中间版本 `~/.dsh/agent-team`）复制到 `~/.dsh/im-agent-team`，旧目录保留作为备份；随后卸载旧 bundle、安装新 bundle。
