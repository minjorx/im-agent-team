---
name: feishu-bridge
description: 在 Qoder 中初始化并管理 im-agent-team 飞书连接；当用户要求连接飞书、查看机器人状态、发送测试消息时使用。
---

# Feishu Bridge

这个 Skill 把 Qoder 接到 `im-agent-team` 的飞书连接器。

## 初始化

1. `feishu_status` 查看是否已有配置和扫码进度。
2. 没有配置时调用 `feishu_connect`（或 `feishu_onboard`）：
   - 它会启动飞书官方扫码，返回授权链接；
   - 把链接展示给用户，说明有效期；不要让用户粘贴 App Secret。
3. 用户扫码/确认后再次 `feishu_status`：
   - 看到 `扫码接入：done` 或已配置后，调用 `feishu_connect` 启动连接器；
   - 仍在 `waiting` 时继续等待，不要伪造成功。
4. 确认连接器 `running` 后，告诉用户到飞书群 @ 机器人。

## 使用

- 飞书群里的消息由连接器转成 Qoder 任务，回复发回飞书。
- 当前 Qoder 会话是控制面，不是飞书消息的镜像。
- 不要在对话里保存 App Secret；凭据只在本机状态目录。

## 权限与交互

- 在飞书群里 @ 机器人发送 `/mode`、`/plan`、`/model`、`/stop`、`/sessions`、`/models`、`/usage`、`/goal`、`/status`。
- 工具审批和 `AskUserQuestion` 会以飞书卡片或文本出现；只有发起人可以操作。
- `/mode bypass` 是完全访问，必须先确认，并会在配置的 TTL 后自动回退到 `plan`。

## 故障排查

- `feishu_status` 报未配置：调用 `feishu_connect` 启动扫码；不需要终端。
- 扫码链接过期：再次调用 `feishu_connect` 重新发起。
- 状态为 configured 但 connector offline：调用 `feishu_connect`。若提示找不到 worker runtime，确认 Qoder 安装完整并已登录；也可设置 `QODER_WORKER_RUNTIME`。
- 飞书无回复：确认 Qoder 已登录；检查机器人是否在群里被 @。
