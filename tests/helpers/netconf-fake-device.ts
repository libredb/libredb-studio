/**
 * A scripted NETCONF device for the agent path's unit tests: a session that answers the YANG library, the module texts
 * and the data reads from fixed text, and records every request it was asked, so a test can pin that the agent path
 * sends only reads and see what each one was.
 *
 * Its modules are shaped like the RFC modules the docker/netconf fixture serves: a keyed interface list with a
 * description, a leaf its module marks nacm:default-deny-all and a leaf typed iana-crypt-hash crypt-hash, plus
 * ietf-keystore and ietf-netconf-acm, which are withheld whole. Every value it holds is an obvious fake.
 */
import type { SessionPort } from "@/lib/db/providers/network/netconf/reader";
import type { NetconfRequest } from "@/lib/db/providers/network/netconf/requests";

export const FAKE_SECRET = "not-a-real-secret";
export const FAKE_HASH = "not-a-real-hash";

const BASE = 'xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"';
const MONITORING = 'xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring"';

export const FAKE_MODULES: Readonly<Record<string, { namespace: string; text: string }>> = {
  "ex-if": {
    namespace: "urn:example:ex-if",
    text: `module ex-if { prefix exif; import ietf-netconf-acm { prefix nacm; } import iana-crypt-hash { prefix ianach; }
      container interfaces { list interface { key name; leaf name { type string; } leaf description { type string; }
        leaf secret { type string; nacm:default-deny-all; } leaf pw { type ianach:crypt-hash; } } }
      container users { list user { key token; leaf token { type string; nacm:default-deny-all; } leaf note { type string; } } } }`,
  },
  "iana-crypt-hash": {
    namespace: "urn:ietf:params:xml:ns:yang:iana-crypt-hash",
    text: "module iana-crypt-hash { prefix ianach; typedef crypt-hash { type string; } }",
  },
  "ietf-netconf-acm": {
    namespace: "urn:ietf:params:xml:ns:yang:ietf-netconf-acm",
    text: "module ietf-netconf-acm { prefix nacm; extension default-deny-all; container nacm { nacm:default-deny-all; leaf enable-nacm { type boolean; } } }",
  },
  "ietf-keystore": {
    namespace: "urn:ietf:params:xml:ns:yang:ietf-keystore",
    text: "module ietf-keystore { prefix ks; container keystore { leaf k { type binary; } } }",
  },
  "ietf-netconf-nmda": {
    namespace: "urn:ietf:params:xml:ns:yang:ietf-netconf-nmda",
    text: "module ietf-netconf-nmda { prefix ncds; }",
  },
};

const libraryReply = (modules: Readonly<Record<string, { namespace: string }>>): string =>
  `<rpc-reply ${BASE}><data><modules-state xmlns="urn:ietf:params:xml:ns:yang:ietf-yang-library">${Object.entries(
    modules,
  )
    .map(
      ([name, { namespace }]) =>
        `<module><name>${name}</name><revision>2026-01-01</revision><namespace>${namespace}</namespace></module>`,
    )
    .join("")}</modules-state></data></rpc-reply>`;

/** Interface entries: each with a description, a deny-all secret and a password hash. */
export const interfacesData = (count: number): string =>
  `<interfaces xmlns="urn:example:ex-if">${Array.from(
    { length: count },
    (_, index) =>
      `<interface><name>ge-${index}</name><description>port ${index}</description><secret>${FAKE_SECRET}</secret><pw>${FAKE_HASH}</pw></interface>`,
  ).join("")}</interfaces>` +
  `<users xmlns="urn:example:ex-if"><user><token>${FAKE_SECRET}</token><note>n</note></user></users>` +
  `<keystore xmlns="urn:ietf:params:xml:ns:yang:ietf-keystore"><k>${FAKE_SECRET}</k></keystore>`;

export interface FakeDeviceOptions {
  /** The data `<get-config>` and `<get-data>` answer. */
  readonly data?: string;
  /** Module texts in place of the fixed ones, by name. */
  readonly texts?: Readonly<Record<string, string>>;
  /** A whole reply in place of the library's. */
  readonly libraryReply?: string;
  /** A schema identifier answered with an rpc-error. */
  readonly refuseSchema?: string;
}

export interface FakeDevice {
  readonly session: SessionPort;
  readonly sent: NetconfRequest[];
  readonly closed: { count: number };
}

/** One fake device session. */
export function fakeNetconfDevice(options: FakeDeviceOptions = {}): FakeDevice {
  const sent: NetconfRequest[] = [];
  const closed = { count: 0 };
  const session: SessionPort = {
    request: async (request) => {
      sent.push(request);
      switch (request.operation) {
        case "get":
          return options.libraryReply ?? libraryReply(FAKE_MODULES);
        case "get-schema": {
          if (request.identifier === options.refuseSchema) {
            return `<rpc-reply ${BASE}><rpc-error><error-tag>invalid-value</error-tag><error-message>${FAKE_SECRET}</error-message></rpc-error></rpc-reply>`;
          }
          const text = options.texts?.[request.identifier] ?? FAKE_MODULES[request.identifier]?.text ?? "";
          return `<rpc-reply ${BASE}><data ${MONITORING}>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</data></rpc-reply>`;
        }
        case "get-config":
        case "get-data":
          return `<rpc-reply ${BASE}><data>${options.data ?? interfacesData(3)}</data></rpc-reply>`;
        case "close-session":
          return `<rpc-reply ${BASE}><ok/></rpc-reply>`;
      }
    },
    close: async () => void (closed.count += 1),
  };
  return { session, sent, closed };
}
