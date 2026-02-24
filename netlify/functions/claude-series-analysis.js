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

  const { replies, question, sourceContext } = body;

  if (!replies || !replies.length) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No replies provided.' }) };
  }
  if (!question || !question.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No question provided.' }) };
  }

  // Build reply text for the prompt (cap at 60 replies to stay within token limits)
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
      return { statusCode: 500, body: JSON.stringify({ error: err }) };
    }

    const data = await response.json();
    const analysis = data.content?.[0]?.text || '';
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ analysis }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
