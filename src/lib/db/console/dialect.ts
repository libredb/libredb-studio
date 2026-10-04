import { QueryError } from "@/lib/db/errors";

/**
 * A console dialect as data: the request grammar two engines share, with every difference between them declared
 * here rather than branched on (vector-family spec 3.4).
 *
 * A console text is one HTTP-shaped request: comment lines, one request line (a method and a route, with an
 * optional query string), and one JSON object as its body. The dialect says which methods, which prefix, which
 * comment markers and which bounds; the route table says which routes, with their parameters, query keys and body
 * rule. No published capability declares a dialect: each provider holds its own and hands it to these modules.
 */

/** What a path parameter holds: a name, checked here as non-empty, or a point id, unsigned 64-bit digits or a UUID. */
export type ParamKind = "name" | "point-id";

/** What a route does, which the browser's confirmation gate reads: a read runs, anything else asks first. */
export type RouteClass = "read" | "write" | "destructive" | "admin";

/** One query key a route declares, and the values it takes. */
export interface QueryKeySpec {
  readonly kind: "positive-int" | "positive-int-or-words" | "word-list";
  /** The words the key takes: one of them for `positive-int-or-words`, a comma-separated list of them for `word-list`. */
  readonly words?: readonly string[];
}

/** One route of a console's table. */
export interface RouteSpec<Op extends string = string> {
  readonly method: string;
  /**
   * The route after the dialect's prefix, with each path parameter written as `{name}`: `items/search`, or
   * `things/{name}/query` under the prefix `/`. A request writes it after the prefix, or alone where the dialect
   * allows the short form.
   */
  readonly template: string;
  readonly op: Op;
  readonly class: RouteClass;
  readonly params: Readonly<Record<string, ParamKind>>;
  readonly query: Readonly<Record<string, QueryKeySpec>>;
  /** `"optional"`: an absent body is read as `{}`. */
  readonly body: "none" | "optional" | "required";
}

/** A console's dialect: its grammar facts and its bounds. */
export interface ConsoleDialectSpec {
  /** The dialect id, which is also the Monaco language id of its editor. */
  readonly id: string;
  readonly methods: readonly string[];
  readonly pathPrefix: string;
  /** Whether a route may be written without the prefix. */
  readonly shortForm: boolean;
  /** The comment markers a line before the request line may start with; after it, none is a comment marker. */
  readonly commentMarkers: readonly string[];
  /** Whether `//` opens a comment to the end of the line after the request line, outside strings. */
  readonly bodyComments: boolean;
  /** The bound on the whole text, in UTF-8 bytes, checked before the text is read. */
  readonly maxTextBytes: number;
  /** The deepest nesting of objects and arrays the body may hold, the body object counting as one. */
  readonly maxDepth: number;
  /** Objects, arrays that are neither all numbers nor all strings, and every value outside such arrays. */
  readonly maxNodes: number;
  /** The numbers inside arrays whose elements are all numbers. */
  readonly maxNumericLeaves: number;
  /** The strings inside arrays whose elements are all strings. */
  readonly maxScalarLeaves: number;
}

/**
 * When a rule refuses a request: phase 0 reads the text alone and makes no call of any kind, phase 1 reads the
 * schema first, with exactly one bounded, read-only metadata sequence and no execution call.
 */
export type ValidationPhase = 0 | 1;

/** A request refused before its execution call, with the phase whose rule refused it. */
export class RequestRefusal extends QueryError {
  constructor(
    message: string,
    public readonly phase: ValidationPhase,
    /** The body key the refusal names, when it names one. */
    public readonly key: string | null = null,
  ) {
    super(message);
    this.name = "RequestRefusal";
    Object.setPrototypeOf(this, RequestRefusal.prototype);
  }
}
