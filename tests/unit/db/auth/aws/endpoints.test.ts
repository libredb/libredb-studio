/**
 * The commercial partition's row: parseAwsRegion against AWS's own regionRegex for "aws", the three refusals and
 * when a refused value is quoted, and awsServiceOrigin's https origin and its service-name rule.
 */
import { describe, expect, test } from "bun:test";
import {
  AWS_REGION_SENTENCES,
  AWS_SIGNING_REGION,
  type AwsRegion,
  awsServiceOrigin,
  parseAwsRegion,
} from "@/lib/db/auth/aws/endpoints";
import { DatabaseConfigError } from "@/lib/db/errors";

function refusal(run: () => unknown): DatabaseConfigError {
  try {
    run();
  } catch (error) {
    if (error instanceof DatabaseConfigError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("parseAwsRegion", () => {
  test.each([
    "us-east-1",
    "us-west-2",
    "eu-central-1",
    "eu-south-2",
    "ap-southeast-5",
    "sa-east-1",
    "ca-west-1",
    "me-central-1",
    "af-south-1",
    "il-central-1",
    "mx-central-1",
  ])("%s is a commercial region", (name) => {
    expect(parseAwsRegion(name, "postgres")).toEqual({ name, dnsSuffix: "amazonaws.com" });
  });

  test.each([undefined, "", "   ", "\t\n"])("%p is missing", (value) => {
    const error = refusal(() => parseAwsRegion(value, "postgres"));
    expect(error.message).toBe(AWS_REGION_SENTENCES.missing);
    expect(error.provider).toBe("postgres");
  });

  test.each(["cn-north-1", "cn-northwest-1", "us-gov-west-1", "us-iso-east-1", "xx-north-1"])(
    "%s is outside the partitions and quoted",
    (value) => {
      const error = refusal(() => parseAwsRegion(value, "postgres"));
      expect(error.message).toBe(AWS_REGION_SENTENCES.outsidePartitions(value));
      expect(error.message).toContain(value);
      expect(error.provider).toBe("postgres");
    },
  );

  test("a refusal without a provider carries none", () => {
    expect(refusal(() => parseAwsRegion("cn-north-1", undefined)).provider).toBeUndefined();
  });

  test.each([
    ["local", "local"],
    ["a secret access key", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"],
    ["a 40-character lower-case secret", "abcdefghijklmnopqrstuvwxyzabcdefghijklmn"],
    ["a padded region", " us-east-2"],
    ["a region with a host after it", "us-east-1.evil.example"],
    ["markup", "<script>us-east-1</script>"],
    ["a region name with three trailing digits", "cn-north-123"],
    ["an upper-case region name", "CN-NORTH-1"],
    // The European Sovereign Cloud's region has four letters before its first hyphen, so it is not region-shaped.
    ["the European Sovereign Cloud's region", "eusc-de-east-1"],
  ])("%s is not a region and is not quoted", (_label, value) => {
    const error = refusal(() => parseAwsRegion(value, "postgres"));
    expect(error.message).toBe(AWS_REGION_SENTENCES.notARegion);
    expect(error.message).not.toContain(value);
    expect(error.provider).toBe("postgres");
  });

  test("the sentences", () => {
    expect(AWS_REGION_SENTENCES.missing).toBe("The AWS region is required, such as us-east-1");
    expect(AWS_REGION_SENTENCES.outsidePartitions("cn-north-1")).toBe(
      "The AWS region cn-north-1 is outside the commercial partition (aws), the only one this version supports",
    );
    expect(AWS_REGION_SENTENCES.notARegion).toBe("The AWS region is not an AWS region name, such as us-east-1");
  });
});

describe("AWS_SIGNING_REGION", () => {
  test("takes any partition's or emulator's region and refuses what would break a credential scope", () => {
    for (const ok of ["us-east-1", "cn-north-1", "local", "garage", "A_b-9", "x".repeat(64)]) {
      expect(AWS_SIGNING_REGION.test(ok)).toBe(true);
    }
    for (const bad of ["", "x".repeat(65), "us east 1", "us/east", "us-east-1\n"]) {
      expect(AWS_SIGNING_REGION.test(bad)).toBe(false);
    }
  });
});

describe("awsServiceOrigin", () => {
  const region = parseAwsRegion("eu-west-1", undefined);

  test("is https://<service>.<region>.amazonaws.com:443", () => {
    expect(awsServiceOrigin("dynamodb", parseAwsRegion("us-east-1", undefined))).toEqual({
      scheme: "https",
      host: "dynamodb.us-east-1.amazonaws.com",
      port: 443,
    });
    expect(awsServiceOrigin("athena", region)).toEqual({
      scheme: "https",
      host: "athena.eu-west-1.amazonaws.com",
      port: 443,
    });
    expect(awsServiceOrigin("redshift-serverless", region).host).toBe("redshift-serverless.eu-west-1.amazonaws.com");
  });

  test.each(["", "a", "Dynamodb", "1st", "-x", "dynamo.db", "dynamo_db", "dynamodb/", `a${"b".repeat(63)}`])(
    "refuses the service name %p",
    (service) => {
      expect(refusal(() => awsServiceOrigin(service, region)).message).toBe(
        "The AWS service name must be a lower-case letter followed by 1 to 62 lower-case letters, digits or hyphens",
      );
    },
  );

  test("takes a 63-character service name", () => {
    const service = `a${"b".repeat(62)}`;
    expect(awsServiceOrigin(service, region).host).toBe(`${service}.eu-west-1.amazonaws.com`);
  });

  test.each<[string, AwsRegion]>([
    ["a name parseAwsRegion refuses", { name: "cn-north-1", dnsSuffix: "amazonaws.com" }],
    ["a name that adds a host", { name: "us-east-1.evil.example", dnsSuffix: "amazonaws.com" }],
    ["another DNS suffix", { name: "us-east-1", dnsSuffix: "evil.example" }],
  ])("refuses a region that is not the commercial row's: %s", (_label, forged) => {
    expect(refusal(() => awsServiceOrigin("dynamodb", forged)).message).toBe(
      "The AWS region is not one parseAwsRegion returned for the commercial partition",
    );
  });
});
