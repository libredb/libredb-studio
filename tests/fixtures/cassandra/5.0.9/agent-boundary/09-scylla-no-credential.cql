-- What the engine gate reads on ScyllaDB 2026.2.4 (stock authenticator), and what the role listing answers there.
SELECT release_version FROM system.local;
SELECT key FROM system.versions;
LIST ROLES OF 'cassandra';
LIST ALL PERMISSIONS OF 'cassandra';
