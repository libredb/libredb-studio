-- An unqualified call resolves to the session keyspace's function of that name before the built-in one, and the server
-- refuses it without EXECUTE; a built-in named with its keyspace still answers.
SELECT now() FROM probe.customers WHERE id = 1;
SELECT totimestamp(now()) FROM probe.customers WHERE id = 1;
SELECT system.now() FROM probe.customers WHERE id = 1;
SELECT system.totimestamp(system.now()) FROM probe.customers WHERE id = 1;
