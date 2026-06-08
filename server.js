const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// ── PROXY ANTHROPIC ──
app.post('/api/claude', async (req, res) => {
  try {
    console.log('Claude request:', JSON.stringify(req.body).substring(0, 100));
    if (!process.env.ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_KEY not set' });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
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
    console.log('Fal inpainting request received');
    if (!process.env.FAL_KEY) return res.status(500).json({ error: 'FAL_KEY not set' });

    const { image, mask, prompt } = req.body;

    // Soumettre le job à fal.ai FLUX Fill
    const submitResp = await fetch('https://queue.fal.run/fal-ai/flux-pro/v1/fill', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Key ' + process.env.FAL_KEY
      },
      body: JSON.stringify({
        image_url: image,
        mask_url: mask,
        prompt: prompt || 'compacted gravel driveway 0/20, flat clean professional surface, construction site finished, realistic',
        num_inference_steps: 28,
        guidance_scale: 60,
        output_format: 'jpeg'
      })
    });

    const submitData = await submitResp.json();
    console.log('Fal submit:', JSON.stringify(submitData).substring(0, 200));

    if (submitData.detail) return res.status(400).json({ error: submitData.detail });

    const requestId = submitData.request_id;
    if (!requestId) return res.status(500).json({ error: 'No request_id from fal', raw: submitData });

    // Polling du résultat
    let result = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const pollResp = await fetch(`https://queue.fal.run/fal-ai/flux-pro/v1/fill/requests/${requestId}`, {
        headers: { 'Authorization': 'Key ' + process.env.FAL_KEY }
      });
      const pollData = await pollResp.json();
      console.log(`Poll ${i+1}:`, pollData.status);

      if (pollData.status === 'COMPLETED') {
        result = pollData;
        break;
      }
      if (pollData.status === 'FAILED') {
        return res.status(500).json({ error: 'Fal job failed', raw: pollData });
      }
    }

    if (!result) return res.status(500).json({ error: 'Timeout waiting for result' });

    // Récupérer l'image résultat
    const imageUrl = result.output?.images?.[0]?.url || result.output?.image?.url;
    if (!imageUrl) return res.status(500).json({ error: 'No image in result', raw: result });

    // Télécharger et retourner en base64
    const imgResp = await fetch(imageUrl);
    const buffer = await imgResp.buffer();
    const base64 = buffer.toString('base64');
    res.json({ image: 'data:image/jpeg;base64,' + base64 });

  } catch(e) {
    console.error('Inpainting error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.send('DevisTP Proxy OK — Claude + Flux Inpainting'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
