module.exports = async function (req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { replies, question, sourceContext } = req.body;

  if (!replies || !replies.length) return res.status(400).json({ error: 'No replies provided.' });
  if (!question || !question.trim()) return res.status(400).json({ error: 'No question provided.' });

  const sample = replies.slice(0, 60);
  const replyLines = sample.map((r, i) => {
    const date = r.replyDate
      ? new Date(r.replyDate * 1000).toISOString().slice(0, 10)
      : '—';
    return `Reply ${i + 1} [${date}, ${r.contactName || 'Unknown'}]: ${r.replyText}`;
  }).join('\n\n');

  const prompt = `You are a lifecycle marketing analyst at Intercom (B2B SaaS) reviewing customer replies to an outbound automated email.

Email context: ${sourceContext || 'Automated outbound email from a Series'}
Total replies received: ${replies.length}${replies.length > 60 ? ` (showing first 60)` : ''}

Customer replies:
${replyLines}

Marketing team question: ${question.trim()}

Provide a clear, direct, specific answer. Call out themes, patterns, sentiment, and any signals worth acting on. If relevant, quote or reference specific replies. Use a confident analyst tone — no fluff.`;

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
        max_tokens: 1000,
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
