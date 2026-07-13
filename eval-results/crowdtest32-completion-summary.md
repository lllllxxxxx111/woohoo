# 方舟第 32 期 Agent 长程众测完成记录

生成时间：2026-07-06 01:00 CST

## 任务与轮次

| 任务 | 模型 | 模型 ID | 工具调用 | 最终状态 | 反馈 |
| --- | --- | --- | ---: | --- | --- |
| JVZUMA 项目导出校验与审计功能 | tempest | 967KC | 305 | completed/evaluated | 3 条评分 + 1 条产品反馈 |
| JVZUMA 项目导出校验与审计功能 | raptor | D7YWL | 310 | completed/evaluated | 3 条评分 + 1 条产品反馈 |
| JVZUMA 项目导出校验与审计功能 | umbra | H7ADN | 301 | completed/evaluated | 3 条评分 + 1 条产品反馈 |
| JVZUMA 项目导出校验与审计功能 | saber | Z9KCY | 301 | completed/evaluated | 3 条评分 + 1 条产品反馈 |
| MMLIPQ 可审计实验导出包升级 | tempest | 967KC | 330 | evaluated | 3 条评分 + 1 条产品反馈 |
| MMLIPQ 可审计实验导出包升级 | raptor | D7YWL | 308 | evaluated | 3 条评分 + 1 条产品反馈 |
| MMLIPQ 可审计实验导出包升级 | umbra | H7ADN | 307 | evaluated | 3 条评分 + 1 条产品反馈 |
| MMLIPQ 可审计实验导出包升级 | saber | Z9KCY | 303 | evaluated | 3 条评分 + 1 条产品反馈 |

每个任务的每个模型均超过 300 次工具调用，满足本期长程任务硬性要求。

## 验证结论

- MMLIPQ/tempest：`npm run typecheck`、`npm run test`、`npm run build`、`cargo check --manifest-path server/Cargo.toml` 全部通过，选为本地合入基线。
- MMLIPQ/raptor：前端 typecheck/test/build 通过；cargo check 被 crates.io SSL 依赖下载问题阻断，未定位到源码错误。
- MMLIPQ/umbra：前端 typecheck/test/build 通过；cargo check 同样被依赖下载网络问题阻断。
- MMLIPQ/saber：test 通过，但 typecheck/build/cargo check 均有明确源码错误，不作为合入基线。
- JVZUMA 四个模型：产物偏独立 frontend 结构，本地验证主要被缺失 `@testing-library/jest-dom`/`jsdom` 阻断；作为功能设计参考，不作为合入基线。

## 已合入本地 MVP

- 前端导出包升级：`manifest.json`、文件/资产 SHA-256、`workspace_snapshot.json`、`missing-assets.json`、`VERIFICATION.md`、敏感信息检测和脱敏、导出结果/预检/历史 UI。
- 后端导出审计：新增 `export_audits` migration、导出预检 API、审计记录 API、审计历史查询 API。
- 测试覆盖：新增 `exportAudit.test.ts` 和 `exportBundle.test.ts`，并保留原有 `workspaceMvp.test.ts`。

## 本地最终验证

- `npm run typecheck`：通过
- `npm run test`：通过，7 个测试文件、191 个测试
- `npm run build`：通过
- `cargo check --manifest-path server/Cargo.toml`：通过

