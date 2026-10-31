/**
 * What an agent-mode handle keeps of a target, a rule and an alert: every URL kept to its scheme, host, port and path,
 * never its userinfo, query string or fragment; an address written with userinfo kept to its host and port; every scrape
 * parameter withheld; and the server's flags withheld whole, with the reason, before anything is sent.
 *
 * The values below are obviously fake and generated for the test; nothing here is a credential.
 */
import { describe, expect, mock, test } from "bun:test";
import {
  PROMETHEUS_AGENT_PROJECTION,
  projectAgentTransport,
  projectRuleGroup,
  projectTarget,
  projectUrlText,
} from "@/lib/db/providers/timeseries/prometheus/agent-projection";
import type {
  PrometheusRuleGroup,
  PrometheusTarget,
  PrometheusTransport,
} from "@/lib/db/providers/timeseries/prometheus/transport";
import { PrometheusTransportError } from "@/lib/db/providers/timeseries/prometheus/transport";

const MARK = PROMETHEUS_AGENT_PROJECTION.mark;
const SECRET = "not-a-real-token";
const USER = "not-a-real-user";

describe("projectUrlText", () => {
  test("keeps a URL's scheme, host, port and path, and marks what it dropped", () => {
    expect(projectUrlText(`http://localhost:9090/metrics?token=${SECRET}`)).toBe(
      `http://localhost:9090/metrics ${MARK}`,
    );
    expect(projectUrlText(`https://${USER}:${SECRET}@runbooks.example.invalid/page?token=${SECRET}#frag`)).toBe(
      `https://runbooks.example.invalid/page ${MARK}`,
    );
    expect(projectUrlText(`http://${USER}@example.invalid:8080/a/b`)).toBe(`http://example.invalid:8080/a/b ${MARK}`);
    expect(projectUrlText("http://example.invalid/page#section")).toBe(`http://example.invalid/page ${MARK}`);
    expect(projectUrlText("http://example.invalid/page?")).toBe(`http://example.invalid/page ${MARK}`);
  });

  test("leaves a URL with nothing to drop exactly as written", () => {
    expect(projectUrlText("http://localhost:9090/metrics")).toBe("http://localhost:9090/metrics");
    expect(projectUrlText("https://[::1]:9443/federate")).toBe("https://[::1]:9443/federate");
  });

  test("projects every URL inside free text, delimited by quotes, brackets and whitespace", () => {
    expect(
      projectUrlText(
        `Get "http://127.0.0.1:1/metrics?token=${SECRET}": dial tcp 127.0.0.1:1: connect: connection refused`,
      ),
    ).toBe(`Get "http://127.0.0.1:1/metrics ${MARK}": dial tcp 127.0.0.1:1: connect: connection refused`);
    expect(projectUrlText(`see <http://example.invalid/a?token=${SECRET}> or (ftp://${USER}:${SECRET}@h/x)`)).toBe(
      `see <http://example.invalid/a ${MARK}> or (ftp://h/x) ${MARK}`,
    );
    expect(projectUrlText(`url=http://example.invalid/a?t=${SECRET}`)).toBe(`url=http://example.invalid/a ${MARK}`);
  });

  test("withholds a URL it cannot read whole, never a part of it", () => {
    const projected = projectUrlText(`http://${USER}:${SECRET}%40localhost:9090/metrics`);
    expect(projected).toBe(PROMETHEUS_AGENT_PROJECTION.unreadableUrl);
    expect(projected).not.toContain(SECRET);
  });

  test("keeps an address written with userinfo to its host and port", () => {
    expect(projectUrlText(`${USER}:${SECRET}@localhost:9090`)).toBe(`localhost:9090 ${MARK}`);
    expect(projectUrlText(`address ${USER}:${SECRET}@localhost:9090: too many colons in address`)).toBe(
      `address localhost:9090: ${MARK} too many colons in address`,
    );
  });

  test("leaves text with no URL and no userinfo alone, an e-mail address included", () => {
    for (const text of ["", "up", "connection refused", "contact ops@example.invalid", "a :// b", "rate(x[5m])"]) {
      expect(projectUrlText(text)).toBe(text);
    }
  });
});

