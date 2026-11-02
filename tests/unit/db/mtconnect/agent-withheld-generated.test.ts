/**
 * Generated values for the URL rule of an agent-mode MTConnect handle (`agent-withheld.ts`): every value is built from
 * a grammar of the spellings a URL client still reads as a URL, and no piece of its fake user name, password or token
 * may reach the asset projection (`/assets`) or the observation projection (`/current`).
 *
 * The grammar: a scheme in mixed case, in fullwidth form, with a tab or a line break inside it, or none; a colon in
 * ASCII or fullwidth; a run of zero to four slashes or backslashes, ASCII or fullwidth, with a tab inside it; a user
 * name and a password whose pieces are joined by `@`, a quote, a slash, `#`, `?` or a space; a host, a path, a query
 * token and a fragment; any subset of `:/@?#` percent-encoded everywhere in the value, in either hex case; a prefix of a
 * word, a quote or a bracket. The asset projection splits the value across its element's text, CDATA sections and
 * child elements, and carries it in an attribute; the href projection carries it in a `FileLocation href` and an
 * `xlink:href`, the fields read as URLs by the parser; the observation projection splits it across an `AssetChanged`
 * value's text and CDATA sections, and carries it as an `AssetCountDataSet` key.
 *
 * Where nothing marks a URL's start (no scheme and fewer than two slashes), a space ends the word the rule reads, so
 * there the pieces are joined by anything but a space, and a password is always present, since a `user@host` with no
 * colon is a mail address and is kept as written; or there the value is a path and its query with no user information
 * at all. A query always follows a path. Every random choice comes from one
 * seeded generator, so every run builds the same values.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { NodeRequest, NodeResponse, NodeTransport } from "@/lib/db/http/node-transport";
import { MTConnectProvider } from "@/lib/db/providers/industrial/mtconnect/index";
import type { ProviderExecutionContext, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

const FIXTURES = path.resolve(import.meta.dir, "..", "..", "..", "fixtures", "mtconnect");
const capture = (name: string): string => readFileSync(path.join(FIXTURES, `${name}.xml`), "utf8");

const SEED = 0x4d54_4301;
const CASES = 3000;
const BATCH = 250;
const BUDGET: ReadOnlyStatementBudget = { statementTimeoutMs: 5_000, maxResultRows: 1_000, maxResultBytes: 50_000_000 };
const AGENT: ProviderExecutionContext = { readOnly: true, sendsStatements: true };

/** mulberry32: a small seeded generator, so the values are the same on every run. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = generator(SEED);
const chance = (p: number): boolean => random() < p;
const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
const between = (low: number, high: number): number => low + Math.floor(random() * (high - low + 1));

/** The fullwidth form of a printable ASCII character, which NFKC reads back as the character. */
const fullwidth = (text: string): string =>
  [...text].map((c) => (c >= "!" && c <= "~" ? String.fromCharCode(c.charCodeAt(0) + 0xfee0) : c)).join("");

const SCHEMES = ["http", "https", "ftp", "s3", "ws", "wss", "svn+ssh", "x-file"];
const DROPPED = ["\t", "\n", "\r"];
const ENCODABLE = [":", "/", "@", "?", "#"];
const PREFIXES: readonly (readonly [string, string])[] = [
  ["", ""],
  ["login ", ""],
  ["see ", " now"],
  ["'", "'"],
  ['"', '"'],
  ["[", "]"],
  ["(", ")"],
  ["<", ">"],
  ["see '", "' please"],
];

/** A secret of fake pieces, each a marker no other text holds, joined by the characters a URL may still carry. */
function secret(marker: string, joiners: readonly string[]): { readonly text: string; readonly pieces: string[] } {
  const pieces = Array.from({ length: between(1, 3) }, (_, at) => `${marker}${at}`);
  return { text: pieces.reduce((text, piece) => `${text}${pick(joiners)}${piece}`), pieces };
}

interface Case {
  readonly value: string;
  readonly pieces: readonly string[];
}

