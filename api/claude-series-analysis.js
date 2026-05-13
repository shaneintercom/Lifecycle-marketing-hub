module.exports = async function (req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { replies, question, sourceContext } = req.body;

  if (!replies || !replies.length) return res.status(400).json({ error: 'No replies provided.' });
  if (!question || !question.trim()) return res.status(400).json({ error: 'No question provided.' });

  // Sonnet 4.6 has 200k input context. ~4 chars/token. Cap each reply at 1200 chars
  // (~300 tokens) and target ~150k tokens of replies max → ~500 replies headroom.
  // For larger volumes we trim, keeping the most recent.
  const MAX_REPLIES = 800;
  const sorted = [...replies].sort((a, b) => (b.replyDate || 0) - (a.replyDate || 0));
  const sampled = sorted.slice(0, MAX_REPLIES);
  const trimmed = replies.length > MAX_REPLIES;

  const replyLines = sampled.map((r, i) => {
    const date = r.replyDate
      ? new Date(r.replyDate * 1000).toISOString().slice(0, 10)
      : '—';
    const body = (r.replyText || '').slice(0, 1200);
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
        max_tokens: 4000,
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
};
