// Check if pg is installed
let Pool;
try {
  const pg = require('pg');
  Pool = pg.Pool;
} catch (error) {
  console.warn('pg package not installed. Database functionality will be limited.');
}

// Create a mock pool or real PostgreSQL connection pool
let pool;

if (Pool) {
  // Create a PostgreSQL connection pool
  pool = new Pool({
    user: process.env.POSTGRES_USER,
    host: process.env.POSTGRES_HOST,
    database: process.env.POSTGRES_DB,
    password: process.env.POSTGRES_PASSWORD,
    port: process.env.POSTGRES_PORT || 5432,
    ssl: process.env.POSTGRES_SSL === 'true' ? {
      rejectUnauthorized: false
    } : false
  });

  // Test the database connection on startup
  pool.query('SELECT NOW()', (err, res) => {
    if (err) {
      console.error('Database connection error:', err.message);
    } else {
      console.log('Database connected successfully at:', res.rows[0].now);
    }
  });
} else {
  // Create a mock pool with methods that log warnings
  pool = {
    query: () => {
      console.warn('Database query attempted but pg package is not installed');
      return Promise.resolve({ rows: [] });
    },
    end: () => {
      console.warn('Database connection end attempted but pg package is not installed');
      return Promise.resolve();
    }
  };
}

module.exports = {
  pool,
  // Add a function to query the database
  query: (text, params) => pool.query(text, params)
}; 