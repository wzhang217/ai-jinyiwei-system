# AI 摘要质量评估

## 目的

用固定的、脱敏的活动元数据样例检查 Qwen Memory Summary 是否仍然符合产品边界：能形成可读的工作主题，保留东八区时间、应用阶段和工作标识，同时不输出 URL、文件路径或正文内容。

样例位于 `server/ai-evals/memory-summary-fixtures.json`，只包含应用名、脱敏项目/操作/状态标签、域名、来源类型和时间序列，不包含键盘、剪贴板、截图、聊天正文、页面正文或文件正文。

## 执行方式

在仓库根目录执行：

```bash
cd server
npm run ai:eval -- --dry-run
```

上面的命令只校验评估集，不调用模型。配置好 `DASHSCOPE_API_KEY` 后，可以运行一次真实评估：

```bash
npm run ai:eval -- --live --output /tmp/ai-jinyiwei-memory-eval.json
```

也可以对已经保存的模型输出重新评估：

```bash
npm run ai:eval -- --outputs /tmp/ai-jinyiwei-memory-eval.json
```

## 发布门槛

- 所有样例状态为 `generated`；
- 标题不能只是单个应用名或域名；
- 摘要包含东八区时间和至少一个活动证据标签；
- 不出现完整 URL、本地路径、页面正文、聊天正文、键盘输入或剪贴板内容；
- 任何样例失败都需要检查 prompt、脱敏输入或模型输出后再发布。

脚本只做自动化门禁，正式版本还应由产品人员抽检 10 条真实但已脱敏的记录，确认主题、时间范围、应用顺序、切换次数、来源类型和不确定性说明没有夸大。
