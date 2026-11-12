# im-agent-team · Qoder Plugin

把 Qoder 接到 `im-agent-team` 的飞书机器人。安装后：

- 在 Qoder 里 `@feishu`（Agent）初始化、查看状态、发送测试消息；
- 用 `/connect` 或 `/status`（命令）执行同样的流程；
- MCP 工具由 `bin/im-agent-team-mcp.mjs` 提供。

## 安装

Qoder IDE：

1. 在 `runtimes/qoder` 里执行 `node build.mjs`，产出 `dist/im-agent-team-qoder-plugin-0.2.0.zip`；
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
| `feishu_status` / `/status` | ✅ 读取本机配置、绑定、连接器状态 |
| `feishu_send` | ✅ 通过已配置机器人发文本 |
| `feishu_connect` / `/connect` | 🟡 有对应账号时启动实验性连接器；无账号时返回 onboarding 命令 |
| `feishu_disconnect` | 🟡 停止实验性连接器 |
| 实时飞书 ↔ Qoder 长连接 | 🟡 已实现实验版，依赖 Qoder CLI；纯插件方案待 Plugin SDK |

## 纯插件目标（未完成）

最终目标是：只装 Qoder IDE + 插件，不装 Qoder CLI，扫码后直接使用。

当前卡点不是插件开发入口，而是 Qoder 的 Plugin SDK 没有公开文档：
内部存在 `chatSessions.submit` / `chatSessions.read` scope，但没有公开声明方式和客户端 API。

交接文档：[docs/qoder-plugin-handoff.md](../../docs/qoder-plugin-handoff.md)

## 为什么不是“@插件”

Qoder 的 `@` 用于选择 **Agent**，`/` 用于选择 Plugin / Skill / Command / Connector。因此本插件同时提供：

- `agents/feishu.md` → `@feishu`
- `commands/connect.md` → `/connect`
- `commands/status.md` → `/status`

## 实时收发（实验版）

`connector/` 已经实现：

1. 维护飞书 WebSocket；
2. 收到消息后调用 `runtime/cli.mjs`（`qoder -p --output-format json`）；
3. 用 `--resume <session_id>` 维持每个群的会话；
4. 把结果发回飞书。

限制：

- 需要 Qoder CLI 在 PATH 且已登录；
- 这是开发/验证实现，不是最终纯插件方案；
- 最终应替换为 Qoder Plugin SDK 的 `chatSessions.submit/read`。

## 打包

`build.mjs` 会生成自包含的插件 ZIP：

```bash
cd runtimes/qoder
node build.mjs
# dist/im-agent-team-qoder-plugin-0.2.0.zip
```

ZIP 内包含：

- `.qoder-plugin/`、`agents/`、`commands/`、`skills/`
- `bin/` MCP server
- `connector/` 飞书 WS
- `runtime/` Qoder CLI 运行时
- `node_modules/` 飞书 SDK
- `.mcp.json`

`connector/index.mjs` 通过 `../runtime/...` 导入运行时，源目录和打包后结构一致。

## 依赖

- 实验连接器：Qoder CLI 已安装并登录（`qoder -p "只回复 OK"` 可用）；
- 纯插件目标：不应依赖 Qoder CLI；
- 本机已有 `im-agent-team` 配置（`~/.dsh/im-agent-team`），或先运行 `im-agent-team-onboard`。
