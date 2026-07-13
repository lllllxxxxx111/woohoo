const base = (process.env.CROWDTEST_BASE || 'https://sd8a11ch62e4kq5onetdg.apigateway-cn-shanghai.volceapi.com').replace(/\/$/, '');
const cookie = process.env.CROWDTEST_COOKIE || 'username=KzZd1nlyoi';
const taskId = process.argv[2] || process.env.CROWDTEST32_TASK_B;

if (!taskId) {
  throw new Error('Usage: node eval-results/crowdtest32-status.mjs <taskId>');
}

function sumToolCounts(toolCounts = {}) {
  return Object.values(toolCounts).reduce((total, value) => total + (Number(value) || 0), 0);
}

async function requestJson(path) {
  const response = await fetch(`${base}${path}`, { headers: { cookie } });
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

const details = await requestJson(`/api/task_details/${encodeURIComponent(taskId)}?_ts=${Date.now()}`);

const rows = (details.runs || []).map((run) => {
  const rounds = Array.isArray(run.rounds) && run.rounds.length ? run.rounds : [run];
  const totalToolCalls = rounds.reduce((total, round) => total + sumToolCounts(round.stats?.toolCounts), 0);
  const latest = rounds.find((round) => round.isLatestRound) || rounds[rounds.length - 1] || run;
  return {
    model: run.displayName || run.modelName || run.modelId,
    modelId: run.modelId,
    status: latest.status || run.status,
    roundCount: run.roundCount || rounds.length,
    latestRound: latest.roundNo,
    totalToolCalls,
    latestToolCalls: sumToolCounts(latest.stats?.toolCounts),
    turns: Number(run.stats?.turns) || 0,
    stopReason: latest.stopReason || run.stopReason || '',
    canDownload: Boolean(run.downloadPackage?.canDownload),
    downloadStatus: run.downloadPackage?.status || '',
    generatedFiles: Array.isArray(run.generatedFiles) ? run.generatedFiles.length : 0,
    hasFeedback: run.feedbackScores && Object.keys(run.feedbackScores).length > 0,
  };
});

console.log(JSON.stringify({
  taskId: details.taskId,
  title: details.title,
  evaluationTask: details.evaluationTask?.target,
  requirementType: details.requirementType,
  rows,
}, null, 2));
