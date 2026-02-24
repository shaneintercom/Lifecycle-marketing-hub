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

  const { mode, query, sourceId, since } = body;
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
    // ── SEARCH MODE: find unique automated message sources matching query ──────
    if (mode === 'search') {
      if (!query || query.trim().length < 2) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Query must be at least 2 characters.' }) };
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

      const res = await fetch('https://api.intercom.io/conversations/search', {
        method: 'POST',
        headers: icHeaders,
        body: JSON.stringify(searchBody),
      });

      if (!res.ok) {
        const err = await res.text();
        return { statusCode: 500, body: JSON.stringify({ error: err }) };
      }

      const data = await res.json();
      const convs = data.conversations || [];

      // Group by source.id to show unique originating messages
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
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources, totalConversations: data.total_count }),
      };
    }

    // ── REPLIES MODE: fetch all replies for a specific source message ──────────
    if (mode === 'replies') {
      if (!sourceId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'sourceId is required.' }) };
      }

      // Paginate through all conversations for this source
      const allConvs = [];
      let cursor = null;

      for (let page = 0; page < 5; page++) {
        const pageBody = {
          query: {
            operator: 'AND',
            value: [{ field: 'source.id', operator: '=', value: sourceId }],
          },
          pagination: { per_page: 50 },
        };
        if (cursor) pageBody.pagination.starting_after = cursor;

        const res = await fetch('https://api.intercom.io/conversations/search', {
          method: 'POST',
          headers: icHeaders,
          body: JSON.stringify(pageBody),
        });
        const data = await res.json();
        const convs = data.conversations || [];
        allConvs.push(...convs);

        if (convs.length < 50 || !data.pages?.next?.starting_after) break;
        cursor = data.pages.next.starting_after;
      }

      // Fetch full conversation details in parallel batches to get reply parts
      const BATCH = 20;
      const replies = [];

      for (let i = 0; i < Math.min(allConvs.length, 100); i += BATCH) {
        const batch = allConvs.slice(i, i + BATCH);
        const fullConvs = await Promise.all(
          batch.map(c =>
            fetch(`https://api.intercom.io/conversations/${c.id}`, {
              headers: {
                'Authorization': `Bearer ${TOKEN}`,
                'Accept': 'application/json',
                'Intercom-Version': '2.11',
              },
            }).then(r => r.json())
          )
        );

        for (const conv of fullConvs) {
          if (!conv.id) continue;
          const parts = conv.conversation_parts?.conversation_parts || [];

          // Find the first non-empty customer reply (user or lead type)
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
      }

      // Most recent first
      replies.sort((a, b) => b.replyDate - a.replyDate);

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replies, total: allConvs.length }),
      };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid mode. Use "search" or "replies".' }) };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
