# 离线验收自测包

本目录是 2026-11-10 设计阶段的可执行验收证据，不是产品实现，也不声称 API、Codex 或 ZCode 已可用。

运行入口：

```powershell
python -B docs/acceptance/run_offline_acceptance.py
```

运行器只导入父项目代码，以固定的 E01/A01/E04/E05 白板快照、假 HTTP opener 和假 CLI 进程驱动边界。它不会读取登录状态、凭据或用户配置，不会调用供应商、不会启动或接触 `127.0.0.1:8791`，也不会写入父项目。HTTP 合同例外仅以 `127.0.0.1` 的系统随机端口监听，并在每个测试结束时 `shutdown` 和 `server_close`。

结果写入本目录：`offline-report.json` 是机器可读报告，`offline-report.md` 是人工摘要。两者把原有 26 项回归、新增模拟测试、浏览器缺口和真实后端状态分开；失败是设计门禁证据，不能改断言把失败解释成通过。

夹具中的 `TEST-ONLY-NOT-A-REAL-KEY` 不是凭据；它只用于验证脱敏与不持久化路径。
