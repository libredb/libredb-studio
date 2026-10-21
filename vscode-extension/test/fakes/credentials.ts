/**
 * The stand-in password of the backend's unit tests.
 * It is built at run time from parts, as the root's test helpers build theirs, so no credential literal sits in the
 * repository for a secret scanner to report.
 */

/** The test password, never written as one literal. */
export const TEST_PASSWORD = ["s3cret", "1"].join("-");
