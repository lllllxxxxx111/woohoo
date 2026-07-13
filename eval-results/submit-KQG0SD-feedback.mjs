import { readFile } from 'node:fs/promises';
import path from 'node:path';

const base = 'https://sd87fd44849k0md74sh9g.apigateway-cn-shanghai.volceapi.com';
const taskId = 'KQG0SD';
const userId = '674';
const root = process.cwd();
const cookie = 'username=admin';

const models = [
  {
    name: 'piston',
    modelId: 'A1XCY',
    image: path.join(root, 'eval-results', 'KQG0SD_piston_validation.png'),
    scores: { efficiency: 8, quality: 4, overall: 5 },
    product:
      '前端验证通过：npm run typecheck、npm run test、npm run build 均成功，测试为 5 个文件 143 个用例通过。后端 cargo check --manifest-path server\\Cargo.toml 失败，核心错误是 server/src/billing/budget_enforce.rs 中 check.window 被 unwrap_or 移动后又借用，触发 E0382。因此当前服务无法编译启动，预算拦截功能不能端到端验收。',
    efficiencyComment:
      '模型交付效率较高，能在一轮中完成数据库 migration、预算 repo/enforce helper、后端 API、chat/task/image/video 拦截点、Settings 预算页、WarningBar 和前端 API 接入，覆盖面是四个产物里最完整的。缺点是交付前没有完成 Rust 编译验证，留下了明显所有权错误。',
    qualityComment:
      '产物形态完整，UI 和前端 API 设计比较细，前端三项验证全部通过；后端也考虑了 block history、高成本任务阈值和预算刷新事件。但核心后端无法通过编译，且预算消耗来源使用 credit_transactions，与题目要求“使用 ai_usage_events.total_tokens 聚合，1000 token = 1 积分”不一致。因此功能设计有亮点，但当前不可直接使用。',
    overallComment:
      '综合表现是本轮中相对最完整的一个，但因为 Rust 编译失败，预算控制无法真实运行；同时消耗来源选错会导致业务口径偏离题目要求。若修复所有权错误并改为基于 ai_usage_events.total_tokens 统计，再补充后端验证，才有可验收价值。',
  },
  {
    name: 'onyx',
    modelId: 'JH0M0',
    image: path.join(root, 'eval-results', 'KQG0SD_onyx_validation.png'),
    scores: { efficiency: 7, quality: 4, overall: 4 },
    product:
      '前端验证通过：npm run typecheck、npm run test、npm run build 均成功，测试为 5 个文件 143 个用例通过。后端 cargo check --manifest-path server\\Cargo.toml 失败，主要错误包括引用不存在的 crate::auth::extractors::AuthenticatedUser，以及 /api/billing/budget 路由注册时 Axum state 类型不匹配。因此预算 API 不能在真实服务中运行。',
    efficiencyComment:
      '模型完成速度较快，能实现预算配置、状态查询、设置页 UI、错误识别和 AI chat/task 的预算检查，并且使用了题目要求的 /api/billing/budget API 方向。问题是集成前没有核对现有认证和 Axum state 模式，导致基础编译失败。',
    qualityComment:
      '优点是预算消耗来源使用了 ai_usage_events.total_tokens 并按 1000 token = 1 积分换算，比较符合题目要求；前端构建也通过。但后端引入了不存在的认证 extractor，路由 handler state 类型也和项目现有 AppState 不匹配，说明没有充分阅读现有服务结构。当前产物无法启动，且图像/视频等高成本入口覆盖不足。',
    overallComment:
      '模型对需求口径理解较好，特别是用量来源选择正确；但工程集成质量不足，后端编译失败让核心功能不可用。整体比只做 UI 或只做流水统计的方案更接近题意，但还需要修复认证、路由 state 和拦截点覆盖后才能继续验收。',
  },
  {
    name: 'mirage',
    modelId: 'OM5KP',
    image: path.join(root, 'eval-results', 'KQG0SD_mirage_validation.png'),
    scores: { efficiency: 7, quality: 3, overall: 4 },
    product:
      '前端验证通过：npm run typecheck、npm run test、npm run build 均成功，测试为 5 个文件 143 个用例通过。后端 cargo check --manifest-path server\\Cargo.toml 失败，错误是 server/src/budget/repo.rs 使用 now.year() / now.month() 但没有引入 chrono::Datelike，触发 E0599。当前后端无法编译。',
    efficiencyComment:
      '模型产出速度尚可，也覆盖了 migration、预算 repo/API、设置页和 chat/task/image/video 入口，说明执行路径比较完整。但它没有把验证闭环做到 Rust 编译通过，且 API 命名偏离题目指定路径。',
    qualityComment:
      '前端部分可以通过构建和测试，设置页也能展示预算状态；后端失败点本身可能较容易修复。但实现存在两个明显需求偏差：新增接口使用 /api/budget/status、/api/budget/settings，不是题目要求的 GET/PUT /api/billing/budget；预算消耗来源使用 credit_transactions，不是 ai_usage_events.total_tokens。这些会影响真实业务验收。',
    overallComment:
      '整体完成了一个预算控制雏形，但后端不可编译，且核心 API 形状和用量口径都偏离要求。即使修复 Datelike 导入，也仍需调整 API 路径和预算统计来源，因此综合分偏低。',
  },
  {
    name: 'nebula',
    modelId: 'LODPC',
    image: path.join(root, 'eval-results', 'KQG0SD_nebula_validation.png'),
    scores: { efficiency: 6, quality: 3, overall: 3 },
    product:
      '前端验证通过：npm run typecheck、npm run test、npm run build 均成功，测试为 5 个文件 143 个用例通过。后端 cargo check --manifest-path server\\Cargo.toml 失败，错误是 server/src/billing/budget_model.rs 访问 UserBudgetSettingsRow.month_limit，但结构体实际字段不匹配，触发 E0609。当前后端无法编译。',
    efficiencyComment:
      '模型完成了预算 API、设置页和部分拦截逻辑，但耗时和工具调用相对更多，最终仍没有通过 Rust 编译。整体执行比较勤快，但收敛质量一般。',
    qualityComment:
      '接口路径基本使用了 /api/billing/budget，前端构建通过，也有预算事件表和设置 UI。但后端字段名不一致导致编译失败；预算消耗同样基于 credit_transactions，没有按题目要求从 ai_usage_events.total_tokens 聚合；部分拦截逻辑用 if let Ok(gate) 包裹，预算检查出错时可能直接放行，风险较大。',
    overallComment:
      '产物有一定结构，但关键路径不可编译，并且预算统计口径和错误处理都不够可靠。相比其他模型，它的 API 方向还可以，但工程质量和业务准确性不足，综合只能给较低分。',
  },
];

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      cookie,
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return data;
}

