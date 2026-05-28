/**
 * CDN Upload Server for MattMakes3D (local dev)
 * Mirrors the Vercel function in api/upload.js. Run with: node server.js
 * Then open: http://localhost:3001
 *
 * Two modes via the `mode` form field:
 *   - "print" (default): upload print photo + PATCH matching Print Log page.
 *   - "deal":            upload deal photo + CREATE new page in Workshop Picks.
 */

import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import SFTPClient from 'ssh2-sftp-client';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  SFTP_HOST,
  SFTP_USER,
  SFTP_PASS,
  SFTP_PATH,
  CDN_BASE = 'https://cdn.mattmakes3d.com/images/',
  UPLOAD_PASSWORD = 'makes3d',
  NOTION_TOKEN,
  NOTION_DATABASE_ID       = '31737eb9-8530-8036-b514-e688248e45fc', // Print Log
  NOTION_DEALS_DATABASE_ID = '632deb71-b945-4967-a8fe-93977d4b2e7d', // Workshop Picks
  PORT = 3001,
} = process.env;

const NOTION_HEADERS = {
  Authorization: `Bearer ${NOTION_TOKEN}`,
  'Content-Type': 'application/json',
  'Notion-Version': '2022-06-28',
};

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', cdn: CDN_BASE });
});

// ── Upload endpoint ────────────────────────────────────────────────────────
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (req.headers['x-upload-password'] !== UPLOAD_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const mode = req.body.mode || 'print';
  const { filename } = req.body;

  if (!filename || !req.file) {
    return res.status(400).json({ error: 'Missing file or filename.' });
  }
  if (!/^[a-z0-9][a-z0-9\-]*\.[a-z]{2,5}$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename format.' });
  }

  // SFTP upload (shared)
  let cdnUrl;
  try {
    cdnUrl = await sftpUpload(req.file.buffer, filename);
    console.log(`✓ Uploaded ${filename} → ${cdnUrl} (mode: ${mode})`);
  } catch (err) {
    console.error('SFTP error:', err.message);
    return res.status(500).json({ error: `Upload failed: ${err.message}` });
  }

  // Branch on mode
  try {
    if (mode === 'deal') {
      const pageUrl = await createNotionDeal({
        name:          req.body.name,
        category:      req.body.category,
        price:         req.body.price ? Number(req.body.price) : null,
        originalPrice: req.body.originalPrice ? Number(req.body.originalPrice) : null,
        url:           req.body.url,
        source:        req.body.source,
        myTake:        req.body.myTake,
        featured:      req.body.featured === 'true' || req.body.featured === '1',
        status:        req.body.status || 'Live',
        cdnUrl,
        filename,
      });
      return res.json({ url: cdnUrl, mode: 'deal', notionUpdated: !!pageUrl, notionPageUrl: pageUrl });
    } else {
      const notionUpdated = await updateNotionPhoto(req.body.modelName, req.body.printDate, cdnUrl, filename);
      return res.json({ url: cdnUrl, mode: 'print', notionUpdated });
    }
  } catch (err) {
    console.warn('Notion step failed:', err.message);
    return res.status(207).json({
      url: cdnUrl,
      mode,
      notionUpdated: false,
      warning: `Image uploaded, but Notion step failed: ${err.message}`,
    });
  }
});

// ── SFTP helper ────────────────────────────────────────────────────────────
async function sftpUpload(buffer, filename) {
  const sftp = new SFTPClient();
  try {
    await sftp.connect({
      host: SFTP_HOST,
      username: SFTP_USER,
      password: SFTP_PASS,
      readyTimeout: 20000,
    });
    const remotePath = path.posix.join(SFTP_PATH, filename);
    await sftp.put(buffer, remotePath);
    await sftp.end();
    return CDN_BASE + filename;
  } catch (err) {
    try { await sftp.end(); } catch {}
    throw err;
  }
}

// ── Print log: PATCH existing page ─────────────────────────────────────────
async function updateNotionPhoto(modelName, printDate, cdnUrl, filename) {
  if (!NOTION_TOKEN || !modelName || !printDate) return false;

  const queryRes = await fetch(
    `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`,
    {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({
        filter: {
          and: [
            { property: 'Model Name', title: { equals: modelName } },
            { property: 'Print Date', date:  { equals: printDate } },
          ],
        },
      }),
    }
  );

  const queryData = await queryRes.json();
  if (!queryData.results?.length) {
    console.warn(`Notion: no page found for "${modelName}" on ${printDate}`);
    return false;
  }

  const pageId = queryData.results[0].id;
  const patchRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: NOTION_HEADERS,
    body: JSON.stringify({
      properties: {
        Photo: { files: [{ type: 'external', name: filename, external: { url: cdnUrl } }] },
      },
    }),
  });

  if (!patchRes.ok) {
    const err = await patchRes.json().catch(() => ({}));
    throw new Error(err.message || `Notion ${patchRes.status}`);
  }
  console.log(`✓ Notion print updated: "${modelName}"`);
  return true;
}

// ── Deals: CREATE new page ─────────────────────────────────────────────────
async function createNotionDeal(d) {
  if (!NOTION_TOKEN || !NOTION_DEALS_DATABASE_ID || !d.name) {
    throw new Error('Missing NOTION_TOKEN, deals DB ID, or product name.');
  }

  const properties = {
    Name: { title: [{ text: { content: d.name } }] },
    Photo: {
      files: [{ type: 'external', name: d.filename, external: { url: d.cdnUrl } }],
    },
    Status: { select: { name: d.status || 'Live' } },
    Featured: { checkbox: !!d.featured },
  };

  if (d.category) properties.Category = { select: { name: d.category } };
  if (d.source)   properties.Source   = { select: { name: d.source } };
  if (d.url)      properties.URL      = { url: d.url };
  if (d.price != null && !Number.isNaN(d.price))
    properties.Price = { number: d.price };
  if (d.originalPrice != null && !Number.isNaN(d.originalPrice))
    properties['Original Price'] = { number: d.originalPrice };
  if (d.myTake)
    properties['My Take'] = { rich_text: [{ text: { content: d.myTake } }] };

  const createRes = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: NOTION_HEADERS,
    body: JSON.stringify({
      parent: { database_id: NOTION_DEALS_DATABASE_ID },
      properties,
    }),
  });

  if (!createRes.ok) {
    const err = await createRes.json().catch(() => ({}));
    throw new Error(err.message || `Notion ${createRes.status}`);
  }
  const page = await createRes.json();
  console.log(`✓ Notion deal created: "${d.name}" → ${page.url}`);
  return page.url || null;
}

app.listen(PORT, () => {
  console.log(`\n🖨️  MattMakes3D CDN Upload Server`);
  console.log(`   Running at: http://localhost:${PORT}`);
  console.log(`   CDN target: ${CDN_BASE}\n`);
});
