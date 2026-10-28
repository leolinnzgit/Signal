import { readFile } from 'node:fs/promises';

// Browser previews share the real seasonal assets with the application shell.
export function previewHandler(html) {
  return async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const assets = {
      '/seasonal-branding.js': ['../public/seasonal-branding.js', 'text/javascript'],
      '/signalwatch/halloween.css': ['../public/signalwatch/halloween.css', 'text/css'],
      '/icons/signal-halloween.svg': ['../public/icons/signal-halloween.svg', 'image/svg+xml'],
    };
    const asset = assets[pathname];
    if (!asset) { res.setHeader('Content-Type', 'text/html'); res.end(html); return; }
    try {
      res.setHeader('Content-Type', asset[1]);
      res.end(await readFile(new URL(asset[0], import.meta.url)));
    } catch { res.statusCode = 404; res.end(); }
  };
}
