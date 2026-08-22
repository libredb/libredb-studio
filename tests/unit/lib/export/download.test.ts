import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { downloadBlob, downloadText } from "@/lib/export/download";

interface Recorded {
  created: Blob[];
  revoked: string[];
  clicked: { href: string; download: string; inDocument: boolean }[];
}

let recorded: Recorded;
let originalCreate: typeof URL.createObjectURL | undefined;
let originalRevoke: typeof URL.revokeObjectURL | undefined;
let originalClick: () => void;

beforeEach(() => {
  recorded = { created: [], revoked: [], clicked: [] };
  originalCreate = URL.createObjectURL;
  originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob: Blob) => {
    recorded.created.push(blob);
    return `blob:test/${recorded.created.length}`;
  };
  URL.revokeObjectURL = (url: string) => {
    recorded.revoked.push(url);
  };

  // happy-dom's anchor click would navigate; record the state at click time
  // instead, which is the only moment at which "is it attached?" can be asked.
  originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    recorded.clicked.push({
      href: this.href,
      download: this.download,
      inDocument: document.body.contains(this),
    });
  };
});

afterEach(async () => {
  // Drain this test's own revoke timer before the stubs go back, so it cannot
  // land in the NEXT test's recorder — the timer resolves `URL.revokeObjectURL`
  // when it fires, not when it was queued.
  await nextTask();
  URL.createObjectURL = originalCreate as typeof URL.createObjectURL;
  URL.revokeObjectURL = originalRevoke as typeof URL.revokeObjectURL;
  HTMLAnchorElement.prototype.click = originalClick;
});

/** Let the macrotask the revoke is queued on run. */
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("downloadBlob", () => {
  test("clicks a link that is attached to the document, which is what Firefox honours", () => {
    downloadBlob(new Blob(["x"]), "report.csv");

    expect(recorded.clicked).toHaveLength(1);
    expect(recorded.clicked[0].inDocument).toBe(true);
    expect(recorded.clicked[0].download).toBe("report.csv");
    expect(recorded.clicked[0].href).toContain("blob:test/1");
  });

  test("leaves no anchor behind in the document", () => {
    downloadBlob(new Blob(["x"]), "report.csv");

    expect(document.querySelectorAll("a[download]")).toHaveLength(0);
  });

  test("does not revoke the URL in the task that started the download", () => {
    downloadBlob(new Blob(["x"]), "report.csv");

    expect(recorded.revoked).toEqual([]);
  });

  test("revokes the URL once the download has been handed off", async () => {
    downloadBlob(new Blob(["x"]), "report.csv");
    await nextTask();

    expect(recorded.revoked).toEqual(["blob:test/1"]);
  });
});

describe("downloadText", () => {
  test("wraps the text in a blob of the declared type", async () => {
    downloadText('{"a":1}', "application/json", "rows.json");

    expect(recorded.created).toHaveLength(1);
    expect(recorded.created[0].type).toStartWith("application/json");
    expect(await recorded.created[0].text()).toBe('{"a":1}');
    expect(recorded.clicked[0].download).toBe("rows.json");
  });

  // Read as BYTES, not through `blob.text()`: the text decoder strips a leading BOM
  // per spec, so a text assertion here passes whether the mark is written or not.
  const firstBytes = async (blob: Blob, count: number) => [...new Uint8Array(await blob.arrayBuffer()).slice(0, count)];

  // Excel decides a CSV's encoding from its first bytes, not from the charset on the
  // download: without the mark it reads UTF-8 as the host's legacy code page, and
  // every non-ASCII name in the file arrives mangled. Every other reader treats the
  // mark as insignificant.
  test("puts the byte order mark Excel needs in front of a CSV", async () => {
    downloadText("ad,şehir\nÖmer,İstanbul", "text/csv;charset=utf-8", "rows.csv");

    expect(await firstBytes(recorded.created[0], 3)).toEqual([0xef, 0xbb, 0xbf]);
    expect(await recorded.created[0].text()).toBe("ad,şehir\nÖmer,İstanbul");
  });

  test("marks a CSV even when the caller named the type without a charset", async () => {
    downloadText("a,b", "text/csv", "rows.csv");

    expect(await firstBytes(recorded.created[0], 3)).toEqual([0xef, 0xbb, 0xbf]);
  });

  test("leaves SQL bytes alone, so the first statement is still the first byte", async () => {
    downloadText("INSERT INTO t (a) VALUES (1);", "text/sql", "rows.sql");

    expect(await firstBytes(recorded.created[0], 1)).toEqual(["I".charCodeAt(0)]);
  });

  test("leaves markdown bytes alone", async () => {
    downloadText("# Docs", "text/markdown", "docs.md");

    expect(await firstBytes(recorded.created[0], 1)).toEqual(["#".charCodeAt(0)]);
  });

  test("leaves JSON bytes alone, so a strict parser still reads the first token", async () => {
    downloadText('{"a":1}', "application/json", "rows.json");

    expect(await firstBytes(recorded.created[0], 1)).toEqual(["{".charCodeAt(0)]);
  });
});
