# Oxia captures

Each JSON file under a set directory is one named read-only run of `tests/live/oxia-live-support.ts`, recorded against a live compose fixture by `tests/live/oxia-evidence.ts` through the real provider and adapter.
No file here is written by hand: the harness writes every capture and this README, and `tests/integration/db/oxia-provider.test.ts` replays each capture and holds it by the digest below.

| Set | Image | Digest | Captured | Command |
|---|---|---|---|---|
| 0.16.10 | `oxia/oxia:0.16.10@sha256:da5133e862715b2ea03aada42593d0cb16b7b079bbba2035f82b870a3ccfb322` | `oxia/oxia@sha256:da5133e862715b2ea03aada42593d0cb16b7b079bbba2035f82b870a3ccfb322` | 2026-10-04 | `bun tests/live/oxia-evidence.ts --target 127.0.0.1:6648 --version 0.16.10` |
| 0.17.1 | `oxia/oxia:0.17.1@sha256:165bf4f3803153f23be3ba699f6430ab1463cdeaa46e341ff32c3eaed0d1b7d6` | `oxia/oxia@sha256:165bf4f3803153f23be3ba699f6430ab1463cdeaa46e341ff32c3eaed0d1b7d6` | 2026-10-04 | `bun tests/live/oxia-evidence.ts --target 127.0.0.1:6668 --version 0.17.1` |
| 0.16.10-natural | `oxia/oxia:0.16.10@sha256:da5133e862715b2ea03aada42593d0cb16b7b079bbba2035f82b870a3ccfb322` | `oxia/oxia@sha256:da5133e862715b2ea03aada42593d0cb16b7b079bbba2035f82b870a3ccfb322` | 2026-10-04 | `bun tests/live/oxia-evidence.ts --target 127.0.0.1:6658 --version 0.16.10-natural` |
| 0.16.10-natural-blind | `oxia/oxia:0.16.10@sha256:da5133e862715b2ea03aada42593d0cb16b7b079bbba2035f82b870a3ccfb322` | `oxia/oxia@sha256:da5133e862715b2ea03aada42593d0cb16b7b079bbba2035f82b870a3ccfb322` | 2026-10-04 | `bun tests/live/oxia-evidence.ts --target 127.0.0.1:6659 --version 0.16.10-natural-blind` |
| 0.16.10-auth | `oxia/oxia:0.16.10@sha256:da5133e862715b2ea03aada42593d0cb16b7b079bbba2035f82b870a3ccfb322` | `oxia/oxia@sha256:da5133e862715b2ea03aada42593d0cb16b7b079bbba2035f82b870a3ccfb322` | 2026-10-04 | `bun tests/live/oxia-evidence.ts --target 127.0.0.1:6678 --version 0.16.10-auth --certs <a copy of the volume>` |

