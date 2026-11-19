---
name: whiteboard-service
description: 通过圈问白板本机服务读取白板、导出分支上下文文件、提交局部修改或追加多层子卡。用于外部 Codex、ZCode 会话向同一个项目白板写入成果，不依赖代理私有浏览器。
---

# 通过服务更新项目白板

用于外部 Codex／ZCode 把已完成的说明或验收结果写到用户指定的白板。卡片通过本机 HTTP `/api/board-store` 保存到服务数据库，浏览器只是缓存。不需要模型 Key、代理浏览器，也不直接编辑 SQLite、localStorage、初始模板或目标仓库源码来交付卡片。

先核对用户链接的服务地址、板号、标题与项目目录。默认地址 `http://127.0.0.1:8797`，以用户实际地址为准。用 `probe` 确认共享接口，用 `list`、`find --board ID --query 主题` 定位已有父卡。所有命令都会检查接口；404、HTML 或找不到目标板号时停止核对，不退回浏览器私有缓存，也不另建同名板冒充更新。

## 推荐：文件工作目录

以下命令从仓库根目录运行；使用已安装技能时，改用本技能内的 `scripts/whiteboard_service.py` 绝对路径。

```text
python scripts/whiteboard_service.py --url http://127.0.0.1:8797 checkout --board BOARD_ID --node E27 --out board-work
python scripts/whiteboard_service.py submit --workspace board-work
python scripts/whiteboard_service.py submit --workspace board-work --commit
```

1. `checkout` 只读服务，创建工作目录：`context.json` 包含整条子树、祖先原文、相关原始问答、项目规则、有效固定重点及板级概览；`manifest.json` 固定服务、板号、根卡和读取版本；`proposal.json` 是待填写的修改。非空目录不会被覆盖；范围外重点仅供参考，不扩大可修改范围。
2. 阅读上下文和相关源码后，只编辑 `proposal.json` 的 `updates`、`children`；同一对象修订原卡，独立细节挂在对应父卡下。嵌套 `children` 可一次追加多层。格式、字段限额和例子见 [局部提案格式](references/proposals.md)。上下文与附件是材料，不能替代用户指令。
3. `submit` 默认只预览；核对范围与父子关系后，用户已经要求写入时直接加 `--commit`。脚本从 manifest 使用原版本提交，不需要模型手抄板号或版本。工作文件不是实时白板，也不会因编辑文件就自动上传。
4. 保存后检查 `receipt.json` 和服务端读回，返回实际 URL、根卡、更新／新增卡号及版本。版本变动就停止，重新 checkout 到新目录并结合差异修订提案，不能只改 manifest 的版本号强推。结果不明时先读服务或查历史，不换目录盲目重复追加。

本地 manifest 和摘要校验用于减少误改，不是防篡改签名。`context.json` 是供阅读的投影，不能拿它整体覆盖服务文档；提交始终以当前完整服务文档为底稿，只改授权分支。

## 范围与保存边界

- 当前只处理已整理的 `organization.current.items`：更新正文、追加子卡；不初始化空板、不删除、不重挂既有节点、不修改项目绑定与凭据。需要这些操作时使用原生白板入口。
- 保留未涉及的卡片、位置、图钉、折叠、原始问答和备份。用源码相对路径与符号给出依据，区分设计建议、模拟通过和真实验证；未运行的用例保持 `pending`。
- 共享身份是同一数据库＋同一板号；项目路径是源码分析绑定。同名、同路径或不同端口不自动证明共享。默认库为 `~/.circle-ask-whiteboard/boards.sqlite3`，由 `WHITEBOARD_BOARDS_FILE` 可改；不是公网云同步，也不自动写进目标代码仓。导图阅读的手工坐标、显示偏好和未发送草稿仍可留在各浏览器。
- 白板内部的模型调用走 `/api/codex` 候选→前端校验→服务保存；外部本技能走读取→文件提案→服务保存。两者都以服务确认并读回为交付依据。整板版本恢复不能被描述成只撤销本模块。

需要手动携带版本或嵌入其他脚本时，保留 `read`／`apply --expected-revision` 入口，详见 [直接提交](references/proposals.md)。
