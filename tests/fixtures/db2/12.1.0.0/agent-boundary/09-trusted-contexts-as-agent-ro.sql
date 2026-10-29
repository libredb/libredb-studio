-- The trusted contexts a fresh database holds, read as the agent user, which PUBLIC's SELECT on SYSCAT.CONTEXTS lets
-- it read: IBM's task scheduler context SYSATSCONTEXT, whose system authorization ID is SYSATS. The check's read names
-- no context for AGENT_RO. That a context naming the user hands its default role to a plain connection from the
-- address it names is measured over TCP by tests/live/db2-agent-boundary.ts, since the CLP here connects locally.
SELECT VARCHAR(CONTEXTNAME, 16) AS CONTEXTNAME, VARCHAR(SYSTEMAUTHID, 10) AS SYSTEMAUTHID, VARCHAR(DEFAULTCONTEXTROLE, 10) AS DEFAULTROLE, ENABLED FROM SYSCAT.CONTEXTS ORDER BY 1;
SELECT VARCHAR(TRUSTEDID, 16) AS TRUSTEDID, TRUSTEDIDTYPE, VARCHAR(SURROGATEAUTHID, 10) AS SURROGATEAUTHID, SURROGATEAUTHIDTYPE FROM SYSCAT.SURROGATEAUTHIDS ORDER BY 1;
SELECT CONTEXTNAME AS NAME, COALESCE(DEFAULTCONTEXTROLE, '') AS ROLE FROM SYSCAT.CONTEXTS WHERE SYSTEMAUTHID = SESSION_USER ORDER BY 1;
