/**
 * What went wrong, read from the wire and never from a message string.
 *
 * THE RULE AND WHY IT IS NOT STYLE. Every case below is recognised by a Report's OID or by a
 * PDU's error-status, both of which are numbers the standard fixes. None of them is recognised
 * by the text of an exception. Measured on 13 October 2026: the same failure to serialise a
 * 64-bit value reads "Do not know how to serialize a BigInt" under Node 24.14.0 and
 * "JSON.stringify cannot serialize BigInt." under Bun 1.4.2, so a comparison against message
 * text is a comparison against the runtime. The client's own strings are no better: they are a
 * library's wording, free to change in a patch release.
 *
 * WHY SILENCE NEEDS ITS OWN TREATMENT. Over UDP most failures are silence, and silence does not
 * say which failure it was. Measured against Net-SNMP snmpd 5.9.4 on 13 October 2026, all of
 * these produced no answer at all: a wrong v2c community, a port nothing listens on, a v2c
 * request whose answer would exceed a datagram, a v3 request with a wrong privacy passphrase,
 * a v3 request naming an unknown context, and an aggregate of ordinary values whose total
 * overflows, on v3 as well as on v2c. A filtered path and a host that is down look the same.
 * So a timeout here lists every cause its own case allows and asserts none of them, which is
 * the honest reading and also the useful one.
 */

/** Report OIDs from the USM statistics group (RFC 3414 section 5), as dotted strings. */
export const USM_REPORT_OIDS = {
  unsupportedSecurityLevel: "1.3.6.1.6.3.15.1.1.1.0",
  notInTimeWindow: "1.3.6.1.6.3.15.1.1.2.0",
  unknownUserName: "1.3.6.1.6.3.15.1.1.3.0",
  unknownEngineId: "1.3.6.1.6.3.15.1.1.4.0",
  wrongDigest: "1.3.6.1.6.3.15.1.1.5.0",
  decryptionError: "1.3.6.1.6.3.15.1.1.6.0",
} as const;

/** error-status values this provider can meet (RFC 3416 section 3). */
export const ERROR_STATUS = {
  noError: 0,
  tooBig: 1,
  noSuchName: 2,
  genErr: 5,
  noAccess: 6,
  authorizationError: 16,
  notWritable: 17,
} as const;

export type SnmpFailure =
  | { readonly kind: "credential"; readonly reason: string; readonly retryable: false }
  | { readonly kind: "refused"; readonly reason: string; readonly retryable: false }
  | { readonly kind: "tooLarge"; readonly reason: string; readonly retryable: false }
  | { readonly kind: "requestTooLarge"; readonly reason: string; readonly retryable: false }
  | { readonly kind: "silence"; readonly reason: string; readonly causes: readonly string[]; readonly retryable: true }
  | { readonly kind: "transport"; readonly reason: string; readonly retryable: false };

/**
 * A Report the agent sent instead of an answer.
 *
 * Every one of these arrives unauthenticated, at noAuthNoPriv, which RFC 3414 section 11.4 warns
 * about in those terms. They are therefore read for WHICH failure they name and never trusted for
 * anything else: an engine ID carried by one does not re-pin a connection.
 */
export function failureFromReport(oid: string): SnmpFailure {
  switch (oid) {
    case USM_REPORT_OIDS.unknownUserName:
      return { kind: "credential", reason: "the agent does not know this user name", retryable: false };
    case USM_REPORT_OIDS.wrongDigest:
      return {
        kind: "credential",
        reason: "the authentication passphrase or protocol does not match the agent's",
        retryable: false,
      };
    case USM_REPORT_OIDS.unsupportedSecurityLevel:
      return {
        kind: "credential",
        reason: "the agent does not offer this user the requested security level",
        retryable: false,
      };
    case USM_REPORT_OIDS.unknownEngineId:
      return {
        kind: "credential",
        reason: "the agent does not recognise the engine ID this request was localised to",
        retryable: false,
      };
    case USM_REPORT_OIDS.notInTimeWindow:
      return { kind: "credential", reason: "this request fell outside the agent's time window", retryable: false };
    case USM_REPORT_OIDS.decryptionError:
      return { kind: "credential", reason: "the agent could not decrypt this request", retryable: false };
    default:
      return {
        kind: "refused",
        reason: `the agent sent a report this provider does not know (${oid})`,
        retryable: false,
      };
  }
}

