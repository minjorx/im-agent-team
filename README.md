# im-agent-team

把不同终端 / 智能体 / 会话中的 AI Agent，以独立机器人身份接入同一个飞书群，让它们在群里分工、交接、协作。

- AI 工具端：DSH（首版）
- 消息端：飞书（首版）
- 设计文档：[飞书多机器人协作适配层](docs/feishu-multi-agent-bridge-design.md)
- 实现记录：[实现说明与联调记录](docs/implementation-notes.md)

## 当前状态

首版已实现，并在真实飞书租户完成多 Bot 联调：

- 飞书长连接收发、绑定/动态群绑定、名册、角色卡、命令、交接协议、防环。
- 真实协作链路：总调度 → 调研员（真实模型）→ 总调度 → 用户；`result` 回执不触发下一跳。
- 21 个本地测试通过。
- 运行时：`dsh-native`（常驻 Agent，受当前 DSH 根 Agent 收流问题影响）与 `subagent`（每条消息一个子 Agent，已验证可用）。
- 扫码创建机器人：`im-agent-team-onboard`（飞书官方 `registerApp` 设备授权流程）。

## 架构与目录（core + adapters）

代码已按“与平台/Agent 无关的 bridge-core + 可替换适配层”分层：

```
lib/
├── bridge-core/           # 协议、名册、角色、记忆、防环、控制器
├── channels/feishu/       # 飞书渠道适配层
├── channels/mock/         # 测试渠道
├── runtimes/dsh/          # DSH 运行时适配层（native + subagent）
└── runtimes/qoder/        # Qoder 运行时适配层（实验：CLI）
```

目标矩阵：

| 运行时 \ 渠道 | 飞书 | 其他渠道 |
|---|---|---|
| DSH | ✅ 首版 | 新增 channel 即可 |
| Qoder | ✅ 可通过 Agent SDK / ACP / CLI 接入（待实现） | 后续 |
| Claude Code / Codex 等 | 新增 runtime 即可 | 两者分别扩展 |

- 渠道契约与运行时契约见 [docs/adapters.md](docs/adapters.md)。
- Qoder 接入可行性：[docs/qoder-integration.md](docs/qoder-integration.md)（结论：支持，推荐 Agent SDK，ACP 备选，CLI 用于 POC）。
- 命名：包名定为 **`im-agent-team`**（IM + Agent + Team），内部核心目录为 `bridge-core`。npm 上 `agent-team` 已被占用，`im-agent-team` 当前可用；npm 注册暂不作为发布前提。

## Qoder 插件

`qoder-plugin/` 是同一套桥接层的 Qoder 插件形态：

- `@feishu`：初始化、查看状态、发送测试消息；
- `/connect`、`/status`：命令入口；
- MCP 工具：`feishu_status`、`feishu_connect`、`feishu_send`、`feishu_disconnect`。

安装：

```bash
qoder plugins install C:\path\to\im-agent-team\qoder-plugin
qoder plugins validate C:\path\to\im-agent-team\qoder-plugin
```

或在 Qoder **Extensions → Plugins → Add Plugins → Upload Plugin** 上传 `im-agent-team-qoder-plugin-0.1.0.zip`。

当前控制面已可用（状态/发送/连接引导）；实时连接器是依赖 Qoder CLI 的实验版，纯插件方案待 Qoder Plugin SDK。详见 [qoder-plugin/README.md](qoder-plugin/README.md) 和 [Qoder 纯插件交接文档](docs/qoder-plugin-handoff.md)。

## 安装方式

### 1. 从 npm 安装（推荐，需已发布）

```bash
dsh plugin --profile desktop add im-agent-team
```

### 2. 从 GitHub 安装

```bash
dsh plugin --profile desktop add github:minjorx/im-agent-team
```

要求：能访问 GitHub。pnpm 也接受 `git+https://...#<commit>` 形式。

### 3. 离线 tarball（适合只能访问 npm、不能访问 GitHub 的环境）

在一台有网络的机器上：

```bash
pnpm pack
# 产出 im-agent-team-0.2.0.tgz
```

把 tgz 传到目标机器后：

```bash
dsh plugin --profile desktop add ./im-agent-team-0.2.0.tgz
```

注意：pnpm 仍会从 npm registry 解析 `@larksuiteoapi/node-sdk` 和 `qrcode` 两个依赖。目标机器只要能访问 npm（或 npmmirror 等镜像）即可；如果连 npm 也不通，见下方“完全离线”。

### 4. 本地目录（开发/内网共享）

```bash
dsh plugin --profile desktop add C:\path\to\im-agent-team
# 或 Linux/macOS
dsh plugin --profile desktop add /opt/im-agent-team
```

### 完全离线

`dsh plugin add` 通过 pnpm 安装依赖，因此“完全断网”需要满足其一：

1. 内网 npm 镜像（Verdaccio、Nexus、npmmirror 私有代理），把 registry 配到 pnpm；
2. 预填充目标 profile 的 pnpm store，并让 pnpm 使用 `--offline`（插件管理器不直接暴露该参数，需要预置 profile 依赖后启动）；
3. 把依赖一起打成一个内网分发包，由内网源安装。

不建议手工把包复制进 profile 的 `node_modules` 后改 `package.json`，这会绕过插件管理器的兼容性校验与锁文件。

