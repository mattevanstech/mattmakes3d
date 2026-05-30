/**
 * Vercel serverless function: CDN Upload Handler for MattMakes3D
 *
 * Two modes (selected via the `mode` form field):
 *   - "print" (default): upload print photo, then PATCH the matching Notion
 *     page in the Print Log database with the CDN URL.
 *   - "deal": upload deal photo, then CREATE a new page in the Workshop Picks
 *     (deals) Notion database with the submitted fields.
 *
 * In both modes, the image is sent to Dreamhost via SFTP under SFTP_PATH and
 * served from CDN_BASE.
 */

import SFTPClient from 'ssh2-sftp-client';
import formidable from 'formidable';
import fs from 'fs';

const {
  SFTP_HOST,
  SFTP_USER,
  SFTP_PASS,
  SFTP_PATH,
  CDN_BASE = 'https://cdn.mattmakes3d.com/images/',
  UPLOAD_PASSWORD,
  NOTION_TOKEN,
  NOTION_DATABASE_ID       = '31737eb9-8530-8036-b514-e688248e45fc', // Print Log
  NOTION_DEALS_DATABASE_ID = '632deb71-b945-4967-a8fe-93977d4b2e7d', // Workshop Picks
} = process.env;

export const config = {
  api: { bodyParser: false },
};

const NOTION_HEADERS = {
  Authorization: `Bearer ${NOTION_TOKEN}`,
  'Content-Type': 'application/json',
  'Notion-Version': '2022-06-28',
};

// ── Handler ───────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-upload-password');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Password gate
  const password = req.headers['x-upload-password'];
  if (!UPLOAD_PASSWORD || password !== UPLOAD_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Parse multipart form
  const form = formidable({ maxFileSize: 20 * 1024 * 1024 });
  let fields, files;
  try {
    [fields, files] = await form.parse(req);
  } catch (err) {
    return res.status(400).json({ error: `Could not parse upload: ${err.message}` });
  }

  const F = (name) => Array.isArray(fields[name]) ? fields[name][0] : fields[name];
  const mode = F('mode') || 'print';
  const filename = F('filename');
  const uploadedFile = files.file?.[0];

  if (!filename || !uploadedFile) {
    return res.status(400).json({ error: 'Missing file or filename.' });
  }
  if (!/^[a-z0-9][a-z0-9\-]*\.jpg$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename format.' });
  }

  // SFTP upload (shared by both modes)
  let cdnUrl;
  try {
    cdnUrl = await sftpUpload(uploadedFile, filename);
  } catch (err) {
    try { if (uploadedFile?.filepath) fs.unlinkSync(uploadedFile.filepath); } catch {}
    return res.status(500).json({ error: `Upload failed: ${err.message}` });
  }

  // Branch on mode for the Notion step
  try {
    if (mode === 'deal') {
      const pageUrl = await createNotionDeal({
        name:          F('name'),
        category:      F('category'),
        price:         F('price') ? Number(F('price')) : null,
        originalPrice: F('originalPrice') ? Number(F('originalPrice')) : null,
        url:           F('url'),
        source:        F('source'),
        myTake:        F('myTake'),
        featured:      F('featured') === 'true' || F('featured') === '1',
        status:        F('status') || 'Live',
        cdnUrl,
        filename,
      });
      return res.status(200).json({ url: cdnUrl, mode: 'deal', notionUpdated: !!pageUrl, notionPageUrl: pageUrl });
    } else {
      const result = await upsertNotionPrint({
        modelName: F('modelName'),
        printDate: F('printDate'),
        source:    F('source'),
        modelUrl:  F('modelUrl'),
        featured:  F('featured') === 'true' || F('featured') === '1',
        cdnUrl,
        filename,
      });
      return res.status(200).json({
        url: cdnUrl,
        mode: 'print',
        notionUpdated: !!result.pageUrl,
        notionAction: result.action,
        notionPageUrl: result.pageUrl,
      });
    }
  } catch (err) {
    // CDN upload already happened; report partial success
    return res.status(207).json({
      url: cdnUrl,
      mode,
      notionUpdated: false,
      warning: `Image uploaded, but Notion step failed: ${err.message}`,
    });
  }
}

