async function runQuery(sql, token) {
  const account = (process.env.SNOWFLAKE_ACCOUNT || 'PEOSZPH-INTERCOM_US').toLowerCase();
  const url = `https://${account}.snowflakecomputing.com/api/v2/statements`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-Snowflake-Authorization-Token-Type': 'PROGRAMMATIC_ACCESS_TOKEN',
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      statement: sql,
      warehouse: process.env.SNOWFLAKE_WAREHOUSE || 'WH_INTERCOMRADE',
      database: 'INTERCOM_PROD',
      timeout: 50,
    }),
  });

  const body = await res.json();
  if (body.resultSetMetaData) return parseRows(body);
  if (!res.ok) throw new Error(body.message || `Snowflake error ${res.status}`);
  if (body.statementHandle) return poll(body.statementHandle, token, account);
  throw new Error('Unexpected Snowflake response');
}

async function poll(handle, token, account) {
  const url = `https://${account}.snowflakecomputing.com/api/v2/statements/${handle}`;
  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Snowflake-Authorization-Token-Type': 'PROGRAMMATIC_ACCESS_TOKEN',
        'Accept': 'application/json',
      },
    });
    const body = await res.json();
    if (body.status === 'failed') throw new Error(body.message || 'Query failed');
    if (body.resultSetMetaData) return parseRows(body);
  }
  throw new Error('Query timed out after 50 seconds');
}

function parseRows(body) {
  if (!body.resultSetMetaData || !body.data) return [];
  const cols = body.resultSetMetaData.rowType.map(c => c.name);
  return body.data.map(row => {
    const obj = {};
    cols.forEach((c, i) => { obj[c] = row[i]; });
    return obj;
  });
}

const SCHEMA_CONTEXT = `
Available Snowflake tables (database: INTERCOM_PROD):

── WORKSPACE DIMENSIONS ──
INTERCOM_PROD.CORE_COMMON.DIM_APPS
  APP_ID, IS_PAID_APP_NOW (boolean), IS_DELETED_APP (boolean),
  INCLUDE_IN_ANALYSIS (boolean), APP_CREATED_AT, PLAN_NAME, INDUSTRY

── CAMPAIGN / SERIES RECIPIENTS ──
INTERCOM_PROD.CORE_PRODUCT.FCT_OUTBOUND_RECEIPTS
  APP_ID (= 6 for Intercom's own sending workspace — always filter APP_ID = 6),
  RULESET_ID (= the Intercom Series ID),
  USER_ID (the teammate/admin who received it),
  CONTENT_TYPE ('email', 'post', 'chat', etc.),
  CREATED_AT (send timestamp),
  OPEN_ID (NULL = not opened; NOT NULL = opened),
  WAS_CLICKED (boolean)
  → Use to get campaign recipients: WHERE APP_ID = 6 AND RULESET_ID = <series_id>

INTERCOM_PROD.CORE_PRODUCT.DIM_TEAMMATES
  I4I_USER_ID (joins to FCT_OUTBOUND_RECEIPTS.USER_ID),
  DEFAULT_APP_ID (the customer workspace APP_ID this teammate belongs to)
  → Join to map email recipients → their customer workspace APP_IDs

── PRODUCT USAGE / DAILY METRICS ──
INTERCOM_PROD.CORE_PRODUCT.MART_APP_METRICS_DAILY
  CALENDAR_DATE, APP_ID,
  COUNT_INBOX_CONVERSATIONS_FIN_ADDRESSABLE,
  COUNT_INBOX_CONVERSATIONS_HARD_RESOLVED_BY_FIN_AI_ANSWER,
  COUNT_INBOX_CONVERSATIONS_WITH_FIN_GUIDANCE,
  COUNT_INBOX_CONVERSATIONS_TOTAL,
  COUNT_INBOX_CONVERSATIONS,
  COUNT_INBOX_CONVERSATIONS_CLOSED,
  COUNT_INBOX_CONVERSATIONS_FIN_ELIGIBLE,
  COUNT_INBOX_CONVERSATIONS_FIN_SENT_AI_ANSWER,
  COUNT_INBOX_CONVERSATIONS_RESOLVED_BY_FIN_OR_LEGACY_RESOLUTION_BOT

── FIN SETUP / ACTIVATION ──
INTERCOM_PROD.CORE_PRODUCT.FCT_APPS_CMF_RETURNS
  APP_ID, CALENDAR_DATE_FIRST_FIN_OR_LEGACY_RESOLUTION_BOT_CONVERSATION

INTERCOM_PROD.CORE_PRODUCT.FCT_CONVERSATION_APPLIED_FIN_GUIDANCE
  APP_ID, CONVERSATION_ID, CREATED_AT
  → Rows exist when Fin guidance was applied; use COUNT(DISTINCT APP_ID) for setup rate

INTERCOM_PROD.CORE_PRODUCT.DIM_PROCEDURES
  APP_ID, PROCEDURE_ID, CREATED_AT
  → Rows exist when a Fin procedure was created

INTERCOM_PROD.CORE_PRODUCT.FCT_PROCEDURE_EXECUTIONS
  APP_ID, PROCEDURE_ID, PROCEDURE_EXECUTION_STARTED_AT
  → Actual procedure runs (not just creation)

Standard filter for active paid workspaces (always include unless asked not to):
  JOIN INTERCOM_PROD.CORE_COMMON.DIM_APPS da ON <table>.APP_ID = da.APP_ID
  WHERE da.IS_PAID_APP_NOW = true AND da.IS_DELETED_APP = false AND da.INCLUDE_IN_ANALYSIS = true

── BEFORE/AFTER CAMPAIGN IMPACT PATTERN ──
When asked about campaign impact, use this pattern:
  WITH send_info AS (
    SELECT DATE(MIN(CREATED_AT)) AS sd
    FROM INTERCOM_PROD.CORE_PRODUCT.FCT_OUTBOUND_RECEIPTS
    WHERE APP_ID = 6 AND RULESET_ID = <series_id>
  ),
  recipients AS (
    SELECT DISTINCT t.DEFAULT_APP_ID AS app_id
    FROM INTERCOM_PROD.CORE_PRODUCT.FCT_OUTBOUND_RECEIPTS r
    JOIN INTERCOM_PROD.CORE_PRODUCT.DIM_TEAMMATES t ON r.USER_ID = t.I4I_USER_ID
    WHERE r.APP_ID = 6 AND r.RULESET_ID = <series_id> AND t.DEFAULT_APP_ID IS NOT NULL
    LIMIT 2000
  )
  -- Then compare metric before (DATEADD day -30 to sd) vs after (sd to DATEADD day +30)
  -- for recipients vs a control group (paid workspaces NOT in recipients)
`.trim();

