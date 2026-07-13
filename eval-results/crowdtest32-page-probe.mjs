const base = 'https://sd87fd44849k0md74sh9g.apigateway-cn-shanghai.volceapi.com';
const cookie = 'username=admin';

const paths = ['/task.html', '/task_detail.html', '/task-details.html', '/feedback.html', '/profile.html'];

for (const path of paths) {
  const response = await fetch(`${base}${path}`, { headers: { cookie } });
  const text = await response.text();
  const title = text.match(/<title>(.*?)<\/title>/i)?.[1] ?? '';
  const fetches = [...text.matchAll(/fetch\(([^)]{1,260})\)/g)].map(match => match[1]);
  const scripts = [...text.matchAll(/<script[^>]*src=["']([^"']+)/g)].map(match => match[1]);
  const locationLines = text
    .split(/\r?\n/)
    .filter(line => /fetch|api\/|location|evaluation|model|task|harness|feedback|upload/i.test(line))
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 200);
  console.log(`\n### ${path} ${response.status} ${response.statusText} len=${text.length} title=${title}`);
  console.log('fetches:', JSON.stringify(fetches.slice(0, 80), null, 2));
  console.log('scripts:', JSON.stringify(scripts.slice(0, 20), null, 2));
  console.log('interesting lines:');
  console.log(locationLines.join('\n').slice(0, 12000));
}
