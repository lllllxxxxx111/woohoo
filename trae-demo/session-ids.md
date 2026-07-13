# TRAE Session ID 与截图清单

论坛提交通常需要补充 TRAE 生成过程记录。请把真实 Session ID 填到这里，再复制到作品帖。

## Session ID

| 序号 | 用途 | Session ID |
| --- | --- | --- |
| 1 | 提交材料审查与缺口补齐 | 待填写 |
| 2 | GitHub + Docker 可运行路径验证 | 待填写 |
| 3 | 核心产品体验闭环演示 | 待填写 |
| 4 | 发帖前最终检查 | 可选 |

## 截图建议

| 序号 | 截图内容 | 状态 |
| --- | --- | --- |
| 1 | TRAE 会话：官方要求拆解和提交材料更新 | 待补 |
| 2 | TRAE 会话：Docker 运行路径检查 | 待补 |
| 3 | Woohoo 登录后工作台首页 | 待补 |
| 4 | 创意对话 + 多智能体侧栏 | 待补 |
| 5 | 制作流程 / 管线预览 / 资产库 | 可选 |

## 对应提示词

可直接复制 `trae-demo/key-steps-prompts.md` 中的 4 段提示词，在 TRAE 里分别开会话执行。

## 当前本地验证结果

```text
npm run typecheck                         PASS
cargo check --manifest-path server/Cargo.toml PASS
npm run build                             PASS
GET http://127.0.0.1:8080/health          status: ok
GET http://127.0.0.1:1420/                200
```
