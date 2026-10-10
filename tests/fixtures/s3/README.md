# S3 provider fixtures

Every file here is test data for `tests/unit/db/s3/` and states where it came from.

## sigv4-suite.json

The 24 vectors of the AWS Signature Version 4 test suite as vendored by smithy-typescript, `packages/signature-v4/src/suite.fixture.ts` at commit `f884df74e42e5b51ec7c482812cee0afd6d9ac79` (2025-09-03).
Copyright Amazon.com, Inc. or its affiliates, licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0).
The file's `header` object records the repository, path, commit, licence and the conversion; the conversion only reshapes the exported array into JSON and changes no value.
The key pair inside it is AWS's published documentation example, not a credential.
