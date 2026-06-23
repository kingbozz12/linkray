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

export async function query(text, params = []) {
  const result = await pool.query(text, params);
  return result.rows;
}

export { pool };