function generate(index: number): Case {
  const marker = `zq${index}`;
  const scheme = chance(0.75) ? pick(SCHEMES) : undefined;
  let spelled = "";
  if (scheme !== undefined) {
    spelled = [...scheme].map((c) => (chance(0.5) ? c.toUpperCase() : c)).join("");
    const wide = chance(0.3);
    if (wide) spelled = fullwidth(spelled);
    if (chance(0.3)) {
      const at = between(1, spelled.length - 1);
      spelled = `${spelled.slice(0, at)}${pick(DROPPED)}${spelled.slice(at)}`;
    }
    spelled += wide && chance(0.7) ? fullwidth(":") : ":";
  }
  const slashes = between(0, 4);
  let run = Array.from({ length: slashes }, () => {
    const slash = pick(["/", "\\"]);
    return chance(0.2) ? fullwidth(slash) : slash;
  }).join("");
  if (slashes >= 2 && chance(0.2)) run = `${run[0]}${pick(DROPPED)}${run.slice(1)}`;
  // A URL's start is marked when a scheme or two slashes stand before its user information.
  const marked = scheme !== undefined || slashes >= 2;
  const joiners = marked ? ["@", "'", '"', "/", "#", "?", " "] : ["@", "'", '"', "/", "#", "?"];
  // A path and its query with no user information and nothing marking a URL: `files.example/x.nc?token=...`.
  const bare = !marked && chance(0.3);
  const user = secret(`${marker}u`, joiners);
  const password = !marked || chance(0.8) ? secret(`${marker}p`, joiners) : undefined;
  const token = secret(`${marker}t`, ["-", "/", "'", '"', "#", "?", "="]);
  const fragment = `${marker}f`;
  const hash = chance(0.3);
  const query = bare ? !hash || chance(0.5) : chance(0.7);
  const tail = query || hash || chance(0.5) ? "/x.nc" : "";
  const userinfo = bare ? "" : `${user.text}${password === undefined ? "" : `:${password.text}`}@`;
  let value = `${spelled}${run}${userinfo}h${index}.example${tail}${query ? `?token=${token.text}` : ""}${hash ? `#${fragment}` : ""}`;
  const encode = ENCODABLE.filter(() => chance(0.35));
  value = [...value]
    .map((c) => {
      if (!encode.includes(c)) return c;
      const hex = c.charCodeAt(0).toString(16).padStart(2, "0");
      return `%${chance(0.5) ? hex.toUpperCase() : hex}`;
    })
    .join("");
  const [before, after] = pick(PREFIXES);
  return {
    value: `${before}${value}${after}`,
    pieces: [
      ...(bare ? [] : user.pieces),
      ...(bare ? [] : (password?.pieces ?? [])),
      ...(query ? token.pieces : []),
      ...(hash ? [fragment] : []),
    ],
  };
}

/** XML-escaped text that keeps a tab and a line break, which an attribute or a parser would otherwise normalize. */
const escape = (text: string): string =>
  text.replace(/[&<>"\t\n\r]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : `&#${c.charCodeAt(0)};`,
  );

/** `text` cut at random places into pieces, each written as text, a CDATA section or, where `children`, a child. */
function split(text: string, children: boolean): string {
  const cuts = Array.from({ length: between(0, 4) }, () => between(0, text.length)).sort((a, b) => a - b);
  const pieces = [0, ...cuts, text.length]
    .slice(1)
    .map((end, at, ends) => text.slice(at === 0 ? 0 : ends[at - 1], end));
  return pieces
    .map((piece) => {
      const written =
        piece.includes("\r") || piece.includes("]]>") || !chance(0.4) ? escape(piece) : `<![CDATA[${piece}]]>`;
      if (!children || !chance(0.35)) return written;
      return chance(0.3) ? `<b><i>${written}</i></b>` : `<b>${written}</b>`;
    })
    .join("");
}

const CASES_BUILT: readonly Case[] = Array.from({ length: CASES }, (_, index) => generate(index));

let recorded: NodeRequest[] = [];

function standIn(answers: Readonly<Record<string, string>>): NodeTransport {
  return {
    async request(request: NodeRequest): Promise<NodeResponse> {
      recorded.push(request);
      const url = new URL(request.url);
      const answer = answers[`${url.pathname}${url.search}`];
      if (answer === undefined) throw new Error(`the stand-in holds no answer for ${url.pathname}${url.search}`);
      return { status: 200, contentType: "application/xml", retryAfter: null, text: answer };
    },
    close() {},
  };
}

async function read(line: string, answer: string): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const transport = standIn({ "/probe": capture("probe"), "/current": capture("current"), [line]: answer });
  const connection = { id: "mtc-gen", name: "mtconnect", type: "mtconnect", host: "127.0.0.1", port: 17322 };
  const provider = new MTConnectProvider(connection as DatabaseConnection, {}, AGENT, () => transport);
  await provider.connect();
  return (await provider.queryReadOnly(line, BUDGET)).rows;
}

