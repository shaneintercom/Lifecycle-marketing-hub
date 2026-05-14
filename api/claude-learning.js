module.exports = async function (req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // ── SUBJECT PREDICT MODE ──────────────────────────────────────────────────
  // The numerical range, σ, and cohort size are computed client-side from a
  // pattern-matched cohort (P25–P75). Claude is asked only for the narrative
  // layer: a grounded reasoning sentence, a one-line "why it works" per
  // reference, and one concrete tightening suggestion. JSON-only response.
  if (req.body?.mode === 'subjectPredict') {
    const { subject, category, audience, stats, features, featureLifts, references } = req.body;
    if (!subject || !subject.trim()) return res.status(400).json({ error: 'subject required' });
    if (!stats || typeof stats.p25 !== 'number') {
      return res.status(400).json({ error: 'stats object required (p25, p75, mean, sd, n)' });
    }
    if (!Array.isArray(references) || !references.length) {
      return res.status(400).json({ error: 'references array required (closest matches)' });
    }

    const featurePills = Object.entries(features || {})
      .filter(([k, v]) => v === true)
      .map(([k]) => k)
      .join(', ') || 'none detected';

    const liftLines = (featureLifts || []).slice(0, 6).map(f =>
      `- ${f.label}: ${f.avgWith.toFixed(1)}% with vs ${f.avgWithout.toFixed(1)}% without (${f.liftPp >= 0 ? '+' : ''}${f.liftPp.toFixed(1)}pp, n=${f.nWith})`
    ).join('\n') || '(none)';

    const refLines = references.slice(0, 5).map((r, i) =>
      `[${i + 1}] (${r.category || 'uncategorised'}) Open ${r.openRate.toFixed(1)}%: "${(r.subject || '').slice(0, 200)}"`
    ).join('\n');

    const system = `You are a senior lifecycle marketing analyst at Intercom (B2B SaaS, AI-first customer service platform). The numerical prediction has ALREADY been computed mathematically from a pattern-matched cohort of the user's own past sends. Your job is the narrative layer ONLY: a reasoning sentence that explains the math, a one-line "why it works" per reference, and one concrete tightening suggestion. Do NOT propose your own range — use the numbers supplied. You return ONLY valid JSON, no preamble, no markdown fences. Be honest, evidence-led, no filler. No em dashes.`;

    const userPrompt = `Draft subject line: "${subject.trim()}"
${category ? `Target category: ${category}` : 'Category: not specified'}
${audience ? `Audience hint: ${audience}` : ''}

Detected features in the draft: ${featurePills}

PRE-COMPUTED COHORT STATS (use these numbers verbatim — do not invent your own):
- Cohort size: n=${stats.n} pattern-matched past sends
- P25–P75 open rate: ${stats.p25.toFixed(1)}% to ${stats.p75.toFixed(1)}%
- Median: ${stats.p50.toFixed(1)}% · Mean: ${stats.mean.toFixed(1)}% · σ: ${stats.sd.toFixed(1)}pp
- Full cohort range: ${stats.min.toFixed(1)}% to ${stats.max.toFixed(1)}%
- Confidence (size + spread based): ${stats.confidence}

Per-feature historical lift (within ${category || 'full library'}):
${liftLines}

Closest references from the cohort (already selected by similarity + open rate):
${refLines}

Return JSON in this exact shape:
{
  "reasoning": "<2 short sentences. Cite the P25–P75 range, n, and ONE specific feature lift that drove it up or down. Do not restate raw stats without interpretation.>",
  "references": [
    { "subject": "<verbatim subject from the references above>", "openRate": <number — the exact one supplied>, "whyItWorks": "<one sentence tying this subject's structure back to the draft>" },
    { "subject": "...", "openRate": <number>, "whyItWorks": "..." },
    { "subject": "...", "openRate": <number>, "whyItWorks": "..." }
  ],
  "suggestion": "<one specific edit to the draft drawn from the historical lifts above. Propose actual wording. If draft already exploits the high-lift patterns, say 'Already strong on [pattern]; the only further move would be [X]'.>"
}

Pick the three references that map most closely to the draft's structure. Reference openRate values must match the numbers supplied above exactly.`;

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
      return res.status(200).json({ prediction: parsed });
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
