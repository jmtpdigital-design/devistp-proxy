const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const fs = require('fs');
const DB_FILE = '/tmp/devis_db.json';

function loadDB() {
  try { if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) {}
  return { devis: [] };
}
function saveDB(db) {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch(e) {}
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
    console.error('Claude error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PROXY FAL.AI FLUX INPAINTING ──
app.post('/api/inpainting', async (req, res) => {
  try {
    console.log('Fal inpainting request');
    if (!process.env.FAL_KEY) return res.status(500).json({ error: 'FAL_KEY not set' });

    const { image, mask, prompt } = req.body;

    // Soumettre le job
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

    const submitData = await submitResp.json();
    console.log('Fal submit response:', JSON.stringify(submitData).substring(0, 300));

    if (submitData.detail) return res.status(400).json({ error: submitData.detail });
    if (!submitData.request_id) return res.status(500).json({ error: 'No request_id', raw: submitData });

    const requestId = submitData.request_id;
    console.log('Request ID:', requestId);

    // Polling
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 3000));

      const pollResp = await fetch(`https://queue.fal.run/fal-ai/flux-pro/v1/fill/requests/${requestId}`, {
        headers: { 'Authorization': 'Key ' + process.env.FAL_KEY }
      });
      const pollData = await pollResp.json();
      console.log(`Poll ${i+1} status:`, pollData.status, JSON.stringify(pollData).substring(0, 200));

      if (pollData.status === 'COMPLETED') {
        // Chercher l'image dans tous les formats possibles
        const imageUrl =
          pollData.output?.images?.[0]?.url ||
          pollData.output?.image?.url ||
          pollData.output?.image ||
          pollData.images?.[0]?.url ||
          pollData.image?.url;

        console.log('Image URL found:', imageUrl);

        if (!imageUrl) {
          console.error('Full response:', JSON.stringify(pollData));
          return res.status(500).json({ error: 'No image URL in response', raw: pollData });
        }

        // Télécharger l'image
        const imgResp = await fetch(imageUrl);
        const buffer = await imgResp.buffer();
        return res.json({ image: 'data:image/jpeg;base64,' + buffer.toString('base64') });
      }

      if (pollData.status === 'FAILED') {
        console.error('Fal job failed:', JSON.stringify(pollData));
        return res.status(500).json({ error: 'Fal job failed', detail: pollData.error });
      }
    }

    res.status(500).json({ error: 'Timeout après 120 secondes' });

  } catch(e) {
    console.error('Inpainting error:', e.message);
    res.status(500).json({ error: e.message });
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
    console.log('Devis saved:', devis._id, '- Total:', db.devis.length);
    res.json({ ok: true, id: devis._id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── RÉCUPÉRATION DEVIS ──
app.get('/api/devis', (req, res) => {
  try { res.json(loadDB().devis); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SUPPRESSION DEVIS ──
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
