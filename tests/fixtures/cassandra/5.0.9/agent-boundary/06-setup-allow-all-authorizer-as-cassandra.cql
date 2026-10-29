-- PasswordAuthenticator with the stock AllowAllAuthorizer: a role that would hold only SELECT on probe.
CREATE KEYSPACE probe WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};
CREATE TABLE probe.customers (id int PRIMARY KEY, name text);
CREATE ROLE agent_ro WITH LOGIN = true AND PASSWORD = 'not-a-real-password';
GRANT SELECT ON KEYSPACE probe TO agent_ro;
