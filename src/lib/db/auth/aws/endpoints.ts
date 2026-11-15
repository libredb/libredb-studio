/**
 * AWS regional endpoints: the one partition this version supports, the commercial "aws" partition, as a row of fixed
 * values, and the https origin of a service in one of its regions. China, GovCloud and the isolated partitions are
 * refused with a sentence naming the region. The European Sovereign Cloud's eusc-de-east-1 is not shaped as a region
 * name by the quoting rule, so it is refused as notARegion, unquoted. A partition is a row added when an operator needs
 * it, never a guess.
 *
 * The region rule is AWS's own `regionRegex` for the "aws" partition, copied from partitions.js in the npm package
 * @aws-sdk/core 3.977.9 (dist-es/submodules/client/util-endpoints/lib/aws/partitions.js; the registry's integrity for
 * that version is sha512-reqPFEQrZxDZpeGj4PFMepBeR5LGYHRqq/L0motTzgFkCRBA4rFdaVXDSLYyGHhxVz7sT2PDnPN9CluGSfgyJA==),
 * whose row gives the DNS suffix amazonaws.com. No FIPS or dual-stack endpoint is built.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import { type HttpOrigin, httpOrigin } from "@/lib/db/http/endpoint";
import type { DatabaseType } from "@/lib/types";

/** A region of the commercial partition, as parseAwsRegion returns it. */
export interface AwsRegion {
  readonly name: string;
  readonly dnsSuffix: string;
}

/**
 * A region a signature scope may carry, in any partition or emulator: 1 to 64 letters, digits, hyphens or underscores,
 * which keeps the `Credential=` scope of the Authorization value unbroken.
 */
export const AWS_SIGNING_REGION = /^[A-Za-z0-9_-]{1,64}$/;

/** The commercial partition's regionRegex, as AWS publishes it but for its `\-` escapes, which match the same "-". */
const COMMERCIAL_REGION = /^(us|eu|ap|sa|ca|me|af|il|mx)-\w+-\d+$/;
const COMMERCIAL_DNS_SUFFIX = "amazonaws.com";
/** The shape of an AWS region name in any partition, which no secret access key has: safe to quote back. */
const REGION_SHAPED = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
/** A service's signing and endpoint name. */
const SERVICE_NAME = /^[a-z][a-z0-9-]{1,62}$/;
const HTTPS_PORT = 443;

export const AWS_REGION_SENTENCES = Object.freeze({
  missing: "The AWS region is required, such as us-east-1",
  outsidePartitions: (region: string) =>
    `The AWS region ${region} is outside the commercial partition (aws), the only one this version supports`,
  notARegion: "The AWS region is not an AWS region name, such as us-east-1",
});

const SERVICE_REFUSED =
  "The AWS service name must be a lower-case letter followed by 1 to 62 lower-case letters, digits or hyphens";
const REGION_FORGED = "The AWS region is not one parseAwsRegion returned for the commercial partition";

/**
 * A region of the commercial partition. Undefined or blank is `missing`. A value shaped as an AWS region name is quoted
 * in `outsidePartitions`; any other value is `notARegion`, unquoted, since a secret pasted into the wrong field must
 * not be repeated. The value is not trimmed: a padded name is not a region name.
 */
export function parseAwsRegion(value: string | undefined, provider: DatabaseType | undefined): AwsRegion {
  if (value === undefined || value.trim() === "") throw new DatabaseConfigError(AWS_REGION_SENTENCES.missing, provider);
  if (COMMERCIAL_REGION.test(value)) return { name: value, dnsSuffix: COMMERCIAL_DNS_SUFFIX };
  if (REGION_SHAPED.test(value)) {
    throw new DatabaseConfigError(AWS_REGION_SENTENCES.outsidePartitions(value), provider);
  }
  throw new DatabaseConfigError(AWS_REGION_SENTENCES.notARegion, provider);
}

/**
 * Throws DatabaseConfigError, quoting nothing, unless `service` matches ^[a-z][a-z0-9-]{1,62}$: a service's signing
 * and endpoint name, which the caller passes and this layer never names.
 */
export function checkAwsServiceName(service: string): void {
  if (!SERVICE_NAME.test(service)) throw new DatabaseConfigError(SERVICE_REFUSED);
}

/**
 * https://<service>.<region>.<dnsSuffix>:443 through httpOrigin. The service is the name the caller passes and must
 * match ^[a-z][a-z0-9-]{1,62}$; the region must be one parseAwsRegion returns, so no hand-built value names a host
 * outside the partition's suffix. Both refusals are DatabaseConfigError and quote nothing.
 */
export function awsServiceOrigin(service: string, region: AwsRegion): HttpOrigin {
  checkAwsServiceName(service);
  if (!COMMERCIAL_REGION.test(region.name) || region.dnsSuffix !== COMMERCIAL_DNS_SUFFIX) {
    throw new DatabaseConfigError(REGION_FORGED);
  }
  return httpOrigin("https", `${service}.${region.name}.${region.dnsSuffix}`, HTTPS_PORT);
}
