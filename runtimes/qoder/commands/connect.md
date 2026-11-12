---
description: 连接当前 Qoder 到飞书机器人（扫码初始化）
---

使用 `im-agent-team` 的 `feishu_connect` 工具完成连接。

步骤：

1. 先调用 `feishu_status`，判断是首次配置还是已有配置。
2. 如果已配置，调用 `feishu_connect` 启动连接器。
3. 如果没有配置，调用 `feishu_connect`（或 `feishu_onboard`）：
   - 它会启动飞书官方扫码并返回授权链接；
   - 把链接原样展示给用户，说明有效期；
   - 不要让用户粘贴 App Secret。
4. 用户扫码/确认后再次调用 `feishu_status`；看到 `扫码接入：done` 或已配置后，再次调用 `feishu_connect` 启动连接器。
5. 确认连接器 `running`，告诉用户到飞书群里 @ 机器人。

不要自行编造 App ID、App Secret 或群 ID。
