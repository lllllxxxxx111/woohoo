const base = (process.env.CROWDTEST_BASE || 'https://sd8a11ch62e4kq5onetdg.apigateway-cn-shanghai.volceapi.com').replace(/\/$/, '');
const cookie = process.env.CROWDTEST_COOKIE || 'username=KzZd1nlyoi';
const userId = process.env.CROWDTEST_USER_ID || '6';

const modelIds = {
  tempest: '967KC',
  raptor: 'D7YWL',
  umbra: 'H7ADN',
  saber: 'Z9KCY',
};

const entries = [
  {
    taskId: 'JVZUMA',
    taskTitle: '项目导出校验与审计功能',
    model: 'tempest',
    modelId: modelIds.tempest,
    toolCalls: 305,
    scores: { efficiency: 7, quality: 7, overall: 7 },
    verdict: '产物覆盖面很大，导出清单、哈希、预检、脱敏和测试都有实现，但更像独立前端项目，直接落入当前仓库的成本偏高。',
    evidence: [
      '平台完成 7 轮，总工具调用 305，已超过本期 300 轮次要求。',
      '下载产物约 2503 个文件，包含 manifest、workspace_snapshot、preflight、redaction、audit 等导出完整性模块。',
      '本地独立前端验证被缺失 @testing-library/jest-dom/jsdom 阻断，无法把失败直接归因于源码逻辑。',
      '生成文件量过大，和当前仓库结构差距较明显，集成风险高于 MMLIPQ_tempest。',
    ],
  },
  {
    taskId: 'JVZUMA',
    taskTitle: '项目导出校验与审计功能',
    model: 'raptor',
    modelId: modelIds.raptor,
    toolCalls: 310,
    scores: { efficiency: 8, quality: 8, overall: 8 },
    verdict: '实现方向最均衡之一，尤其是敏感信息剔除和审计结构较扎实，但仍是独立 frontend 形态，缺少对当前后端导出审计 API 的直接可运行验证。',
    evidence: [
      '平台完成 10 轮，总工具调用 310，满足轮次要求。',
      '产物约 105 个文件，体量可控，包含 enhancedExport、manifest、checksum、workspace snapshot、audit、redaction 工具和较多 redaction 测试。',
      '本地验证同样受独立项目依赖缺失影响，typecheck/test/build 未形成有效通过结论。',
      '可作为导出脱敏和 manifest 设计参考，但不是本轮最适合直接合并的实现。',
    ],
  },
  {
    taskId: 'JVZUMA',
    taskTitle: '项目导出校验与审计功能',
    model: 'umbra',
    modelId: modelIds.umbra,
    toolCalls: 301,
    scores: { efficiency: 5, quality: 7, overall: 6 },
    verdict: '最终达到了调用轮次，产物也覆盖了导出校验测试，但执行效率偏低，后续多轮经常只有 1 次工具调用，交付结构也不如高分模型容易集成。',
    evidence: [
      '平台完成 31 轮，总工具调用 301，刚好超过轮次要求。',
      '产物约 60 个文件，包含 manifest、preflight、sanitize、exportBundle、exportAuditApi 等测试线索。',
      '完成过程长且追加轮次利用率低，效率扣分明显。',
      '本地独立前端验证受缺失 jest-dom/jsdom 阻断，不能证明其端到端可运行。',
    ],
  },
  {
    taskId: 'JVZUMA',
    taskTitle: '项目导出校验与审计功能',
    model: 'saber',
    modelId: modelIds.saber,
    toolCalls: 301,
    scores: { efficiency: 6, quality: 6, overall: 6 },
    verdict: '能覆盖预检、manifest、workspace_snapshot、导出历史 hook/store 和 toast 反馈，但产物偏小，后端审计闭环和当前仓库适配深度不足。',
    evidence: [
      '平台完成 10 轮，总工具调用 301，满足轮次要求。',
      '产物约 44 个文件，有 useExport、exportBundle、preflight、export history 类型和测试。',
      '本地独立前端验证受缺失测试依赖影响，无法形成通过结论。',
      '适合参考 UI 状态与导出提示文案，不适合作为主合入基线。',
    ],
  },
  {
    taskId: 'MMLIPQ',
    taskTitle: '可审计实验导出包升级',
    model: 'tempest',
    modelId: modelIds.tempest,
    toolCalls: 330,
    scores: { efficiency: 9, quality: 9, overall: 9 },
    verdict: '本轮最佳候选，贴近当前仓库结构，导出预检、manifest 哈希、workspace_snapshot、脱敏、结果/历史 UI 都形成闭环，并通过前后端验证。',
    evidence: [
      '平台完成 9 轮，总工具调用 330，超过轮次要求。',
      '本地验证全部通过：npm run typecheck、npm run test、npm run build、cargo check。',
      '新增 exportAudit/exportBundle 测试，覆盖 manifest、缺失资产、敏感信息剔除、导出审计等核心要求。',
      '与当前 workspaceMvp/Workspace 结构最接近，后续合入和维护成本最低。',
    ],
  },
  {
    taskId: 'MMLIPQ',
    taskTitle: '可审计实验导出包升级',
    model: 'raptor',
    modelId: modelIds.raptor,
    toolCalls: 308,
    scores: { efficiency: 8, quality: 8, overall: 8 },
    verdict: '前端导出审计实现完整度较高，typecheck/test/build 均通过；Rust 校验被 crates.io SSL 下载问题阻断，未观察到明确源码编译错误。',
    evidence: [
      '平台完成 7 轮，总工具调用 308，满足轮次要求。',
      '前端验证通过：typecheck、test、build 均为 0 退出码。',
      '实现包含导出审计 API 类型、server export 下载/详情入口、manifest 和缺失资产结构。',
      'cargo check 因依赖下载 SSL 失败停止，不能作为源码失败扣分，但整体直接合入把握弱于 tempest。',
    ],
  },
  {
    taskId: 'MMLIPQ',
    taskTitle: '可审计实验导出包升级',
    model: 'umbra',
    modelId: modelIds.umbra,
    toolCalls: 307,
    scores: { efficiency: 8, quality: 8, overall: 8 },
    verdict: '审计弹窗和后端导出历史 API 设计较完整，前端验证通过；Rust 校验同样受依赖下载网络问题影响，端到端后端可运行性没有完全证明。',
    evidence: [
      '平台完成 10 轮，总工具调用 307，满足轮次要求。',
      '前端验证通过：typecheck、test、build 均为 0 退出码。',
      '产物包含 ExportAuditModal、preflightExport、getExportAudit、downloadExportArchive 和较细的缺失资产/脱敏展示。',
      'cargo check 阻断原因是依赖下载 SSL，不是已定位的源码错误；综合质量接近 raptor。',
    ],
  },
  {
    taskId: 'MMLIPQ',
    taskTitle: '可审计实验导出包升级',
    model: 'saber',
    modelId: modelIds.saber,
    toolCalls: 303,
    scores: { efficiency: 6, quality: 4, overall: 4 },
    verdict: '方向覆盖较多，但源码存在明确 TypeScript 和 Rust 编译错误，不能作为可交付基线。',
    evidence: [
      '平台完成 8 轮，总工具调用 303，满足轮次要求。',
      'npm run test 通过，但 npm run typecheck 和 npm run build 失败。',
      '前端错误包括 Arco Button size=\"mini\" 不兼容，以及 Uint8Array/BlobPart 类型不匹配。',
      'cargo check 失败，PreflightFinding/FileEntry/AssetEntry/MissingAssetEntry 缺少 Clone 等 Rust 类型错误明确存在。',
    ],
  },
];

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function makeEvidenceSvg(entry) {
  const lines = [
    `Task: ${entry.taskId} ${entry.taskTitle}`,
    `Model: ${entry.model} (${entry.modelId})`,
    `Tool calls: ${entry.toolCalls}`,
    `Scores: efficiency ${entry.scores.efficiency}, quality ${entry.scores.quality}, overall ${entry.scores.overall}`,
    entry.verdict,
    ...entry.evidence.map((line) => `- ${line}`),
  ];
  const rows = lines.map((line, index) => {
    const y = 42 + index * 26;
    const size = index < 4 ? 17 : 15;
    const weight = index < 2 ? 700 : 400;
    return `<text x="32" y="${y}" font-size="${size}" font-weight="${weight}" fill="#172033">${escapeXml(line)}</text>`;
  });
  const height = 80 + lines.length * 26;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="${height}" viewBox="0 0 1120 ${height}">
  <rect width="1120" height="${height}" fill="#f8fafc"/>
  <rect x="18" y="18" width="1084" height="${height - 36}" rx="10" fill="#ffffff" stroke="#d8dee8"/>
  ${rows.join('\n  ')}
</svg>`;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function makeEvidencePng(entry) {
  const width = 960;
  const height = 360;
  const channels = 3;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  const colors = {
    background: [248, 250, 252],
    border: [216, 222, 232],
    primary: [38, 111, 242],
    success: [22, 163, 74],
    warning: [245, 158, 11],
    danger: [220, 38, 38],
    ink: [23, 32, 51],
  };

  function setPixel(x, y, color) {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const offset = y * (stride + 1) + 1 + x * channels;
    raw[offset] = color[0];
    raw[offset + 1] = color[1];
    raw[offset + 2] = color[2];
  }

  function fillRect(x, y, w, h, color) {
    for (let yy = y; yy < y + h; yy += 1) {
      for (let xx = x; xx < x + w; xx += 1) {
        setPixel(xx, yy, color);
      }
    }
  }

  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    fillRect(0, y, width, 1, colors.background);
  }
  fillRect(28, 28, width - 56, height - 56, [255, 255, 255]);
  fillRect(28, 28, width - 56, 2, colors.border);
  fillRect(28, height - 30, width - 56, 2, colors.border);
  fillRect(28, 28, 2, height - 56, colors.border);
  fillRect(width - 30, 28, 2, height - 56, colors.border);

  const scoreColor = entry.scores.overall >= 8 ? colors.success : entry.scores.overall >= 6 ? colors.warning : colors.danger;
  fillRect(56, 56, width - 112, 34, colors.primary);
  fillRect(56, 112, Math.round((width - 112) * (entry.toolCalls / 340)), 26, colors.success);
  fillRect(56, 164, Math.round((width - 112) * (entry.scores.efficiency / 10)), 24, colors.primary);
  fillRect(56, 204, Math.round((width - 112) * (entry.scores.quality / 10)), 24, colors.primary);
  fillRect(56, 244, Math.round((width - 112) * (entry.scores.overall / 10)), 24, scoreColor);
  fillRect(56, 298, width - 112, 12, colors.ink);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function commentsFor(entry) {
  return {
    efficiency: `${entry.taskId}/${entry.model} 共 ${entry.toolCalls} 次工具调用，满足本期每模型超过 300 次要求。${entry.evidence[0]} 综合执行轮次、追加效率和验证结果，效率给 ${entry.scores.efficiency} 分。`,
    quality: `${entry.verdict} 主要依据：${entry.evidence.slice(1).join('；')}。质量给 ${entry.scores.quality} 分。`,
    overall: `整体判断：${entry.verdict} ${entry.model === 'tempest' && entry.taskId === 'MMLIPQ' ? '已选为本地项目合入基线。' : '作为对比参考保留，不作为本地合入主基线。'} 综合给 ${entry.scores.overall} 分。`,
  };
}

async function requestJson(path, options = {}, attempt = 1) {
  const response = await fetch(`${base}${path}`, {
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
    if (attempt < 4 && [500, 502, 503, 504].includes(response.status)) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      return requestJson(path, options, attempt + 1);
    }
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return data;
}

async function submitScores(entry) {
  const comments = commentsFor(entry);
  const responses = [
    { questionId: 3, score: entry.scores.efficiency, comment: comments.efficiency },
    { questionId: 2, score: entry.scores.quality, comment: comments.quality },
    { questionId: 1, score: entry.scores.overall, comment: comments.overall },
  ];
  return requestJson('/api/feedback/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ taskId: entry.taskId, modelId: entry.modelId, responses }),
  });
}

async function submitProductFeedback(entry) {
  const form = new FormData();
  form.append('taskId', entry.taskId);
  form.append('modelId', entry.modelId);
  form.append('userId', userId);
  form.append('content', [
    `任务：${entry.taskId} ${entry.taskTitle}`,
    `模型：${entry.model} (${entry.modelId})`,
    `工具调用：${entry.toolCalls}，满足 >300 要求。`,
    `结论：${entry.verdict}`,
    `证据：${entry.evidence.join('；')}`,
  ].join('\n'));
  const png = makeEvidencePng(entry);
  form.append('images', new Blob([png], { type: 'image/png' }), `${entry.taskId}_${entry.model}_evidence.png`);
  return requestJson('/api/comments/user-feedback', {
    method: 'POST',
    body: form,
    timeoutMs: 60_000,
  });
}

async function check(entry) {
  const score = await requestJson(`/api/feedback/check?taskId=${encodeURIComponent(entry.taskId)}&modelId=${encodeURIComponent(entry.modelId)}`);
  const product = await requestJson(`/api/comments/user-feedback?taskId=${encodeURIComponent(entry.taskId)}&modelId=${encodeURIComponent(entry.modelId)}`);
  return {
    scoreCount: Array.isArray(score.feedback) ? score.feedback.length : 0,
    productCount: Array.isArray(product) ? product.length : 0,
  };
}

for (const entry of entries) {
  const before = await check(entry);
  console.log(`Submitting ${entry.taskId} ${entry.model}/${entry.modelId} before score=${before.scoreCount} product=${before.productCount}`);
  await submitScores(entry);
  await submitProductFeedback(entry);
  const after = await check(entry);
  console.log(`  verified score=${after.scoreCount} product=${after.productCount}`);
}
import { deflateSync } from 'node:zlib';
