-- Two user-defined functions in the agent's keyspace named like Cassandra's own now() and totimestamp().
CREATE OR REPLACE FUNCTION probe.now() CALLED ON NULL INPUT RETURNS int LANGUAGE java AS 'return 1;';
CREATE OR REPLACE FUNCTION probe.totimestamp(x timeuuid) CALLED ON NULL INPUT RETURNS int LANGUAGE java AS 'return 1;';
