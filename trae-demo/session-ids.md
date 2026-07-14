# TRAE Session ID 与截图清单

论坛提交通常需要补充 TRAE 生成过程记录。请把真实 Session ID 填到这里，再复制到作品帖。

## Session ID

| 序号 | 用途 | Session ID |
| --- | --- | --- |
| 1 | 增加 Demo 一键体验模式 | 待填写 |
| 2 | 补齐 GitHub + Docker 评审运行闭环 | 待填写 |
| 3 | 打磨核心工作台演示流程 | 待填写 |
| 4 | 完成参赛提交前质量门禁 | 可选 |

## 截图建议

| 序号 | 截图内容 | 状态 |
| --- | --- | --- |
| 1 | TRAE 会话：实现 Demo 一键体验 / 示例项目 | 待补 |
| 2 | 终端：Docker 运行路径验证或 compose config | 待补 |
| 3 | Woohoo 登录后工作台首页 | 待补 |
| 4 | 创意对话 + 多智能体侧栏 | 待补 |
| 5 | 制作流程 / 管线预览 / 资产库 | 可选 |

## 对应提示词

可直接复制 `trae-demo/key-steps-prompts.md` 中的 4 段“实际迭代任务”提示词，在 TRAE 里分别开会话执行。

## 当前本地验证结果

```text
npm run typecheck                         PASS
cargo check --manifest-path server/Cargo.toml PASS
npm run build                             PASS
GET http://127.0.0.1:8080/health          status: ok
GET http://127.0.0.1:1420/                200
```
