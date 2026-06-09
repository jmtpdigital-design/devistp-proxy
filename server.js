const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const DB_FILE = '/tmp/devis_db.json';
const JOBS_FILE = '/tmp/jobs.json';

function loadDB() {
  try { if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE,'utf8')); } catch(e) {}
  return { devis: [] };
}
function saveDB(db) { try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch(e) {} }
function loadJobs() {
  try { if (fs.existsSync(JOBS_FILE)) return JSON.parse(fs.readFileSync(JOBS_FILE,'utf8')); } catch(e) {}
  return {};
}
function saveJobs(j) { try { fs.writeFileSync(JOBS_FILE, JSON.stringify(j)); } catch(e) {} }

// ── APPEL CLAUDE AVEC GESTION TOOL USE ──
async function callClaude(body) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  console.log('Claude status:', r.status, text.substring(0, 150));
  return { status: r.status, text };
}

// ── PROXY CLAUDE ──
app.post('/api/claude', async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_KEY not set' });

    let body = { ...req.body };

    // Activer web_search pour les gros appels (devis)
    if (body.max_tokens > 500) {
      body.tools = [{
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 3
      }];
    }

    const { status, text } = await callClaude(body);
    let parsed;
    try { parsed = JSON.parse(text); }
    catch(e) { return res.status(500).json({ error: 'Bad JSON', raw: text.substring(0, 500) }); }

    // Gérer le cas où Claude a utilisé web_search et attend de continuer
    let iterations = 0;
    while (iterations < 5) {
      const content = parsed.content || [];
      const hasToolUse = content.some(b => b.type === 'tool_use');
      const stopReason = parsed.stop_reason;

      console.log('Stop reason:', stopReason, '- Has tool_use:', hasToolUse);

      if (stopReason !== 'tool_use' && stopReason !== 'end_turn_tool_use') break;
      if (!hasToolUse) break;

      // Continuer la conversation avec les résultats des outils
      const messages = [...(body.messages || [])];
      messages.push({ role: 'assistant', content: content });

      // Ajouter les résultats tool_result pour chaque tool_use
      const toolResults = content
        .filter(b => b.type === 'tool_use')
        .map(b => ({
          type: 'tool_result',
          tool_use_id: b.id,
          content: 'Search completed'
        }));

      if (toolResults.length > 0) {
        messages.push({ role: 'user', content: toolResults });
      }

      console.log('Continuing with tool results...');
      const body2 = { ...body, messages, tools: body.tools };
      const resp2 = await callClaude(body2);

      try { parsed = JSON.parse(resp2.text); }
      catch(e) { break; }

      iterations++;
    }

    res.json(parsed);

  } catch(e) {
    console.error('Claude error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── SUBMIT INPAINTING ──
app.post('/api/inpainting/submit', async (req, res) => {
  try {
    console.log('Fal submit request');
    if (!process.env.FAL_KEY) return res.status(500).json({ error: 'FAL_KEY not set' });

    const { image, mask, prompt } = req.body;
    const r = await fetch('https://queue.fal.run/fal-ai/flux-pro/v1/fill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Key ' + process.env.FAL_KEY },
      body: JSON.stringify({
        image_url: image,
        mask_url: mask,
        prompt: prompt || 'compacted gravel driveway, flat clean professional surface, realistic photo',
        num_inference_steps: 28,
        guidance_scale: 10,
        output_format: 'jpeg'
      })
    });

    const text = await r.text();
    console.log('Submit response:', text.substring(0, 300));

    let data;
    try { data = JSON.parse(text); } 
    catch(e) { return res.status(500).json({ error: 'Bad submit JSON', raw: text }); }

    if (!data.request_id) return res.status(500).json({ error: 'No request_id', raw: data });

    const jobs = loadJobs();
    jobs[data.request_id] = {
      status_url: data.status_url,
      response_url: data.response_url,
      created: Date.now()
    };
    saveJobs(jobs);

    console.log('Job ID:', data.request_id);
    res.json({ request_id: data.request_id });

  } catch(e) {
    console.error('Submit error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POLL STATUS ──
app.get('/api/inpainting/status/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!process.env.FAL_KEY) return res.status(500).json({ error: 'FAL_KEY not set' });

    const jobs = loadJobs();
    const job = jobs[id] || {};
    const statusUrl = job.status_url || ('https://queue.fal.run/fal-ai/flux-pro/v1/fill/requests/' + id);

    const r = await fetch(statusUrl, { headers: { 'Authorization': 'Key ' + process.env.FAL_KEY } });
    const text = await r.text();
    console.log('Poll status:', r.status, text.substring(0, 150));

    if (!text || !text.trim()) return res.json({ status: 'pending' });

    let data;
    try { data = JSON.parse(text); } catch(e) { return res.json({ status: 'pending' }); }

    if (data.status === 'COMPLETED') {
      const responseUrl = job.response_url || statusUrl.replace('/status', '');
      console.log('Fetching result from:', responseUrl);

      const rr = await fetch(responseUrl, { headers: { 'Authorization': 'Key ' + process.env.FAL_KEY } });
      const resultText = await rr.text();
      console.log('Result:', resultText.substring(0, 300));

      let result;
      try { result = JSON.parse(resultText); } catch(e) { result = data; }

      const imageUrl =
        result.images?.[0]?.url ||
        result.output?.images?.[0]?.url ||
        result.output?.image?.url ||
        result.output?.image ||
        result.image?.url ||
        result.image;

      if (!imageUrl) return res.json({ status: 'error', error: 'No image URL', raw: result });

      const img = await fetch(imageUrl);
      const buf = await img.buffer();
      return res.json({ status: 'completed', image: 'data:image/jpeg;base64,' + buf.toString('base64') });
    }

    if (data.status === 'FAILED') return res.json({ status: 'error', error: 'Job failed' });
    return res.json({ status: 'pending', queue_position: data.queue_position });

  } catch(e) {
    console.error('Poll error:', e.message);
    res.json({ status: 'pending' });
  }
});

// ── DEVIS CRUD ──
app.post('/api/devis/save', (req, res) => {
  try {
    const db = loadDB();
    const d = { ...req.body, _id: req.body._id || Date.now() };
    if (d._photo && d._photo.length > 50000) delete d._photo;
    if (d._rendu) delete d._rendu;
    const i = db.devis.findIndex(x => x._id === d._id);
    if (i >= 0) db.devis[i] = d; else db.devis.unshift(d);
    if (db.devis.length > 50) db.devis = db.devis.slice(0, 50);
    saveDB(db);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/devis', (req, res) => {
  try { res.json(loadDB().devis); } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/devis/:id', (req, res) => {
  try {
    const db = loadDB();
    db.devis = db.devis.filter(d => String(d._id) !== String(req.params.id));
    saveDB(db);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => res.send('DevisTP Proxy OK'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Proxy running on port', PORT));
