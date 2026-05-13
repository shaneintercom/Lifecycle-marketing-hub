// Classifies a batch of customer replies with sentiment, theme, concern level, and a
// one-line summary. Called per-batch by the frontend as replies stream in.
//
// Input: { replies: [{ convId, replyText }] , subject?: string }
// Output: { classifications: [{ convId, sentiment, theme, concern, summary }] }
//   sentiment: "positive" | "neutral" | "negative"
//   theme: short kebab-cased label, ideally drawn from the suggested vocabulary
//   concern: 0 (none) | 1 (note) | 2 (escalate) | 3 (urgent)
//   summary: <= 90 chars

module.exports = async function (req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { replies, subject } = req.body || {};
  if (!Array.isArray(replies) || !replies.length) {
    return res.status(400).json({ error: 'replies array required' });
  }
  if (replies.length > 60) {
    return res.status(400).json({ error: 'Batch too large (max 60).' });
  }

  // Trim long replies — classification only needs the gist, not the whole essay.
  const compact = replies.map((r, i) => ({
    i,
    convId: r.convId,
    text: (r.replyText || '').slice(0, 800),
  }));

  const blocks = compact.map(r => `[${r.i}] ${r.text}`).join('\n---\n');

  const systemPrompt = `You classify customer replies to outbound B2B SaaS marketing emails. You return ONLY valid JSON, no preamble, no markdown fences. Every classification must be present and well-formed.`;

  const userPrompt = `Email subject: ${subject || '(unknown)'}

Customer replies (numbered):
${blocks}

For each reply, output:
- sentiment: "positive" | "neutral" | "negative" (be honest, do not soften)
- theme: a single kebab-case theme label, 1-3 words. Prefer reusing across replies when meaning is similar. Suggested vocabulary (use when fitting, invent only when nothing fits): "praise", "pricing", "feature-request", "roadmap-question", "concern", "confusion", "churn-signal", "competitor-mention", "support-request", "thanks", "unsubscribe-request", "spam-complaint", "billing-issue", "integration-question", "out-of-office", "irrelevant"
- concern: 0 (routine), 1 (worth a note), 2 (escalate to PM/CSM), 3 (urgent — churn risk, legal, exec-level)
- summary: <= 90 chars, action-first if asking for something, fact-first if reporting something. Strip pleasantries.

Return JSON in this exact shape, with one object per reply in original order:
{"classifications":[{"i":0,"sentiment":"...","theme":"...","concern":0,"summary":"..."}]}`;

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
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: `Claude ${response.status}: ${err.slice(0, 400)}` });
    }
    const data = await response.json();
    let raw = (data.content?.[0]?.text || '').trim();
    // Tolerate stray fences just in case
    if (raw.startsWith('```')) raw = raw.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { return res.status(500).json({ error: 'Model returned non-JSON', raw: raw.slice(0, 300) }); }

    const list = Array.isArray(parsed.classifications) ? parsed.classifications : [];
    const byIndex = new Map(list.map(c => [c.i, c]));
    const classifications = compact.map(r => {
      const c = byIndex.get(r.i) || {};
      return {
        convId: r.convId,
        sentiment: ['positive','neutral','negative'].includes(c.sentiment) ? c.sentiment : 'neutral',
        theme: (c.theme || 'other').toString().toLowerCase().replace(/\s+/g, '-').slice(0, 40),
        concern: Number.isInteger(c.concern) ? Math.max(0, Math.min(3, c.concern)) : 0,
        summary: (c.summary || '').toString().slice(0, 140),
      };
    });

    return res.status(200).json({ classifications });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
