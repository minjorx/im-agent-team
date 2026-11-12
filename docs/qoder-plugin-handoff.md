# Qoder 纯插件接入 · 交接文档

> 目标读者：接手继续尝试 Qoder 插件接入的 Agent / 开发者
> 时间：2026-11-12
> 结论先行：**个人开发者可以开发、上传、上架 Qoder 插件；但“插件直接驱动 Qoder 聊天会话”的 Plugin SDK 没有公开文档。** 纯插件 + 扫码 + 实时飞书，卡在这里，不是卡在插件开发入口。
>
> **2026-11-12 更新（路径 B 已落地）**：插件内已改用 `@qoder-ai/qoder-agent-sdk` + Qoder 安装目录自带的 worker runtime；`qodercliAuth()` 复用本机登录态。用户不需要安装 Qoder CLI，飞书消息会创建独立 Qoder session 并回复到飞书。Plugin SDK 的 `chatSessions.submitRich` 仍没有公开的清单声明方式，因此“把飞书消息注入当前 Qoder 聊天窗口”仍不可用。
>
> 交互层也已落地：`canUseTool` / `onElicitation` 已接入飞书卡片和文本回退；`AskUserQuestion` 单选/多选答案通过 `updatedInput.answers` 回填；`/mode`、`/plan`、`/model`、`/stop`、`/sessions`、`/models`、`/usage`、`/goal`、`/status` 已实现；`/mode bypass` 需要二次确认，并按 TTL 自动回退到 `plan`。

## 1. 目标

普通用户在 Qoder 里：

1. 安装 `im-agent-team` 插件；
2. 在会话里 `@feishu` 或 `/connect`；
3. 扫码创建/绑定飞书机器人；
4. 在飞书群里 @ 机器人，Qoder 处理并回复到飞书；
5. 全程不需要终端、不需要手动安装/登录 Qoder CLI。

## 2. 当前状态（可复现）

### 2.1 已经跑通

- Qoder IDE 已安装（Windows）。
- Qoder CLI 1.1.87 已安装并登录（仅用于验证，不是目标方案）：
  - `qoder -p "只回复 OK" --output-format json` 返回 `{"result":"OK",...}`
  - `--resume <session_id>` 能记住上一轮内容。
- Qoder 插件 `im-agent-team@local v0.1.0` 已安装并启用：
  - `qoder plugins validate runtimes/qoder`
    - components: `skills 1, agents 1, commands 2, mcp-servers 1`
  - `qoder plugins install runtimes/qoder`
    - `im-agent-team@local v0.1.0`, enabled
  - `qoder plugins list` 可见。
- MCP 控制面已验证：
  - `feishu_status` 能读取本机 3 个机器人、7 个 binding；
  - `feishu_send` 可通过已配置机器人发文本；
  - `feishu_connect` 当前会启动 CLI 连接器（实验性，非目标）。
- 连接器单元测试：6 个通过。
  - `node --test runtimes/qoder/test/connector.test.mjs`

### 2.2 当前插件文件

```
runtimes/qoder/runtime/
├── sdk.mjs                   # Qoder Agent SDK + worker runtime
├── prompt.mjs                # 角色/团队/记忆 prompt
└── worker.mjs                # 消息 → Qoder → 回复

runtimes/qoder/
├── .qoder-plugin/plugin.json
├── agents/feishu.md          # @feishu
├── commands/connect.md       # /connect
├── commands/status.md        # /status
├── skills/feishu-bridge/     # Skill
├── .mcp.json                 # 本地 MCP server
├── bin/im-agent-team-mcp.mjs # 控制面 + 实验性连接器
├── bin/connector-cli.mjs     # 独立启动连接器（开发用）
├── connector/index.mjs       # 飞书 WS + 插件宿主
├── runtime/                  # Qoder Agent SDK 运行时（worker）
├── build.mjs                 # 生成插件 ZIP
└── test/connector.test.mjs
```

### 2.3 历史：CLI 连接器为什么不合格

`runtimes/qoder/connector/index.mjs` 目前：

- 用 `@larksuiteoapi/node-sdk` 维护飞书 WebSocket；
- 收到消息后调用 `runtimes/qoder/runtime/cli.mjs`（`qoder -p ... --output-format json`）；
- 用 `--resume <session_id>` 维持每个群的会话；
- 把结果发回飞书。

它**依赖 Qoder CLI 在 PATH 且已登录**。这不符合“普通用户只装插件、扫码就用”的目标，只能作为开发/验证代码，不应作为最终发布方案。

> 更新：`runtime/sdk.mjs` 已替换上述 CLI 连接器。现在通过 `@qoder-ai/qoder-agent-sdk` 的 `query()` + `WorkerTransport` 驱动 Qoder 安装目录自带的 `qoder-worker-runtime.obf.mjs`，认证用 `qodercliAuth()` 复用 Qoder 本机登录态，不再需要用户安装 Qoder CLI。首次创建飞书应用已由插件内 `feishu_onboard` 覆盖，CLI onboarding 仅保留为备用。

