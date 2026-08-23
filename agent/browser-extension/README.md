# AI锦衣卫 Chrome / Edge Browser Source MVP

这个目录提供一个 Chrome 和 Edge 都能加载的 Manifest V3 扩展。它与 Windows Agent 使用同一套 `POST /api/agent/events` 事件接口：

- 采集当前标签页的域名；
- GitHub、GitLab、Notion、Figma、ChatGPT、Codex、Jira、Linear、Trello、Asana、ClickUp、飞书、钉钉、Slack、Teams 只生成有限的来源/项目提示；
- 每 30 秒用同一个 `event_id` 更新活动时长；
- 不上传完整 URL、查询参数、网页正文、聊天正文、键盘内容、剪贴板或截图。

## 在测试电脑上加载

1. 打开 `chrome://extensions` 或 `edge://extensions`。
2. 打开右上角“开发者模式”。
3. 选择“加载已解压的扩展”，选中本目录 `agent/browser-extension/`。
4. 在 Windows Agent 已注册的设备上打开 Agent，点击“生成浏览器配对码”。
5. 打开扩展“详情”→“扩展程序选项”，填入服务地址、配对码和浏览器名称。
6. 保存后切换几个网站，在管理后台点击“立即刷新”。

## 安全边界

Agent 生成的是 10 分钟有效、只能使用一次的浏览器配对码。服务端换取 30 天有效的独立浏览器凭据，扩展只保存该凭据，不保存 Agent 设备 Token。不能把管理员 Token 填入扩展，也不要通过聊天、截图或公开仓库传递任何 Token。
