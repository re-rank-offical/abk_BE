const { Client } = require('pg');
const c = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
c.connect()
  .then(() =>
    c.query(`
      SELECT "id", "siteName", "siteUrl", "loginUsername",
        CASE WHEN "loginPassword" IS NOT NULL AND "loginPassword" <> '' THEN 'SET' ELSE 'EMPTY' END as pw_status,
        CASE WHEN "sessionCookies" IS NOT NULL AND length("sessionCookies") > 10 THEN 'SET' ELSE 'EMPTY' END as cookie_status
      FROM authority_sites
      WHERE "siteUrl" LIKE '%re-rank%' OR "siteUrl" LIKE '%flfodzm%'
      ORDER BY "siteName"
    `),
  )
  .then((r) => {
    r.rows.forEach((row) =>
      console.log(
        `${row.siteName} | url: ${row.siteUrl} | login: ${row.loginUsername || 'NULL'} | pw: ${row.pw_status} | cookie: ${row.cookie_status}`,
      ),
    );
    c.end();
  })
  .catch((e) => {
    console.error(e.message);
    c.end();
  });
