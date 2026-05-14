module.exports = async function (req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // ── SUBJECT PREDICT MODE ──────────────────────────────────────────────────
  // Forward-looking: given a draft subject + similar past campaigns, return a
  // predicted open-rate range, 3 verbatim winning references, and one tightening
  // suggestion. JSON-only response.
  if (req.body?.mode === 'subjectPredict') {
    const { subject, category, audience, history } = req.body;
    if (!subject || !subject.trim()) return res.status(400).json({ error: 'subject required' });
    if (!Array.isArray(history) || !history.length) {
      return res.status(400).json({ error: 'history array required (similar past campaigns)' });
    }

    const lines = history.slice(0, 50).map((h, i) => {
      const rate = h.open_rate != null ? (h.open_rate * 100).toFixed(1) + '%' : '—';
      return `[${i + 1}] (${h.category || 'uncategorised'}) Open ${rate}: "${(h.subject_line || '').slice(0, 200)}"`;
    }).join('\n');

    const system = `You are a senior lifecycle marketing analyst at Intercom (B2B SaaS, AI-first customer service platform). You predict open-rate ranges for draft subject lines using only the historical campaigns provided. You return ONLY valid JSON, no preamble, no markdown fences. Be honest, evidence-led, no filler. No em dashes.`;

    const userPrompt = `Draft subject line: "${subject.trim()}"
${category ? `Target category: ${category}` : 'Category: not specified'}
${audience ? `Audience hint: ${audience}` : ''}

Historical campaigns (most relevant first):
${lines}

Predict performance for the draft. Return JSON in this exact shape:
{
  "predictedRangeLow": <number, open rate as percentage like 38.5>,
  "predictedRangeHigh": <number, open rate as percentage like 52.0>,
  "confidence": "low" | "medium" | "high",
  "reasoning": "<2-3 sentence explanation grounded in the history above, referencing example numbers>",
  "references": [
    { "subject": "<verbatim subject from history>", "openRate": <number as percentage>, "whyItWorks": "<one sentence>" },
    { "subject": "...", "openRate": <number>, "whyItWorks": "..." },
    { "subject": "...", "openRate": <number>, "whyItWorks": "..." }
  ],
  "suggestion": "<one specific edit to the draft drawn from winning patterns in the history; be concrete, propose actual wording. If the draft is already strong, say so plainly>"
}

Pick the three references that are most relevant to the draft AND had strong open rates. If the history is too thin to predict confidently, set confidence to "low" and widen the range accordingly.`;

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
          system,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });
      if (!response.ok) {
        const err = await response.text();
        return res.status(500).json({ error: `Claude ${response.status}: ${err.slice(0, 400)}` });
      }
      const data = await response.json();
      let raw = (data.content?.[0]?.text || '').trim();
      if (raw.startsWith('```')) raw = raw.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch (e) { return res.status(500).json({ error: 'Model returned non-JSON', raw: raw.slice(0, 300) }); }
      return res.status(200).json({ prediction: parsed, historyConsidered: Math.min(history.length, 50) });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  const { tests, question } = req.body;
  if (!tests || !tests.length) {
    return res.status(400).json({ error: 'No tests provided' });
  }

  const fmt = v => v != null ? (v * 100).toFixed(1) + '%' : '—';

  const testLines = tests.map((t, i) => {
    const winnerName = t.winner === 'A'
      ? (t.variant_a_name || 'Variant A')
      : t.winner === 'B'
      ? (t.variant_b_name || 'Variant B')
      : 'No clear winner';

    return `Test ${i + 1}: ${t.test_name || 'Untitled'} (${t.test_date || 'no date'})
Element: ${t.element_tested || '—'}
Hypothesis: ${t.hypothesis || '—'}
A — "${t.variant_a_name || 'Variant A'}": ${t.variant_a_content || '—'} | Open: ${fmt(t.variant_a_open_rate)} | Click: ${fmt(t.variant_a_click_rate)}
B — "${t.variant_b_name || 'Variant B'}": ${t.variant_b_content || '—'} | Open: ${fmt(t.variant_b_open_rate)} | Click: ${fmt(t.variant_b_click_rate)}
Winner: ${winnerName}
Learning: ${t.winner_notes || '—'}`;
  }).join('\n\n');

  let prompt;

  if (question) {
    prompt = `You are a lifecycle email marketing expert. Below is the full A/B test history for a B2B SaaS company (Intercom). Answer the question below, citing specific test numbers as evidence where relevant.

A/B Test History:
${testLines}

Question: ${question}

Answer directly and concisely. Cite test numbers (e.g. "Test 3", "Tests 1 and 5") when referencing specific evidence.`;
  } else {
    prompt = `You are a lifecycle email marketing expert. Analyse the following A/B test history for a B2B SaaS company (Intercom) and produce a structured report with exactly these 5 sections:

**1. PATTERNS CONFIRMED**
Validated tactics that appear consistently across multiple tests.

**2. WHAT WINS BY ELEMENT**
Per element type (subject line, CTA, send time, etc.) — what the data shows works.

**3. CONTRADICTIONS OR SURPRISES**
Unexpected results or findings that contradict initial hypotheses.

**4. GAPS IN THE TEST PROGRAMME**
Elements or hypotheses that haven't been tested yet but should be.

**5. TOP 3 NEXT TESTS**
Specific test hypotheses with rationale, based on gaps and patterns found.

A/B Test History:
${testLines}

Write in a direct, confident tone. Use the section headers exactly as shown (bold, with numbering). Each section should be 2–4 concise sentences or bullet points. Do not add extra sections.`;
  }

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
