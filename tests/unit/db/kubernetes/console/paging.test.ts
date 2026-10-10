/**
 * The provider's paging clause: written by prepareQuery for the list form of a single-type get only, read back by
 * query(), and the route's probe through the same clause.
 */
import { describe, expect, test } from "bun:test";
import { probePastPage } from "@/lib/api/page-probe";
import {
  PAGING_CLAUSE_SENTENCE,
  prepareKubectlQuery,
  readKubectlRun,
  readPagingClause,
  withPagingClause,
} from "@/lib/db/providers/platform/kubernetes/console/paging";
import { parseKubectl } from "@/lib/db/providers/platform/kubernetes/console/parse";

describe("the clause", () => {
  test("is one last comment line, so the prepared text still parses as the statement", () => {
    const text = withPagingClause("kubectl get pods -n shop", { offset: 500, limit: 501 });
    expect(text).toBe("kubectl get pods -n shop\n# libredb:page offset=500 limit=501");
    expect(parseKubectl(text)).toEqual(parseKubectl("kubectl get pods -n shop"));
    expect(readPagingClause(text)).toEqual({
      statement: "kubectl get pods -n shop",
      page: { offset: 500, limit: 501 },
    });
  });

  test("only an exact last line is a clause", () => {
    for (const text of [
      "get pods",
      "get pods # libredb:page offset=0 limit=5",
      "get pods\n# libredb:page offset=0 limit=0",
      "get pods\n# libredb:page offset=01 limit=5",
      "get pods\n# libredb:page offset=0 limit=5\n",
      "get pods\n# libredb:page offset=0 limit=5 x",
    ]) {
      expect(readPagingClause(text)).toEqual({ statement: text });
    }
  });
});

describe("prepareKubectlQuery", () => {
  test("pages the list form of a get, as a table, wide or names", () => {
    for (const text of ["get pods", "kubectl get deploy -A -o wide --show-labels", "get svc -o name -l app=web"]) {
      expect(prepareKubectlQuery(text, { limit: 50, offset: 100 })).toEqual({
        query: `${text}\n# libredb:page offset=100 limit=50`,
        wasLimited: true,
        limit: 50,
        offset: 100,
      });
    }
  });

  test("the route's probe asks for one row more through the same clause", () => {
    const options = { limit: 50, offset: 0 };
    const prepared = prepareKubectlQuery("get pods", options);
    const probe = probePastPage({ prepareQuery: prepareKubectlQuery }, "get pods", options, prepared);
    expect(probe.query).toBe("get pods\n# libredb:page offset=0 limit=51");
  });

  test("hands every other statement on untouched, with no page two", () => {
    for (const text of [
      "get pod web",
      "get pods -w",
      "get pods -o yaml",
      "describe pod web",
      "logs web",
      "events",
      "delete pod web",
      "get pods | head",
    ]) {
      expect(prepareKubectlQuery(text, { limit: 50, offset: 50 })).toEqual({
        query: text,
        wasLimited: false,
        limit: 50,
        offset: 0,
      });
    }
  });

  test("the defaults: 500 rows from the start, and an unlimited run asks for the 5,000 a statement reads", () => {
    expect(prepareKubectlQuery("get pods")).toMatchObject({ wasLimited: true, limit: 500, offset: 0 });
    expect(prepareKubectlQuery("get pods", { unlimited: true, limit: 50 })).toEqual({
      query: "get pods\n# libredb:page offset=0 limit=5000",
      wasLimited: true,
      limit: 5_000,
      offset: 0,
    });
  });
});

describe("readKubectlRun", () => {
  test("a pageable get keeps its page; a statement with no clause has none", () => {
    expect(readKubectlRun("get pods\n# libredb:page offset=5 limit=10")).toMatchObject({
      ok: true,
      statement: { command: "get", type: "pods" },
      page: { offset: 5, limit: 10 },
    });
    const plain = readKubectlRun("describe pod web");
    expect(plain).toMatchObject({ ok: true, statement: { command: "describe" } });
    expect("page" in plain).toBe(false);
  });

  test("a clause under a statement that cannot page is refused, as is what the parser refuses", () => {
    expect(readKubectlRun("describe pod web\n# libredb:page offset=0 limit=5")).toEqual({
      ok: false,
      message: PAGING_CLAUSE_SENTENCE,
    });
    const parsed = parseKubectl("delete pod web");
    expect(readKubectlRun("delete pod web")).toEqual({
      ok: false,
      message: parsed.ok ? "unreachable" : parsed.refusal.message,
    });
  });
});