## 3. Qoder 插件不是官方专属

个人开发者入口是存在的：

| 能力 | 入口 | 文档 |
|---|---|---|
| 本地创建/上传插件 | Qoder IDE → Extensions → Plugins → Add Plugins → Create with Qoder / Upload Plugin | [Plugins](https://docs.qoder.com/qoder-plugins) |
| 本地安装 | `qoder plugins install <目录或 zip>` | [插件参考](https://docs.qoder.com/cli/plugins-reference) |
| 公开市场上架（QoderWork） | QoderWork 内提交 → 审核 → 公开市场；“设置 → 我的发布”管理 | [QoderWork 拓展发布指南](https://www.alibabacloud.com/help/zh/lingma/qoderwork-cn/user-guide/qoderwork-extension-release-guide-skill-plugin-connector) |
| Qoder IDE / CN 社区 | <https://qoder.com.cn/marketplace>，提交入口 <https://qoder.com.cn/account/apphub-publications> | 第三方开发者指南（腾讯云 CloudBase）：[qoder-submit.md](https://github.com/tencentcloudbase/cloudbase-ai-toolkit/blob/956cb75bfcecf2184d0da2a61fa0dbaddf8ecc05/plugin/cloudbase/docs/qoder-submit.md) |

注意：

- Qoder IDE 上传/打包**不会自动公开上架**；公开市场需要走 QoderWork 审核或 Qoder CN 的提交入口。
- QoderWork 的 Plugin 在客户端叫“专家套件（Expert Kits）”，格式与 Qoder 插件兼容。
- 官方/合作伙伴插件（Lark、DingTalk 等）只是市场的一部分，不是唯一来源。

## 4. 真正的阻塞：Plugin SDK 没有公开文档

### 4.1 内部确有“插件 SDK 授权”

在 Qoder IDE 的 `app.asar` 中可检索到：

- `pluginSdkConsentService` / `pluginSdkConsent`
- scopes：
  - `workspaces.read`
  - `chatSessions.read`
  - `chatSessions.submit`
  - `chatSessions.control`
- host 方法（节选）：
  - `chatSessions.list`
  - `chatSessions.readSummary`
  - `chatSessions.readHistory`
  - `chatSessions.submitRich`
  - `chatSessions.open`
  - `chatSessions.interrupt`
- 授权对象包含：`credentialFile`、`endpointFile`、`privateKeyPkcs8Pem`、`logicalClientId`、`declaredScopes`、`grantedScopes`。

这说明 Qoder 内部允许插件：

- 读取/提交某个聊天会话；
- 读取历史；
- 控制（中断等）。

### 4.2 但缺少公开 API

- 没有公开文档说明插件如何在 `.qoder-plugin/plugin.json` 里声明 SDK scope；
- 没有公开的 Plugin SDK 客户端/协议文档；
- 没有示例插件使用 `chatSessions.submit`；
- 安装时的“SDK 权限”确认 UI 存在，但只对声明了 SDK 的插件出现。

因此，第三方插件**不能可靠地**把飞书消息注入当前 Qoder 会话。逆向 `endpointFile` / credential 协议可以研究，但不适合生产发布。

## 5. 目标架构（纯插件、无 CLI）

```
飞书 WebSocket
   ↓
Qoder 插件内的 MCP server / daemon
   ↓  Plugin SDK: chatSessions.submitRich / readHistory / open
当前 Qoder 聊天会话（或插件创建的会话）
   ↓
回复 → 飞书
```

插件入口：

- `@feishu`：初始化/状态/发送测试消息；
- `/connect`：扫码绑定；
- `feishu_status` / `feishu_send` / `feishu_disconnect`：MCP 工具。

关键点：

- 插件必须声明并获批 `chatSessions.submit`、`chatSessions.read`；
- 飞书 WS 常驻在插件 MCP server 或 `bin/` 守护进程里；
- 不需要 Qoder CLI，不需要用户终端；
- 二维码由飞书官方 `registerApp` 设备授权流程生成。

## 6. 接手任务清单

### P0：确认 Plugin SDK 的公开/半公开入口

1. 用 Qoder IDE 的 **Plugin Creator** 创建一个“需要读取/提交聊天会话”的插件，观察：
   - 生成的 `plugin.json` 是否有 `sdk` / `permissions` / `scopes` 字段；
   - 安装时是否弹出 SDK 权限确认；
   - 插件安装目录是否出现 credential/endpoint 文件。
2. 在 `app.asar` 中搜索 manifest 解析逻辑：
   - 关键字：`sdkAuthorizationSummary`、`declaredScopes`、`grantedScopes`、`pluginSdkConsent`；
   - 重点看 `plugin.json` 的 schema/validator，而不是 UI。
3. 搜索插件进程的环境变量：
   - `QODER_PLUGIN_ROOT`、`QODER_PLUGIN_DATA` 已知；
   - 继续找 `QODER_PLUGIN_SDK_*`、`PLUGIN_SDK_*`、credential/endpoint 路径。
4. 如果拿到 endpoint/credential 协议，先用最小脚本验证：
   - 列会话；
   - 发一条消息到指定会话；
   - 读回 assistant 回复。

### P1：最小可行插件

1. 在 `runtimes/qoder/` 增加一个 `sdk-bridge.mjs`，只做：
   - `submit(sessionId, text)`；
   - `read(sessionId)`；
   - 失败时返回明确错误。
2. 用 `feishu_status` 暴露 SDK 授权状态。
3. 在 `@feishu` / `/connect` 中区分：
   - SDK 可用 → 纯插件路径；
   - SDK 不可用 → 明确提示，不假装已连接。

### P2：替换 CLI 连接器

> 状态：已完成（2026-11-12）。见 `runtimes/qoder/runtime/sdk.mjs`。

1. `connector/index.mjs` 把 `runQoderCli` 替换为 `runQoderSdk`（`runtime/sdk.mjs`，内部使用 `query()` + `WorkerTransport`）；
2. 保留飞书 WS、去重、会话映射、prompt 构建；
3. 已删除 `runtimes/qoder/runtime/cli.mjs`，避免误用；
4. 在干净机器上验收（只装 Qoder IDE，不装 Qoder CLI）。

### P3：打包与上架

- 插件 ZIP 通过 `cd runtimes/qoder && node build.mjs` 生成；
- ZIP 根目录包含 `.qoder-plugin/`、`agents/`、`commands/`、`skills/`、`.mcp.json`、`runtime/bin`（MCP server）、`runtime/connector`、`runtime/runtime`、`runtime/node_modules`；
- Qoder 安装器会剔除顶层 `node_modules`，所以依赖必须放在 `runtime/node_modules`（官方插件同款布局）；
- 走 QoderWork “设置 → 我的发布”或 Qoder CN `apphub-publications`；
- 写清 SDK 权限用途、飞书权限、隐私说明。

## 7. 验收标准

在**全新 Windows** 上：

1. 只安装 Qoder IDE，不安装 Qoder CLI，PATH 中无 `qoder`（当前实现即按此目标设计；已完成本机实测：无 CLI、无随包下载，使用 Qoder worker runtime 成功完成查询与会话续聊）；
2. 安装插件 ZIP；
3. 新会话 `@feishu` 或 `/connect`；
4. 扫码创建飞书应用/测试群；
5. 在飞书群 @ 机器人发一条消息；
6. Qoder 处理并在 60 秒内回复到飞书；
7. 重启 Qoder 后，同一群继续对话，会话上下文可恢复；
8. 全程没有终端、PAT、`qoder -p`。

## 8. 备选方案

如果 Plugin SDK 短期不公开：

1. **QoderWork 官方 Feishu IM Channel**：扫码、@bot、结果回飞书，无 CLI；但是单 Qoder 会话，不是多 Bot 团队。
   - <https://docs.qoder.com/qoderwork/im-channels>
2. **Qoder Cloud Agents Forward Channel API**：官方 Feishu channel + QR + pairing；云端 Agent，不是本地 IDE 会话。
   - <https://docs.qoder.com/cloud-agents/api/forward/channels/message-channel-integration>
3. **保留外部 runtime adapter（CLI/SDK/ACP）**：最可靠，但用户明确不接受。

## 9. 复现命令

```bash
# 校验/安装插件
qoder plugins validate runtimes/qoder/dist/qoder-plugin
qoder plugins install runtimes/qoder/dist/qoder-plugin
qoder plugins list

# 连接器单测
node --test runtimes/qoder/test/connector.test.mjs

# MCP 控制面 handshake（不启动连接器）
# 依次输入 initialize / tools/list / tools/call feishu_status
node runtimes/qoder/bin/im-agent-team-mcp.mjs
```

MCP 请求示例：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"feishu_status","arguments":{}}}
```

## 10. 注意事项

- 不要在生产插件里硬编码 App Secret、PAT 或群 ID。
- 不要把逆向得到的内部 endpoint 协议直接发布；Qoder 更新会破坏，且有合规风险。
- 插件 ZIP 若包含 `node_modules`，注意体积与许可证；飞书 SDK 是 MIT/Apache 系，Qoder Agent SDK 是 `SEE LICENSE IN LICENSE`，不要打包进 MIT 插件。
- 当前 `runtimes/qoder/connector/` 依赖 Qoder CLI，仅用于验证，不应作为最终交付。
- Qoder 插件 SDK 授权按 scope 生效，未来方法也会在授权范围内；上架时要向用户说明。
