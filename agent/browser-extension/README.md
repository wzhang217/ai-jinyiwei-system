# AI锦衣卫 Chrome / Edge Browser Source MVP

这个目录提供一个 Chrome 和 Edge 都能加载的 Manifest V3 扩展。它与 Windows Agent 使用同一套 `POST /api/agent/events` 事件接口：

- 采集当前标签页的域名；
- GitHub、GitLab、Notion、Figma、ChatGPT、Codex、Jira、Linear、Trello、Asana、ClickUp、飞书、钉钉、Slack、Teams 只生成有限的来源/项目提示；
- 每 60 秒用同一个 `event_id` 更新活动时长；
- 不上传完整 URL、查询参数、网页正文、聊天正文、键盘内容、剪贴板或截图。

## 在测试电脑上加载

1. 打开 `chrome://extensions` 或 `edge://extensions`。
2. 打开右上角“开发者模式”。
3. 选择“加载已解压的扩展”，选中本目录 `agent/browser-extension/`。
4. 打开扩展“详情”→“扩展程序选项”。
5. 填入服务地址和当前 Windows Agent 对应的设备 Token。
6. 切换几个网站后，在管理后台点击“立即刷新”。

## 安全边界

这是 MVP 的手动配对方式，设备 Token 只保存在该浏览器的本地扩展存储中。不能把管理员 Token 填入扩展，也不要通过聊天、截图或公开仓库传递设备 Token。正式企业版应由 Agent 生成一次性浏览器配对码，由服务端换取短期扩展凭据。
