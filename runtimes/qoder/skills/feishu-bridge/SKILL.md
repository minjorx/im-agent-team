---
name: feishu-bridge
description: 在 Qoder 中初始化并管理 im-agent-team 飞书连接；当用户要求连接飞书、查看机器人状态、发送测试消息时使用。
---

# Feishu Bridge

这个 Skill 把 Qoder 接到 `im-agent-team` 的飞书连接器。

## 初始化

1. `feishu_status` 查看是否已有配置。
2. 没有配置时调用 `feishu_connect`，把二维码/授权链接展示给用户。
3. 用户扫码后再次 `feishu_status`，确认连接。

## 使用

- 飞书群里的消息由连接器转成 Qoder 任务，回复发回飞书。
- 当前 Qoder 会话是控制面，不是飞书消息的镜像。
- 不要在对话里保存 App Secret；凭据只在本机状态目录。

## 故障排查

- `feishu_status` 报未配置：运行 `im-agent-team-onboard`。
- 状态为 configured 但 connector offline：启动 `im-agent-team` 连接器，或重启 Qoder。
- 飞书无回复：检查 Qoder CLI 是否已登录，以及机器人是否在群里被 @。
