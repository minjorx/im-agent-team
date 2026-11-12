# 实现说明与联调记录

> 对应设计文档：[feishu-multi-agent-bridge-design.md](./feishu-multi-agent-bridge-design.md)
> 更新：2026-11-12

## 1. 当前状态

首版已实现并在真实飞书租户完成双 Bot 联调。

已落地：

- Cordis Host 插件 `dsh-feishu-team`，可在 profile 中安装、启用、热重载。
- 飞书长连接（官方 `@larksuiteoapi/node-sdk`）：事件接收、文本/富文本发送、@ 识别。
- 绑定模型：`appId + chatId → DSH Agent`；会话可恢复，损坏会话自动轮换。
- 团队层：名册、角色卡、`/role`、`/team`、`/whoami`、`/status`、`/stop`、`/new`。
- 协作协议：trace / hop / kind / task 正文尾注，`decorateOutgoing` 自动补全。
- 防环：hop 上限、result 回执不触发下一跳、`HandoffGuard` 冷却/指纹/预算。
- 两种运行时：
  - `dsh-native`：`ctx.agents.create()` 常驻 Agent，会话持久。
  - `subagent`：每条消息一个子 Agent，走已验证可用的子 Agent 模型链路；用于当前 DSH 版本根 Agent 收流异常时的兜底。
- 真实飞书资源：3 个企业自建应用、1 个测试群、3 个机器人入群。
- 21 个测试通过（协议、名册、防环、去重、配置、事件归一化、控制器命令/交接/p2p 邀请）。

## 2. 运行时选择

```jsonc
// ~/.dsh/dsh-feishu-team/config.json
{
  "accounts": [
    {
      "id": "director",
      "channel": "feishu",
      "appId": "cli_xxx",
      "chatIds": ["oc_xxx"],
      "runtime": "subagent",   // 或省略 = dsh-native
      "echo": false,           // true = 不调用模型，直接回执，用于验证飞书链路
      "role": { "name": "总调度", "mission": "..." },
      "peers": [{ "name": "调研员", "openId": "ou_xxx" }]
    }
  ]
}
```

- `dsh-native` 是目标形态；当前桌面版本中根 Agent 的模型请求在收流阶段会报 `DeepSeek Messages transport failed`，子 Agent 正常。
- `subagent` 模式已验证能产生真实模型回复，并完成“总调度 → 调研员 → 总调度 → 用户”的两跳协作；代价是每条消息独立，上下文靠最近对话摘要维系。

## 3. 已验证的飞书事实

1. **机器人 mention 的 `open_id` 可以直接用机器人自身的 `/bot/v3/info` open_id**：director 用 researcher 的自身 open_id 发富文本 @，researcher 收到的 `mentions[0].open_id` 与自身一致，`mentionedMe=true`。
2. **发送者 open_id 是应用作用域的**：researcher 看到的 director 发送者 open_id 与 director 自身 open_id 不同；因此回复发送者要使用事件里的 sender open_id（桥接层会自动 upsert）。
3. **post 消息的接收结构不一定带 `zh_cn`**：可能是 `{ title, content }` 根结构；解析器已兼容。
4. **`uuid` 上限 50 字符**：桥接层对 uuid 做 32 位 hash，避免 `field validation failed`。
5. **群成员列表不含机器人**；机器人入群用 `POST /im/v1/chats` 的 `bot_id_list`（app_id），一次可建群并拉最多 5 个机器人。
6. **API 创建的群没有人类成员**，用户客户端可能看不到；桥接层支持 **p2p 邀请**：用户私聊机器人后，机器人调用 `POST /im/v1/chats/:chat_id/members` 把用户加入配置的群。

## 4. 真实联调证据

消息链路（researcher state）：

```text
lastInbound.text = "@Researcher 请用一句话说明「长连接接收事件」的优势… 上游：总调度"
mentionedMe = true
runtime = subagent
outboundCount = 1
```

总调度收到 result 后：

