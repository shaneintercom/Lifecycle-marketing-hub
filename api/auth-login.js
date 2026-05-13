module.exports = async function (req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const body = req.body || {};
  const password = (body.password || '').trim();
  const AUTH_PASSWORD = (process.env.AUTH_PASSWORD || '').trim();
  const AUTH_SECRET   = (process.env.AUTH_SECRET   || '').trim();

  if (!AUTH_PASSWORD || !AUTH_SECRET) {
    return res.status(500).json({ error: 'Auth not configured.' });
  }

  if (password !== AUTH_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }

  const maxAge = 60 * 60 * 24 * 30;
  res.setHeader('Set-Cookie', `auth_session=${AUTH_SECRET}; Path=/; SameSite=Strict; Max-Age=${maxAge}`);
  return res.status(200).json({ ok: true });
};