const target = (overrides: Partial<PrometheusTarget> = {}): PrometheusTarget => ({
  scrapePool: "studio-token",
  scrapeUrl: `http://localhost:9090/metrics?token=${SECRET}`,
  health: "down",
  lastError: `Get "http://localhost:9090/metrics?token=${SECRET}": context deadline exceeded`,
  lastScrape: "2026-10-31T00:00:00Z",
  lastScrapeDuration: 0.1,
  scrapeInterval: "5s",
  labels: { instance: `${USER}:${SECRET}@localhost:9090`, job: "studio-token" },
  discoveredLabels: {
    __address__: `${USER}:${SECRET}@localhost:9090`,
    __param_token: SECRET,
    __scheme__: "http",
    job: "studio-token",
  },
  ...overrides,
});

describe("projectTarget", () => {
  test("projects the scrape URL, the last error and every label, and withholds every scrape parameter", () => {
    const projected = projectTarget(target());
    expect(projected).toEqual({
      scrapePool: "studio-token",
      scrapeUrl: `http://localhost:9090/metrics ${MARK}`,
      health: "down",
      lastError: `Get "http://localhost:9090/metrics ${MARK}": context deadline exceeded`,
      lastScrape: "2026-10-31T00:00:00Z",
      lastScrapeDuration: 0.1,
      scrapeInterval: "5s",
      labels: { instance: `localhost:9090 ${MARK}`, job: "studio-token" },
      discoveredLabels: {
        __address__: `localhost:9090 ${MARK}`,
        __param_token: PROMETHEUS_AGENT_PROJECTION.scrapeParameter,
        __scheme__: "http",
        job: "studio-token",
      },
    });
    expect(JSON.stringify(projected)).not.toContain(SECRET);
    expect(JSON.stringify(projected)).not.toContain(USER);
  });

  test("keeps a target with nothing to withhold as it was", () => {
    const clean = target({
      scrapeUrl: "http://localhost:9090/metrics",
      lastError: "",
      labels: { job: "a" },
      discoveredLabels: { __address__: "localhost:9090" },
    });
    expect(projectTarget(clean)).toEqual(clean);
  });
});

const groups = (): PrometheusRuleGroup[] => [
  {
    name: "studio-urls",
    file: "/etc/prometheus/rules/a.yml",
    interval: 5,
    limit: 0,
    evaluationTime: 0,
    lastEvaluation: "2026-10-31T00:00:00Z",
    rules: [
      {
        kind: "recording",
        name: "job:up:sum",
        query: `sum by (job) (up{url="http://example.invalid/?t=${SECRET}"})`,
        labels: { source: `http://${USER}:${SECRET}@example.invalid/x` },
        health: "err",
        lastError: `bad http://example.invalid/?token=${SECRET}`,
        evaluationTime: 0,
        lastEvaluation: "2026-10-31T00:00:00Z",
      },
      {
        kind: "alerting",
        name: "StudioFiring",
        query: "vector(1)",
        labels: { link: `http://example.invalid/x?token=${SECRET}` },
        health: "ok",
        lastError: "",
        evaluationTime: 0,
        lastEvaluation: "2026-10-31T00:00:00Z",
        duration: 0,
        keepFiringFor: 0,
        annotations: { runbook_url: `https://${USER}:${SECRET}@runbooks.example.invalid/p?token=${SECRET}` },
        state: "firing",
        alerts: [
          {
            labels: { alertname: "StudioFiring", link: `http://example.invalid/x?token=${SECRET}` },
            annotations: { summary: `see http://example.invalid/a?token=${SECRET} for more` },
            state: "firing",
            activeAt: "2026-10-31T00:00:00Z",
            value: "1e+00",
          },
        ],
      },
    ],
  },
];

describe("projectRuleGroup", () => {
  test("projects every URL a rule, its labels and annotations, and its alerts carry, and keeps the names", () => {
    const projected = groups().map(projectRuleGroup);
    const text = JSON.stringify(projected);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(USER);
    const [recording, alerting] = projected[0].rules;
    expect(projected[0].name).toBe("studio-urls");
    expect(projected[0].file).toBe("/etc/prometheus/rules/a.yml");
    expect(recording.name).toBe("job:up:sum");
    expect(recording.query).toBe(`sum by (job) (up{url="http://example.invalid/ ${MARK}"})`);
    expect(recording.labels).toEqual({ source: `http://example.invalid/x ${MARK}` });
    expect(recording.lastError).toBe(`bad http://example.invalid/ ${MARK}`);
    if (alerting.kind !== "alerting") throw new Error("expected the alerting rule");
    expect(alerting.annotations).toEqual({ runbook_url: `https://runbooks.example.invalid/p ${MARK}` });
    expect(alerting.alerts[0].annotations).toEqual({ summary: `see http://example.invalid/a ${MARK} for more` });
    expect(alerting.alerts[0].labels.alertname).toBe("StudioFiring");
    expect(alerting.alerts[0].value).toBe("1e+00");
  });
});

