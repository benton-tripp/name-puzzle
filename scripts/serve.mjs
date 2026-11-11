import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml'};
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '0.0.0.0';
http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const relative = pathname === '/' ? 'index.html' : pathname === '/__mobile' ? 'scripts/mobile-preview.html' : pathname.replace(/^\/+/, '');
    if (!['index.html','styles.css','favicon.svg','scripts/mobile-preview.html'].includes(relative) && !/^src\/[a-z0-9._/-]+\.js$/.test(relative)) {
      response.writeHead(404).end('Not found');
      return;
    }
    const file = path.resolve(root, relative);
    if (!file.startsWith(root) || !(await stat(file)).isFile()) {
      response.writeHead(404).end('Not found');
      return;
    }
    const content = await readFile(file);
    response.writeHead(200, {'Content-Type':types[path.extname(file)] || 'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    response.end(content);
  } catch {
    response.writeHead(404).end('Not found');
  }
}).listen(port, host, () => console.log(`Name Puzzle development server listening on ${host}:${port}`));
