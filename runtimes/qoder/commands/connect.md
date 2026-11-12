---
description: 连接当前 Qoder 到飞书机器人（扫码初始化）
---

使用 `im-agent-team` 的 `feishu_connect` 工具初始化飞书连接。

步骤：

1. 先调用 `feishu_status`，判断是首次配置还是已有配置。
2. 如果没有配置，调用 `feishu_connect`，把返回的二维码/授权链接原样展示给用户。
3. 用户确认扫码后，再次调用 `feishu_status`，确认 `connected`。
4. 成功后告诉用户：到飞书里 @ 机器人开始工作；本 Qoder 会话只负责连接管理。

不要自行编造 App ID、App Secret 或群 ID。
