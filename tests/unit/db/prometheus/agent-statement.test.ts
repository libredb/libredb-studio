/**
 * The agent's reader of one PromQL read: the expression alone, read by a lexer that mirrors the top level of the
 * v3.13.3 lexer (`promql/parser/lex.go`), so anything that is not an expression the console would send, a dashboard
 * variable, a request parameter, a JSON request or an unbalanced bracket, is refused before anything is sent, in agent
 * mode's own words with its list of reads.
 */
import { describe, expect, test } from "bun:test";
import {
  PROMETHEUS_AGENT_READS,
  readPrometheusAgentStatement,
} from "@/lib/db/providers/timeseries/prometheus/agent-statement";

const refusedWith = (text: string) => {
  const reading = readPrometheusAgentStatement(text);
  if (reading.ok) throw new Error(`admitted: ${text}`);
  return reading;
};

const admitted = (text: string): string => {
  const reading = readPrometheusAgentStatement(text);
  if (!reading.ok) throw new Error(`refused: ${text}: ${reading.message}`);
  return reading.expression;
};

describe("what the reader admits", () => {
  test.each([
    "up",
    'up{job="prometheus"}',
    "sum by (job) (rate(prometheus_http_requests_total[5m]))",
    "rate(prometheus_http_requests_total[1m])[5m:30s]",
    "up offset 5m",
    "up @ 1790158578",
    "up @ start()",
    "histogram_quantile(0.9, sum by (le) (rate(prometheus_http_request_duration_seconds_bucket[5m])))",
    '{__name__="studio.dotted.name"}',
    '{"studio.dotted.name", job=~"pro.*", instance!="a", env!~"b"}',
    "count(up) > 0",
    "up == bool 1",
    "-1/0",
    "0x1f + 1e3 + .5 + inf - NaN",
    "'single' ",
    "`raw \\ text`",
    "max_over_time(up[1h:]) ^ 2 % 3",
    "up # a comment ; & $ ? with anything in it",
    "\n  up\r\n",
    'label_replace(up, "x", "$1", "instance", "(.*)")',
    "up[5m+1m]",
    'up{job="a\\"b"}',
    "label_replace(up, 'x', 'it\\'s', 'job', '.*')",
    "job:up:sum",
  ])("%p", (text) => {
    expect(admitted(text)).toBe(text);
  });

  test("the expression is sent exactly as written, comments and whitespace included", () => {
    expect(admitted("  up  # why\n")).toBe("  up  # why\n");
  });
});

describe("what the reader refuses before anything is sent", () => {
  test("a text with no expression once comments and whitespace are removed", () => {
    for (const text of ["", "   ", "# only a comment", "#a\n#b\r\n"]) {
      expect(refusedWith(text).message).toStartWith("The text holds no PromQL expression");
    }
  });

  test("a dashboard variable, which is a dashboard's time-range directive and not PromQL", () => {
    for (const text of ["rate(up[$__rate_interval])", "up[$__range]", "sum(up) / $__interval_ms", "${job}"]) {
      expect(refusedWith(text).message).toStartWith("$ is not PromQL: a dashboard variable");
    }
  });

  test("request parameters written beside the expression", () => {
    expect(refusedWith("up&time=0").message).toStartWith('The character "&" is not PromQL');
    expect(refusedWith("query=up&start=0&end=1&step=1").message).toStartWith('The character "&" is not PromQL');
    expect(refusedWith("up?timeout=1h").message).toStartWith('The character "?" is not PromQL');
    expect(refusedWith("up; up").message).toStartWith('The character ";" is not PromQL');
  });

  test("a JSON request, whose colon inside braces no label matcher holds", () => {
    expect(refusedWith('{"query": "up", "time": 0}').message).toStartWith(
      'The character ":" cannot stand inside a label matcher\'s braces',
    );
  });

  test("anything inside braces that is not a label name, a string, a comma or a matcher operator", () => {
    expect(refusedWith("up{job=5}").message).toStartWith(
      'The character "5" cannot stand inside a label matcher\'s braces',
    );
    expect(refusedWith("up{job=(x)}").message).toStartWith(
      'The character "(" cannot stand inside a label matcher\'s braces',
    );
    expect(refusedWith("up{job!x}").message).toStartWith('"!" stands only in "!=" and "!~"');
  });

  test("a character the lexer never reads, outside a string or a comment", () => {
    for (const [text, character] of [
      ["up \\ 2", "\\"],
      ["up | 2", "|"],
      ["ünits", "ü"],
      ["up.x", "."],
    ] as const) {
      expect(refusedWith(text).message).toStartWith(`The character "${character}" is not PromQL`);
    }
  });

  test("an unterminated string, a lone ! and unbalanced brackets", () => {
    expect(refusedWith('up{job="x}').message).toStartWith("A string is not closed");
    expect(refusedWith("'open").message).toStartWith("A string is not closed");
    expect(refusedWith("`open").message).toStartWith("A string is not closed");
    expect(refusedWith('"line\nbreak"').message).toStartWith("A string is not closed");
    expect(refusedWith('up{job="ends in an escape\\"}').message).toStartWith("A string is not closed");
    expect(refusedWith("!up").message).toStartWith('"!" stands only in "!=" and "!~"');
    expect(refusedWith("sum(up").message).toStartWith('"(" is not closed');
    expect(refusedWith("up)").message).toStartWith('")" closes nothing');
    expect(refusedWith("up[5m").message).toStartWith('"[" is not closed');
    expect(refusedWith("up{job='a'").message).toStartWith('"{" is not closed');
    expect(refusedWith("sum(up]").message).toStartWith('"]" closes nothing');
    expect(refusedWith("up}").message).toStartWith('"}" closes nothing');
  });

  test("every refusal names agent mode's reads and that nothing was sent", () => {
    const { message, code } = refusedWith("up&time=0");
    expect(code).toBe("statement");
    expect(message).toContain(PROMETHEUS_AGENT_READS);
    expect(message).toEndWith("Nothing was sent.");
  });

  test("the list of reads names what is sent and what can never be", () => {
    expect(PROMETHEUS_AGENT_READS).toContain("instant query");
    expect(PROMETHEUS_AGENT_READS).toContain("no time, range, step, limit or other request parameter");
    expect(PROMETHEUS_AGENT_READS).toContain("never a write");
  });
});
