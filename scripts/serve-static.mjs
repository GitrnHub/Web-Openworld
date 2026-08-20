import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const port = Number(process.env.SITE_PORT || 4173);
const mime = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
    let target = resolve(root, `.${pathname}`);
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    if ((await stat(target)).isDirectory()) target = resolve(target, 'index.html');
    const info = await stat(target);
    response.writeHead(200, {
      'Content-Type': mime.get(extname(target).toLowerCase()) || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
    });
    createReadStream(target).pipe(response);
  } catch {
    response.writeHead(404).end('Not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Static site: http://127.0.0.1:${port}`);
});
