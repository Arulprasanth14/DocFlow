-- DocFlow DB Init Script (runs once on container creation)
-- Enables required PostgreSQL extensions

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "btree_gin";

-- Confirm extensions loaded
SELECT extname, extversion FROM pg_extension
WHERE extname IN ('uuid-ossp', 'vector', 'pg_trgm');
