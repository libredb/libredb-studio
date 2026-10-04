/**
 * The etcd editor text, read one way by the parser and the editor's tokens provider (spec 3.3, 10).
 *
 * One corpus for both readers: tests/unit/db/etcd/lexer.test.ts runs `tokenizeLine` and
 * `splitWords` over it, tests/unit/db/etcd/commands.test.ts runs `parseEtcdCommand`, and the tokens
 * provider's test (spec 3.3) runs the editor's language over it, so each requires the same word
 * boundaries, the same section for each line and the same bytes (R11 ARCH-9).
 *
 * The txn cases hold the texts on which the shell rule and etcdctl's own reading disagree (spec 10).
 * Their bytes were measured, not derived: each txn text below was run on 2026-09-30 by etcdctl
 * v3.7.2's own `txn` against gcr.io/etcd-development/etcd:v3.7.2
 * (sha256:7c6c239825d00e3f6328a69caafd54be92063acf0c2ce78b8394699f52b75dc3) in a private
 * container, and every stored key read back with `get -w json`. What etcdctl answered for a case
 * Studio refuses is noted on the case.
 */
import type { CommandRefusalCode } from "@/lib/db/providers/keyvalue/etcd/commands";
import type { LexRefusalCode, LexSection } from "@/lib/db/providers/keyvalue/etcd/lexer";

/** A word as the lexer reads it: where its source starts and ends, and what it holds. */
export interface CorpusWord {
  /** 1-based line and 0-based column of the word's first source character. */
  readonly line: number;
  readonly column: number;
  /** 1-based line and 0-based exclusive column just past the word's last source character. */
  readonly endLine: number;
  readonly endColumn: number;
  /** What the word holds, when it is text; otherwise `hex` gives its bytes. */
  readonly text?: string;
  readonly hex?: string;
}

/** A compare line's four parts (spec 5.1.4), the key and the value as bytes in lowercase hex. */
export interface CorpusCompare {
  readonly line: number;
  readonly target: string;
  readonly keyHex: string;
  readonly operator: string;
  readonly valueHex: string;
}

export interface GrammarCorpusCase {
  readonly name: string;
  readonly text: string;
  /** The section each physical line is read in, one entry per line. */
  readonly sections: readonly LexSection[];
  /** Every word of the command line and of each txn request, in text order. */
  readonly words: readonly CorpusWord[];
  readonly compares?: readonly CorpusCompare[];
  /** The lexer's refusal, when the text cannot be read as words at all. */
  readonly lexRefusal?: { readonly code: LexRefusalCode; readonly line: number; readonly column: number };
  /** What the parser answers: the command's kind and line, or the refusal's code and line. */
  readonly parse:
    | { readonly ok: true; readonly kind: string; readonly line: number }
    | { readonly ok: false; readonly code: CommandRefusalCode; readonly line: number };
}

/** A one-line command a shell would expand or refuse, which the lexer refuses at `column` (spec 5.1.1). */
function shellRefusal(name: string, text: string, code: LexRefusalCode, column: number): GrammarCorpusCase {
  return {
    name,
    text,
    sections: ["command"],
    words: [],
    lexRefusal: { code, line: 1, column },
    parse: { ok: false, code, line: 1 },
  };
}