```text
lastInbound.text = "@DSH 总调度 以下是调研员对 trace … 的回复（可直接转述给张三）…"
outboundCount = 2   // 任务 + 转述
```

防环结果：

- researcher 发出 result 后收到 director 的“回执”消息；
- 因为 inbound kind = result，`decorateOutgoing` 不再追加触发用 footer；
- researcher 的 `outboundCount` 保持 1，没有形成第三跳。

## 5. 角色与记忆

- 角色字段：`name` / `mission` / `responsibilities` / `inputs` / `outputs` / `handoffTo` / `constraints` / `behavior`。
- 角色可来自 `config.json`、`dsh-feishu-team-role` CLI、群内 `/role` 命令。
- `behavior` 不设置时使用默认四条工作方式：任务合理性评估与反驳、主动补齐前置、主动推进、像真实同事一样工作。
- 这些约束会进入 `dsh-native` 的系统提示分段，也会进入 `subagent` 每条消息的 prompt。
- 团队记忆按 `appId + chatId` 存在 `state.json` 的 `memory` 字段；自动记录任务/产出/角色决策，`/remember` / `/memory` / `/forget` 手动管理。
- `subagent` 运行时没有持久 Session，依靠团队记忆 + 最近 6 条对话摘要维持上下文；`dsh-native` 同时有 DSH Session 历史。

## 6. 已知限制

- `dsh-native` 根 Agent 模型收流异常（DSH 侧问题）；当前用 `subagent` 运行时规避。
- `subagent` 模式没有持久会话，长对话依赖桥接层的历史摘要（最近 6 条）。
- 群全量消息读取需要敏感权限 `im:message.group_msg`；首版只依赖 @ 消息权限。
- 卡片交互、任务板、多运行时（ACP/SDK/Claude Code）尚未实现。
- 角色卡广播目前是文本消息，尚未做成可编辑卡片。

## 7. 开发与测试

```bash
# 单元 + 控制器测试
node --test test/unit.test.js test/controller.test.js test/memory.test.js

# 语法检查
node --check index.js
node --check lib/runtimes/dsh/native.js
node --check lib/runtimes/dsh/subagent.js

# 本地安装（当前 profile）
dsh plugin --profile desktop add C:/path/to/dsh-feishu-team
```

调试工具（Host 工具，仅开发期）：

```json
{ "action": "list" }
{ "action": "state", "accountId": "director" }
{ "action": "simulate", "accountId": "director", "text": "…" }
{ "action": "handoff", "accountId": "director", "to": "调研员", "goal": "…" }
{ "action": "probe", "text": "只回复 OK" }
```

## 8. 文件地图

| 文件 | 作用 |
|---|---|
| `index.js` | 插件入口、配置加载、binding 启动、调试工具 |
| `lib/bridge-core/config.js` | 配置归一化与校验 |
| `lib/bridge-core/contracts.js` | ChannelAdapter / AgentRuntime 契约 |
| `lib/bridge-core/team.js` | 绑定控制器、命令、交接、防环、p2p 邀请 |
| `lib/bridge-core/memory.js` | 按 binding 持久化的团队记忆 |
| `lib/bridge-core/roster.js` | 名册与同作用域 open_id 合并 |
| `lib/bridge-core/guard.js` | hop / 冷却 / 指纹 / 预算 |
| `lib/bridge-core/protocol.js` | 信封、富文本、分片、解析 |
| `lib/bridge-core/prompt.js` | 身份、名册、协议、工作方式、记忆提示词 |
| `lib/channels/feishu/channel.js` | 长连接与事件归一化 |
| `lib/channels/feishu/api.js` | tenant token、发消息、建群/拉人 |
| `lib/runtimes/dsh/native.js` | 常驻 Agent 运行时 |
| `lib/runtimes/dsh/subagent.js` | 子 Agent 兜底运行时 |
| `bin/onboard.mjs` | 扫码创建应用 CLI |
| `bin/role.mjs` | 角色配置 CLI |
| `docs/adapters.md` | 分层、契约与新增渠道/运行时的步骤 |