afterEach(() => {
  for (const request of recorded) expect(request.method).toBe("GET");
  recorded = [];
});

const batches = Array.from({ length: CASES / BATCH }, (_, at) => CASES_BUILT.slice(at * BATCH, (at + 1) * BATCH));

describe(`${CASES} generated URL spellings, seed ${SEED}`, () => {
  test("every case carries its fake pieces into the agent's answer, so each assertion below has something to find", () => {
    for (const built of CASES_BUILT) {
      expect(built.pieces.length).toBeGreaterThan(0);
      for (const piece of built.pieces) expect(built.value).toContain(piece);
    }
  });

  test.each(batches.map((cases, at) => [at, cases] as const))(
    "batch %d: the asset projection keeps no piece, in an attribute, the asset id or text split by CDATA and children",
    async (at, cases) => {
      const assets = cases
        .map((built, index) => {
          const id = index % 2 === 0 ? `NOTE-${at}-${index}` : built.value;
          return `<ProgramNote assetId="${escape(id)}" deviceUuid="LIBREDB-1722" timestamp="2026-11-02T00:00:00Z" source="${escape(built.value)}"><Note>${split(built.value, true)}</Note></ProgramNote>`;
        })
        .join("");
      const answer = capture("assets").replace(/<Assets>[\s\S]*<\/Assets>/, `<Assets>${assets}</Assets>`);
      for (const built of cases) for (const piece of built.pieces) expect(answer).toContain(piece);
      const rows = await read("/assets", answer);
      expect(rows.length).toBe(cases.length);
      rows.forEach((row, index) => {
        const text = JSON.stringify(row);
        for (const piece of cases[index].pieces) expect(text, cases[index].value).not.toContain(piece);
      });
    },
  );

  test.each(batches.map((cases, at) => [at, cases] as const))(
    "batch %d: the href projection keeps no piece, in a FileLocation href and an xlink:href read as URLs",
    async (at, cases) => {
      const assets = cases
        .map(
          (built, index) =>
            `<File assetId="FILE-${at}-${index}" deviceUuid="LIBREDB-1722" timestamp="2026-11-02T00:00:00Z"><FileLocation href="${escape(built.value)}"/><Link xlink:href="${escape(built.value)}"/></File>`,
        )
        .join("");
      const answer = capture("assets").replace(/<Assets>[\s\S]*<\/Assets>/, `<Assets>${assets}</Assets>`);
      for (const built of cases) for (const piece of built.pieces) expect(answer).toContain(piece);
      const rows = await read("/assets", answer);
      expect(rows.length).toBe(cases.length);
      rows.forEach((row, index) => {
        const text = JSON.stringify(row);
        for (const piece of cases[index].pieces) expect(text, cases[index].value).not.toContain(piece);
      });
    },
  );

  test.each(batches.map((cases, at) => [at, cases] as const))(
    "batch %d: the observation projection keeps no piece, in an AssetChanged value split by CDATA or a data set key",
    async (at, cases) => {
      const observations = cases
        .map(
          (built, index) =>
            `<AssetChanged assetType="ProgramNote" dataItemId="gen_chg_${index}" sequence="${1000 + 2 * index}" timestamp="2026-11-02T00:00:00Z">${split(built.value, false)}</AssetChanged><AssetCountDataSet count="1" dataItemId="gen_cnt_${index}" sequence="${1001 + 2 * index}" timestamp="2026-11-02T00:00:00Z"><Entry key="${escape(built.value)}">1</Entry></AssetCountDataSet>`,
        )
        .join("");
      const answer = capture("current").replace(
        '<Availability dataItemId="d1722-avail"',
        `${observations}<Availability dataItemId="d1722-avail"`,
      );
      for (const built of cases) for (const piece of built.pieces) expect(answer).toContain(piece);
      const rows = await read("/current", answer);
      const byId = new Map(rows.map((row) => [String(row.dataItemId), JSON.stringify(row)]));
      cases.forEach((built, index) => {
        for (const id of [`gen_chg_${index}`, `gen_cnt_${index}`]) {
          const text = byId.get(id);
          expect(text, `${at}/${id}`).toBeDefined();
          for (const piece of built.pieces) expect(text, built.value).not.toContain(piece);
        }
      });
    },
  );
});
