module.exports = function (req, res) {
  const AUTH_SECRET = (process.env.AUTH_SECRET || '').trim();
  if (!AUTH_SECRET) return res.status(200).end(); // not configured, allow through

  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)auth_session=([^;]+)/);
  const sessionValue = match ? match[1] : null;

  if (sessionValue === AUTH_SECRET) {
    return res.status(200).end();
  }
  return res.status(401).end();
};
