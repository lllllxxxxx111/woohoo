const base = 'https://sd87fd44849k0md74sh9g.apigateway-cn-shanghai.volceapi.com';
const cookie = 'username=admin';

const paths = [
  '/',
  '/index.html',
  '/api/tasks',
  '/api/tasks?userId=674',
  '/api/task_types',
  '/api/task-types',
  '/api/taskType',
  '/api/evaluationTasks',
  '/api/evaluation_tasks',
  '/api/evaluationTask',
  '/api/evaluation-task',
  '/api/evaluation_task',
  '/api/evaluation/list',
  '/api/evaluation-task/list',
  '/api/evaluation_tasks/list',
  '/api/evaluationTasks/list',
  '/api/task-evaluations',
  '/api/task_evaluations',
  '/api/active_evaluation_task',
  '/api/active-evaluation-task',
  '/api/current_evaluation_task',
  '/api/current-evaluation-task',
  '/api/config',
  '/api/public/config',
  '/api/evaluation_tasks',
  '/api/evaluation-tasks',
  '/api/evaluations',
  '/api/tasks/config',
  '/api/models',
  '/api/task_models',
  '/api/task-models',
  '/api/harnesses',
  '/api/user',
  `/api/task_details/KQG0SD?_ts=${Date.now()}`,
  '/api/tasks/list?userId=674',
];

for (const path of paths) {
  try {
    const response = await fetch(`${base}${path}`, { headers: { cookie } });
    const text = await response.text();
    console.log('\n###', path, response.status, response.statusText);
    console.log(text.slice(0, 4000));
  } catch (error) {
    console.log('\n###', path, 'ERROR', error.message);
  }
}
