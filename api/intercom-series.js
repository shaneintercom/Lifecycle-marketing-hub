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
      const { until, exact } = req.body;
      const hasQuery = query && query.trim().length >= 2;
      const hasDateRange = since && until;

      if (!hasQuery && !hasDateRange) {
        return res.status(400).json({ error: 'Provide a query (min 2 chars) or a since+until date range.' });
      }

      const andFilters = [];

      if (hasQuery) {
        // exact=true: only match the precise subject line (used by chip clicks)
        // exact=false/unset: contains search (used by manual search box)
        andFilters.push(exact
          ? { field: 'source.subject', operator: '=', value: query.trim() }
          : {
              operator: 'OR',
              value: [
                { field: 'source.subject', operator: '~', value: query.trim() },
                { field: 'source.body',    operator: '~', value: query.trim() },
                { field: 'source.author.name', operator: '~', value: query.trim() },
              ],
            }
        );
      }

      if (since) andFilters.push({ field: 'created_at', operator: '>', value: since });
      if (until) andFilters.push({ field: 'created_at', operator: '<', value: until });

      // Pull a wider sample (100 conversations) so the unique-subject grouping is more complete.
      const searchBody = {
        query: { operator: 'AND', value: andFilters },
        pagination: { per_page: 100 },
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

      // Strip Re:/Fwd:/AW:/SV: prefixes recursively so reply chains collapse under their parent.
      const normaliseSubject = (s) => {
        let out = (s || '').trim();
        const re = /^\s*(re|fwd?|aw|sv|tr|rv)\s*:\s*/i;
        while (re.test(out)) out = out.replace(re, '');
        return out.toLowerCase().replace(/\s+/g, ' ').trim();
      };

      // Step 1: group raw source IDs as before (one entry per Intercom source).
      const rawSources = {};
      for (const c of convs) {
        const src = c.source || {};
        const sid = src.id;
        if (!sid) continue;
        if (!rawSources[sid]) {
          const subject = stripHtml(src.subject || '');
          const bodySnippet = stripHtml(src.body || '').slice(0, 150);
          rawSources[sid] = {
            sourceId: sid,
            subject: subject || bodySnippet,
            bodySnippet,
            senderName: src.author?.name || '',
            senderEmail: src.author?.email || '',
            replyCount: 0,
          };
        }
        rawSources[sid].replyCount++;
      }

      // Step 2: merge raw sources by normalised subject. "Re: X" and "Re: Re: X" fold into "X".
      // Entries with empty normalised subjects (e.g. inbound chats with no subject) stay separate by sourceId.
      const merged = {};
      for (const s of Object.values(rawSources)) {
        const key = normaliseSubject(s.subject) || `__by_id_${s.sourceId}`;
        if (!merged[key]) {
          merged[key] = {
            sourceIds: [],
            // representative subject + sender start from this first entry; may be overridden by the dominant one
            subject: s.subject,
            bodySnippet: s.bodySnippet,
            senderName: s.senderName,
            senderEmail: s.senderEmail,
            replyCount: 0,
            dominantCount: 0,
          };
        }
        const g = merged[key];
        g.sourceIds.push(s.sourceId);
        g.replyCount += s.replyCount;
        // The original outbound usually has the highest replyCount; use it as the representative
        if (s.replyCount > g.dominantCount) {
          g.dominantCount  = s.replyCount;
          g.subject        = s.subject;
          g.bodySnippet    = s.bodySnippet;
          g.senderName     = s.senderName;
          g.senderEmail    = s.senderEmail;
        }
      }

      const sources = Object.values(merged)
        .map(g => ({
          // Backwards-compatible: sourceId = first id. New: sourceIds is the full list.
          sourceId:  g.sourceIds[0],
          sourceIds: g.sourceIds,
          subject:     g.subject,
          bodySnippet: g.bodySnippet,
          senderName:  g.senderName,
          senderEmail: g.senderEmail,
          replyCount:  g.replyCount,
          mergedFrom:  g.sourceIds.length,
        }))
        .sort((a, b) => b.replyCount - a.replyCount);

      return res.status(200).json({ sources, totalConversations: data.total_count });
    }

    // ── REPLIES MODE (cursor-paginated, one batch per call) ──────────────────
    // Frontend calls repeatedly with the returned nextCursor until it's null.
    // Each call: 1 search page (50 conversations) + 50 parallel deep-fetches.
    // For a campaign with N replies, frontend loops ceil(N/50) times.
    if (mode === 'replies') {
      // Accept either a single sourceId (legacy) or an array of sourceIds (merged group).
      const sourceIds = Array.isArray(req.body.sourceIds) && req.body.sourceIds.length
        ? req.body.sourceIds
        : (sourceId ? [sourceId] : []);
      if (!sourceIds.length) return res.status(400).json({ error: 'sourceId or sourceIds required.' });
      const cursor = req.body.cursor || null;

      const sourceClauses = sourceIds.map(sid => ({ field: 'source.id', operator: '=', value: sid }));
      const sourceQuery = sourceClauses.length === 1
        ? sourceClauses[0]
        : { operator: 'OR', value: sourceClauses };

      const pageBody = {
        query: { operator: 'AND', value: [sourceQuery] },
        pagination: { per_page: 50 },
      };
      if (cursor) pageBody.pagination.starting_after = cursor;

      const searchResp = await fetch('https://api.intercom.io/conversations/search', {
        method: 'POST',
        headers: icHeaders,
        body: JSON.stringify(pageBody),
      });
      if (!searchResp.ok) {
        const err = await searchResp.text();
        return res.status(500).json({ error: `Intercom search ${searchResp.status}: ${err.slice(0, 300)}` });
      }
      const searchData = await searchResp.json();
      const convs = searchData.conversations || [];
      const nextCursor = searchData.pages?.next?.starting_after || null;
      const total = searchData.total_count ?? null;

      const fullConvs = await Promise.all(
        convs.map(c =>
          fetch(`https://api.intercom.io/conversations/${c.id}`, {
            headers: {
              'Authorization': `Bearer ${TOKEN}`,
              'Accept': 'application/json',
              'Intercom-Version': '2.11',
            },
          }).then(r => r.ok ? r.json() : null).catch(() => null)
        )
      );

      const replies = [];
      for (const conv of fullConvs) {
        if (!conv || !conv.id) continue;
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
      return res.status(200).json({
        replies,
        nextCursor,
        total,
        batchConversations: convs.length,
      });
    }

    // ── RECENT SUBJECTS MODE ─────────────────────────────────────────────────
    if (mode === 'recentSubjects') {
      // GET /conversations is a simple indexed list — much faster than search for no-filter queries
      const r = await fetch('https://api.intercom.io/conversations?per_page=50&sort=created_at&order=desc', {
        headers: {
          'Authorization': `Bearer ${TOKEN}`,
          'Accept': 'application/json',
          'Intercom-Version': '2.11',
        },
      });

      if (!r.ok) {
        const err = await r.text();
        return res.status(500).json({ error: `Intercom ${r.status}: ${err.slice(0, 300)}` });
      }

      const data = await r.json();
      const convs = data.conversations || [];

      // Group by subject line — skip empty subjects (inbound/in-app messages have no subject)
      const subjects = {};
      for (const c of convs) {
        const subj = stripHtml(c.source?.subject || '').trim();
        if (!subj) continue;
        if (!subjects[subj]) subjects[subj] = { subject: subj, replyCount: 0, latestAt: 0 };
        subjects[subj].replyCount++;
        if ((c.created_at || 0) > subjects[subj].latestAt) subjects[subj].latestAt = c.created_at;
      }

      const sorted = Object.values(subjects)
        .sort((a, b) => b.latestAt - a.latestAt)
        .slice(0, 15);

      return res.status(200).json({ subjects: sorted, debug: { fetched: convs.length } });
    }


    return res.status(400).json({ error: 'Invalid mode. Use "search", "replies", "recentSubjects", or "firehose".' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