export const GRAMMAR_CORPUS: readonly GrammarCorpusCase[] = [
  {
    name: "a read with a flag",
    text: "get /app/config/ --prefix",
    sections: ["command"],
    words: [
      { line: 1, column: 0, endLine: 1, endColumn: 3, text: "get" },
      { line: 1, column: 4, endLine: 1, endColumn: 16, text: "/app/config/" },
      { line: 1, column: 17, endLine: 1, endColumn: 25, text: "--prefix" },
    ],
    parse: { ok: true, kind: "get", line: 1 },
  },
  {
    name: "a prompt and ETCDCTL_API=3 before etcdctl",
    text: "$ ETCDCTL_API=3 etcdctl get /a",
    sections: ["command"],
    words: [
      { line: 1, column: 0, endLine: 1, endColumn: 1, text: "$" },
      { line: 1, column: 2, endLine: 1, endColumn: 15, text: "ETCDCTL_API=3" },
      { line: 1, column: 16, endLine: 1, endColumn: 23, text: "etcdctl" },
      { line: 1, column: 24, endLine: 1, endColumn: 27, text: "get" },
      { line: 1, column: 28, endLine: 1, endColumn: 30, text: "/a" },
    ],
    parse: { ok: true, kind: "get", line: 1 },
  },
  {
    // SRC landscape/coredns-v1.14.7__plugin_etcd_README.md:156, as printed.
    name: "CoreDNS's put, with a % prompt and a single-quoted JSON value",
    text: `% etcdctl put /skydns/arpa/in-addr/10/0/0/127 '{"host":"reverse.skydns.local."}'`,
    sections: ["command"],
    words: [
      { line: 1, column: 0, endLine: 1, endColumn: 1, text: "%" },
      { line: 1, column: 2, endLine: 1, endColumn: 9, text: "etcdctl" },
      { line: 1, column: 10, endLine: 1, endColumn: 13, text: "put" },
      { line: 1, column: 14, endLine: 1, endColumn: 45, text: "/skydns/arpa/in-addr/10/0/0/127" },
      { line: 1, column: 46, endLine: 1, endColumn: 80, text: '{"host":"reverse.skydns.local."}' },
    ],
    parse: { ok: true, kind: "put", line: 1 },
  },
  {
    // SRC landscape/m3-v1.6.0__site_content_operational_guide_bootstrapping_crash_recovery.md:172, as printed.
    name: "M3's del, with env",
    text: "env ETCDCTL_API=3 etcdctl del _kv/default_env/m3db.client.bootstrap-consistency-level",
    sections: ["command"],
    words: [
      { line: 1, column: 0, endLine: 1, endColumn: 3, text: "env" },
      { line: 1, column: 4, endLine: 1, endColumn: 17, text: "ETCDCTL_API=3" },
      { line: 1, column: 18, endLine: 1, endColumn: 25, text: "etcdctl" },
      { line: 1, column: 26, endLine: 1, endColumn: 29, text: "del" },
      {
        line: 1,
        column: 30,
        endLine: 1,
        endColumn: 85,
        text: "_kv/default_env/m3db.client.bootstrap-consistency-level",
      },
    ],
    parse: { ok: true, kind: "del", line: 1 },
  },
  {
    // The same file, :166: the value is piped in, so the pipe is refused (spec 5.1.2).
    name: "M3's put, which pipes its value in, is refused at the pipe",
    text: 'echo -n "ChF1bnN0cmljdF9tYWpvcml0eQ==" | base64 -d | env ETCDCTL_API=3 etcdctl put _kv/default_env/m3db.client.bootstrap-consistency-level',
    sections: ["command"],
    words: [],
    lexRefusal: { code: "shell-operator", line: 1, column: 39 },
    parse: { ok: false, code: "shell-operator", line: 1 },
  },
  {
    // SRC landscape/k8s-website__tasks_administer-cluster_encrypt-data.md:549-555, as printed: it
    // passes connection flags and pipes to hexdump, and the pipe is what the lexer meets.
    name: "the Kubernetes documentation's get, across four backslash-newlines, is refused at the pipe",
    text: "ETCDCTL_API=3 etcdctl \\\n   --cacert=/etc/kubernetes/pki/etcd/ca.crt   \\\n   --cert=/etc/kubernetes/pki/etcd/server.crt \\\n   --key=/etc/kubernetes/pki/etcd/server.key  \\\n   get /registry/secrets/default/secret1 | hexdump -C",
    sections: ["command", "command", "command", "command", "command"],
    words: [],
    lexRefusal: { code: "shell-operator", line: 5, column: 41 },
    parse: { ok: false, code: "shell-operator", line: 5 },
  },
  {
    name: "comment, blank and blank-looking lines before a path-spelled etcdctl",
    text: "# a comment\n\n   \n/usr/local/bin/etcdctl get /a\n",
    sections: ["command", "command", "command", "command", "after-command"],
    words: [
      { line: 4, column: 0, endLine: 4, endColumn: 22, text: "/usr/local/bin/etcdctl" },
      { line: 4, column: 23, endLine: 4, endColumn: 26, text: "get" },
      { line: 4, column: 27, endLine: 4, endColumn: 29, text: "/a" },
    ],
    parse: { ok: true, kind: "get", line: 4 },
  },
  {
    name: "CRLF line endings",
    text: "# c\r\n\r\nget /a\r\n",
    sections: ["command", "command", "command", "after-command"],
    words: [
      { line: 3, column: 0, endLine: 3, endColumn: 3, text: "get" },
      { line: 3, column: 4, endLine: 3, endColumn: 6, text: "/a" },
    ],
    parse: { ok: true, kind: "get", line: 3 },
  },
  {
    // Monaco's model ends a line at a lone CR too, so the parser and the tokens provider both do.
    name: "a lone CR ends a line, so a second command after it is refused on line 2",
    text: "get /a\rput /b c",
    sections: ["command", "after-command"],
    words: [
      { line: 1, column: 0, endLine: 1, endColumn: 3, text: "get" },
      { line: 1, column: 4, endLine: 1, endColumn: 6, text: "/a" },
    ],
    parse: { ok: false, code: "second-command", line: 2 },
  },
  {
    name: "a single-quoted value that spans two lines",
    text: "put /app/cfg 'line one\nline two'",
    sections: ["command", "command"],
    words: [
      { line: 1, column: 0, endLine: 1, endColumn: 3, text: "put" },
      { line: 1, column: 4, endLine: 1, endColumn: 12, text: "/app/cfg" },
      { line: 1, column: 13, endLine: 2, endColumn: 9, text: "line one\nline two" },
    ],
    parse: { ok: true, kind: "put", line: 1 },
  },
  {
    name: "a backslash-newline between words",
    text: "put /a \\\n  value",
    sections: ["command", "command"],
    words: [
      { line: 1, column: 0, endLine: 1, endColumn: 3, text: "put" },
      { line: 1, column: 4, endLine: 1, endColumn: 6, text: "/a" },
      { line: 2, column: 2, endLine: 2, endColumn: 7, text: "value" },
    ],
    parse: { ok: true, kind: "put", line: 1 },
  },
  {
    name: "a backslash-newline inside a word joins it",
    text: "put /a val\\\nue",
    sections: ["command", "command"],
    words: [
      { line: 1, column: 0, endLine: 1, endColumn: 3, text: "put" },
      { line: 1, column: 4, endLine: 1, endColumn: 6, text: "/a" },
      { line: 1, column: 7, endLine: 2, endColumn: 2, text: "value" },
    ],
    parse: { ok: true, kind: "put", line: 1 },
  },
  {
    // The word ab ends with its backslash on line 1, and the third positional is refused on line 2.
    name: "a backslash-newline before a blank ends the word on the line before",
    text: "put k ab\\\n cd",
    sections: ["command", "command"],
    words: [
      { line: 1, column: 0, endLine: 1, endColumn: 3, text: "put" },
      { line: 1, column: 4, endLine: 1, endColumn: 5, text: "k" },
      { line: 1, column: 6, endLine: 1, endColumn: 9, text: "ab" },
      { line: 2, column: 1, endLine: 2, endColumn: 3, text: "cd" },
    ],
    parse: { ok: false, code: "bad-argument", line: 2 },
  },
  {
    name: "the empty word",
    text: "put k ''",
    sections: ["command"],
    words: [
      { line: 1, column: 0, endLine: 1, endColumn: 3, text: "put" },
      { line: 1, column: 4, endLine: 1, endColumn: 5, text: "k" },
      { line: 1, column: 6, endLine: 1, endColumn: 8, text: "" },
    ],
    parse: { ok: true, kind: "put", line: 1 },
  },
  {
    name: "a single quote inside a single-quoted word, as a shell writes it",
    text: "put k 'it'\\''s'",
    sections: ["command"],
    words: [
      { line: 1, column: 0, endLine: 1, endColumn: 3, text: "put" },
      { line: 1, column: 4, endLine: 1, endColumn: 5, text: "k" },
      { line: 1, column: 6, endLine: 1, endColumn: 15, text: "it's" },
    ],
    parse: { ok: true, kind: "put", line: 1 },
  },
  {
    name: "a shell expansion on the command line is refused",
    text: "put k $HOME",
    sections: ["command"],
    words: [],
    lexRefusal: { code: "shell-expansion", line: 1, column: 6 },
    parse: { ok: false, code: "shell-expansion", line: 1 },
  },
  shellRefusal("${ is refused", "put k ${x}", "shell-expansion", 6),
  shellRefusal("$( is refused", "put k $(ls)", "shell-expansion", 6),
  shellRefusal("$1 is refused", "put k $1", "shell-expansion", 6),
  shellRefusal("$? is refused", "put k $?", "shell-expansion", 6),
  // Measured: bash and zsh pass a newline for $'a\nb', dash passes $a\nb.
  shellRefusal("$' is refused", "put k $'a\\nb'", "shell-expansion", 6),
  shellRefusal('$" is refused', 'put k $"a"', "shell-expansion", 6),
  // Measured: bash and zsh pass 2 for $[1+1].
  shellRefusal("$[ is refused", "put k $[1+1]", "shell-expansion", 6),
  shellRefusal("a ~ that begins a word is refused", "get ~/x", "shell-expansion", 4),
  // Measured: bash passes a=/home/x/x for a=~/x outside POSIX mode.
  shellRefusal("a ~ after the = of a NAME= word is refused", "put k a=~/x", "shell-expansion", 6),
  // Measured: zsh 5.9 passes /usr/bin/ls for =ls, where bash and dash pass =ls.
  shellRefusal("an = that begins a word is refused", "put k =ls", "shell-expansion", 6),
  // Measured: bash and zsh pass two words for {a,b}.
  shellRefusal("braces holding a comma are refused", "put k {a,b}", "shell-expansion", 6),
  shellRefusal("a backquote is refused", "put k `ls`", "shell-expansion", 6),
  shellRefusal("; is refused", "get a; get b", "shell-operator", 5),
  shellRefusal("& is refused", "get a &", "shell-operator", 6),
  shellRefusal("| is refused", "get a | tee x", "shell-operator", 6),
  shellRefusal("< is refused", "put k < file", "shell-operator", 6),
  shellRefusal("> is refused", "get a > file", "shell-operator", 6),
  shellRefusal("( is refused", "put k (v)", "shell-operator", 6),
  shellRefusal(") is refused", "put k v)", "shell-operator", 7),
  shellRefusal("a quote never closed is refused", "put k 'a", "unclosed-quote", 6),
  // Measured: bash and dash keep a backslash that ends the text, zsh drops it.
  shellRefusal("a backslash that ends the text is refused", "put k a\\", "trailing-backslash", 7),
  {
    name: "a second command is refused, naming its line",
    text: "get /a\nput /b c",
    sections: ["command", "after-command"],
    words: [
      { line: 1, column: 0, endLine: 1, endColumn: 3, text: "get" },
      { line: 1, column: 4, endLine: 1, endColumn: 6, text: "/a" },
    ],
    parse: { ok: false, code: "second-command", line: 2 },
  },
  {
    // The command line ends at the line break before any command word, so line 2 is a line of its own.
    name: "a command below a line of leading tokens alone is refused, naming its line",
    text: "etcdctl\nget /a",
    sections: ["command", "after-command"],
    words: [{ line: 1, column: 0, endLine: 1, endColumn: 7, text: "etcdctl" }],
    parse: { ok: false, code: "second-command", line: 2 },
  },
  {
    // Measured: FAILURE, then key1 = "created-key1" and key2 = "some extra key".
    name: 'the README\'s non-interactive txn, mod("key1") > "0"',
    text: 'txn\nmod("key1") > "0"\n\nput key1 "overwrote-key1"\n\nput key1 "created-key1"\nput key2 "some extra key"\n\n',
    sections: ["command", "compares", "compares", "success", "success", "failure", "failure", "failure", "after-body"],
    words: [
      { line: 1, column: 0, endLine: 1, endColumn: 3, text: "txn" },
      { line: 4, column: 0, endLine: 4, endColumn: 3, text: "put" },
      { line: 4, column: 4, endLine: 4, endColumn: 8, text: "key1" },
      { line: 4, column: 9, endLine: 4, endColumn: 25, text: "overwrote-key1" },
      { line: 6, column: 0, endLine: 6, endColumn: 3, text: "put" },
      { line: 6, column: 4, endLine: 6, endColumn: 8, text: "key1" },
      { line: 6, column: 9, endLine: 6, endColumn: 23, hex: "637265617465642d6b657931" },
      { line: 7, column: 0, endLine: 7, endColumn: 3, text: "put" },
      { line: 7, column: 4, endLine: 7, endColumn: 8, text: "key2" },
      { line: 7, column: 9, endLine: 7, endColumn: 25, hex: "736f6d65206578747261206b6579" },
    ],
    compares: [{ line: 2, target: "mod", keyHex: "6b657931", operator: ">", valueHex: "30" }],
    parse: { ok: true, kind: "txn", line: 1 },
  },
  {
    name: "a create compare with <",
    text: 'txn\nc("k") < "10"\n\nput r success\n\nput r failure\n',
    sections: ["command", "compares", "compares", "success", "success", "failure", "failure"],
    words: [
      { line: 1, column: 0, endLine: 1, endColumn: 3, text: "txn" },
      { line: 4, column: 0, endLine: 4, endColumn: 3, text: "put" },
      { line: 4, column: 4, endLine: 4, endColumn: 5, text: "r" },
      { line: 4, column: 6, endLine: 4, endColumn: 13, text: "success" },
      { line: 6, column: 0, endLine: 6, endColumn: 3, text: "put" },
      { line: 6, column: 4, endLine: 6, endColumn: 5, text: "r" },
      { line: 6, column: 6, endLine: 6, endColumn: 13, text: "failure" },
    ],
    compares: [{ line: 2, target: "c", keyHex: "6b", operator: "<", valueHex: "3130" }],
    parse: { ok: true, kind: "txn", line: 1 },
  },
  {
    // Measured: the compare held the five bytes "$HOME"; nothing expanded it.
    name: 'val("k") = "$HOME" compares the text as written',
    text: 'txn\nval("k") = "$HOME"\n\nput r yes\n\nput r no\n',
    sections: ["command", "compares", "compares", "success", "success", "failure", "failure"],
    words: [
      { line: 1, column: 0, endLine: 1, endColumn: 3, text: "txn" },
      { line: 4, column: 0, endLine: 4, endColumn: 3, text: "put" },
      { line: 4, column: 4, endLine: 4, endColumn: 5, text: "r" },
      { line: 4, column: 6, endLine: 4, endColumn: 9, text: "yes" },
      { line: 6, column: 0, endLine: 6, endColumn: 3, text: "put" },
      { line: 6, column: 4, endLine: 6, endColumn: 5, text: "r" },
      { line: 6, column: 6, endLine: 6, endColumn: 8, text: "no" },
    ],
    compares: [{ line: 2, target: "val", keyHex: "6b", operator: "=", valueHex: "24484f4d45" }],
    parse: { ok: true, kind: "txn", line: 1 },
  },
  {
    // Measured: SUCCESS, so the backquoted key read as the key k.
    name: "a compare key in backquotes, taken raw",
    text: 'txn\nmod(`k`) = "0"\n\nput r success\n\nput r failure\n',
    sections: ["command", "compares", "compares", "success", "success", "failure", "failure"],
    words: [
      { line: 1, column: 0, endLine: 1, endColumn: 3, text: "txn" },
      { line: 4, column: 0, endLine: 4, endColumn: 3, text: "put" },
      { line: 4, column: 4, endLine: 4, endColumn: 5, text: "r" },
      { line: 4, column: 6, endLine: 4, endColumn: 13, text: "success" },
      { line: 6, column: 0, endLine: 6, endColumn: 3, text: "put" },
      { line: 6, column: 4, endLine: 6, endColumn: 5, text: "r" },
      { line: 6, column: 6, endLine: 6, endColumn: 13, text: "failure" },
    ],
    compares: [{ line: 2, target: "mod", keyHex: "6b", operator: "=", valueHex: "30" }],
    parse: { ok: true, kind: "txn", line: 1 },
  },
  {
    // Measured, each value read back: a\nb, a\tb, a\x00b, the literal and the escaped e-acute as
    // UTF-8, the octal escape as the single byte e9, and \xff as the single byte ff.
    name: "Go escapes in request values are bytes",
    text: 'txn\nmod("k") = "0"\n\nput n "a\\nb"\nput t "a\\tb"\nput z "a\\x00b"\nput e1 "é"\nput e2 "\\u00e9"\nput o "\\351"\nput f "\\xff"\n',
    sections: [
      "command",
      "compares",
      "compares",
      "success",
      "success",
      "success",
      "success",
      "success",
      "success",
      "success",
      "success",
    ],
    words: [
      { line: 1, column: 0, endLine: 1, endColumn: 3, text: "txn" },
      { line: 4, column: 0, endLine: 4, endColumn: 3, text: "put" },
      { line: 4, column: 4, endLine: 4, endColumn: 5, text: "n" },
      { line: 4, column: 6, endLine: 4, endColumn: 12, hex: "610a62" },
      { line: 5, column: 0, endLine: 5, endColumn: 3, text: "put" },
      { line: 5, column: 4, endLine: 5, endColumn: 5, text: "t" },
      { line: 5, column: 6, endLine: 5, endColumn: 12, hex: "610962" },
      { line: 6, column: 0, endLine: 6, endColumn: 3, text: "put" },
      { line: 6, column: 4, endLine: 6, endColumn: 5, text: "z" },
      { line: 6, column: 6, endLine: 6, endColumn: 14, hex: "610062" },
      { line: 7, column: 0, endLine: 7, endColumn: 3, text: "put" },
      { line: 7, column: 4, endLine: 7, endColumn: 6, text: "e1" },
      { line: 7, column: 7, endLine: 7, endColumn: 10, hex: "c3a9" },
      { line: 8, column: 0, endLine: 8, endColumn: 3, text: "put" },
      { line: 8, column: 4, endLine: 8, endColumn: 6, text: "e2" },
      { line: 8, column: 7, endLine: 8, endColumn: 15, hex: "c3a9" },
      { line: 9, column: 0, endLine: 9, endColumn: 3, text: "put" },
      { line: 9, column: 4, endLine: 9, endColumn: 5, text: "o" },
      { line: 9, column: 6, endLine: 9, endColumn: 12, hex: "e9" },
      { line: 10, column: 0, endLine: 10, endColumn: 3, text: "put" },
      { line: 10, column: 4, endLine: 10, endColumn: 5, text: "f" },
      { line: 10, column: 6, endLine: 10, endColumn: 12, hex: "ff" },
    ],
    compares: [{ line: 2, target: "mod", keyHex: "6b", operator: "=", valueHex: "30" }],
    parse: { ok: true, kind: "txn", line: 1 },
  },
  {
    // Measured: etcdctl refused the whole txn with "invalid syntax".
    name: 'the invalid escape "\\q" is refused',
    text: 'txn\nmod("k") = "0"\n\nput k "\\q"\n',
    sections: ["command", "compares", "compares", "success", "success"],
    words: [{ line: 1, column: 0, endLine: 1, endColumn: 3, text: "txn" }],
    compares: [{ line: 2, target: "mod", keyHex: "6b", operator: "=", valueHex: "30" }],
    parse: { ok: false, code: "txn-quoting", line: 4 },
  },
  {
    // Measured: etcdctl stored the four bytes it's.
    name: "put k it's is one word",
    text: "txn\n\nput k it's\n",
    sections: ["command", "compares", "success", "success"],
    words: [
      { line: 1, column: 0, endLine: 1, endColumn: 3, text: "txn" },
      { line: 3, column: 0, endLine: 3, endColumn: 3, text: "put" },
      { line: 3, column: 4, endLine: 3, endColumn: 5, text: "k" },
      { line: 3, column: 6, endLine: 3, endColumn: 10, hex: "69742773" },
    ],
    parse: { ok: true, kind: "txn", line: 1 },
  },
  {
    // Measured: etcdctl dropped the open quote and stored abc; Studio refuses instead.
    name: "an unterminated quote in a request is refused",
    text: 'txn\n\nput k "abc\n',
    sections: ["command", "compares", "success", "success"],
    words: [{ line: 1, column: 0, endLine: 1, endColumn: 3, text: "txn" }],
    parse: { ok: false, code: "txn-quoting", line: 3 },
  },
  {
    // Measured: FAILURE, key2 held real newlines.
    name: "the README's multi-line put key2",
    text: 'txn\nmod("key1") > "0"\n\nput key1 "overwrote-key1"\n\nput key1 "created-key1"\nput key2 "this is\\na multi-line\\nvalue"\n\n',
    sections: ["command", "compares", "compares", "success", "success", "failure", "failure", "failure", "after-body"],
    words: [
      { line: 1, column: 0, endLine: 1, endColumn: 3, text: "txn" },
      { line: 4, column: 0, endLine: 4, endColumn: 3, text: "put" },
      { line: 4, column: 4, endLine: 4, endColumn: 8, text: "key1" },
      { line: 4, column: 9, endLine: 4, endColumn: 25, text: "overwrote-key1" },
      { line: 6, column: 0, endLine: 6, endColumn: 3, text: "put" },
      { line: 6, column: 4, endLine: 6, endColumn: 8, text: "key1" },
      { line: 6, column: 9, endLine: 6, endColumn: 23, text: "created-key1" },
      { line: 7, column: 0, endLine: 7, endColumn: 3, text: "put" },
      { line: 7, column: 4, endLine: 7, endColumn: 8, text: "key2" },
      { line: 7, column: 9, endLine: 7, endColumn: 39, hex: "746869732069730a61206d756c74692d6c696e650a76616c7565" },
    ],
    compares: [{ line: 2, target: "mod", keyHex: "6b657931", operator: ">", valueHex: "30" }],
    parse: { ok: true, kind: "txn", line: 1 },
  },
  {
    // Measured: FAILURE, and k then held v2: the put sat in the failure list.
    name: 'mod("k") = "5", two empty lines, then put k v2 lands in the failure list',
    text: 'txn\nmod("k") = "5"\n\n\nput k v2\n',
    sections: ["command", "compares", "compares", "success", "failure", "failure"],
    words: [
      { line: 1, column: 0, endLine: 1, endColumn: 3, text: "txn" },
      { line: 5, column: 0, endLine: 5, endColumn: 3, text: "put" },
      { line: 5, column: 4, endLine: 5, endColumn: 5, text: "k" },
      { line: 5, column: 6, endLine: 5, endColumn: 8, text: "v2" },
    ],
    compares: [{ line: 2, target: "mod", keyHex: "6b", operator: "=", valueHex: "35" }],
    parse: { ok: true, kind: "txn", line: 1 },
  },
  {
    // Measured: etcdctl read "# compares:" as a malformed compare; Studio removes a # line
    // directly above a compare or a request.
    name: "# lines directly above a compare or a request are removed",
    text: 'txn\n# compares:\nmod("k") > "0"\n\n# success:\nput k a\n\n# failure:\nput k b\n',
    sections: [
      "command",
      "compares",
      "compares",
      "compares",
      "success",
      "success",
      "success",
      "failure",
      "failure",
      "failure",
    ],
    words: [
      { line: 1, column: 0, endLine: 1, endColumn: 3, text: "txn" },
      { line: 6, column: 0, endLine: 6, endColumn: 3, text: "put" },
      { line: 6, column: 4, endLine: 6, endColumn: 5, text: "k" },
      { line: 6, column: 6, endLine: 6, endColumn: 7, text: "a" },
      { line: 9, column: 0, endLine: 9, endColumn: 3, text: "put" },
      { line: 9, column: 4, endLine: 9, endColumn: 5, text: "k" },
      { line: 9, column: 6, endLine: 9, endColumn: 7, text: "b" },
    ],
    compares: [{ line: 3, target: "mod", keyHex: "6b", operator: ">", valueHex: "30" }],
    parse: { ok: true, kind: "txn", line: 1 },
  },
  {
    name: "a # line set before an empty line is refused",
    text: 'txn\nmod("k") > "0"\n\n# success:\n\nput k v\n',
    sections: ["command", "compares", "compares", "success", "success", "failure", "failure"],
    words: [
      { line: 1, column: 0, endLine: 1, endColumn: 3, text: "txn" },
      { line: 6, column: 0, endLine: 6, endColumn: 3, text: "put" },
      { line: 6, column: 4, endLine: 6, endColumn: 5, text: "k" },
      { line: 6, column: 6, endLine: 6, endColumn: 7, text: "v" },
    ],
    compares: [{ line: 2, target: "mod", keyHex: "6b", operator: ">", valueHex: "30" }],
    parse: { ok: false, code: "txn-syntax", line: 4 },
  },
  {
    name: "a line past the failure list is refused",
    text: "txn\n\n\n\nput k v\n",
    sections: ["command", "compares", "success", "failure", "after-body", "after-body"],
    words: [{ line: 1, column: 0, endLine: 1, endColumn: 3, text: "txn" }],
    parse: { ok: false, code: "txn-syntax", line: 5 },
  },
  {
    name: "a protected key written with a Go escape in a txn branch",
    text: 'txn\n\nput "\\x2fregistry/x" v\n',
    sections: ["command", "compares", "success", "success"],
    words: [
      { line: 1, column: 0, endLine: 1, endColumn: 3, text: "txn" },
      { line: 3, column: 0, endLine: 3, endColumn: 3, text: "put" },
      { line: 3, column: 4, endLine: 3, endColumn: 20, hex: "2f72656769737472792f78" },
      { line: 3, column: 21, endLine: 3, endColumn: 22, text: "v" },
    ],
    parse: { ok: true, kind: "txn", line: 1 },
  },
];
