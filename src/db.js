import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  host: process.env.POSTGRES_HOST || process.env.DB_HOST || 'postgres',
  port: Number(process.env.POSTGRES_PORT || process.env.DB_PORT || 5432),
  database: process.env.POSTGRES_DB || process.env.DB_NAME || 'linkray',
  user: process.env.POSTGRES_USER || process.env.DB_USER || 'linkray',
  password: process.env.POSTGRES_PASSWORD || process.env.DB_PASSWORD || 'linkray_test_password_12345',
});
// LR_DB_UNKNOWN_PARAM_GUARD_V2_START
function lrDbBadParamV2(v) {
  const t = String(v ?? '').trim().toLowerCase();
  return t === 'unknown' || t === 'undefined' || t === 'null' || t === 'nan' || t === '[object object]';
}

function lrDbCleanParamsV2(params) {
  if (!Array.isArray(params)) return params;
  return params.map((p) => lrDbBadParamV2(p) ? null : p);
}

if (typeof pool !== 'undefined' && pool && typeof pool.query === 'function' && !pool.__lrUnknownGuardV2) {
  const __lrRawPoolQueryV2 = pool.query.bind(pool);
  pool.query = function lrPoolQueryUnknownGuardV2(text, params, cb) {
    if (Array.isArray(params)) {
      return __lrRawPoolQueryV2(text, lrDbCleanParamsV2(params), cb);
    }
    return __lrRawPoolQueryV2(text, params, cb);
  };
  pool.__lrUnknownGuardV2 = true;
}
// LR_DB_UNKNOWN_PARAM_GUARD_V2_END



export async function query(text, params = []) {
  /* LR_DB_UNKNOWN_PARAM_GUARD_V1 */
  const sql = String(text || '');
  const numericLikeSql = /(channel_id|post_id|chat_id|message_id|max_chat_id|id)/i.test(sql);

  const safeParams = Array.isArray(params)
    ? params.map((p) => {
        const sv = String(p ?? '').trim();
        const low = sv.toLowerCase();
        const bad =
          p === undefined ||
          low === 'unknown' ||
          low === 'nan' ||
          low === 'undefined' ||
          low === 'null' ||
          low === '[object object]';

        if (bad && numericLikeSql) return null;
        return p;
      })
    : params;

  const result = await pool.query(text, safeParams);
  return result.rows;
}

export { pool };
