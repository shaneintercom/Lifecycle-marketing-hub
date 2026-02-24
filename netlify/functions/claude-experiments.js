exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const { categorySummary, existingTests, existingBacklog } = body;
  const fmt = v => v != null ? (v * 100).toFixed(1) + '%' : '—';

  const catLines = (categorySummary || [])
    .sort((a, b) => (b.campaigns || 0) - (a.campaigns || 0))
    .map(c => `- ${c.category}: ${c.campaigns} campaigns, avg open ${fmt(c.avgOpen)}, avg click ${fmt(c.avgClick)}`)
    .join('\n') || '- No category data yet';

  const testLines = (existingTests || []).length
    ? existingTests.map(t => `- "${t.name}" tested ${t.element || '?'}${t.winner && t.winner !== 'N' ? ` — Variant ${t.winner} won` : ''}`).join('\n')
    : '- None run yet';

  const backlogLines = (existingBacklog || []).filter(Boolean).length
    ? existingBacklog.filter(Boolean).map(h => `- ${h}`).join('\n')
    : '- Empty';

  const prompt = `You are a senior lifecycle marketing strategist with deep expertise in B2B SaaS email marketing for product-led growth companies like Intercom. You have full visibility into a team's campaign performance and experiment history.

Your task: suggest exactly 5 high-impact email experiments this team should run next.

Rules:
- Base suggestions on the gaps and opportunities the data shows (low click rates in a category, low CTOR, etc.)
- Do NOT duplicate anything in "A/B Tests Already Run" or "Existing Backlog"
- Draw on known email marketing best practices: personalisation, segmentation, timing, progressive profiling, behavioural triggers, send cadence, re-engagement, onboarding flows, feature adoption, expansion signals
- Be specific to B2B SaaS lifecycle marketing — think Intercom's use cases: trial conversion, onboarding, expansion, re-engagement, product launches, newsletters
- Vary the element types across your 5 suggestions (don't suggest 5 subject line tests)

Campaign Performance by Category:
${catLines}

A/B Tests Already Run (do not duplicate):
${testLines}

Existing Backlog Hypotheses (do not duplicate):
${backlogLines}

Return ONLY a valid JSON array with exactly 5 objects. No explanation, no markdown, just the raw JSON array.
Each object must have these exact keys:
- "hypothesis": a clear, testable hypothesis (1-2 sentences, written as "We believe [change] will [outcome] because [reason]")
- "element": exactly one of: Subject Line, Preview Text, Send Time, CTA, Email Content, Sender Name, Offer, Segmentation
- "category": the most relevant campaign category this applies to (use the categories from the data above)
- "context": brief audience/campaign context for when to run this (1 short sentence)
- "rationale": why this is worth testing now — reference the specific data gap or best practice (1-2 sentences)
- "priority": exactly one of: High, Medium, Low`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1800,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return { statusCode: 500, body: JSON.stringify({ error: err }) };
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '[]';

    // Robustly extract JSON array even if Claude adds any surrounding text
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Could not parse response', raw: text }) };
    }
    const suggestions = JSON.parse(jsonMatch[0]);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ suggestions }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
