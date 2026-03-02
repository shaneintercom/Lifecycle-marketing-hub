module.exports = async function (req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { mode, query, sourceId, since } = req.body;
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
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  try {
    // ── SEARCH MODE ──────────────────────────────────────────────────────────
    if (mode === 'search') {
      if (!query || query.trim().length < 2) {
        return res.status(400).json({ error: 'Query must be at least 2 characters.' });
      }

      const andFilters = [
        { field: 'source.delivered_as', operator: '=', value: 'automated' },
        {
          operator: 'OR',
          value: [
            { field: 'source.subject', operator: '~', value: query.trim() },
            { field: 'source.author.name', operator: '~', value: query.trim() },
          ],
        },
      ];

      if (since) {
        andFilters.push({ field: 'created_at', operator: '>', value: since });
      }

      const searchBody = {
        query: { operator: 'AND', value: andFilters },
        pagination: { per_page: 50 },
      };

      const response = await fetch('https://api.intercom.io/conversations/search', {
        method: 'POST',
        headers: icHeaders,
        body: JSON.stringify(searchBody),
      });

      if (!response.ok) {
        const err = await response.text();
        return res.status(500).json({ error: err });
      }

      const data = await response.json();
      const convs = data.conversations || [];

      const groups = {};
      for (const c of convs) {
        const src = c.source || {};
        const sid = src.id;
        if (!sid) continue;
        if (!groups[sid]) {
          groups[sid] = {
            sourceId: sid,
            subject: stripHtml(src.subject || ''),
            bodySnippet: stripHtml(src.body || '').slice(0, 150),
            senderName: src.author?.name || '',
            senderEmail: src.author?.email || '',
            replyCount: 0,
          };
        }
        groups[sid].replyCount++;
      }

      const sources = Object.values(groups).sort((a, b) => b.replyCount - a.replyCount);
      return res.status(200).json({ sources, totalConversations: data.total_count });
    }

    // ── REPLIES MODE ─────────────────────────────────────────────────────────
    if (mode === 'replies') {
      if (!sourceId) return res.status(400).json({ error: 'sourceId is required.' });

      // Fetch conversations for this source (up to 2 pages = 100)
      const allConvs = [];
      let cursor = null;

      for (let page = 0; page < 2; page++) {
        const pageBody = {
          query: {
            operator: 'AND',
            value: [{ field: 'source.id', operator: '=', value: sourceId }],
          },
          pagination: { per_page: 50 },
        };
        if (cursor) pageBody.pagination.starting_after = cursor;

        const r = await fetch('https://api.intercom.io/conversations/search', {
          method: 'POST',
          headers: icHeaders,
          body: JSON.stringify(pageBody),
        });
        const data = await r.json();
        const convs = data.conversations || [];
        allConvs.push(...convs);
        if (convs.length < 50 || !data.pages?.next?.starting_after) break;
        cursor = data.pages.next.starting_after;
      }

      // Cap at 50 and fetch all in one parallel batch to stay within timeout
      const toFetch = allConvs.slice(0, 50);
      const fullConvs = await Promise.all(
        toFetch.map(c =>
          fetch(`https://api.intercom.io/conversations/${c.id}`, {
            headers: {
              'Authorization': `Bearer ${TOKEN}`,
              'Accept': 'application/json',
              'Intercom-Version': '2.11',
            },
          }).then(r => r.json())
        )
      );

      const replies = [];
      for (const conv of fullConvs) {
        if (!conv.id) continue;
        const parts = conv.conversation_parts?.conversation_parts || [];
        const userReply = parts.find(p =>
          (p.author?.type === 'user' || p.author?.type === 'lead') &&
          p.body &&
          p.body.trim() !== '' &&
          p.body !== '<p></p>' &&
          p.body !== '<p> </p>'
        );
        if (!userReply) continue;

        const author = userReply.author || {};
        replies.push({
          convId: conv.id,
          contactName: author.name || author.email || 'Unknown',
          contactEmail: author.email || '',
          replyText: stripHtml(userReply.body || ''),
          replyDate: userReply.created_at,
          sourceSubject: stripHtml(conv.source?.subject || ''),
        });
      }

      replies.sort((a, b) => b.replyDate - a.replyDate);
      return res.status(200).json({ replies, total: allConvs.length });
    }

    return res.status(400).json({ error: 'Invalid mode. Use "search" or "replies".' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