async function submitScores(model) {
  const responses = [
    { questionId: 3, score: model.scores.efficiency, comment: model.efficiencyComment },
    { questionId: 2, score: model.scores.quality, comment: model.qualityComment },
    { questionId: 1, score: model.scores.overall, comment: model.overallComment },
  ];

  return requestJson(`${base}/api/feedback/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ taskId, modelId: model.modelId, responses }),
  });
}

async function submitProductFeedback(model) {
  const imageBytes = await readFile(model.image);
  const form = new FormData();
  form.append('taskId', taskId);
  form.append('modelId', model.modelId);
  form.append('userId', userId);
  form.append('content', model.product);
  form.append('images', new Blob([imageBytes], { type: 'image/png' }), path.basename(model.image));

  return requestJson(`${base}/api/comments/user-feedback`, {
    method: 'POST',
    body: form,
  });
}

async function checkSubmitted(model) {
  const score = await requestJson(
    `${base}/api/feedback/check?taskId=${encodeURIComponent(taskId)}&modelId=${encodeURIComponent(model.modelId)}`,
  );
  const product = await requestJson(
    `${base}/api/comments/user-feedback?taskId=${encodeURIComponent(taskId)}&modelId=${encodeURIComponent(model.modelId)}`,
  );
  return {
    scoreCount: Array.isArray(score.feedback) ? score.feedback.length : 0,
    productCount: Array.isArray(product) ? product.length : 0,
  };
}

for (const model of models) {
  console.log(`Submitting ${model.name} / ${model.modelId}`);
  const scoreResult = await submitScores(model);
  console.log(`  score result: ${JSON.stringify(scoreResult)}`);
  const productResult = await submitProductFeedback(model);
  console.log(`  product result: ${JSON.stringify(productResult)}`);
  const check = await checkSubmitted(model);
  console.log(`  verified scoreCount=${check.scoreCount} productCount=${check.productCount}`);
}
