import fs from 'fs';
const html = fs.readFileSync('apps/desktop/static/index.html', 'utf8');
const newHtml = html.replace(/<style>[\s\S]*?<\/style>/, '<link rel="stylesheet" href="./styles.css" />');
fs.writeFileSync('apps/desktop/static/index.html', newHtml);
