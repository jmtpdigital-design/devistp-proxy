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
  try { if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) {}
  return { devis: [] };
}
function saveDB(db) {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch(e) {}
}
function loadJobs() {
  try { if (fs.existsSync(JOBS_FILE)) return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')); } catch(e) {}
  return {};
}
function saveJobs(jobs) {
  try { fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs)); } catch(e) {}
}

// ── PROXY ANTHROPIC ──
app.post('/api/claude', async (req, res) => {
  try {
    console.log('Claude request:', JSON.stringify(req.body).substring(0, 100));
    if (!process.env.ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_KEY not set' });
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(req.body)
    });
    const text = await response.text();
    console.log('Anthropic status:', response.status, text.substring(0, 150));
    try { res.json(JSON.parse(text)); }
    catch(e) { res.status(500).json({ error: 'Invalid JSON', raw: text }); }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SOUMETTRE JOB INPAINTING (répond immédiatement) ──
app.post('/api/inpainting/submit', async (req, res) => {
  try {
    console.log('Fal submit request');
    if (!process.env.FAL_KEY) return res.status(500).json({ error: 'FAL_KEY not set' });

    const { image, mask, prompt } = req.body;

    const submitResp = await fetch('https://queue.fal.run/fal-ai/flux-pro/v1/fill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Key ' + process.env.FAL_KEY },
      body: JSON.stringify({
        image_url: image,
        mask_url: mask,
        prompt: prompt || 'compacted gravel driveway 0/20, flat clean professional surface, realistic photo',
        num_inference_steps: 28,
        guidance_scale: 60,
        output_format: 'jpeg'
      })
    });

    const submitText = await submitResp.text();
    console.log('Submit response:', submitText.substring(0, 200));

    let submitData;
    try { submitData = JSON.parse(submitText); }
    catch(e) { return res.status(500).json({ error: 'Invalid submit response', raw: submitText }); }

    if (!submitData.request_id) return res.status(500).json({ error: 'No request_id', raw: submitData });

    // Sauvegarder le job
    const jobs = loadJobs();
    jobs[submitData.request_id] = { status: 'pending', created: Date.now() };
    saveJobs(jobs);

    console.log('Job submitted:', submitData.request_id);
    res.json({ request_id: submitData.request_id, status: 'pending' });

  } catch(e) {
    console.error('Submit error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── VÉRIFIER STATUT JOB (polling léger) ──
app.get('/api/inpainting/status/:id', async (req, res) => {
  try {
    const requestId = req.params.id;
    if (!process.env.FAL_KEY) return res.status(500).json({ error: 'FAL_KEY not set' });

    const pollResp = await fetch(
      `https://queue.fal.run/fal-ai/flux-pro/v1/fill/requests/${requestId}`,
      { headers: { 'Authorization': 'Key ' + process.env.FAL_KEY } }
    );

    const pollText = await pollResp.text();
    console.log('Poll status:', pollResp.status, pollText.substring(0, 200));

    if (!pollText || pollText.trim() === '') {
      return res.json({ status: 'pending' });
    }

    let pollData;
    try { pollData = JSON.parse(pollText); }
    catch(e) { return res.json({ status: 'pending' }); }

    if (pollData.status === 'COMPLETED') {
      const imageUrl =
        pollData.output?.images?.[0]?.url ||
        pollData.output?.image?.url ||
        pollData.output?.image ||
        pollData.images?.[0]?.url;

      if (!imageUrl) {
        console.error('No image URL:', JSON.stringify(pollData));
        return res.json({ status: 'error', error: 'No image in response' });
      }

      // Télécharger et retourner l'image
      const imgResp = await fetch(imageUrl);
      const buffer = await imgResp.buffer();
      return res.json({
        status: 'completed',
        image: 'data:image/jpeg;base64,' + buffer.toString('base64')
      });
    }

    if (pollData.status === 'FAILED') {
      return res.json({ status: 'error', error: 'Job failed' });
    }

    // IN_QUEUE ou IN_PROGRESS
    return res.json({ status: 'pending', queue_position: pollData.queue_position });

  } catch(e) {
    console.error('Status error:', e.message);
    res.json({ status: 'pending' });
  }
});

// ── SAUVEGARDE DEVIS ──
app.post('/api/devis/save', (req, res) => {
  try {
    const db = loadDB();
    const devis = { ...req.body };
    devis._id = devis._id || Date.now();
    if (devis._photo && devis._photo.length > 50000) delete devis._photo;
    if (devis._rendu) delete devis._rendu;
    const idx = db.devis.findIndex(d => d._id === devis._id);
    if (idx >= 0) db.devis[idx] = devis;
    else db.devis.unshift(devis);
    if (db.devis.length > 50) db.devis = db.devis.slice(0, 50);
    saveDB(db);
    res.json({ ok: true, id: devis._id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/devis', (req, res) => {
  try { res.json(loadDB().devis); }
  catch(e) { res.status(500).json({ error: e.message }); }
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
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