module.exports = async function (req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { seriesId, request, campaignContext } = req.body;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const SF_TOKEN = (process.env.SNOWFLAKE_PAT || '').trim();

  if (!request || !request.trim()) {
    return res.status(400).json({ error: 'Analytics request is required.' });
  }
  if (!SF_TOKEN) {
    return res.status(200).json({ setupRequired: true, error: 'Snowflake not connected — add SNOWFLAKE_PAT to Vercel environment variables.' });
  }

  // Optional: fetch series context from Intercom
  let seriesContext = seriesId ? `Intercom Series ID: ${seriesId}` : '';
  if (seriesId && process.env.INTERCOM_TOKEN) {
    try {
      const icRes = await fetch(`https://api.intercom.io/series/${seriesId}`, {
        headers: {
          'Authorization': `Bearer ${process.env.INTERCOM_TOKEN}`,
          'Accept': 'application/json',
          'Intercom-Version': '2.11',
        },
      });
      if (icRes.ok) {
        const ic = await icRes.json();
        seriesContext = `Intercom Series: "${ic.title || ic.name || 'Unknown'}" (ID: ${seriesId})`;
      }
    } catch (_) { /* use default */ }
  }

  // Step 1: Claude generates SQL
  const sqlPrompt = `You are a Snowflake SQL expert for Intercom's internal data warehouse.
Generate a SQL query to answer this analytics question for the Lifecycle Marketing team.

${seriesContext ? `Campaign context: ${seriesContext}` : ''}
${campaignContext ? `Campaign details: ${campaignContext}` : ''}
Analytics question: ${request.trim()}

Schema reference:
${SCHEMA_CONTEXT}

Rules:
- Use only the tables listed above with full schema paths
- Always apply the standard paid workspace filter via DIM_APPS unless the user explicitly asks not to
- Use DATEADD('day', -N, CURRENT_DATE) for relative date ranges
- If a Series ID is provided and the question is about campaign impact, use the BEFORE/AFTER CAMPAIGN IMPACT PATTERN — identify recipients via FCT_OUTBOUND_RECEIPTS + DIM_TEAMMATES, compare 30 days before vs 30 days after the send date, and include a control group of non-recipient paid workspaces
- For involvement/guidance/procedures questions, use FCT_CONVERSATION_APPLIED_FIN_GUIDANCE, DIM_PROCEDURES, or MART_APP_METRICS_DAILY columns as appropriate
- Keep the query focused and efficient — return only the columns needed to answer the question
- Return ONLY the raw SQL query — no markdown, no backticks, no explanation`;

  let sql;
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: sqlPrompt }],
      }),
    });
    if (!claudeRes.ok) throw new Error('Claude error: ' + await claudeRes.text());
    const claudeData = await claudeRes.json();
    sql = (claudeData.content?.[0]?.text || '').trim()
      .replace(/^```sql\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '').trim();
  } catch (e) {
    return res.status(500).json({ error: `SQL generation failed: ${e.message}` });
  }

  // Step 2: Execute the query in Snowflake
  let rows;
  try {
    rows = await runQuery(sql, SF_TOKEN);
  } catch (e) {
    const isNetworkPolicy = e.message && e.message.toLowerCase().includes('network policy');
    if (isNetworkPolicy) {
      return res.status(200).json({
        sql,
        networkPolicyError: true,
        error: 'Snowflake blocked the query due to a network policy — your PAT token is restricted to Intercom\'s corporate network and cannot be used from Vercel\'s servers. To fix this, create a new PAT token in Snowflake without a network policy restriction (or ask your Snowflake admin to create one). Then update the SNOWFLAKE_PAT environment variable in Vercel.',
      });
    }
    return res.status(200).json({ sql, error: `Query failed: ${e.message}`, queryError: true });
  }

  // Step 3: Claude narrates results
  const narrativePrompt = `You are a lifecycle marketing analyst at Intercom.

Question: ${request.trim()}
${seriesContext ? `Campaign: ${seriesContext}` : ''}
${campaignContext ? `Campaign details: ${campaignContext}` : ''}

Query results (${rows.length} row${rows.length !== 1 ? 's' : ''}):
${JSON.stringify(rows.slice(0, 50), null, 2)}

Write 2–4 sentences answering the question based on these results. Be specific — use the actual numbers. If results are surprising, say so. No fluff or preamble.`;

  let narrative = '';
  try {
    const narRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        messages: [{ role: 'user', content: narrativePrompt }],
      }),
    });
    const narData = await narRes.json();
    narrative = narData.content?.[0]?.text || '';
  } catch (_) { /* return results without narrative */ }

  return res.status(200).json({ sql, rows, rowCount: rows.length, narrative });
};
