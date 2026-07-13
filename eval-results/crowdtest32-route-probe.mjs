const base = 'https://sd87fd44849k0md74sh9g.apigateway-cn-shanghai.volceapi.com';
const cookie = 'username=admin';

const paths = [
  '/',
  '/dashboard',
  '/tasks',
  '/task/KQG0SD',
  '/tasks/new',
  '/new-task',
  '/submit',
  '/create',
  '/profile',
  '/home',
  '/index',
  '/main',
  '/app',
  '/admin',
  '/feedback',
  '/leaderboard',
  '/login',
];

for (const path of paths) {
  const response = await fetch(`${base}${path}`, { headers: { cookie } });
  const text = await response.text();
  const title = text.match(/<title>(.*?)<\/title>/i)?.[1] ?? '';
  const fetches = [...text.matchAll(/fetch\(([^)]{1,200})\)/g)].map(match => match[1]);
  const hrefs = [...text.matchAll(/href=["']([^"']+)["']/g)].map(match => match[1]);
  const scripts = [...text.matchAll(/<script[^>]*src=["']([^"']+)["']/g)].map(match => match[1]);
  console.log(`\n### ${path} ${response.status} ${response.statusText} len=${text.length} title=${title}`);
  console.log('fetches:', JSON.stringify(fetches.slice(0, 20)));
  console.log('hrefs:', JSON.stringify(hrefs.slice(0, 20)));
  console.log('scripts:', JSON.stringify(scripts.slice(0, 20)));
  console.log(text.slice(0, 1200).replace(/\s+/g, ' '));
}
