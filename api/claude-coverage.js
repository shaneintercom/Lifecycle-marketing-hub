module.exports = async function (req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { signals, campaigns } = req.body || {};
  if (!signals || !signals.length) {
    return res.status(400).json({ error: 'No signals provided' });
  }

  const signalLines = signals.map(s =>
    `Signal: ${s.label}\nWorkspaces affected: ${Number(s.count).toLocaleString()}\nWhat this means: ${s.description}`
  ).join('\n\n');

  const fmt = v => v != null ? (parseFloat(v) * 100).toFixed(1) + '%' : '—';

  const campaignLines = (campaigns || []).map(c =>
    `${c.campaign_name} | ${c.category || '—'} | ${c.send_date || '—'} | Open: ${fmt(c.open_rate)} | Notes: ${c.notes || '—'}`
  ).join('\n');

  const prompt = `You are a lifecycle email marketing strategist at Intercom. Below are live product signals showing gaps in Fin adoption, plus the recent campaign history. Analyse coverage and identify what's missing.

PRODUCT SIGNALS (from Snowflake — live workspace counts):
${signalLines}

RECENT CAMPAIGNS (last 60):
${campaignLines || 'No campaigns recorded yet.'}

Produce a structured analysis with exactly these 3 sections:

**1. COVERAGE BY SIGNAL**
For each signal: state Covered / Partial / Gap, citing specific campaigns by name where they address it.

**2. BIGGEST GAPS**
2–3 most under-served segments with a brief explanation of why they matter commercially.

**3. RECOMMENDED CAMPAIGNS**
3 specific campaigns to build. For each: audience (the signal), goal, and rationale (what outcome it drives).

Be direct and specific. Use the section headers exactly as shown. Each section should be concise — 3–5 bullet points or sentences.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: err });
    }

    const data = await response.json();
    const analysis = data.content?.[0]?.text || '';
    return res.status(200).json({ analysis });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