/** A response PDU that carried a non-zero error-status. */
export function failureFromStatus(status: number): SnmpFailure | undefined {
  switch (status) {
    case ERROR_STATUS.noError:
      return undefined;
    case ERROR_STATUS.tooBig:
      return {
        kind: "tooLarge",
        reason: "the answer would not fit one datagram, so the agent sent none of it",
        retryable: false,
      };
    case ERROR_STATUS.authorizationError:
      return { kind: "refused", reason: "the agent refused this read for this credential", retryable: false };
    case ERROR_STATUS.noAccess:
    case ERROR_STATUS.notWritable:
      // Neither can arise from a read this provider sends. Reaching one means something built a
      // write, which is a defect rather than a condition, and it is reported as itself.
      return {
        kind: "refused",
        reason: `the agent answered error-status ${status}, which only a write draws`,
        retryable: false,
      };
    case ERROR_STATUS.noSuchName:
      return {
        kind: "refused",
        reason: "the agent answered noSuchName, which this provider should never draw because it does not speak v1",
        retryable: false,
      };
    default:
      return { kind: "refused", reason: `the agent answered error-status ${status}`, retryable: false };
  }
}

export interface SilenceContext {
  readonly version: "v2c" | "v3";
  readonly securityLevel?: "noAuthNoPriv" | "authNoPriv" | "authPriv";
  readonly contextNameSet: boolean;
}

/**
 * No answer arrived. Lists what that can mean here and claims none of them.
 *
 * The list is narrowed by what the request actually was, not by guesswork: a wrong privacy
 * passphrase cannot explain a v2c timeout, and an unknown context cannot explain one where no
 * context was named.
 */
export function failureFromSilence(context: SilenceContext): SnmpFailure {
  const causes = [
    "nothing is listening on that address and port",
    "a filter dropped the request or the answer",
    "the agent is reachable but did not answer in time",
    "the answer would not fit one datagram, which this version reports as nothing at all",
  ];
  if (context.version === "v2c") {
    causes.unshift("the community does not match the agent's");
  } else {
    if (context.securityLevel === "authPriv")
      causes.unshift("the privacy passphrase or protocol does not match the agent's");
    if (context.contextNameSet) causes.push("the agent does not know the context name this request carried");
  }
  return {
    kind: "silence",
    reason: "no answer arrived, and over UDP that does not say which of these it was",
    causes,
    retryable: true,
  };
}

/**
 * A failure raised by the socket rather than by the agent.
 *
 * `EMSGSIZE` is here because it is not a reading of anything. Measured on 13 October 2026: a Get
 * carrying 600 small OIDs produced it, and the datagram never left the machine, so the agent was
 * never asked. Reporting it as an answer, or as a timeout, would state something about an agent
 * that said nothing because it heard nothing.
 */
export function failureFromSocket(code: string): SnmpFailure {
  if (code === "EMSGSIZE") {
    return {
      kind: "requestTooLarge",
      reason: "this request is larger than one datagram, so it was never sent and the agent was never asked",
      retryable: false,
    };
  }
  if (code === "EACCES") {
    return {
      kind: "transport",
      reason: "the operating system refused the send, which a broadcast address draws",
      retryable: false,
    };
  }
  if (code === "ECONNREFUSED") {
    // MEASURED on 14 October 2026 against a loopback port with nothing bound: a CONNECTED UDP
    // socket receives the ICMP port-unreachable as an error event, within milliseconds. The
    // send was not refused; it succeeded, and the far host answered that nothing is listening.
    // Saying "the socket refused the send" here would send a reader to look at this machine.
    return {
      kind: "transport",
      reason: "the host answered that nothing is listening on that UDP port",
      retryable: false,
    };
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return { kind: "transport", reason: "the host name did not resolve", retryable: false };
  }
  return { kind: "transport", reason: `the socket refused the send (${code})`, retryable: false };
}
