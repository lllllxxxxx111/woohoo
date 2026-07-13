import { readFile } from 'node:fs/promises';
import path from 'node:path';

const base = 'https://sd87fd44849k0md74sh9g.apigateway-cn-shanghai.volceapi.com';
const userId = '674';
const cookie = 'username=admin';
const root = process.cwd();

const entries = [
  {
    taskId: 'PWVLRG',
    model: 'mirage',
    modelId: 'OM5KP',
    image: 'PWVLRG_mirage_validation.png',
    scores: { efficiency: 8, quality: 7, overall: 7 },
    product:
      '本地下载并验证产物：npm run typecheck、npm run test、npm run build 均通过。实现包含 /api/assets/search、/api/assets/{id}/references、删除前引用检查和 force=true 强制删除，并在 AssetLibrary 加入跨项目/标签/引用展示入口。主要不足是标签维护更多依赖前端 metadata 更新，没有像 piston 那样提供独立 tags API；删除阻断返回也偏文本化，前端可读性和结构化处理一般。',
    efficiencyComment:
      '完成效率较高，一轮内覆盖了后端搜索、引用查询、安全删除和前端素材库改造，并能通过前端 typecheck/test/build。追加轮次在平台中仍处 pending，当前评分基于已下载的完成产物。',
    qualityComment:
      '产物基本可用，后端搜索限定当前用户项目，引用能查 storyboard/pipeline，前端也有范围切换、标签筛选和删除前引用提示。短板是标签治理闭环不够独立，metadata merge 的后端保护不如专门接口清晰，删除阻断响应不够结构化。',
    overallComment:
      '整体满足大部分核心目标，工程集成能构建通过，功能链路较完整；但标签维护和错误响应细节仍需补强，所以给中上分。',
  },
  {
    taskId: 'PWVLRG',
    model: 'nebula',
    modelId: 'LODPC',
    image: 'PWVLRG_nebula_validation.png',
    scores: { efficiency: 1, quality: 1, overall: 1 },
    product:
      '该模型运行状态为 stopped，stopReason=is_error。多次下载产物得到空目录或无效压缩包，本地验证文件数为 0，无法运行 typecheck/test/build，也无法检查功能实现。',
    efficiencyComment:
      '任务执行中断，没有可用交付物，后续下载也没有得到有效代码包。',
    qualityComment:
      '产物为空，无法验证任何跨项目搜索、标签、引用关系或安全删除能力。',
    overallComment:
      '没有可用产物，按任务执行中断/交付物为空处理。',
  },
  {
    taskId: 'PWVLRG',
    model: 'piston',
    modelId: 'A1XCY',
    image: 'PWVLRG_piston_validation.png',
    scores: { efficiency: 9, quality: 8, overall: 8 },
    product:
      '本地下载并验证产物：npm run typecheck、npm run test、npm run build 均通过。实现最完整：新增后端跨项目搜索、/api/assets/{id}/references、PUT /api/assets/{id}/tags、默认阻断被引用素材删除并用 409 返回结构化引用列表，force=true 时才允许强制删除。前端 AssetLibrary 支持跨项目/项目筛选、标签编辑、引用分组展示和删除影响确认，且补充了标签/删除辅助测试。',
    efficiencyComment:
      '完成效率高，改动覆盖后端 repo/handler/model/migration、serverApi、AssetLibrary UI 和测试，且验证命令全部通过。',
    qualityComment:
      '核心需求覆盖最好：搜索条件较全，权限通过项目归属过滤；tags 使用 metadata.tags 并做 merge，避免覆盖 favorite/rating/prompt；引用识别覆盖 storyboard 和 pipeline；删除保护前后端都有。仍有一些边界依赖 JSON 字段匹配，真实历史数据的引用识别可能还要补更多样本。',
    overallComment:
      '产物可用性和需求贴合度最高，功能闭环完整，只有引用识别的历史数据兼容性仍有少量风险。',
  },
  {
    taskId: 'PWVLRG',
    model: 'onyx',
    modelId: 'JH0M0',
    image: 'PWVLRG_onyx_validation.png',
    scores: { efficiency: 7, quality: 6, overall: 6 },
    product:
      '本地下载并验证产物：npm run typecheck、npm run test、npm run build 均通过。实现了后端搜索、引用查询和删除前引用计数保护，前端加入标签展示/筛选、引用信息和删除确认。主要问题是标签维护闭环不完整，未看到独立 tags 更新 API；安全删除阻断更偏简单 Validation 文本，结构化引用返回和 UI 操作一致性弱于 piston。',
    efficiencyComment:
      '完成速度快，能接入主要模块并通过前端验证；但实现深度不足，部分目标只做到展示/筛选层。',
    qualityComment:
      '搜索、引用查询和删除保护方向正确，基础可用；但标签治理缺少后端写入闭环，删除阻断响应不够结构化，前端强制删除和后端响应的细节也不够清楚。',
    overallComment:
      '能交付一版可运行功能，但相比高分产物缺少完整标签维护和更可靠的删除保护体验，因此给中等偏上分。',
  },
  {
    taskId: '7VZPUW',
    model: 'mirage',
    modelId: 'OM5KP',
    image: '7VZPUW_mirage_validation.png',
    scores: { efficiency: 8, quality: 8, overall: 8 },
    product:
      '本地下载并验证产物：npm run typecheck、npm run test、npm run build 均通过。实现了 pipeline_manual_reviews 表、review-queue API、review-decision API、retry/cancel/acknowledge 动作、前端 ReviewQueueWorkbench，并补充 pipelineReviewUtils 测试。队列来自真实 pipeline_runs/steps/events/optimizations，不是前端 mock。',
    efficiencyComment:
      '完成效率高，后端持久化、聚合队列、前端工作台和测试都覆盖到，并能通过三项前端验证。',
    qualityComment:
      '整体闭环完整：失败/阻塞步骤聚合、优化建议计数、复核备注、retry/cancel/ack 动作和历史展示都有实现；前端交互也比较完整。仍需在真实运行中继续验证 retry 是否和 orchestrator 的所有边界完全一致。',
    overallComment:
      '功能链路完整且可构建通过，基本满足真实运维/创作流水线复核场景，给高分。',
  },
  {
    taskId: '7VZPUW',
    model: 'nebula',
    modelId: 'LODPC',
    image: '7VZPUW_nebula_validation.png',
    scores: { efficiency: 1, quality: 1, overall: 1 },
    product:
      '该模型运行状态为 stopped，stopReason=is_error。下载产物为空或无效压缩包，本地文件数为 0，无法运行验证命令，也没有可检查的 pipeline 复核实现。',
    efficiencyComment:
      '任务执行中断，没有形成可用交付物。',
    qualityComment:
      '产物为空，无法验证 review queue、人工复核记录、retry/cancel/ack 或前端工作台。',
    overallComment:
      '没有可用产物，按交付失败处理。',
  },
  {
    taskId: '7VZPUW',
    model: 'piston',
    modelId: 'A1XCY',
    image: '7VZPUW_piston_validation.png',
    scores: { efficiency: 9, quality: 8, overall: 8 },
    product:
      '本地下载并验证产物：npm run typecheck、npm run test、npm run build 均通过。实现了 review-queue、review-decision、pipeline_manual_reviews、listStepReviews、前端 ReviewQueue 工作台和较完整的状态/decision 辅助测试。retry 会写入复核记录和 step_retry 事件，cancel 复用 run cancel 状态转换，acknowledge 只留痕。',
    efficiencyComment:
      '完成效率最高之一，后端 API、持久化、前端工作台、类型映射和测试覆盖都较完整。',
    qualityComment:
      '需求贴合度高：队列来源是真实 pipeline 数据，权限/归属、stepId/runId、终态动作、手工复核历史和优化建议都有处理；piston 对 terminal run 仍允许 acknowledge 留痕，这一点比直接拒绝所有动作更符合业务。',
    overallComment:
      '整体是第二个任务里最稳的产物之一，可用性高，边界考虑较充分。',
  },
  {
    taskId: '7VZPUW',
    model: 'onyx',
    modelId: 'JH0M0',
    image: '7VZPUW_onyx_validation.png',
    scores: { efficiency: 8, quality: 7, overall: 7 },
    product:
      '本地下载并验证产物：npm run typecheck、npm run test、npm run build 均通过。实现了 review-queue、manual reviews 表、review-decision、前端 PipelineReviewWorkbench 和相关类型测试，整体方向正确。主要扣分点是后端对 completed/cancelled run 的处理过于一刀切，连 acknowledge 留痕也会被拒绝，和“ack 只记录、不改变状态”的目标不完全一致。',
    efficiencyComment:
      '效率较高，能在现有 pipeline 模块内完成后端 API、前端工作台和测试，并通过验证命令。',
    qualityComment:
      '队列聚合、复核记录、retry/cancel/ack 三类动作都具备，UI 也能展示失败步骤和复核历史；但终态 run 的 acknowledge 边界处理不够合理，部分历史复核查询按 run 粒度而不是更细 step 粒度，验收体验略弱于 piston。',
    overallComment:
      '是可用实现，但边界状态和历史展示细节不如高分产物完整，因此给 7 分档。',
  },
];

