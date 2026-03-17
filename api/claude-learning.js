module.exports = async function (req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

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