## 扫码创建机器人

安装后运行 onboarding CLI（首次使用需要先允许扫码授权）：

```bash
# 已发布到 npm 时
npx im-agent-team-onboard --name "DSH Assistant" --id assistant

# 本地开发时
node bin/onboard.mjs --name "DSH Assistant" --id assistant
```

流程：

1. 终端打印二维码，同时把二维码写到 `$DSH_HOME/im-agent-team/onboard-qr.png`；
2. 手机飞书扫码，在确认页同意创建；
3. 官方 `registerApp` 返回 App ID / App Secret；
4. 凭据写入 `$DSH_HOME/im-agent-team/feishu-apps.json`；
5. 自动创建「<应用名> 测试群」并把扫码人拉进去；
6. 新账号追加到 `$DSH_HOME/im-agent-team/config.json`；
7. 重载插件（或重启 DSH）后，新机器人即可在群里被 @。

可选参数：`--no-group` 只创建应用、不建群。

## 插件市场

当前 DSH 构建**没有内置的官方插件市场索引**（`plugin_market` 的 `indexes` 为空），也不存在“上传到官方市场”的公开接口。可用路径：

1. **npm 直装**：发布到 npm 后，用户直接 `dsh plugin add im-agent-team`；
2. **自建市场索引**：DSH 支持用户配置一个 format 1 的插件市场 JSON 索引 URL（Settings → Plugins → Discover 可添加），把本包写进索引即可被搜索/安装；索引可放在任意 HTTPS 静态托管上；
3. **GitHub Release**：发布 tgz 附件，用户下载后按“离线 tarball”安装。

如果 DeepSeek 后续开放官方市场提交入口，再按官方格式提交；本仓库不假设存在该入口。

## 配置

- 运行配置：`~/.dsh/im-agent-team/config.json`
- 应用凭据：`~/.dsh/im-agent-team/feishu-apps.json`（不会进仓库）
- 扫码结果：`~/.dsh/im-agent-team/onboard-result.json`
- 二维码：`~/.dsh/im-agent-team/onboard-qr.png`

群绑定是动态的：机器人被拉进新群后，收到第一条 @ 消息会自动创建 binding，不需要改配置；`config.json` 里的 `chatIds` 只是初始绑定。

## 角色定位与工作方式

每个 bot 的角色独立配置。三种入口：

1. **终端 CLI**（不需要打开飞书）：

```bash
im-agent-team-role \
  --id director \
  --name 总调度 \
  --mission "接需求、拆任务、最终交付" \
  --responsibilities "理解目标;拆解任务;汇总交付" \
  --handoff-to "调研员;撰稿人" \
  --constraints "不替其他机器人干活;不泄露凭据"
```

`--inputs`、`--outputs`、`--behavior` 同样用 `;` 或 `|` 分隔。`--show` 只读查看，`--app-id` 可按 App ID 定位。

2. **群内命令**：`@机器人 /role <职责描述>` 更新使命，并广播角色卡给其他机器人。

3. **配置文件**：`~/.dsh/im-agent-team/config.json` 的 `accounts[].role`。

### 默认工作方式（可用 `--behavior` 覆盖或追加）

- **先评估任务**：目标、范围、输入、交付物、时限是否清楚合理；不合理、信息不足或与角色冲突时，先向上游/用户说明理由、风险和建议方案，再决定是否执行，不盲目迎合。
- **主动补齐前置**：缺材料、数据、权限或依赖时，明确列出需要什么、为什么、何时需要；阻塞时及时升级，不静默等待。
- **主动推进**：收到任务先确认，过程中给简短进展，完成后主动交付并说明产物位置，不等催。
- **像真正的同事**：有 ownership、结论先行、诚实说明不确定性、对结果负责、不编造、不甩锅。

这些约束会注入每个 bot 的角色提示词（`dsh-native` 的系统提示分段，以及 `subagent` 运行时的每条消息提示），不是建议而是硬性要求。

## 记忆

- `dsh-native`：DSH 自身的持久 Session 提供完整对话记忆；桥接层再叠加“团队记忆”。
- `subagent`：每条消息是独立子 Agent，桥接层用**持久团队记忆 + 最近 6 条对话摘要**保持连续性。
- 团队记忆按 `appId + chatId` 隔离，落盘在 `state.json` 的 `bindings[].memory`，最多 80 条、摘要 3000 字。
- 自动记录：收到的任务、模型产出、角色变更决策。
- 手动记录：`/remember <内容>`；查看：`/memory`；清空：`/forget`。

## 开发

```bash
pnpm install
node --test test/unit.test.js test/controller.test.js
node --check index.js
pnpm pack
```

## 发布清单

1. 把 `package.json` 的 `repository` / `homepage` / `bugs` 补成实际仓库地址；
2. 确认 `engines.dsh` 与目标 DSH 版本一致（当前 `>=0.2.1-rc.3 <0.3.0`）；
3. `npm publish --access public`（包名 `im-agent-team` 未被占用时）；
4. `git tag v0.1.0 && git push --tags`；
5. 在 GitHub Release 附上 `pnpm pack` 生成的 tgz；
6. 如需市场索引，发布一个 format 1 的 `index.json` 并让用户添加 URL。
