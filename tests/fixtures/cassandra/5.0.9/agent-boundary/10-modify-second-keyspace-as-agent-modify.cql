-- The negative case's positive control: the role the check refuses for MODIFY on a second keyspace can write there.
INSERT INTO other.t (id, v) VALUES (3, 'written-by-agent-modify');
SELECT * FROM other.t WHERE id = 3;
INSERT INTO probe.customers (id, name) VALUES (96, 'x');
