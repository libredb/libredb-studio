-- Enable monitoring extensions
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Create development database
CREATE DATABASE libredb_dev;

-- Connect to libredb_dev and enable extensions there too
\c libredb_dev

CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
