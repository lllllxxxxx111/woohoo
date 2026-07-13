const base = 'https://sd87fd44849k0md74sh9g.apigateway-cn-shanghai.volceapi.com';
const cookie = 'username=admin';
const scripts = [
  'js/app.js',
  'js/api.js',
  'js/auth.js',
  'js/taskHistory.js',
  'js/taskModal.js',
  'js/taskDetails.js',
  'js/mainContent.js',
  'js/feedback.js',
  'js/comments.js',
  'js/qualityInspection.js',
];

for (const script of scripts) {
  const response = await fetch(`${base}/${script}`, { headers: { cookie } });
  const text = await response.text();
  const paths = new Set();
  for (const match of text.matchAll(/['"`](\/api\/[^'"`\\\s)]*)/g)) paths.add(match[1]);
  for (const match of text.matchAll(/fetch\(([^)]{1,300})\)/g)) paths.add(`FETCH ${match[1].replace(/\s+/g, ' ')}`);
  const lines = text
    .split(/\r?\n/)
    .map((line, index) => ({ index: index + 1, line: line.trim() }))
    .filter(({ line }) => /\/api\/|evaluation|model|task|harness|upload|feedback|submit|round|append/i.test(line))
    .slice(0, 260);
  console.log(`\n### ${script} ${response.status} len=${text.length}`);
  console.log('API/path hits:', JSON.stringify([...paths].slice(0, 120), null, 2));
  console.log('Interesting lines:');
  console.log(lines.map(({ index, line }) => `${index}: ${line}`).join('\n').slice(0, 18000));
}
