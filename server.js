const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

app.post('/api/claude', async (req, res) => {
  try {
    console.log('Request received:', JSON.stringify(req.body).substring(0, 100));
    
    if (!process.env.ANTHROPIC_KEY) {
      console.error('ANTHROPIC_KEY not set!');
      return res.status(500).json({ error: 'API key not configured' });
    }

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
    console.log('Anthropic response status:', response.status);
    console.log('Anthropic response:', text.substring(0, 200));

    try {
      const data = JSON.parse(text);
      res.json(data);
    } catch(e) {
      console.error('JSON parse error:', text);
      res.status(500).json({ error: 'Invalid JSON from Anthropic', raw: text });
    }

  } catch (e) {
    console.error('Fetch error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.send('DevisTP Proxy OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