function fakeTransport(): PrometheusTransport {
  return {
    query: mock(() =>
      Promise.resolve({ value: { shape: "vector", series: [] }, notices: [], truncatedByServer: false }),
    ),
    metricNames: mock(() => Promise.resolve({ items: ["up"], truncatedByServer: false })),
    labelNames: mock(() => Promise.resolve(["job"])),
    seriesLabels: mock(() => Promise.resolve({ items: [{ job: "a" }], truncatedByServer: false })),
    metadata: mock(() => Promise.resolve([])),
    rules: mock(() => Promise.resolve(groups())),
    scrapePools: mock(() => Promise.resolve(["studio-token"])),
    targets: mock(() => Promise.resolve([target()])),
    health: mock(() => Promise.resolve({ probes: [] })),
    buildInfo: mock(() => Promise.resolve({ version: "3.13.3" })),
    runtimeInfo: mock(() => Promise.resolve({ startTime: "a", serverTime: "b", storageRetention: "15d" })),
    flags: mock(() => Promise.resolve({ "config.file": "/etc/prometheus/prometheus.yml" })),
    tsdbStatus: mock(() => Promise.resolve({ seriesByMetric: [], valuesByLabel: [] })),
  } as PrometheusTransport;
}

describe("projectAgentTransport", () => {
  test("projects targets and rules on every read, filtered or not", async () => {
    const inner = fakeTransport();
    const projected = projectAgentTransport(inner);
    expect(JSON.stringify(await projected.targets())).not.toContain(SECRET);
    expect(JSON.stringify(await projected.targets("studio-token"))).not.toContain(SECRET);
    expect(inner.targets).toHaveBeenLastCalledWith("studio-token");
    const filter = { group: "studio-urls", file: "/etc/prometheus/rules/a.yml", ruleName: "StudioFiring" };
    expect(JSON.stringify(await projected.rules(filter))).not.toContain(SECRET);
    expect(inner.rules).toHaveBeenLastCalledWith(filter);
    expect(JSON.stringify(await projected.rules())).not.toContain(SECRET);
  });

  test("withholds the flags with the reason and never asks the server for them", async () => {
    const inner = fakeTransport();
    const projected = projectAgentTransport(inner);
    const refusal = projected.flags();
    const error = await refusal.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PrometheusTransportError);
    expect((error as PrometheusTransportError).category).toBe("withheld");
    expect((error as PrometheusTransportError).message).toBe(PROMETHEUS_AGENT_PROJECTION.flags);
    expect(inner.flags).not.toHaveBeenCalled();
  });

  test("passes every other read through unchanged", async () => {
    const inner = fakeTransport();
    const projected = projectAgentTransport(inner);
    const options = { timeoutMs: 1000, seriesLimit: 10 };
    await projected.query("up", options);
    expect(inner.query).toHaveBeenCalledWith("up", options);
    const window = { startSeconds: 1, endSeconds: 2 };
    expect((await projected.metricNames(window, 5)).items).toEqual(["up"]);
    expect(inner.metricNames).toHaveBeenCalledWith(window, 5);
    expect(await projected.labelNames("up", window)).toEqual(["job"]);
    expect((await projected.seriesLabels("up", window, 3)).items).toEqual([{ job: "a" }]);
    expect(await projected.metadata("up")).toEqual([]);
    expect(await projected.scrapePools()).toEqual(["studio-token"]);
    expect(await projected.health()).toEqual({ probes: [] });
    expect(await projected.buildInfo()).toEqual({ version: "3.13.3" });
    expect((await projected.runtimeInfo()).storageRetention).toBe("15d");
    expect(await projected.tsdbStatus(50)).toEqual({ seriesByMetric: [], valuesByLabel: [] });
    expect(inner.tsdbStatus).toHaveBeenCalledWith(50);
  });

  test("the reasons name what is withheld and why", () => {
    expect(PROMETHEUS_AGENT_PROJECTION.flags).toContain("command-line flags");
    expect(PROMETHEUS_AGENT_PROJECTION.flags).toContain("file paths, listen addresses, URLs and local configuration");
    expect(PROMETHEUS_AGENT_PROJECTION.urls).toContain("scheme, host, port and path");
    expect(PROMETHEUS_AGENT_PROJECTION.urls).toContain("token");
  });
});
