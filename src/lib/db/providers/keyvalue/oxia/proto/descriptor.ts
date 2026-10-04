// GENERATED FILE - do not edit. Run: node scripts/generate-oxia-descriptor.mjs
//
// Source: Oxia's client.proto at v0.16.10 and grpc/health/v1/health.proto, vendored in this directory (README.md),
// via scripts/generate-oxia-descriptor.mjs. tests/unit/db/oxia/descriptor.test.ts fails on drift.

import type { fromJSON } from "@grpc/proto-loader";

// Asserted, not annotated: protobufjs 7.6.6's typings omit fields its own toJSON writes (see the generator).
// biome-ignore format: generated; the literal is JSON.stringify output, so a proto upgrade diffs line by line.
export const OXIA_DESCRIPTOR = {
  "nested": {
    "io": {
      "nested": {
        "oxia": {
          "nested": {
            "proto": {
              "nested": {
                "v1": {
                  "options": {
                    "go_package": "github.com/oxia-db/oxia/common/proto",
                    "java_multiple_files": true
                  },
                  "nested": {
                    "OxiaClient": {
                      "methods": {
                        "GetShardAssignments": {
                          "requestType": "ShardAssignmentsRequest",
                          "responseType": "ShardAssignments",
                          "responseStream": true
                        },
                        "Write": {
                          "requestType": "WriteRequest",
                          "responseType": "WriteResponse"
                        },
                        "WriteStream": {
                          "requestType": "WriteRequest",
                          "requestStream": true,
                          "responseType": "WriteResponse",
                          "responseStream": true
                        },
                        "Read": {
                          "requestType": "ReadRequest",
                          "responseType": "ReadResponse",
                          "responseStream": true
                        },
                        "List": {
                          "requestType": "ListRequest",
                          "responseType": "ListResponse",
                          "responseStream": true
                        },
                        "RangeScan": {
                          "requestType": "RangeScanRequest",
                          "responseType": "RangeScanResponse",
                          "responseStream": true
                        },
                        "GetSequenceUpdates": {
                          "requestType": "GetSequenceUpdatesRequest",
                          "responseType": "GetSequenceUpdatesResponse",
                          "responseStream": true
                        },
                        "GetNotifications": {
                          "requestType": "NotificationsRequest",
                          "responseType": "NotificationBatch",
                          "responseStream": true
                        },
                        "CreateSession": {
                          "requestType": "CreateSessionRequest",
                          "responseType": "CreateSessionResponse"
                        },
                        "KeepAlive": {
                          "requestType": "SessionHeartbeat",
                          "responseType": "KeepAliveResponse"
                        },
                        "CloseSession": {
                          "requestType": "CloseSessionRequest",
                          "responseType": "CloseSessionResponse"
                        }
                      }
                    },
                    "ShardAssignmentsRequest": {
                      "fields": {
                        "namespace": {
                          "type": "string",
                          "id": 1
                        }
                      }
                    },
                    "ShardAssignments": {
                      "fields": {
                        "namespaces": {
                          "keyType": "string",
                          "type": "NamespaceShardsAssignment",
                          "id": 1
                        },
                        "allowed_authorities": {
                          "rule": "repeated",
                          "type": "string",
                          "id": 2
                        }
                      }
                    },
                    "NamespaceShardsAssignment": {
                      "fields": {
                        "assignments": {
                          "rule": "repeated",
                          "type": "ShardAssignment",
                          "id": 1
                        },
                        "shard_key_router": {
                          "type": "ShardKeyRouter",
                          "id": 2
                        }
                      }
                    },
                    "ShardAssignment": {
                      "oneofs": {
                        "shard_boundaries": {
                          "oneof": [
                            "int32_hash_range"
                          ]
                        }
                      },
                      "fields": {
                        "shard": {
                          "type": "int64",
                          "id": 1
                        },
                        "leader": {
                          "type": "string",
                          "id": 2
                        },
                        "int32_hash_range": {
                          "type": "Int32HashRange",
                          "id": 3
                        }
                      }
                    },
                    "ShardKeyRouter": {
                      "values": {
                        "UNKNOWN": 0,
                        "XXHASH3": 1
                      }
                    },
                    "Int32HashRange": {
                      "fields": {
                        "min_hash_inclusive": {
                          "type": "fixed32",
                          "id": 1
                        },
                        "max_hash_inclusive": {
                          "type": "fixed32",
                          "id": 2
                        }
                      }
                    },
                    "WriteRequest": {
                      "oneofs": {
                        "_shard": {
                          "oneof": [
                            "shard"
                          ]
                        }
                      },
                      "fields": {
                        "shard": {
                          "type": "int64",
                          "id": 1,
                          "options": {
                            "proto3_optional": true
                          }
                        },
                        "puts": {
                          "rule": "repeated",
                          "type": "PutRequest",
                          "id": 2
                        },
                        "deletes": {
                          "rule": "repeated",
                          "type": "DeleteRequest",
                          "id": 3
                        },
                        "delete_ranges": {
                          "rule": "repeated",
                          "type": "DeleteRangeRequest",
                          "id": 4
                        }
                      }
                    },
                    "WriteResponse": {
                      "fields": {
                        "puts": {
                          "rule": "repeated",
                          "type": "PutResponse",
                          "id": 1
                        },
                        "deletes": {
                          "rule": "repeated",
                          "type": "DeleteResponse",
                          "id": 2
                        },
                        "delete_ranges": {
                          "rule": "repeated",
                          "type": "DeleteRangeResponse",
                          "id": 3
                        }
                      }
                    },
                    "ReadRequest": {
                      "oneofs": {
                        "_shard": {
                          "oneof": [
                            "shard"
                          ]
                        }
                      },
                      "fields": {
                        "shard": {
                          "type": "int64",
                          "id": 1,
                          "options": {
                            "proto3_optional": true
                          }
                        },
                        "gets": {
                          "rule": "repeated",
                          "type": "GetRequest",
                          "id": 2
                        }
                      }
                    },
                    "ReadResponse": {
                      "fields": {
                        "gets": {
                          "rule": "repeated",
                          "type": "GetResponse",
                          "id": 1
                        }
                      }
                    },
                    "SecondaryIndex": {
                      "fields": {
                        "index_name": {
                          "type": "string",
                          "id": 1
                        },
                        "secondary_key": {
                          "type": "string",
                          "id": 2
                        }
                      }
                    },
                    "PutRequest": {
                      "oneofs": {
                        "_expected_version_id": {
                          "oneof": [
                            "expected_version_id"
                          ]
                        },
                        "_session_id": {
                          "oneof": [
                            "session_id"
                          ]
                        },
                        "_client_identity": {
                          "oneof": [
                            "client_identity"
                          ]
                        },
                        "_partition_key": {
                          "oneof": [
                            "partition_key"
                          ]
                        },
                        "_override_version_id": {
                          "oneof": [
                            "override_version_id"
                          ]
                        },
                        "_override_modifications_count": {
                          "oneof": [
                            "override_modifications_count"
                          ]
                        }
                      },
                      "fields": {
                        "key": {
                          "type": "string",
                          "id": 1
                        },
                        "value": {
                          "type": "bytes",
                          "id": 2
                        },
                        "expected_version_id": {
                          "type": "int64",
                          "id": 3,
                          "options": {
                            "proto3_optional": true
                          }
                        },
                        "session_id": {
                          "type": "int64",
                          "id": 4,
                          "options": {
                            "proto3_optional": true
                          }
                        },
                        "client_identity": {
                          "type": "string",
                          "id": 5,
                          "options": {
                            "proto3_optional": true
                          }
                        },
                        "partition_key": {
                          "type": "string",
                          "id": 6,
                          "options": {
                            "proto3_optional": true
                          }
                        },
                        "sequence_key_delta": {
                          "rule": "repeated",
                          "type": "uint64",
                          "id": 7
                        },
                        "secondary_indexes": {
                          "rule": "repeated",
                          "type": "SecondaryIndex",
                          "id": 8
                        },
                        "override_version_id": {
                          "type": "int64",
                          "id": 9,
                          "options": {
                            "proto3_optional": true
                          }
                        },
                        "override_modifications_count": {
                          "type": "int64",
                          "id": 10,
                          "options": {
                            "proto3_optional": true
                          }
                        }
                      }
                    },
                    "PutResponse": {
                      "oneofs": {
                        "_key": {
                          "oneof": [
                            "key"
                          ]
                        }
                      },
                      "fields": {
                        "status": {
                          "type": "Status",
                          "id": 1
                        },
                        "version": {
                          "type": "Version",
                          "id": 2
                        },
                        "key": {
                          "type": "string",
                          "id": 3,
                          "options": {
                            "proto3_optional": true
                          }
                        }
                      }
                    },
                    "DeleteRequest": {
                      "oneofs": {
                        "_expected_version_id": {
                          "oneof": [
                            "expected_version_id"
                          ]
                        }
                      },
                      "fields": {
                        "key": {
                          "type": "string",
                          "id": 1
                        },
                        "expected_version_id": {
                          "type": "int64",
                          "id": 2,
                          "options": {
                            "proto3_optional": true
                          }
                        }
                      }
                    },
                    "DeleteResponse": {
                      "fields": {
                        "status": {
                          "type": "Status",
                          "id": 1
                        }
                      }
                    },
                    "KeyComparisonType": {
                      "values": {
                        "EQUAL": 0,
                        "FLOOR": 1,
                        "CEILING": 2,
                        "LOWER": 3,
                        "HIGHER": 4
                      }
                    },
                    "GetRequest": {
                      "oneofs": {
                        "_secondary_index_name": {
                          "oneof": [
                            "secondary_index_name"
                          ]
                        }
                      },
                      "fields": {
                        "key": {
                          "type": "string",
                          "id": 1
                        },
                        "include_value": {
                          "type": "bool",
                          "id": 2
                        },
                        "comparison_type": {
                          "type": "KeyComparisonType",
                          "id": 3
                        },
                        "secondary_index_name": {
                          "type": "string",
                          "id": 4,
                          "options": {
                            "proto3_optional": true
                          }
                        }
                      }
                    },
                    "GetResponse": {
                      "oneofs": {
                        "_value": {
                          "oneof": [
                            "value"
                          ]
                        },
                        "_key": {
                          "oneof": [
                            "key"
                          ]
                        },
                        "_secondary_index_key": {
                          "oneof": [
                            "secondary_index_key"
                          ]
                        }
                      },
                      "fields": {
                        "status": {
                          "type": "Status",
                          "id": 1
                        },
                        "version": {
                          "type": "Version",
                          "id": 2
                        },
                        "value": {
                          "type": "bytes",
                          "id": 3,
                          "options": {
                            "proto3_optional": true
                          }
                        },
                        "key": {
                          "type": "string",
                          "id": 4,
                          "options": {
                            "proto3_optional": true
                          }
                        },
                        "secondary_index_key": {
                          "type": "string",
                          "id": 5,
                          "options": {
                            "proto3_optional": true
                          }
                        }
                      }
                    },
                    "DeleteRangeRequest": {
                      "fields": {
                        "start_inclusive": {
                          "type": "string",
                          "id": 1
                        },
                        "end_exclusive": {
                          "type": "string",
                          "id": 2
                        }
                      }
                    },
                    "DeleteRangeResponse": {
                      "fields": {
                        "status": {
                          "type": "Status",
                          "id": 1
                        }
                      }
                    },
                    "ListRequest": {
                      "oneofs": {
                        "_shard": {
                          "oneof": [
                            "shard"
                          ]
                        },
                        "_secondary_index_name": {
                          "oneof": [
                            "secondary_index_name"
                          ]
                        }
                      },
                      "fields": {
                        "shard": {
                          "type": "int64",
                          "id": 1,
                          "options": {
                            "proto3_optional": true
                          }
                        },
                        "start_inclusive": {
                          "type": "string",
                          "id": 2
                        },
                        "end_exclusive": {
                          "type": "string",
                          "id": 3
                        },
                        "secondary_index_name": {
                          "type": "string",
                          "id": 4,
                          "options": {
                            "proto3_optional": true
                          }
                        },
                        "include_internal_keys": {
                          "type": "bool",
                          "id": 5
                        }
                      }
                    },
                    "ListResponse": {
                      "fields": {
                        "keys": {
                          "rule": "repeated",
                          "type": "string",
                          "id": 1
                        }
                      }
                    },
                    "RangeScanRequest": {
                      "oneofs": {
                        "_shard": {
                          "oneof": [
                            "shard"
                          ]
                        },
                        "_secondary_index_name": {
                          "oneof": [
                            "secondary_index_name"
                          ]
                        }
                      },
                      "fields": {
                        "shard": {
                          "type": "int64",
                          "id": 1,
                          "options": {
                            "proto3_optional": true
                          }
                        },
                        "start_inclusive": {
                          "type": "string",
                          "id": 2
                        },
                        "end_exclusive": {
                          "type": "string",
                          "id": 3
                        },
                        "secondary_index_name": {
                          "type": "string",
                          "id": 4,
                          "options": {
                            "proto3_optional": true
                          }
                        },
                        "include_internal_keys": {
                          "type": "bool",
                          "id": 5
                        }
                      }
                    },
                    "RangeScanResponse": {
                      "fields": {
                        "records": {
                          "rule": "repeated",
                          "type": "GetResponse",
                          "id": 1
                        }
                      }
                    },
                    "GetSequenceUpdatesRequest": {
                      "fields": {
                        "shard": {
                          "type": "int64",
                          "id": 1
                        },
                        "key": {
                          "type": "string",
                          "id": 2
                        }
                      }
                    },
                    "GetSequenceUpdatesResponse": {
                      "fields": {
                        "highest_sequence_key": {
                          "type": "string",
                          "id": 1
                        }
                      }
                    },
                    "Version": {
                      "oneofs": {
                        "_session_id": {
                          "oneof": [
                            "session_id"
                          ]
                        },
                        "_client_identity": {
                          "oneof": [
                            "client_identity"
                          ]
                        }
                      },
                      "fields": {
                        "version_id": {
                          "type": "int64",
                          "id": 1
                        },
                        "modifications_count": {
                          "type": "int64",
                          "id": 2
                        },
                        "created_timestamp": {
                          "type": "fixed64",
                          "id": 3
                        },
                        "modified_timestamp": {
                          "type": "fixed64",
                          "id": 4
                        },
                        "session_id": {
                          "type": "int64",
                          "id": 5,
                          "options": {
                            "proto3_optional": true
                          }
                        },
                        "client_identity": {
                          "type": "string",
                          "id": 6,
                          "options": {
                            "proto3_optional": true
                          }
                        }
                      }
                    },
                    "Status": {
                      "values": {
                        "OK": 0,
                        "KEY_NOT_FOUND": 1,
                        "UNEXPECTED_VERSION_ID": 2,
                        "SESSION_DOES_NOT_EXIST": 3
                      }
                    },
                    "CreateSessionRequest": {
                      "fields": {
                        "shard": {
                          "type": "int64",
                          "id": 1
                        },
                        "session_timeout_ms": {
                          "type": "uint32",
                          "id": 2
                        },
                        "client_identity": {
                          "type": "string",
                          "id": 3
                        }
                      }
                    },
                    "CreateSessionResponse": {
                      "fields": {
                        "session_id": {
                          "type": "int64",
                          "id": 1
                        }
                      }
                    },
                    "SessionHeartbeat": {
                      "fields": {
                        "shard": {
                          "type": "int64",
                          "id": 1
                        },
                        "session_id": {
                          "type": "int64",
                          "id": 2
                        }
                      }
                    },
                    "KeepAliveResponse": {
                      "fields": {}
                    },
                    "CloseSessionRequest": {
                      "fields": {
                        "shard": {
                          "type": "int64",
                          "id": 1
                        },
                        "session_id": {
                          "type": "int64",
                          "id": 2
                        }
                      }
                    },
                    "CloseSessionResponse": {
                      "fields": {}
                    },
                    "NotificationType": {
                      "values": {
                        "KEY_CREATED": 0,
                        "KEY_MODIFIED": 1,
                        "KEY_DELETED": 2,
                        "KEY_RANGE_DELETED": 3
                      }
                    },
                    "NotificationsRequest": {
                      "oneofs": {
                        "_start_offset_exclusive": {
                          "oneof": [
                            "start_offset_exclusive"
                          ]
                        }
                      },
                      "fields": {
                        "shard": {
                          "type": "int64",
                          "id": 1
                        },
                        "start_offset_exclusive": {
                          "type": "int64",
                          "id": 2,
                          "options": {
                            "proto3_optional": true
                          }
                        }
                      }
                    },
                    "NotificationBatch": {
                      "fields": {
                        "shard": {
                          "type": "int64",
                          "id": 1
                        },
                        "offset": {
                          "type": "int64",
                          "id": 2
                        },
                        "timestamp": {
                          "type": "fixed64",
                          "id": 3
                        },
                        "notifications": {
                          "keyType": "string",
                          "type": "Notification",
                          "id": 4
                        }
                      }
                    },
                    "Notification": {
                      "oneofs": {
                        "_version_id": {
                          "oneof": [
                            "version_id"
                          ]
                        },
                        "_key_range_last": {
                          "oneof": [
                            "key_range_last"
                          ]
                        }
                      },
                      "fields": {
                        "type": {
                          "type": "NotificationType",
                          "id": 1
                        },
                        "version_id": {
                          "type": "int64",
                          "id": 2,
                          "options": {
                            "proto3_optional": true
                          }
                        },
                        "key_range_last": {
                          "type": "string",
                          "id": 3,
                          "options": {
                            "proto3_optional": true
                          }
                        }
                      }
                    },
                    "LeaderHint": {
                      "fields": {
                        "shard": {
                          "type": "int64",
                          "id": 1
                        },
                        "leader_address": {
                          "type": "string",
                          "id": 2
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "grpc": {
      "nested": {
        "health": {
          "nested": {
            "v1": {
              "options": {
                "csharp_namespace": "Grpc.Health.V1",
                "go_package": "google.golang.org/grpc/health/grpc_health_v1",
                "java_multiple_files": true,
                "java_outer_classname": "HealthProto",
                "java_package": "io.grpc.health.v1",
                "objc_class_prefix": "GrpcHealthV1"
              },
              "nested": {
                "HealthCheckRequest": {
                  "fields": {
                    "service": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "HealthCheckResponse": {
                  "fields": {
                    "status": {
                      "type": "ServingStatus",
                      "id": 1
                    }
                  },
                  "nested": {
                    "ServingStatus": {
                      "values": {
                        "UNKNOWN": 0,
                        "SERVING": 1,
                        "NOT_SERVING": 2,
                        "SERVICE_UNKNOWN": 3
                      }
                    }
                  }
                },
                "HealthListRequest": {
                  "fields": {}
                },
                "HealthListResponse": {
                  "fields": {
                    "statuses": {
                      "keyType": "string",
                      "type": "HealthCheckResponse",
                      "id": 1
                    }
                  }
                },
                "Health": {
                  "methods": {
                    "Check": {
                      "requestType": "HealthCheckRequest",
                      "responseType": "HealthCheckResponse"
                    },
                    "List": {
                      "requestType": "HealthListRequest",
                      "responseType": "HealthListResponse"
                    },
                    "Watch": {
                      "requestType": "HealthCheckRequest",
                      "responseType": "HealthCheckResponse",
                      "responseStream": true
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
} as Parameters<typeof fromJSON>[0];
