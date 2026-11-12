# im-agent-team · Qoder Plugin

把 Qoder 接到 `im-agent-team` 的飞书机器人。安装后：

- 在 Qoder 里 `@feishu`（Agent）初始化、查看状态、发送测试消息；
- 用 `/connect` 或 `/status`（命令）执行同样的流程；
- MCP 工具由 `bin/im-agent-team-mcp.mjs` 提供。

## 安装

Qoder IDE：

1. 把本目录打成 zip（根目录直接包含 `.qoder-plugin/`、`agents/`、`commands/`、`skills/`、`bin/`、`.mcp.json`）；
2. **Extensions → Plugins → Add Plugins → Upload Plugin** 选择 zip；
3. 安装后新开任务，输入 `@feishu` 或 `/connect`。

Qoder CLI：

```bash
qoder plugins install C:\path\to\qoder-plugin
qoder plugins list
```

## 当前能力

| 工具/命令 | 状态 |
|---|---|
| `feishu_status` / `/status` | ✅ 读取本机配置、绑定、状态 |
| `feishu_send` | ✅ 通过已配置机器人发文本 |
| `feishu_connect` / `/connect` | 🟡 检查配置并返回 onboarding 命令；尚未直接弹二维码 |
| `feishu_disconnect` | 🟡 仅说明如何停止 connector |
| 实时飞书 ↔ Qoder 长连接 | ⏳ 下一步：connector runtime |

## 为什么不是“@插件”

Qoder 的 `@` 用于选择 **Agent**，`/` 用于选择 Plugin / Skill / Command / Connector。因此本插件同时提供：

- `agents/feishu.md` → `@feishu`
- `commands/connect.md` → `/connect`
- `commands/status.md` → `/status`

## 实时收发的限制

Qoder 的第三方插件没有文档化的“把一条飞书消息注入当前 Qoder 会话”的接口。要实现真正的飞书群机器人，本插件的 connector 需要：

1. 维护飞书 WebSocket；
2. 收到消息后启动/恢复一个 Qoder CLI/SDK 会话；
3. 把结果发回飞书。

这是下一步的实现；当前版本先把控制面（初始化、状态、发送）跑通。

## 依赖

- Qoder CLI 已安装并登录（`qoder -p "只回复 OK"` 可用）；
- 本机已有 `im-agent-team` 配置（`~/.dsh/im-agent-team`），或先运行 `im-agent-team-onboard`。
