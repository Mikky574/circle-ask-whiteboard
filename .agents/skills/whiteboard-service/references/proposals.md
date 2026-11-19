# 局部提案格式与直接提交

`checkout` 工作目录里的 `proposal.json` 可填写 `updates`、`children`，项目概括加 `"structure":"project-summary"`，根卡由 `manifest.json` 固定。下面带 `rootId` 的完整例子适用于直接 `apply` 入口；不能借此改变工作目录的提交范围。

把修改写成 UTF-8 JSON 文件。`rootId` 必须是实际存在的范围根卡，所有更新和新增都留在该分支内。

```json
{
  "rootId": "E27",
  "structure": "project-summary",
  "updates": [{"id": "E27", "summary": "结合新证据修正后的说明；保留仍成立的内容。"}],
  "children": [{
    "ref": "stream",
    "parentId": "E27",
    "title": "事件流如何解码",
    "summary": "写清输入、关键步骤、异常路径和证据。",
    "repositoryFiles": ["server.py"],
    "children": [{
      "ref": "stream-test",
      "title": "分片测试与验收",
      "summary": "列出实际触发方式、可观察断言和验证状态。",
      "spec": {"kind": "case", "id": "TC-STREAM-01", "status": "pending"}
    }]
  }]
}
```

新增卡自动分配 `E` 编号，`ref` 用于回执和本提案的 `parentId:"@stream"` 引用；嵌套 `children` 自动挂在直接父卡下面。项目概括模式会把新增后的活动子卡连同已有子卡一起计数，新增涉及的父卡最多有 4 张直属下级。需要先展示章节、稍后深入时，给新增章节设 `collapsed:true`，原有分支的展开状态保持不变。先预览：

```text
python scripts/whiteboard_service.py --url http://127.0.0.1:8797 apply --board BOARD_ID --expected-revision 12 --file proposal.json
```

核对根卡、受影响卡和新增关系后，用户已经要求写入时直接执行同一命令并加 `--commit --receipt receipt.json`。预览不写服务，不需要为了例行提交再次向用户索要批准。版本号用刚读到的 `revision`。出现版本冲突就停止，重新读取并合并差异；不能用最新版本号盲目重试旧提案。

第一版仅支持已整理的 `organization.current.items`，不删除、不重挂接既有节点、不初始化空板、不修改项目绑定或凭据。更新可写 `title`（100 字）、`summary`（800 字）、`category`、`sources`、`repositoryFiles`、`taskDetails`、`spec`；未提及的属性、位置、固定重点、原始问答和备份保持原样。讨论卡 `A` 的就地正文会使用原生 `localContent` 显示，保留原回答记录。新增卡可附 `position:{"x":100,"y":200,"width":320}`，只定位新卡；大量新增后在白板中仅对新分支快速重排。

新增主题卡可设置 `collapsed:true`，先显示主题，再逐级展开细节。返回链接会定位到首张新增卡；仅更新时定位范围根卡。打开卡片深链接会临时展开祖先，点「回到总览」恢复原先的折叠。

`taskDetails` 包含 `task`、`dependencies`、`acceptance`，后两者最多 5 项且每项 180 字，至少一项验收标准。`spec.kind` 可为 `requirement`、`constraint` 或 `case`；用例状态仅 `pending`、`mock-pass`、`offline-pass`。尚未运行的验证保持 `pending`。

完成以服务端保存回执和读回为准：返回白板链接、根卡、更新卡号、新增引用到编号的映射及版本号。只预览时明确尚未写入；请求结果不明时先读取服务核对，避免重复追加。服务版本历史保留整板旧版本，不能把它描述成只撤销本模块的操作。