| File | SHA-256 |
|---|---|
| 0.16.10-auth/auth-bad-audience.json | c1f329676c1c30b89c0b3bdec325d3daab1351740aed996333b1f03b9bb38b97 |
| 0.16.10-auth/auth-bad-issuer.json | fbe1c52f0d51b9ca033962fe00908b9e6cab051edd48da7fe83d3cb4c1a0d8e1 |
| 0.16.10-auth/auth-bad-signature.json | 8f9a18fb19fc7bcbb057fafafc2f889cb366b7d6cf82b845f79689b4751844ff |
| 0.16.10-auth/auth-expired.json | 7ad9b0b0a54f34abddb9ea266969088deb7933a7f1f0445d7e48ba1f26aa5f34 |
| 0.16.10-auth/auth-good-token.json | e13486bd43e6f42136a1087c22a1e1f70583d193c31759731cda71ac7cfe009d |
| 0.16.10-auth/auth-no-token.json | 162eaa1a78d90d31fce8df5e9f2753df26251f5a4276b94555744dd108fe7278 |
| 0.16.10-auth/health-serving.json | 1b35b820dac86cba87a6d436c8e5bf8e8209fb84318f04f216207350ff917427 |
| 0.16.10-auth/probe-empty-namespace.json | 5f15dee47d5de3e85a2617a6b0fd6c43aac8e2c5db58c0fb4c0b018e41dd9c67 |
| 0.16.10-auth/tls-ip-target.json | 746ea631a6f9499f7b0e674e5d4883d168392d7db5a08a408397bb4abad0fc6a |
| 0.16.10-auth/tls-right-ca.json | 982429c6a417389d1aaec8fb52b1e8597b41e9776ffe65f95e43672c8366b7f9 |
| 0.16.10-auth/tls-unrelated-ca.json | 1b9a5e5016037fb60cf4d3fce243fea7c19c33d0f7b1825ad586e6e02eb3c1ea |
| 0.16.10-natural-blind/assignments-default.json | b344582c419a0c3281b07047ddbe4b87bcbda33ec8a3444ae51d5652b1bc4a54 |
| 0.16.10-natural-blind/health-serving.json | 62bbbd1aa98a80d42437886e23b0e24cec0fd4166f6df0403f68f566476c8fc4 |
| 0.16.10-natural-blind/list-full-walk.json | afaabf9579559ba7018928c39752994ded05aef9a2d61e53cf3ed2493c5fd857 |
| 0.16.10-natural-blind/probe-order.json | 53a88012c076577658e412f0988c36d91e59561497f52551719331b775817ce5 |
| 0.16.10-natural/assignments-default.json | c4481ea33ee3d4542f46f0f9cf23cf3dcd469d8e6fdcdd1bbbafd244939800e8 |
| 0.16.10-natural/get-ceiling.json | 1bd7e20e565222fe2e8f10b8a0a8a9cf481389e9b8b55fb08ce26b4905ae428e |
| 0.16.10-natural/get-floor.json | 091e634fe85c90436d40d43441975ee535a2cb9b7ff46e1017369dd6a4be46bc |
| 0.16.10-natural/get-higher.json | b50f392f859a65db6d9fb7d3f95fcc0376302e1385fcd5cfed1a3be152d7045f |
| 0.16.10-natural/get-lower.json | fa8e7d38f1a2b06fdfc2f313dc9d9c89de97c32030a166581fcf901443d81938 |
| 0.16.10-natural/health-serving.json | d90e26ea7c7d6b97cf4ac69588986c0aee84a9c74eaa90a5d56a7c34204261b6 |
| 0.16.10-natural/list-children-a-b.json | 7f17ae504ae172d688f608bb32928f828d3f603d1536264c06738b11f291ea81 |
| 0.16.10-natural/list-children-trail.json | 2a63d310134e0bdfc8641e4bfe3167f3f34b6cd7d54540c8814cbb202fa5d728 |
| 0.16.10-natural/list-full-walk.json | 980c3e30778632483b3e80d345f307439c0f0abdc0804712e4da849aef870b00 |
| 0.16.10-natural/list-nul-keys.json | 55a86083660b94239e97eae79374fbd503e280868a1b81322bb1799856dffb95 |
| 0.16.10-natural/list-root-level.json | d351218259dc12cfa6844ba517ae3e7888ba4d10a11b656f629e80b07ca2436b |
| 0.16.10-natural/probe-order.json | 4860a619a6695e0e386763e139040d2a42eeaa14b405067a39adb0e0479c48f5 |
| 0.16.10/assignments-default.json | e4ceb3ac98fc0dbe11cc67884b39311c79d2def63cc6af6dace5ab494bf3af8b |
| 0.16.10/assignments-unknown-namespace.json | 5715992a7b1ac632c459275993857a5e339f2799224216c7e9600a4c2b2a3489 |
| 0.16.10/conformance.json | 93667ce23cf3562ac80557717f052df369a8fb1e33bc683ed5c0250793150ac2 |
| 0.16.10/get-binary-hex.json | 145c720bcf525a8fa19e44af5617328ee92302a5802d0e42e4e70c33c085be05 |
| 0.16.10/get-binary.json | 18d3deb28aee5ca2e2ba19c0f683722aa95cfae71bdf41f6b350a2a46e4e1e36 |
| 0.16.10/get-ceiling.json | 3a2d83985db23002ead52b71cab23f07652883883f5d4a53a15a0655b88e2df2 |
| 0.16.10/get-empty.json | cdc7f04a2105012c5e5cf4b7aca49672c569757941dc65720b18ffc7468cc554 |
| 0.16.10/get-floor.json | bbcc59560f1cd15a7dc80f4773d8196fafb55d39bb8f92de6c39066f5c435472 |
| 0.16.10/get-higher.json | b3c2f80cecb02098b496d6125dc4392f045342fa2fd5bc66b9a9fe41a07ff406 |
| 0.16.10/get-json-int64.json | ad0026a1140e861f98ef358d435001efe93d7786913fb40c08caec915110295f |
| 0.16.10/get-json.json | ce08d989c0b9de2c37a6205f51f86fb10b2d10f4cc18666e5bcff67f776b0496 |
| 0.16.10/get-lower.json | cc66bfa79c9dd307a293e226c484d3ede60bd4448da05e5b7663b65952e5c051 |
| 0.16.10/get-miss.json | 3079d875ed0f2736d9bef67537d59685e5a395bf78031e6448bdc45728a508c9 |
| 0.16.10/get-over-cap.json | fa30ecebce7363635eedacf18e930b2d7cd01b174fde72867a49801eeb02d7bd |
| 0.16.10/get-partition-key.json | 3bc6bfe3dd97e72822d3fb67e633485849d520d5baaeae2039e56aac9fb11eaa |
| 0.16.10/get-protobuf-like.json | 08cd8e4395086a8e77ebaff62f4a4b138368e623732bbe0ed6c94499ea1e7216 |
| 0.16.10/get-text-100KiB.json | 1537d80c7f700a27d37e8ba136156f582a2123a2b04e90d90667dd2bbcb6e040 |
| 0.16.10/get-text-c0.json | f41b78184d9fb9bfadfeb2d55785f25a7f2fc5bce0d1332bea91bda705f12bed |
| 0.16.10/get-text-utf8.json | d0425de6b18adfbbd27879a5aeb34d3a150e6fdde85adc204b8280419f2a6d88 |
| 0.16.10/health-serving.json | 732412346e7a7b726167ed1c08848908b57b4183b363f01a691811f5963f0e5c |
| 0.16.10/list-children-a-b.json | 70290ab9d431b72e039cf0f010abd3e204ac79abb3cdcb62b7858908bbba2448 |
| 0.16.10/list-children-trail.json | 18cc2f14552b2a10ac826adb0bbc03b99ff635a2f7f2317227e2b9490f943271 |
| 0.16.10/list-first-pages.json | b727908a28c1065005506c9d78d733a30b9c6de03f5a61e13ddc7f1e1186467c |
| 0.16.10/list-nul-keys.json | 7b170f9f59285e9647951916abfc94d1146081ac3083cc8373f53550deb101be |
| 0.16.10/list-prefix-admin.json | 96fbe7d5818b307fd66b750ed2d9e876fc99c5619e682da0b95b669d73852209 |
| 0.16.10/list-root-level.json | 7c875dccd1861c041eaa8b4c7cd0901d3b0ab4630735159056c2f572fb54b9be |
| 0.16.10/probe-order.json | ef0dc39bd76b80dc3a19fd0fbb65a79e15d5786741be90ee2384fada7c7046a7 |
| 0.16.10/range-scan-budget.json | 8cada4d6841adecaac067b7890f330ec58755f0e25f216a5586515c30976124d |
| 0.16.10/range-scan-over-cap.json | 5261eca4d2cb33b6969047ea15750bcb5d7ff83b602461f55944127eabe04112 |
| 0.17.1/assignments-default.json | b2a195d2bf706741beaee0f5ab5b7a9cf177bc9d20937a61fa4b5feb5177760f |
| 0.17.1/assignments-unknown-namespace.json | fdb80fb15a1aeb43bd605438fab92d944145ec7900af8b22eaab4a75ba7394f7 |
| 0.17.1/get-binary.json | 546511ee613c21196def0b41378d4d92df725283f2e2750891dba8c77ada6734 |
| 0.17.1/get-empty.json | 257394edf598c2722574ea0cdfea3437edf28f483f23cf3f5a36031902e61253 |
| 0.17.1/get-json-int64.json | a14e0c3a5eb0028fd4bf0c33f704464e0f1e463d38abc46e32775f88f4327c16 |
| 0.17.1/get-json.json | 088ba34ef02a2ba5682c438e0a5c9bce7548b09f7a333dd6a3c06c82903ad043 |
| 0.17.1/get-over-cap.json | edb619f2bb4b9d1c7237fa2c7d0da23b0b7f7f6c98694bdcc463f24296d0ca96 |
| 0.17.1/get-protobuf-like.json | b404b40f817c9964bd6c0254fe56f9516d019370c40b4dfe8db788c95cd32351 |
| 0.17.1/get-text-100KiB.json | 921be776400248562540b36233d11719be25112142fa7176740ab221e5243ad1 |
| 0.17.1/get-text-c0.json | 61f159ab3648064aab2cc07b5c49606f87091d799e8c54150bdb0e66e827a043 |
| 0.17.1/get-text-utf8.json | 6bfdd4f20e381b9a90474c0ca666b630473d7a03feba81d78589238d24fb0e83 |
| 0.17.1/health-serving.json | 65c517ba21d19aed3090dd6972b8b4ca6eb4c9758c440cad12b00dd6db218070 |
| 0.17.1/list-full-walk.json | dfbbad04f178a72d8c2e918adbe4f6e242296f885fe0cba1649f5a7ca4908ad6 |
| 0.17.1/list-prefix-admin.json | c177b9c2cf3654d37ba85d6e2ad7426b8b3b30dd23b1ce2cd2f0bb359c8d12ab |
| 0.17.1/probe-order.json | e97020ac1adabf42f3f0cb62d73308899275bc4c5fa31ee48aaf699f5f0691f9 |
| 0.17.1/range-scan-budget.json | 5072e0cc26fe33f5c2fc32608eb9f4cbf6a2b900bb43d75d95286ae27dd2cc5d |
| 0.17.1/range-scan-over-cap.json | 45176996b52b24b2cf12e12dd83bb334f5ce12234e76a13cb81d714ee1cebd63 |

`xxh3-vectors.json` and `order-vectors.json` are vectors with their own provenance, not captures.
