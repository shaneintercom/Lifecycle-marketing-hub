module.exports = async function (req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { question } = req.body;
  if (!question || !question.trim()) return res.status(400).json({ error: 'Question is required.' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const TOKEN = process.env.INTERCOM_TOKEN;

  const icHeaders = {
    'Authorization': `Bearer ${TOKEN}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Intercom-Version': '2.11',
  };

  function stripHtml(html = '') {
    return html
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  try {
    // ── Step 1: Extract key search words from question ───────────────────────
    const extractResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 30,
        messages: [{
          role: 'user',
          content: `Extract 2–4 distinctive keywords from the campaign name in this question. Drop generic words like "email", "campaign", "series", "replies". Return ONLY the keywords, nothing else.\n\nExamples:\n"Fin monthly performance email" → "Fin monthly performance"\n"BFY Feb round up" → "BFY Feb round"\n"LinkedIn Live promo" → "LinkedIn Live"\n\nQuestion: "${question.trim()}"\nKeywords:`,
        }],
      }),
    });
    const extractData = await extractResp.json();
    const searchTerm = (extractData.content?.[0]?.text || question).trim().replace(/^["']|["']$/g, '').slice(0, 80);

    // ── Step 2: Search Intercom — retry with progressively shorter terms ─────
    async function searchIntercom(term) {
      const r = await fetch('https://api.intercom.io/conversations/search', {
        method: 'POST',
        headers: icHeaders,
        body: JSON.stringify({
          query: { operator: 'OR', value: [
            { field: 'source.subject', operator: '~', value: term },
            { field: 'source.author.name', operator: '~', value: term },
          ]},
          pagination: { per_page: 50 },
        }),
      });
      const d = await r.json();
      return d.conversations || [];
    }

    let convs = await searchIntercom(searchTerm);

    // Retry with first 3 words, then first 2 words
    if (!convs.length) {
      const words = searchTerm.split(/\s+/);
      if (words.length > 2) convs = await searchIntercom(words.slice(0, 3).join(' '));
    }
    if (!convs.length) {
      const words = searchTerm.split(/\s+/);
      if (words.length > 1) convs = await searchIntercom(words.slice(0, 2).join(' '));
    }

    if (!convs.length) {
      return res.status(200).json({ noResults: true, searchTerm });
    }

    // ── Step 3: Pick best source (most conversations = most replies) ─────────
    const groups = {};
    for (const c of convs) {
      const sid = c.source?.id;
      if (!sid) continue;
      if (!groups[sid]) groups[sid] = { sourceId: sid, subject: stripHtml(c.source?.subject || ''), count: 0 };
      groups[sid].count++;
    }
    const topSource = Object.values(groups).sort((a, b) => b.count - a.count)[0];
    const toFetch = convs.filter(c => c.source?.id === topSource.sourceId).slice(0, 50);

    // ── Step 4: Fetch full conversation parts in parallel ────────────────────
    const fullConvs = await Promise.all(
      toFetch.map(c =>
        fetch(`https://api.intercom.io/conversations/${c.id}`, {
          headers: { 'Authorization': `Bearer ${TOKEN}`, 'Accept': 'application/json', 'Intercom-Version': '2.11' },
        }).then(r => r.json())
      )
    );

    const replies = [];
    for (const conv of fullConvs) {
      const parts = conv.conversation_parts?.conversation_parts || [];
      const userReply = parts.find(p =>
        (p.author?.type === 'user' || p.author?.type === 'lead') &&
        p.body && p.body.trim() !== '' && p.body !== '<p></p>' && p.body !== '<p> </p>'
      );
      if (!userReply) continue;
      replies.push({
        contactName: userReply.author?.name || userReply.author?.email || 'Unknown',
        replyText: stripHtml(userReply.body),
        replyDate: userReply.created_at,
      });
    }

    if (!replies.length) {
      return res.status(200).json({ noReplies: true, searchTerm, subject: topSource.subject });
    }

    // ── Step 5: Analyse with Claude ──────────────────────────────────────────
    const replyLines = replies.slice(0, 60).map((r, i) => {
      const date = r.replyDate ? new Date(r.replyDate * 1000).toISOString().slice(0, 10) : '—';
      return `Reply ${i + 1} [${date}, ${r.contactName}]: ${r.replyText}`;
    }).join('\n\n');

    const analysisResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `You are a lifecycle marketing analyst at Intercom (B2B SaaS) reviewing customer replies to the outbound email: "${topSource.subject}"\n\nTotal replies analysed: ${replies.length}${replies.length > 60 ? ' (showing first 60)' : ''}\n\nReplies:\n${replyLines}\n\nQuestion: ${question.trim()}\n\nProvide a clear, direct answer. Call out themes, patterns, sentiment, and signals worth acting on. Quote specific replies where relevant. Confident analyst tone — no fluff.`,
        }],
      }),
    });
    const analysisData = await analysisResp.json();
    const analysis = analysisData.content?.[0]?.text || '';

    return res.status(200).json({ analysis, searchTerm, subject: topSource.subject, replyCount: replies.length });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
