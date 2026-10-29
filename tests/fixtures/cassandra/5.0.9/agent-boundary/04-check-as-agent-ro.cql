-- The statements the check sends, in its order, as the role it admits; the probe's table suffix is fixed here.
SELECT release_version FROM system.local;
SELECT key FROM system.versions;
LIST ROLES OF 'agent_ro';
LIST ALL PERMISSIONS OF 'agent_ro';
SELECT keyspace_name, table_name, column_name, function_keyspace, function_name FROM system_schema.column_masks WHERE keyspace_name = 'probe';
DROP TABLE IF EXISTS "probe".libredb_agent_probe_000000000000000000000000;
SELECT keyspace_name AS table_schema, table_name, column_name, type AS data_type, kind AS column_kind, position AS ordinal_position FROM system_schema.columns WHERE keyspace_name = 'probe' AND table_name = 'customers';
