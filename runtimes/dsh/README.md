# DSH Runtime

`runtimes/dsh/` 是 `im-agent-team` 的 DeepSeek Harness 运行时实现。

## 两种模式

| 模式 | 入口 | 能力 |
|---|---|---|
| `dsh-native` | `native.js` | 常驻 Agent / Session、完整工具集、提问/选项、审批、流式、取消 |
| `subagent` | `subagent.js` | 每条消息一个子 Agent；无持久 Session、无提问、cancel 为空实现 |

账号配置：

```jsonc
{
  "id": "director",
  "channel": "feishu",
  "appId": "cli_xxx",
  "chatIds": ["oc_xxx"],
  "runtime": "dsh-native",   // 需要完整能力时
  "fullAccess": true,        // 默认 true
  "role": { "name": "总调度", "mission": "..." }
}
```

## Agent 自助接入（feishu_team_onboard）

DSH Agent 可以直接调用 `feishu_team_onboard`，不需要终端：

| action | 作用 |
|---|---|
| `start` | 启动飞书官方扫码，返回授权链接 |
| `status` | 查询进度；扫码完成后自动启动新账号的 channel/controller |
| `reload` | 重新读取 `config.json`，启动尚未启动的账号 |
| `list` | 查看已启动账号 |

一次扫码完成后，新 bot 会立即出现在 `controllers` 中，可以直接在飞书群里 @ 它。Qoder 侧对应的是 `feishu_onboard` / `feishu_connect`，行为一致。

## 完全权限（fullAccess）

`fullAccess: true`（默认）时，`DshRuntime` 会：

- **不再 restrict 工具集**：Bot 拥有 DSH 的完整工具，包括文件、终端、web、subagent、goal、todo、plan、schedule、plugin manager 等；
- 注册 `user-questions/request` answerer：`ask_user_question` 会转成飞书消息/选项，等待用户回复；
- 注册 `approval/request` answerer：审批直接 `allowed-once`；
- 尝试把会话的 permission preset 切到 `danger-full-access`；
- 保留 `team_handoff` / `team_roster`。

`fullAccess: false` 时恢复受控模式：deny 掉大部分全局工具，只保留团队工具。

> ⚠️ 完全权限等于把 Host 的文件/终端/插件能力交给群里的 Bot。只应在可信群、可信用户范围内开启；群消息仍按“数据而非指令”处理。

## 提问/选项

`ask_user_question` 走 DSH 的 `user-questions/request` waterfall：

1. Agent 调用 `ask_user_question`；
2. `DshRuntime` 的 answerer 调用 `TeamController.askUserQuestions`；
3. 飞书发送：

```
❓ 选择范围
这次做多大范围？

1. 全部
2. 核心
回复序号或选项文字。
```

4. 用户回复 `2` 或“核心”，`TeamController` 解析后返回：

```json
{ "answers": [{ "id": "scope", "selected": ["核心"] }] }
```

支持：

- 单选：回复序号或选项文字；
- 多选：回复 `1,3`；
- 无选项：直接回复文本，作为 `custom`；
- 多问题：逐个提问；
- 超时：默认 `team.questionTimeoutMs`，10 分钟；
- 取消：`signal` abort 或账号 `/stop`。

## 审批

完全权限下，`approval/request` 直接返回 `allowed-once`，不会询问用户。受控模式下没有审批 answerer，审批按 DSH 的 fail-closed 语义处理。

## 已知限制

- `dsh-native` 在当前 DSH 版本仍受根 Agent 收流异常影响（`DeepSeek Messages transport failed`）；实际联调使用 `subagent` 兜底。
- `subagent` 不支持工具、提问、审批，且 `cancel()` 为空实现；它只适合纯文本兜底。
- 飞书选项目前是文本序号，不是 interactive card 按钮；卡片按钮需要额外接 `card.action.trigger`。
- 完全权限下 `permissionPresets.set` 需要 `agent.session`；若 Host 不暴露 session，会跳过 preset 切换，但审批仍放行。

## 测试

```bash
node --test test/unit.test.js test/controller.test.js test/memory.test.js test/native-interactions.test.js test/onboard.test.js test/dsh-plugin.test.js
```
