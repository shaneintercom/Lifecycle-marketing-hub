module.exports = async function (req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const reportData = req.body;
  const fmt   = v => v != null ? (v * 100).toFixed(1) + '%' : '—';
  const delta = (q, a) => {
    if (q == null || a == null) return '';
    const d = ((q - a) * 100).toFixed(1);
    return d > 0 ? ` (+${d}pp vs all-time avg)` : ` (${d}pp vs all-time avg)`;
  };

  const productSection = reportData.productInsights
    ? `\nProduct & Usage Insights (provided by the team):\n${reportData.productInsights}`
    : '';

  let prompt;

  if (reportData.isSingleCampaign) {
    const {
      campaignName, category, sendDate, emailsSent,
      openRate, clickRate, ctor, unsubRate,
      subjectLine, audience, notes,
      catAvgOpen, catAvgClick, catAvgCTOR,
      histAvgOpen, histAvgClick,
    } = reportData;

    prompt = `You are a lifecycle marketing analyst writing a focused campaign post-mortem for a VP of Growth at a B2B SaaS company (Intercom). Write a concise 3-paragraph narrative based on the data below. Be specific with numbers. Use a confident, direct, professional tone. Do not use bullet points or headers — flowing prose only. Do not start with "This campaign" or "In this campaign".

Campaign: ${campaignName}
Category: ${category || '—'}
Send Date: ${sendDate || '—'}
Emails Sent: ${emailsSent ? Number(emailsSent).toLocaleString() : '—'}
Subject Line: ${subjectLine || '—'}
Audience: ${audience || '—'}

Performance:
- Open Rate: ${fmt(openRate)}${delta(openRate, catAvgOpen ? catAvgOpen : histAvgOpen)} (${category} category avg: ${fmt(catAvgOpen)}, all-time avg: ${fmt(histAvgOpen)})
- Click Rate: ${fmt(clickRate)}${delta(clickRate, catAvgClick)} (${category} category avg: ${fmt(catAvgClick)})
- CTOR: ${fmt(ctor)} (${category} category avg: ${fmt(catAvgCTOR)})
- Unsub Rate: ${fmt(unsubRate)}
${notes ? `\nCampaign notes: ${notes}` : ''}${productSection}

Write exactly three paragraphs:
1. Performance summary — how this campaign performed vs category and all-time benchmarks, what the numbers mean
2. What drove results — subject line, audience, timing, content or any other factors that likely explain the performance
3. Learnings & recommendation — one clear, data-backed takeaway for the team${reportData.productInsights ? ', incorporating the product usage insights above' : ''}`;

  } else {
    const {
      period, campaignCount, totalSent,
      avgOpen, avgClick, avgCTOR,
      allTimeOpen, allTimeClick, allTimeCTOR,
      topCampaigns, abTests, categoryBreakdown,
    } = reportData;

    const topLines = (topCampaigns || []).map(c =>
      `  - ${c.name} (${c.category}): ${fmt(c.openRate)} open, ${fmt(c.clickRate)} click`
    ).join('\n') || '  No campaigns with performance data in this period.';

    const abLines = (abTests || []).length
      ? abTests.map(t =>
          `  - "${t.name}": ${t.winner && t.winner !== 'N' ? `Variant ${t.winner} won` : 'No clear winner'}`
        ).join('\n')
      : '  No A/B tests in this period.';

    const catLines = Object.entries(categoryBreakdown || {}).map(([cat, m]) =>
      `  - ${cat}: ${fmt(m.open)} open, ${fmt(m.click)} click (${m.count} campaign${m.count !== 1 ? 's' : ''})`
    ).join('\n') || '  No category data available.';

    prompt = `You are a lifecycle marketing analyst writing an executive performance narrative for a VP of Growth or Marketing at a B2B SaaS company (Intercom). Write a concise 3-paragraph narrative based on the data below. Be specific with numbers. Use a confident, direct, professional tone. Do not use bullet points or headers — flowing prose only. Do not start with "In this period" or "During this period".

Report Period: ${period}
Campaigns sent: ${campaignCount}
Total emails sent: ${totalSent != null ? Number(totalSent).toLocaleString() : '—'}

Performance vs All-Time Benchmarks:
- Avg Open Rate: ${fmt(avgOpen)}${delta(avgOpen, allTimeOpen)}
- Avg Click Rate: ${fmt(avgClick)}${delta(avgClick, allTimeClick)}
- Avg CTOR: ${fmt(avgCTOR)}${delta(avgCTOR, allTimeCTOR)}

Top Performing Campaigns:
${topLines}

A/B Tests:
${abLines}

Category Breakdown:
${catLines}
${productSection}

Write exactly three paragraphs:
1. Overall performance — headline numbers, how the period tracked vs benchmarks, what the numbers mean for the business
2. Campaign highlights — what stood out, which categories or campaigns drove results and why it matters${reportData.productInsights ? ', weaving in the product usage insights above' : ''}
3. Learnings & forward look — what A/B tests revealed, and one clear data-backed observation or recommendation for the team going into the next period`;
  }

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
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: err });
    }

    const data = await response.json();
    const narrative = data.content?.[0]?.text || '';
    return res.status(200).json({ narrative });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
