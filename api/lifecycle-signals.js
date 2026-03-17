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

const SQL_FIN_NO_SETUP = `
SELECT COUNT(DISTINCT cmf.APP_ID) AS CNT
FROM INTERCOM_PROD.CORE_PRODUCT.FCT_APPS_CMF_RETURNS cmf
JOIN INTERCOM_PROD.CORE_COMMON.DIM_APPS da ON cmf.APP_ID = da.APP_ID
LEFT JOIN (SELECT DISTINCT APP_ID FROM INTERCOM_PROD.CORE_PRODUCT.FCT_CONVERSATION_APPLIED_FIN_GUIDANCE) fg ON cmf.APP_ID = fg.APP_ID
LEFT JOIN (SELECT DISTINCT APP_ID FROM INTERCOM_PROD.CORE_PRODUCT.DIM_PROCEDURES) pr ON cmf.APP_ID = pr.APP_ID
WHERE cmf.CALENDAR_DATE_FIRST_FIN_OR_LEGACY_RESOLUTION_BOT_CONVERSATION IS NOT NULL
  AND da.IS_PAID_APP_NOW = true AND da.IS_DELETED_APP = false AND da.INCLUDE_IN_ANALYSIS = true
  AND fg.APP_ID IS NULL AND pr.APP_ID IS NULL
`.trim();

const SQL_FIN_LOW_RESOLUTION = `
WITH fin_metrics AS (
  SELECT APP_ID,
    SUM(COUNT_INBOX_CONVERSATIONS_FIN_ADDRESSABLE) AS fin_convos,
    SUM(COUNT_INBOX_CONVERSATIONS_HARD_RESOLVED_BY_FIN_AI_ANSWER) AS resolved
  FROM INTERCOM_PROD.CORE_PRODUCT.MART_APP_METRICS_DAILY
  WHERE CALENDAR_DATE >= DATEADD('day', -30, CURRENT_DATE)
  GROUP BY APP_ID
  HAVING SUM(COUNT_INBOX_CONVERSATIONS_FIN_ADDRESSABLE) >= 20
)
SELECT COUNT(DISTINCT m.APP_ID) AS CNT
FROM fin_metrics m
JOIN INTERCOM_PROD.CORE_COMMON.DIM_APPS da ON m.APP_ID = da.APP_ID
WHERE da.IS_PAID_APP_NOW = true AND da.IS_DELETED_APP = false AND da.INCLUDE_IN_ANALYSIS = true
  AND (m.resolved::FLOAT / NULLIF(m.fin_convos, 0)) < 0.2
`.trim();

const SQL_NEW_FIN_ACTIVATORS = `
SELECT COUNT(DISTINCT cmf.APP_ID) AS CNT
FROM INTERCOM_PROD.CORE_PRODUCT.FCT_APPS_CMF_RETURNS cmf
JOIN INTERCOM_PROD.CORE_COMMON.DIM_APPS da ON cmf.APP_ID = da.APP_ID
WHERE cmf.CALENDAR_DATE_FIRST_FIN_OR_LEGACY_RESOLUTION_BOT_CONVERSATION >= DATEADD('day', -60, CURRENT_DATE)
  AND da.IS_PAID_APP_NOW = true AND da.IS_DELETED_APP = false AND da.INCLUDE_IN_ANALYSIS = true
`.trim();

const MOCK_SIGNALS = [
  {
    id: 'fin_no_setup',
    label: 'Fin Active — No Setup',
    count: 847,
    description: "Activated Fin but haven't configured guidance or procedures — Fin is running blind.",
    lifecycle_angle: 'These workspaces need education on Fin optimisation to unlock resolution rate gains.',
    urgency: 'high',
    mock: true,
  },
  {
    id: 'fin_low_resolution',
    label: 'Fin Under-utilizers',
    count: 312,
    description: 'Active Fin users (20+ conversations/month) with hard resolution rate below 20%.',
    lifecycle_angle: "They're using Fin but it's underperforming — likely missing guidance/procedures.",
    urgency: 'high',
    mock: true,
  },
  {
    id: 'new_fin_activators',
    label: 'New Fin Activators',
    count: 203,
    description: 'Had their first Fin conversation in the last 60 days — in the critical adoption window.',
    lifecycle_angle: 'Highest-leverage window for lifecycle emails to drive deep Fin adoption before habits form.',
    urgency: 'medium',
    mock: true,
  },
];

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'GET') return res.status(405).end();

  const token = (process.env.SNOWFLAKE_PAT || '').trim();
  if (!token) {
    return res.status(200).json({ signals: MOCK_SIGNALS, mock: true });
  }

  try {
    const [noSetupRows, lowResRows, newActivatorRows] = await Promise.all([
      runQuery(SQL_FIN_NO_SETUP, token),
      runQuery(SQL_FIN_LOW_RESOLUTION, token),
      runQuery(SQL_NEW_FIN_ACTIVATORS, token),
    ]);

    const count = rows => parseInt(rows[0]?.CNT || '0', 10);

    return res.status(200).json({
      signals: [
        {
          id: 'fin_no_setup',
          label: 'Fin Active — No Setup',
          count: count(noSetupRows),
          description: "Activated Fin but haven't configured guidance or procedures — Fin is running blind.",
          lifecycle_angle: 'These workspaces need education on Fin optimisation to unlock resolution rate gains.',
          urgency: 'high',
        },
        {
          id: 'fin_low_resolution',
          label: 'Fin Under-utilizers',
          count: count(lowResRows),
          description: 'Active Fin users (20+ conversations/month) with hard resolution rate below 20%.',
          lifecycle_angle: "They're using Fin but it's underperforming — likely missing guidance/procedures.",
          urgency: 'high',
        },
        {
          id: 'new_fin_activators',
          label: 'New Fin Activators',
          count: count(newActivatorRows),
          description: 'Had their first Fin conversation in the last 60 days — in the critical adoption window.',
          lifecycle_angle: 'Highest-leverage window for lifecycle emails to drive deep Fin adoption before habits form.',
          urgency: 'medium',
        },
      ],
    });
  } catch (e) {
    // Fall back to mock data on network policy or auth errors
    if (e.message && (e.message.includes('Network policy') || e.message.includes('JWT'))) {
      return res.status(200).json({ signals: MOCK_SIGNALS, mock: true });
    }
    return res.status(500).json({ error: e.message });
  }
};
