// Handles two modes:
//   mode: "analyse" (default)  — full CPO-ready analysis of a reply set (Sonnet)
//   mode: "classify"           — batch sentiment/theme/concern per reply (Haiku, JSON)
//
// Folded into one endpoint to stay under Vercel Hobby's 12-function ceiling.

module.exports = async function (req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const mode = (req.body && req.body.mode) || 'analyse';

  if (mode === 'classify') return classifyReplies(req, res);
  return analyseReplies(req, res);
};

// ── ANALYSE (exec-ready, single call over all replies) ──────────────────────
async function analyseReplies(req, res) {
  const { replies, question, sourceContext } = req.body;
  if (!replies || !replies.length) return res.status(400).json({ error: 'No replies provided.' });
  if (!question || !question.trim()) return res.status(400).json({ error: 'No question provided.' });

  // Tuned to land safely under Vercel 60s timeout on Sonnet 4.6:
  // 400 replies × ~250 tokens each ≈ 100k input tokens. Sonnet returns ~3k output
  // in 25-45s typically. Headroom for slow API responses.
  const MAX_REPLIES = 400;
  const sorted = [...replies].sort((a, b) => (b.replyDate || 0) - (a.replyDate || 0));
  const sampled = sorted.slice(0, MAX_REPLIES);
  const trimmed = replies.length > MAX_REPLIES;

  const replyLines = sampled.map((r, i) => {
    const date = r.replyDate
      ? new Date(r.replyDate * 1000).toISOString().slice(0, 10)
      : '—';
    const body = (r.replyText || '').slice(0, 800);
    return `Reply ${i + 1} [${date} · ${r.contactName || 'Unknown'}]: ${body}`;
  }).join('\n\n');

  const systemPrompt = `You are a senior lifecycle marketing analyst at Intercom (B2B SaaS, AI-first customer service platform). You are preparing analysis that will be forwarded to the CPO. Be precise, evidence-led, and avoid filler. Quote real replies verbatim when they illustrate a point. Use a confident analyst voice. No em dashes.`;

  const userPrompt = `Email context: ${sourceContext || 'Outbound automated email from a Series'}
Total customer replies received: ${replies.length}${trimmed ? ` (analysing most recent ${MAX_REPLIES})` : ''}

Customer replies:
${replyLines}

Marketing team question: ${question.trim()}

Produce an executive-ready analysis with this exact structure (use markdown):

## Headline
One sentence answering the question with the most important finding.

## Sentiment breakdown
- Positive: X% (one-line characterisation)
- Neutral: X% (one-line characterisation)
- Negative: X% (one-line characterisation)
Base percentages on the replies above. Round to whole numbers.

## Top themes
For each theme (3-6 themes): a bold heading, one-line summary, count or rough share of replies, and one verbatim quote (in quotation marks, attributed to the customer's first name only).

## What customers are asking for
Bulleted, specific. Include verbatim quotes where short and powerful.

## Concerning signals worth flagging
Anything risky, urgent, or that needs a response. If none, say "None worth escalating." Be honest, not reassuring.

## Recommended next actions
3-5 concrete, specific actions the team should take. Each action one line, action-first.

End cleanly. No closing remarks, no "let me know if you need more." This will be pasted into an email to the CPO so it must be self-contained.`;

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
        max_tokens: 3000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: `Claude API ${response.status}: ${err.slice(0, 500)}` });
    }

    const data = await response.json();
    const analysis = data.content?.[0]?.text || '';
    return res.status(200).json({
      analysis,
      repliesAnalysed: sampled.length,
      repliesTotal: replies.length,
      trimmed,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── CLASSIFY (per-reply sentiment/theme/concern/summary, JSON, Haiku) ───────
async function classifyReplies(req, res) {
  const { replies, subject } = req.body || {};
  if (!Array.isArray(replies) || !replies.length) {
    return res.status(400).json({ error: 'replies array required' });
  }
  if (replies.length > 60) {
    return res.status(400).json({ error: 'Batch too large (max 60).' });
  }

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
}