// ── SFTP upload helper ─────────────────────────────────────────────────────
async function sftpUpload(uploadedFile, filename) {
  const sftp = new SFTPClient();
  try {
    await sftp.connect({
      host: SFTP_HOST,
      username: SFTP_USER,
      password: SFTP_PASS,
      readyTimeout: 20000,
    });
    const remotePath = SFTP_PATH + filename;
    const buffer = fs.readFileSync(uploadedFile.filepath);
    await sftp.put(buffer, remotePath);
    await sftp.end();
    try { fs.unlinkSync(uploadedFile.filepath); } catch {}
    return CDN_BASE + filename;
  } catch (err) {
    try { await sftp.end(); } catch {}
    throw err;
  }
}

// ── Print log: UPSERT (create-if-missing, patch-if-exists) ─────────────────
async function upsertNotionPrint(p) {
  if (!NOTION_TOKEN || !p.modelName || !p.printDate) {
    throw new Error('Missing NOTION_TOKEN, modelName, or printDate.');
  }

  // Build the property bag from whatever was submitted
  const photoProp = {
    files: [{ type: 'external', name: p.filename, external: { url: p.cdnUrl } }],
  };

  // Find an existing page with the same Model Name + Print Date
  const queryRes = await fetch(
    `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`,
    {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({
        filter: {
          and: [
            { property: 'Model Name', title: { equals: p.modelName } },
            { property: 'Print Date', date:  { equals: p.printDate } },
          ],
        },
      }),
    }
  );
  const queryData = await queryRes.json();
  const existing = queryData.results?.[0];

  if (existing) {
    // Update existing page: photo + status=Done + any provided optional fields
    const properties = {
      Photo: photoProp,
      Status: { status: { name: 'Done' } },
      'Uploaded to Print Log': { checkbox: true },
    };
    if (p.source)   properties['Source']           = { rich_text: [{ text: { content: p.source } }] };
    if (p.modelUrl) properties['Model Source URL'] = { url: p.modelUrl };
    if (p.featured) properties['Featured']         = { checkbox: true };

    const patchRes = await fetch(`https://api.notion.com/v1/pages/${existing.id}`, {
      method: 'PATCH',
      headers: NOTION_HEADERS,
      body: JSON.stringify({ properties }),
    });
    if (!patchRes.ok) {
      const err = await patchRes.json().catch(() => ({}));
      throw new Error(err.message || `Notion ${patchRes.status}`);
    }
    const page = await patchRes.json();
    return { action: 'updated', pageUrl: page.url || null };
  }

  // Create a new page
  const properties = {
    'Model Name': { title: [{ text: { content: p.modelName } }] },
    'Print Date': { date: { start: p.printDate } },
    Photo:       photoProp,
    Status:      { status: { name: 'Done' } },
    'Uploaded to Print Log': { checkbox: true },
    Featured:    { checkbox: !!p.featured },
  };
  if (p.source)   properties['Source']           = { rich_text: [{ text: { content: p.source } }] };
  if (p.modelUrl) properties['Model Source URL'] = { url: p.modelUrl };

  const createRes = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: NOTION_HEADERS,
    body: JSON.stringify({
      parent: { database_id: NOTION_DATABASE_ID },
      properties,
    }),
  });
  if (!createRes.ok) {
    const err = await createRes.json().catch(() => ({}));
    throw new Error(err.message || `Notion ${createRes.status}`);
  }
  const page = await createRes.json();
  return { action: 'created', pageUrl: page.url || null };
}

// ── Deals: CREATE a new page in Workshop Picks ─────────────────────────────
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
  return page.url || null;
}