async function requestJson(url, options = {}, attempt = 1) {
  const response = await fetch(url, {
    ...options,
    headers: {
      cookie,
      ...(options.headers ?? {}),
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? 45_000),
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    if (attempt < 3 && [500, 502, 503, 504].includes(response.status)) {
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
      return requestJson(url, options, attempt + 1);
    }
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return data;
}

async function submitScores(entry) {
  const responses = [
    { questionId: 3, score: entry.scores.efficiency, comment: entry.efficiencyComment },
    { questionId: 2, score: entry.scores.quality, comment: entry.qualityComment },
    { questionId: 1, score: entry.scores.overall, comment: entry.overallComment },
  ];
  return requestJson(`${base}/api/feedback/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ taskId: entry.taskId, modelId: entry.modelId, responses }),
  });
}

async function submitProduct(entry) {
  const imagePath = path.join(root, 'eval-results', entry.image);
  const imageBytes = await readFile(imagePath);
  const form = new FormData();
  form.append('taskId', entry.taskId);
  form.append('modelId', entry.modelId);
  form.append('userId', userId);
  form.append('content', entry.product);
  form.append('images', new Blob([imageBytes], { type: 'image/png' }), path.basename(imagePath));
  return requestJson(`${base}/api/comments/user-feedback`, {
    method: 'POST',
    body: form,
    timeoutMs: 60_000,
  });
}

async function check(entry) {
  const score = await requestJson(
    `${base}/api/feedback/check?taskId=${encodeURIComponent(entry.taskId)}&modelId=${encodeURIComponent(entry.modelId)}`,
  );
  const product = await requestJson(
    `${base}/api/comments/user-feedback?taskId=${encodeURIComponent(entry.taskId)}&modelId=${encodeURIComponent(entry.modelId)}`,
  );
  return {
    scoreCount: Array.isArray(score.feedback) ? score.feedback.length : 0,
    productCount: Array.isArray(product) ? product.length : 0,
  };
}

for (const entry of entries) {
  console.log(`Submitting ${entry.taskId} ${entry.model}/${entry.modelId}`);
  const scoreResult = await submitScores(entry);
  console.log(`  score: ${JSON.stringify(scoreResult)}`);
  const productResult = await submitProduct(entry);
  console.log(`  product: ${JSON.stringify(productResult)}`);
  const verified = await check(entry);
  console.log(`  verified scoreCount=${verified.scoreCount} productCount=${verified.productCount}`);
}

process.exit(0);
