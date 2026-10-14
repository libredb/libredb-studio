// GENERATED FILE - do not edit. Run: node scripts/generate-spark-descriptor.mjs
//
// Source: the apache/spark v4.2.0 Spark Connect .proto files vendored in this directory (README.md), via
// scripts/generate-spark-descriptor.mjs. tests/unit/db/spark/descriptor.test.ts fails on drift.

import type { fromJSON } from "@grpc/proto-loader";

// Asserted, not annotated: protobufjs 7.6.6's typings omit fields its own toJSON writes (see the generator).
// biome-ignore format: generated; the literal is JSON.stringify output, so a proto upgrade diffs line by line.
export const SPARK_DESCRIPTOR = {
  "nested": {
    "spark": {
      "nested": {
        "connect": {
          "options": {
            "java_multiple_files": true,
            "java_package": "org.apache.spark.connect.proto",
            "go_package": "internal/generated"
          },
          "nested": {
            "Plan": {
              "oneofs": {
                "op_type": {
                  "oneof": [
                    "root",
                    "command",
                    "compressed_operation"
                  ]
                }
              },
              "fields": {
                "root": {
                  "type": "Relation",
                  "id": 1
                },
                "command": {
                  "type": "Command",
                  "id": 2
                },
                "compressed_operation": {
                  "type": "CompressedOperation",
                  "id": 3
                }
              },
              "nested": {
                "CompressedOperation": {
                  "fields": {
                    "data": {
                      "type": "bytes",
                      "id": 1
                    },
                    "op_type": {
                      "type": "OpType",
                      "id": 2
                    },
                    "compression_codec": {
                      "type": "CompressionCodec",
                      "id": 3
                    }
                  },
                  "nested": {
                    "OpType": {
                      "values": {
                        "OP_TYPE_UNSPECIFIED": 0,
                        "OP_TYPE_RELATION": 1,
                        "OP_TYPE_COMMAND": 2
                      }
                    }
                  }
                }
              }
            },
            "CompressionCodec": {
              "values": {
                "COMPRESSION_CODEC_UNSPECIFIED": 0,
                "COMPRESSION_CODEC_ZSTD": 1
              }
            },
            "UserContext": {
              "fields": {
                "user_id": {
                  "type": "string",
                  "id": 1
                },
                "user_name": {
                  "type": "string",
                  "id": 2
                },
                "extensions": {
                  "rule": "repeated",
                  "type": "google.protobuf.Any",
                  "id": 999
                }
              }
            },
            "AnalyzePlanRequest": {
              "oneofs": {
                "_client_observed_server_side_session_id": {
                  "oneof": [
                    "client_observed_server_side_session_id"
                  ]
                },
                "_client_type": {
                  "oneof": [
                    "client_type"
                  ]
                },
                "analyze": {
                  "oneof": [
                    "schema",
                    "explain",
                    "tree_string",
                    "is_local",
                    "is_streaming",
                    "input_files",
                    "spark_version",
                    "ddl_parse",
                    "same_semantics",
                    "semantic_hash",
                    "persist",
                    "unpersist",
                    "get_storage_level",
                    "json_to_ddl"
                  ]
                }
              },
              "fields": {
                "session_id": {
                  "type": "string",
                  "id": 1
                },
                "client_observed_server_side_session_id": {
                  "type": "string",
                  "id": 17,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "user_context": {
                  "type": "UserContext",
                  "id": 2
                },
                "client_type": {
                  "type": "string",
                  "id": 3,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "schema": {
                  "type": "Schema",
                  "id": 4
                },
                "explain": {
                  "type": "Explain",
                  "id": 5
                },
                "tree_string": {
                  "type": "TreeString",
                  "id": 6
                },
                "is_local": {
                  "type": "IsLocal",
                  "id": 7
                },
                "is_streaming": {
                  "type": "IsStreaming",
                  "id": 8
                },
                "input_files": {
                  "type": "InputFiles",
                  "id": 9
                },
                "spark_version": {
                  "type": "SparkVersion",
                  "id": 10
                },
                "ddl_parse": {
                  "type": "DDLParse",
                  "id": 11
                },
                "same_semantics": {
                  "type": "SameSemantics",
                  "id": 12
                },
                "semantic_hash": {
                  "type": "SemanticHash",
                  "id": 13
                },
                "persist": {
                  "type": "Persist",
                  "id": 14
                },
                "unpersist": {
                  "type": "Unpersist",
                  "id": 15
                },
                "get_storage_level": {
                  "type": "GetStorageLevel",
                  "id": 16
                },
                "json_to_ddl": {
                  "type": "JsonToDDL",
                  "id": 18
                }
              },
              "nested": {
                "Schema": {
                  "fields": {
                    "plan": {
                      "type": "Plan",
                      "id": 1
                    }
                  }
                },
                "Explain": {
                  "fields": {
                    "plan": {
                      "type": "Plan",
                      "id": 1
                    },
                    "explain_mode": {
                      "type": "ExplainMode",
                      "id": 2
                    }
                  },
                  "nested": {
                    "ExplainMode": {
                      "values": {
                        "EXPLAIN_MODE_UNSPECIFIED": 0,
                        "EXPLAIN_MODE_SIMPLE": 1,
                        "EXPLAIN_MODE_EXTENDED": 2,
                        "EXPLAIN_MODE_CODEGEN": 3,
                        "EXPLAIN_MODE_COST": 4,
                        "EXPLAIN_MODE_FORMATTED": 5
                      }
                    }
                  }
                },
                "TreeString": {
                  "oneofs": {
                    "_level": {
                      "oneof": [
                        "level"
                      ]
                    }
                  },
                  "fields": {
                    "plan": {
                      "type": "Plan",
                      "id": 1
                    },
                    "level": {
                      "type": "int32",
                      "id": 2,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "IsLocal": {
                  "fields": {
                    "plan": {
                      "type": "Plan",
                      "id": 1
                    }
                  }
                },
                "IsStreaming": {
                  "fields": {
                    "plan": {
                      "type": "Plan",
                      "id": 1
                    }
                  }
                },
                "InputFiles": {
                  "fields": {
                    "plan": {
                      "type": "Plan",
                      "id": 1
                    }
                  }
                },
                "SparkVersion": {
                  "fields": {}
                },
                "DDLParse": {
                  "fields": {
                    "ddl_string": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "SameSemantics": {
                  "fields": {
                    "target_plan": {
                      "type": "Plan",
                      "id": 1
                    },
                    "other_plan": {
                      "type": "Plan",
                      "id": 2
                    }
                  }
                },
                "SemanticHash": {
                  "fields": {
                    "plan": {
                      "type": "Plan",
                      "id": 1
                    }
                  }
                },
                "Persist": {
                  "oneofs": {
                    "_storage_level": {
                      "oneof": [
                        "storage_level"
                      ]
                    }
                  },
                  "fields": {
                    "relation": {
                      "type": "Relation",
                      "id": 1
                    },
                    "storage_level": {
                      "type": "StorageLevel",
                      "id": 2,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "Unpersist": {
                  "oneofs": {
                    "_blocking": {
                      "oneof": [
                        "blocking"
                      ]
                    }
                  },
                  "fields": {
                    "relation": {
                      "type": "Relation",
                      "id": 1
                    },
                    "blocking": {
                      "type": "bool",
                      "id": 2,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "GetStorageLevel": {
                  "fields": {
                    "relation": {
                      "type": "Relation",
                      "id": 1
                    }
                  }
                },
                "JsonToDDL": {
                  "fields": {
                    "json_string": {
                      "type": "string",
                      "id": 1
                    }
                  }
                }
              }
            },
            "AnalyzePlanResponse": {
              "oneofs": {
                "result": {
                  "oneof": [
                    "schema",
                    "explain",
                    "tree_string",
                    "is_local",
                    "is_streaming",
                    "input_files",
                    "spark_version",
                    "ddl_parse",
                    "same_semantics",
                    "semantic_hash",
                    "persist",
                    "unpersist",
                    "get_storage_level",
                    "json_to_ddl"
                  ]
                }
              },
              "fields": {
                "session_id": {
                  "type": "string",
                  "id": 1
                },
                "server_side_session_id": {
                  "type": "string",
                  "id": 15
                },
                "schema": {
                  "type": "Schema",
                  "id": 2
                },
                "explain": {
                  "type": "Explain",
                  "id": 3
                },
                "tree_string": {
                  "type": "TreeString",
                  "id": 4
                },
                "is_local": {
                  "type": "IsLocal",
                  "id": 5
                },
                "is_streaming": {
                  "type": "IsStreaming",
                  "id": 6
                },
                "input_files": {
                  "type": "InputFiles",
                  "id": 7
                },
                "spark_version": {
                  "type": "SparkVersion",
                  "id": 8
                },
                "ddl_parse": {
                  "type": "DDLParse",
                  "id": 9
                },
                "same_semantics": {
                  "type": "SameSemantics",
                  "id": 10
                },
                "semantic_hash": {
                  "type": "SemanticHash",
                  "id": 11
                },
                "persist": {
                  "type": "Persist",
                  "id": 12
                },
                "unpersist": {
                  "type": "Unpersist",
                  "id": 13
                },
                "get_storage_level": {
                  "type": "GetStorageLevel",
                  "id": 14
                },
                "json_to_ddl": {
                  "type": "JsonToDDL",
                  "id": 16
                }
              },
              "nested": {
                "Schema": {
                  "fields": {
                    "schema": {
                      "type": "DataType",
                      "id": 1
                    }
                  }
                },
                "Explain": {
                  "fields": {
                    "explain_string": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "TreeString": {
                  "fields": {
                    "tree_string": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "IsLocal": {
                  "fields": {
                    "is_local": {
                      "type": "bool",
                      "id": 1
                    }
                  }
                },
                "IsStreaming": {
                  "fields": {
                    "is_streaming": {
                      "type": "bool",
                      "id": 1
                    }
                  }
                },
                "InputFiles": {
                  "fields": {
                    "files": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "SparkVersion": {
                  "fields": {
                    "version": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "DDLParse": {
                  "fields": {
                    "parsed": {
                      "type": "DataType",
                      "id": 1
                    }
                  }
                },
                "SameSemantics": {
                  "fields": {
                    "result": {
                      "type": "bool",
                      "id": 1
                    }
                  }
                },
                "SemanticHash": {
                  "fields": {
                    "result": {
                      "type": "int32",
                      "id": 1
                    }
                  }
                },
                "Persist": {
                  "fields": {}
                },
                "Unpersist": {
                  "fields": {}
                },
                "GetStorageLevel": {
                  "fields": {
                    "storage_level": {
                      "type": "StorageLevel",
                      "id": 1
                    }
                  }
                },
                "JsonToDDL": {
                  "fields": {
                    "ddl_string": {
                      "type": "string",
                      "id": 1
                    }
                  }
                }
              }
            },
            "ExecutePlanRequest": {
              "oneofs": {
                "_client_observed_server_side_session_id": {
                  "oneof": [
                    "client_observed_server_side_session_id"
                  ]
                },
                "_operation_id": {
                  "oneof": [
                    "operation_id"
                  ]
                },
                "_client_type": {
                  "oneof": [
                    "client_type"
                  ]
                }
              },
              "fields": {
                "session_id": {
                  "type": "string",
                  "id": 1
                },
                "client_observed_server_side_session_id": {
                  "type": "string",
                  "id": 8,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "user_context": {
                  "type": "UserContext",
                  "id": 2
                },
                "operation_id": {
                  "type": "string",
                  "id": 6,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "plan": {
                  "type": "Plan",
                  "id": 3
                },
                "client_type": {
                  "type": "string",
                  "id": 4,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "request_options": {
                  "rule": "repeated",
                  "type": "RequestOption",
                  "id": 5
                },
                "tags": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 7
                }
              },
              "nested": {
                "RequestOption": {
                  "oneofs": {
                    "request_option": {
                      "oneof": [
                        "reattach_options",
                        "result_chunking_options",
                        "extension"
                      ]
                    }
                  },
                  "fields": {
                    "reattach_options": {
                      "type": "ReattachOptions",
                      "id": 1
                    },
                    "result_chunking_options": {
                      "type": "ResultChunkingOptions",
                      "id": 2
                    },
                    "extension": {
                      "type": "google.protobuf.Any",
                      "id": 999
                    }
                  }
                }
              }
            },
            "ExecutePlanResponse": {
              "oneofs": {
                "response_type": {
                  "oneof": [
                    "arrow_batch",
                    "sql_command_result",
                    "write_stream_operation_start_result",
                    "streaming_query_command_result",
                    "get_resources_command_result",
                    "streaming_query_manager_command_result",
                    "streaming_query_listener_events_result",
                    "result_complete",
                    "create_resource_profile_command_result",
                    "execution_progress",
                    "checkpoint_command_result",
                    "ml_command_result",
                    "pipeline_event_result",
                    "pipeline_command_result",
                    "pipeline_query_function_execution_signal",
                    "extension"
                  ]
                }
              },
              "fields": {
                "session_id": {
                  "type": "string",
                  "id": 1
                },
                "server_side_session_id": {
                  "type": "string",
                  "id": 15
                },
                "operation_id": {
                  "type": "string",
                  "id": 12
                },
                "response_id": {
                  "type": "string",
                  "id": 13
                },
                "arrow_batch": {
                  "type": "ArrowBatch",
                  "id": 2
                },
                "sql_command_result": {
                  "type": "SqlCommandResult",
                  "id": 5
                },
                "write_stream_operation_start_result": {
                  "type": "WriteStreamOperationStartResult",
                  "id": 8
                },
                "streaming_query_command_result": {
                  "type": "StreamingQueryCommandResult",
                  "id": 9
                },
                "get_resources_command_result": {
                  "type": "GetResourcesCommandResult",
                  "id": 10
                },
                "streaming_query_manager_command_result": {
                  "type": "StreamingQueryManagerCommandResult",
                  "id": 11
                },
                "streaming_query_listener_events_result": {
                  "type": "StreamingQueryListenerEventsResult",
                  "id": 16
                },
                "result_complete": {
                  "type": "ResultComplete",
                  "id": 14
                },
                "create_resource_profile_command_result": {
                  "type": "CreateResourceProfileCommandResult",
                  "id": 17
                },
                "execution_progress": {
                  "type": "ExecutionProgress",
                  "id": 18
                },
                "checkpoint_command_result": {
                  "type": "CheckpointCommandResult",
                  "id": 19
                },
                "ml_command_result": {
                  "type": "MlCommandResult",
                  "id": 20
                },
                "pipeline_event_result": {
                  "type": "PipelineEventResult",
                  "id": 21
                },
                "pipeline_command_result": {
                  "type": "PipelineCommandResult",
                  "id": 22
                },
                "pipeline_query_function_execution_signal": {
                  "type": "PipelineQueryFunctionExecutionSignal",
                  "id": 23
                },
                "extension": {
                  "type": "google.protobuf.Any",
                  "id": 999
                },
                "metrics": {
                  "type": "Metrics",
                  "id": 4
                },
                "observed_metrics": {
                  "rule": "repeated",
                  "type": "ObservedMetrics",
                  "id": 6
                },
                "schema": {
                  "type": "DataType",
                  "id": 7
                }
              },
              "nested": {
                "SqlCommandResult": {
                  "fields": {
                    "relation": {
                      "type": "Relation",
                      "id": 1
                    }
                  }
                },
                "ArrowBatch": {
                  "oneofs": {
                    "_start_offset": {
                      "oneof": [
                        "start_offset"
                      ]
                    },
                    "_chunk_index": {
                      "oneof": [
                        "chunk_index"
                      ]
                    },
                    "_num_chunks_in_batch": {
                      "oneof": [
                        "num_chunks_in_batch"
                      ]
                    }
                  },
                  "fields": {
                    "row_count": {
                      "type": "int64",
                      "id": 1
                    },
                    "data": {
                      "type": "bytes",
                      "id": 2
                    },
                    "start_offset": {
                      "type": "int64",
                      "id": 3,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "chunk_index": {
                      "type": "int64",
                      "id": 4,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "num_chunks_in_batch": {
                      "type": "int64",
                      "id": 5,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "Metrics": {
                  "fields": {
                    "metrics": {
                      "rule": "repeated",
                      "type": "MetricObject",
                      "id": 1
                    }
                  },
                  "nested": {
                    "MetricObject": {
                      "fields": {
                        "name": {
                          "type": "string",
                          "id": 1
                        },
                        "plan_id": {
                          "type": "int64",
                          "id": 2
                        },
                        "parent": {
                          "type": "int64",
                          "id": 3
                        },
                        "execution_metrics": {
                          "keyType": "string",
                          "type": "MetricValue",
                          "id": 4
                        }
                      }
                    },
                    "MetricValue": {
                      "fields": {
                        "name": {
                          "type": "string",
                          "id": 1
                        },
                        "value": {
                          "type": "int64",
                          "id": 2
                        },
                        "metric_type": {
                          "type": "string",
                          "id": 3
                        }
                      }
                    }
                  }
                },
                "ObservedMetrics": {
                  "oneofs": {
                    "_root_error_idx": {
                      "oneof": [
                        "root_error_idx"
                      ]
                    }
                  },
                  "fields": {
                    "name": {
                      "type": "string",
                      "id": 1
                    },
                    "values": {
                      "rule": "repeated",
                      "type": "Expression.Literal",
                      "id": 2
                    },
                    "keys": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 3
                    },
                    "plan_id": {
                      "type": "int64",
                      "id": 4
                    },
                    "root_error_idx": {
                      "type": "int32",
                      "id": 5,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "errors": {
                      "rule": "repeated",
                      "type": "FetchErrorDetailsResponse.Error",
                      "id": 6
                    }
                  }
                },
                "ResultComplete": {
                  "fields": {}
                },
                "ExecutionProgress": {
                  "fields": {
                    "stages": {
                      "rule": "repeated",
                      "type": "StageInfo",
                      "id": 1
                    },
                    "num_inflight_tasks": {
                      "type": "int64",
                      "id": 2
                    }
                  },
                  "nested": {
                    "StageInfo": {
                      "fields": {
                        "stage_id": {
                          "type": "int64",
                          "id": 1
                        },
                        "num_tasks": {
                          "type": "int64",
                          "id": 2
                        },
                        "num_completed_tasks": {
                          "type": "int64",
                          "id": 3
                        },
                        "input_bytes_read": {
                          "type": "int64",
                          "id": 4
                        },
                        "done": {
                          "type": "bool",
                          "id": 5
                        }
                      }
                    }
                  }
                }
              }
            },
            "KeyValue": {
              "oneofs": {
                "_value": {
                  "oneof": [
                    "value"
                  ]
                }
              },
              "fields": {
                "key": {
                  "type": "string",
                  "id": 1
                },
                "value": {
                  "type": "string",
                  "id": 2,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "ConfigRequest": {
              "oneofs": {
                "_client_observed_server_side_session_id": {
                  "oneof": [
                    "client_observed_server_side_session_id"
                  ]
                },
                "_client_type": {
                  "oneof": [
                    "client_type"
                  ]
                }
              },
              "fields": {
                "session_id": {
                  "type": "string",
                  "id": 1
                },
                "client_observed_server_side_session_id": {
                  "type": "string",
                  "id": 8,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "user_context": {
                  "type": "UserContext",
                  "id": 2
                },
                "operation": {
                  "type": "Operation",
                  "id": 3
                },
                "client_type": {
                  "type": "string",
                  "id": 4,
                  "options": {
                    "proto3_optional": true
                  }
                }
              },
              "nested": {
                "Operation": {
                  "oneofs": {
                    "op_type": {
                      "oneof": [
                        "set",
                        "get",
                        "get_with_default",
                        "get_option",
                        "get_all",
                        "unset",
                        "is_modifiable"
                      ]
                    }
                  },
                  "fields": {
                    "set": {
                      "type": "Set",
                      "id": 1
                    },
                    "get": {
                      "type": "Get",
                      "id": 2
                    },
                    "get_with_default": {
                      "type": "GetWithDefault",
                      "id": 3
                    },
                    "get_option": {
                      "type": "GetOption",
                      "id": 4
                    },
                    "get_all": {
                      "type": "GetAll",
                      "id": 5
                    },
                    "unset": {
                      "type": "Unset",
                      "id": 6
                    },
                    "is_modifiable": {
                      "type": "IsModifiable",
                      "id": 7
                    }
                  }
                },
                "Set": {
                  "oneofs": {
                    "_silent": {
                      "oneof": [
                        "silent"
                      ]
                    }
                  },
                  "fields": {
                    "pairs": {
                      "rule": "repeated",
                      "type": "KeyValue",
                      "id": 1
                    },
                    "silent": {
                      "type": "bool",
                      "id": 2,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "Get": {
                  "fields": {
                    "keys": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "GetWithDefault": {
                  "fields": {
                    "pairs": {
                      "rule": "repeated",
                      "type": "KeyValue",
                      "id": 1
                    }
                  }
                },
                "GetOption": {
                  "fields": {
                    "keys": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "GetAll": {
                  "oneofs": {
                    "_prefix": {
                      "oneof": [
                        "prefix"
                      ]
                    }
                  },
                  "fields": {
                    "prefix": {
                      "type": "string",
                      "id": 1,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "Unset": {
                  "fields": {
                    "keys": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "IsModifiable": {
                  "fields": {
                    "keys": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 1
                    }
                  }
                }
              }
            },
            "ConfigResponse": {
              "fields": {
                "session_id": {
                  "type": "string",
                  "id": 1
                },
                "server_side_session_id": {
                  "type": "string",
                  "id": 4
                },
                "pairs": {
                  "rule": "repeated",
                  "type": "KeyValue",
                  "id": 2
                },
                "warnings": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 3
                }
              }
            },
            "AddArtifactsRequest": {
              "oneofs": {
                "_client_observed_server_side_session_id": {
                  "oneof": [
                    "client_observed_server_side_session_id"
                  ]
                },
                "_client_type": {
                  "oneof": [
                    "client_type"
                  ]
                },
                "payload": {
                  "oneof": [
                    "batch",
                    "begin_chunk",
                    "chunk"
                  ]
                }
              },
              "fields": {
                "session_id": {
                  "type": "string",
                  "id": 1
                },
                "user_context": {
                  "type": "UserContext",
                  "id": 2
                },
                "client_observed_server_side_session_id": {
                  "type": "string",
                  "id": 7,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "client_type": {
                  "type": "string",
                  "id": 6,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "batch": {
                  "type": "Batch",
                  "id": 3
                },
                "begin_chunk": {
                  "type": "BeginChunkedArtifact",
                  "id": 4
                },
                "chunk": {
                  "type": "ArtifactChunk",
                  "id": 5
                }
              },
              "nested": {
                "ArtifactChunk": {
                  "fields": {
                    "data": {
                      "type": "bytes",
                      "id": 1
                    },
                    "crc": {
                      "type": "int64",
                      "id": 2
                    }
                  }
                },
                "SingleChunkArtifact": {
                  "fields": {
                    "name": {
                      "type": "string",
                      "id": 1
                    },
                    "data": {
                      "type": "ArtifactChunk",
                      "id": 2
                    }
                  }
                },
                "Batch": {
                  "fields": {
                    "artifacts": {
                      "rule": "repeated",
                      "type": "SingleChunkArtifact",
                      "id": 1
                    }
                  }
                },
                "BeginChunkedArtifact": {
                  "fields": {
                    "name": {
                      "type": "string",
                      "id": 1
                    },
                    "total_bytes": {
                      "type": "int64",
                      "id": 2
                    },
                    "num_chunks": {
                      "type": "int64",
                      "id": 3
                    },
                    "initial_chunk": {
                      "type": "ArtifactChunk",
                      "id": 4
                    }
                  }
                }
              }
            },
            "AddArtifactsResponse": {
              "fields": {
                "session_id": {
                  "type": "string",
                  "id": 2
                },
                "server_side_session_id": {
                  "type": "string",
                  "id": 3
                },
                "artifacts": {
                  "rule": "repeated",
                  "type": "ArtifactSummary",
                  "id": 1
                }
              },
              "nested": {
                "ArtifactSummary": {
                  "fields": {
                    "name": {
                      "type": "string",
                      "id": 1
                    },
                    "is_crc_successful": {
                      "type": "bool",
                      "id": 2
                    }
                  }
                }
              }
            },
            "ArtifactStatusesRequest": {
              "oneofs": {
                "_client_observed_server_side_session_id": {
                  "oneof": [
                    "client_observed_server_side_session_id"
                  ]
                },
                "_client_type": {
                  "oneof": [
                    "client_type"
                  ]
                }
              },
              "fields": {
                "session_id": {
                  "type": "string",
                  "id": 1
                },
                "client_observed_server_side_session_id": {
                  "type": "string",
                  "id": 5,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "user_context": {
                  "type": "UserContext",
                  "id": 2
                },
                "client_type": {
                  "type": "string",
                  "id": 3,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "names": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 4
                }
              }
            },
            "ArtifactStatusesResponse": {
              "fields": {
                "session_id": {
                  "type": "string",
                  "id": 2
                },
                "server_side_session_id": {
                  "type": "string",
                  "id": 3
                },
                "statuses": {
                  "keyType": "string",
                  "type": "ArtifactStatus",
                  "id": 1
                }
              },
              "nested": {
                "ArtifactStatus": {
                  "fields": {
                    "exists": {
                      "type": "bool",
                      "id": 1
                    }
                  }
                }
              }
            },
            "InterruptRequest": {
              "oneofs": {
                "_client_observed_server_side_session_id": {
                  "oneof": [
                    "client_observed_server_side_session_id"
                  ]
                },
                "_client_type": {
                  "oneof": [
                    "client_type"
                  ]
                },
                "interrupt": {
                  "oneof": [
                    "operation_tag",
                    "operation_id"
                  ]
                }
              },
              "fields": {
                "session_id": {
                  "type": "string",
                  "id": 1
                },
                "client_observed_server_side_session_id": {
                  "type": "string",
                  "id": 7,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "user_context": {
                  "type": "UserContext",
                  "id": 2
                },
                "client_type": {
                  "type": "string",
                  "id": 3,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "interrupt_type": {
                  "type": "InterruptType",
                  "id": 4
                },
                "operation_tag": {
                  "type": "string",
                  "id": 5
                },
                "operation_id": {
                  "type": "string",
                  "id": 6
                }
              },
              "nested": {
                "InterruptType": {
                  "values": {
                    "INTERRUPT_TYPE_UNSPECIFIED": 0,
                    "INTERRUPT_TYPE_ALL": 1,
                    "INTERRUPT_TYPE_TAG": 2,
                    "INTERRUPT_TYPE_OPERATION_ID": 3
                  }
                }
              }
            },
            "InterruptResponse": {
              "fields": {
                "session_id": {
                  "type": "string",
                  "id": 1
                },
                "server_side_session_id": {
                  "type": "string",
                  "id": 3
                },
                "interrupted_ids": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 2
                }
              }
            },
            "ReattachOptions": {
              "fields": {
                "reattachable": {
                  "type": "bool",
                  "id": 1
                }
              }
            },
            "ResultChunkingOptions": {
              "oneofs": {
                "_preferred_arrow_chunk_size": {
                  "oneof": [
                    "preferred_arrow_chunk_size"
                  ]
                }
              },
              "fields": {
                "allow_arrow_batch_chunking": {
                  "type": "bool",
                  "id": 1
                },
                "preferred_arrow_chunk_size": {
                  "type": "int64",
                  "id": 2,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "ReattachExecuteRequest": {
              "oneofs": {
                "_client_observed_server_side_session_id": {
                  "oneof": [
                    "client_observed_server_side_session_id"
                  ]
                },
                "_client_type": {
                  "oneof": [
                    "client_type"
                  ]
                },
                "_last_response_id": {
                  "oneof": [
                    "last_response_id"
                  ]
                }
              },
              "fields": {
                "session_id": {
                  "type": "string",
                  "id": 1
                },
                "client_observed_server_side_session_id": {
                  "type": "string",
                  "id": 6,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "user_context": {
                  "type": "UserContext",
                  "id": 2
                },
                "operation_id": {
                  "type": "string",
                  "id": 3
                },
                "client_type": {
                  "type": "string",
                  "id": 4,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "last_response_id": {
                  "type": "string",
                  "id": 5,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "ReleaseExecuteRequest": {
              "oneofs": {
                "_client_observed_server_side_session_id": {
                  "oneof": [
                    "client_observed_server_side_session_id"
                  ]
                },
                "_client_type": {
                  "oneof": [
                    "client_type"
                  ]
                },
                "release": {
                  "oneof": [
                    "release_all",
                    "release_until"
                  ]
                }
              },
              "fields": {
                "session_id": {
                  "type": "string",
                  "id": 1
                },
                "client_observed_server_side_session_id": {
                  "type": "string",
                  "id": 7,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "user_context": {
                  "type": "UserContext",
                  "id": 2
                },
                "operation_id": {
                  "type": "string",
                  "id": 3
                },
                "client_type": {
                  "type": "string",
                  "id": 4,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "release_all": {
                  "type": "ReleaseAll",
                  "id": 5
                },
                "release_until": {
                  "type": "ReleaseUntil",
                  "id": 6
                }
              },
              "nested": {
                "ReleaseAll": {
                  "fields": {}
                },
                "ReleaseUntil": {
                  "fields": {
                    "response_id": {
                      "type": "string",
                      "id": 1
                    }
                  }
                }
              }
            },
            "ReleaseExecuteResponse": {
              "oneofs": {
                "_operation_id": {
                  "oneof": [
                    "operation_id"
                  ]
                }
              },
              "fields": {
                "session_id": {
                  "type": "string",
                  "id": 1
                },
                "server_side_session_id": {
                  "type": "string",
                  "id": 3
                },
                "operation_id": {
                  "type": "string",
                  "id": 2,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "ReleaseSessionRequest": {
              "oneofs": {
                "_client_type": {
                  "oneof": [
                    "client_type"
                  ]
                }
              },
              "fields": {
                "session_id": {
                  "type": "string",
                  "id": 1
                },
                "user_context": {
                  "type": "UserContext",
                  "id": 2
                },
                "client_type": {
                  "type": "string",
                  "id": 3,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "allow_reconnect": {
                  "type": "bool",
                  "id": 4
                }
              }
            },
            "ReleaseSessionResponse": {
              "fields": {
                "session_id": {
                  "type": "string",
                  "id": 1
                },
                "server_side_session_id": {
                  "type": "string",
                  "id": 2
                }
              }
            },
            "FetchErrorDetailsRequest": {
              "oneofs": {
                "_client_observed_server_side_session_id": {
                  "oneof": [
                    "client_observed_server_side_session_id"
                  ]
                },
                "_client_type": {
                  "oneof": [
                    "client_type"
                  ]
                }
              },
              "fields": {
                "session_id": {
                  "type": "string",
                  "id": 1
                },
                "client_observed_server_side_session_id": {
                  "type": "string",
                  "id": 5,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "user_context": {
                  "type": "UserContext",
                  "id": 2
                },
                "error_id": {
                  "type": "string",
                  "id": 3
                },
                "client_type": {
                  "type": "string",
                  "id": 4,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "FetchErrorDetailsResponse": {
              "oneofs": {
                "_root_error_idx": {
                  "oneof": [
                    "root_error_idx"
                  ]
                }
              },
              "fields": {
                "server_side_session_id": {
                  "type": "string",
                  "id": 3
                },
                "session_id": {
                  "type": "string",
                  "id": 4
                },
                "root_error_idx": {
                  "type": "int32",
                  "id": 1,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "errors": {
                  "rule": "repeated",
                  "type": "Error",
                  "id": 2
                }
              },
              "nested": {
                "StackTraceElement": {
                  "oneofs": {
                    "_file_name": {
                      "oneof": [
                        "file_name"
                      ]
                    }
                  },
                  "fields": {
                    "declaring_class": {
                      "type": "string",
                      "id": 1
                    },
                    "method_name": {
                      "type": "string",
                      "id": 2
                    },
                    "file_name": {
                      "type": "string",
                      "id": 3,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "line_number": {
                      "type": "int32",
                      "id": 4
                    }
                  }
                },
                "QueryContext": {
                  "fields": {
                    "context_type": {
                      "type": "ContextType",
                      "id": 10
                    },
                    "object_type": {
                      "type": "string",
                      "id": 1
                    },
                    "object_name": {
                      "type": "string",
                      "id": 2
                    },
                    "start_index": {
                      "type": "int32",
                      "id": 3
                    },
                    "stop_index": {
                      "type": "int32",
                      "id": 4
                    },
                    "fragment": {
                      "type": "string",
                      "id": 5
                    },
                    "call_site": {
                      "type": "string",
                      "id": 6
                    },
                    "summary": {
                      "type": "string",
                      "id": 7
                    }
                  },
                  "nested": {
                    "ContextType": {
                      "values": {
                        "SQL": 0,
                        "DATAFRAME": 1
                      }
                    }
                  }
                },
                "SparkThrowable": {
                  "oneofs": {
                    "_error_class": {
                      "oneof": [
                        "error_class"
                      ]
                    },
                    "_sql_state": {
                      "oneof": [
                        "sql_state"
                      ]
                    },
                    "_breaking_change_info": {
                      "oneof": [
                        "breaking_change_info"
                      ]
                    }
                  },
                  "fields": {
                    "error_class": {
                      "type": "string",
                      "id": 1,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "message_parameters": {
                      "keyType": "string",
                      "type": "string",
                      "id": 2
                    },
                    "query_contexts": {
                      "rule": "repeated",
                      "type": "QueryContext",
                      "id": 3
                    },
                    "sql_state": {
                      "type": "string",
                      "id": 4,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "breaking_change_info": {
                      "type": "BreakingChangeInfo",
                      "id": 5,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "BreakingChangeInfo": {
                  "oneofs": {
                    "_mitigation_config": {
                      "oneof": [
                        "mitigation_config"
                      ]
                    },
                    "_needs_audit": {
                      "oneof": [
                        "needs_audit"
                      ]
                    }
                  },
                  "fields": {
                    "migration_message": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 1
                    },
                    "mitigation_config": {
                      "type": "MitigationConfig",
                      "id": 2,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "needs_audit": {
                      "type": "bool",
                      "id": 3,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "MitigationConfig": {
                  "fields": {
                    "key": {
                      "type": "string",
                      "id": 1
                    },
                    "value": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "Error": {
                  "oneofs": {
                    "_cause_idx": {
                      "oneof": [
                        "cause_idx"
                      ]
                    },
                    "_spark_throwable": {
                      "oneof": [
                        "spark_throwable"
                      ]
                    }
                  },
                  "fields": {
                    "error_type_hierarchy": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 1
                    },
                    "message": {
                      "type": "string",
                      "id": 2
                    },
                    "stack_trace": {
                      "rule": "repeated",
                      "type": "StackTraceElement",
                      "id": 3
                    },
                    "cause_idx": {
                      "type": "int32",
                      "id": 4,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "spark_throwable": {
                      "type": "SparkThrowable",
                      "id": 5,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                }
              }
            },
            "CheckpointCommandResult": {
              "fields": {
                "relation": {
                  "type": "CachedRemoteRelation",
                  "id": 1
                }
              }
            },
            "CloneSessionRequest": {
              "oneofs": {
                "_client_observed_server_side_session_id": {
                  "oneof": [
                    "client_observed_server_side_session_id"
                  ]
                },
                "_client_type": {
                  "oneof": [
                    "client_type"
                  ]
                },
                "_new_session_id": {
                  "oneof": [
                    "new_session_id"
                  ]
                }
              },
              "fields": {
                "session_id": {
                  "type": "string",
                  "id": 1
                },
                "client_observed_server_side_session_id": {
                  "type": "string",
                  "id": 5,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "user_context": {
                  "type": "UserContext",
                  "id": 2
                },
                "client_type": {
                  "type": "string",
                  "id": 3,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "new_session_id": {
                  "type": "string",
                  "id": 4,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "CloneSessionResponse": {
              "fields": {
                "session_id": {
                  "type": "string",
                  "id": 1
                },
                "server_side_session_id": {
                  "type": "string",
                  "id": 2
                },
                "new_session_id": {
                  "type": "string",
                  "id": 3
                },
                "new_server_side_session_id": {
                  "type": "string",
                  "id": 4
                }
              }
            },
            "GetStatusRequest": {
              "oneofs": {
                "_client_type": {
                  "oneof": [
                    "client_type"
                  ]
                },
                "_client_observed_server_side_session_id": {
                  "oneof": [
                    "client_observed_server_side_session_id"
                  ]
                },
                "_operation_status": {
                  "oneof": [
                    "operation_status"
                  ]
                }
              },
              "fields": {
                "session_id": {
                  "type": "string",
                  "id": 1
                },
                "user_context": {
                  "type": "UserContext",
                  "id": 2
                },
                "client_type": {
                  "type": "string",
                  "id": 3,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "client_observed_server_side_session_id": {
                  "type": "string",
                  "id": 4,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "operation_status": {
                  "type": "OperationStatusRequest",
                  "id": 5,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "extensions": {
                  "rule": "repeated",
                  "type": "google.protobuf.Any",
                  "id": 999
                }
              },
              "nested": {
                "OperationStatusRequest": {
                  "fields": {
                    "operation_ids": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 1
                    },
                    "extensions": {
                      "rule": "repeated",
                      "type": "google.protobuf.Any",
                      "id": 999
                    }
                  }
                }
              }
            },
            "GetStatusResponse": {
              "fields": {
                "session_id": {
                  "type": "string",
                  "id": 1
                },
                "server_side_session_id": {
                  "type": "string",
                  "id": 2
                },
                "operation_statuses": {
                  "rule": "repeated",
                  "type": "OperationStatus",
                  "id": 3
                },
                "extensions": {
                  "rule": "repeated",
                  "type": "google.protobuf.Any",
                  "id": 999
                }
              },
              "nested": {
                "OperationStatus": {
                  "fields": {
                    "operation_id": {
                      "type": "string",
                      "id": 1
                    },
                    "state": {
                      "type": "OperationState",
                      "id": 2
                    },
                    "extensions": {
                      "rule": "repeated",
                      "type": "google.protobuf.Any",
                      "id": 999
                    }
                  },
                  "nested": {
                    "OperationState": {
                      "values": {
                        "OPERATION_STATE_UNSPECIFIED": 0,
                        "OPERATION_STATE_UNKNOWN": 1,
                        "OPERATION_STATE_RUNNING": 2,
                        "OPERATION_STATE_TERMINATING": 3,
                        "OPERATION_STATE_SUCCEEDED": 4,
                        "OPERATION_STATE_FAILED": 5,
                        "OPERATION_STATE_CANCELLED": 6
                      }
                    }
                  }
                }
              }
            },
            "SparkConnectService": {
              "methods": {
                "ExecutePlan": {
                  "requestType": "ExecutePlanRequest",
                  "responseType": "ExecutePlanResponse",
                  "responseStream": true
                },
                "AnalyzePlan": {
                  "requestType": "AnalyzePlanRequest",
                  "responseType": "AnalyzePlanResponse"
                },
                "Config": {
                  "requestType": "ConfigRequest",
                  "responseType": "ConfigResponse"
                },
                "AddArtifacts": {
                  "requestType": "AddArtifactsRequest",
                  "requestStream": true,
                  "responseType": "AddArtifactsResponse"
                },
                "ArtifactStatus": {
                  "requestType": "ArtifactStatusesRequest",
                  "responseType": "ArtifactStatusesResponse"
                },
                "Interrupt": {
                  "requestType": "InterruptRequest",
                  "responseType": "InterruptResponse"
                },
                "ReattachExecute": {
                  "requestType": "ReattachExecuteRequest",
                  "responseType": "ExecutePlanResponse",
                  "responseStream": true
                },
                "ReleaseExecute": {
                  "requestType": "ReleaseExecuteRequest",
                  "responseType": "ReleaseExecuteResponse"
                },
                "ReleaseSession": {
                  "requestType": "ReleaseSessionRequest",
                  "responseType": "ReleaseSessionResponse"
                },
                "FetchErrorDetails": {
                  "requestType": "FetchErrorDetailsRequest",
                  "responseType": "FetchErrorDetailsResponse"
                },
                "CloneSession": {
                  "requestType": "CloneSessionRequest",
                  "responseType": "CloneSessionResponse"
                },
                "GetStatus": {
                  "requestType": "GetStatusRequest",
                  "responseType": "GetStatusResponse"
                }
              }
            },
            "Command": {
              "oneofs": {
                "command_type": {
                  "oneof": [
                    "register_function",
                    "write_operation",
                    "create_dataframe_view",
                    "write_operation_v2",
                    "sql_command",
                    "write_stream_operation_start",
                    "streaming_query_command",
                    "get_resources_command",
                    "streaming_query_manager_command",
                    "register_table_function",
                    "streaming_query_listener_bus_command",
                    "register_data_source",
                    "create_resource_profile_command",
                    "checkpoint_command",
                    "remove_cached_remote_relation_command",
                    "merge_into_table_command",
                    "ml_command",
                    "execute_external_command",
                    "pipeline_command",
                    "extension"
                  ]
                }
              },
              "fields": {
                "register_function": {
                  "type": "CommonInlineUserDefinedFunction",
                  "id": 1
                },
                "write_operation": {
                  "type": "WriteOperation",
                  "id": 2
                },
                "create_dataframe_view": {
                  "type": "CreateDataFrameViewCommand",
                  "id": 3
                },
                "write_operation_v2": {
                  "type": "WriteOperationV2",
                  "id": 4
                },
                "sql_command": {
                  "type": "SqlCommand",
                  "id": 5
                },
                "write_stream_operation_start": {
                  "type": "WriteStreamOperationStart",
                  "id": 6
                },
                "streaming_query_command": {
                  "type": "StreamingQueryCommand",
                  "id": 7
                },
                "get_resources_command": {
                  "type": "GetResourcesCommand",
                  "id": 8
                },
                "streaming_query_manager_command": {
                  "type": "StreamingQueryManagerCommand",
                  "id": 9
                },
                "register_table_function": {
                  "type": "CommonInlineUserDefinedTableFunction",
                  "id": 10
                },
                "streaming_query_listener_bus_command": {
                  "type": "StreamingQueryListenerBusCommand",
                  "id": 11
                },
                "register_data_source": {
                  "type": "CommonInlineUserDefinedDataSource",
                  "id": 12
                },
                "create_resource_profile_command": {
                  "type": "CreateResourceProfileCommand",
                  "id": 13
                },
                "checkpoint_command": {
                  "type": "CheckpointCommand",
                  "id": 14
                },
                "remove_cached_remote_relation_command": {
                  "type": "RemoveCachedRemoteRelationCommand",
                  "id": 15
                },
                "merge_into_table_command": {
                  "type": "MergeIntoTableCommand",
                  "id": 16
                },
                "ml_command": {
                  "type": "MlCommand",
                  "id": 17
                },
                "execute_external_command": {
                  "type": "ExecuteExternalCommand",
                  "id": 18
                },
                "pipeline_command": {
                  "type": "PipelineCommand",
                  "id": 19
                },
                "extension": {
                  "type": "google.protobuf.Any",
                  "id": 999
                }
              }
            },
            "SqlCommand": {
              "fields": {
                "sql": {
                  "type": "string",
                  "id": 1,
                  "options": {
                    "deprecated": true
                  }
                },
                "args": {
                  "keyType": "string",
                  "type": "Expression.Literal",
                  "id": 2,
                  "options": {
                    "deprecated": true
                  }
                },
                "pos_args": {
                  "rule": "repeated",
                  "type": "Expression.Literal",
                  "id": 3,
                  "options": {
                    "deprecated": true
                  }
                },
                "named_arguments": {
                  "keyType": "string",
                  "type": "Expression",
                  "id": 4,
                  "options": {
                    "deprecated": true
                  }
                },
                "pos_arguments": {
                  "rule": "repeated",
                  "type": "Expression",
                  "id": 5,
                  "options": {
                    "deprecated": true
                  }
                },
                "input": {
                  "type": "Relation",
                  "id": 6
                }
              }
            },
            "CreateDataFrameViewCommand": {
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "name": {
                  "type": "string",
                  "id": 2
                },
                "is_global": {
                  "type": "bool",
                  "id": 3
                },
                "replace": {
                  "type": "bool",
                  "id": 4
                }
              }
            },
            "WriteOperation": {
              "oneofs": {
                "_source": {
                  "oneof": [
                    "source"
                  ]
                },
                "save_type": {
                  "oneof": [
                    "path",
                    "table"
                  ]
                }
              },
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "source": {
                  "type": "string",
                  "id": 2,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "path": {
                  "type": "string",
                  "id": 3
                },
                "table": {
                  "type": "SaveTable",
                  "id": 4
                },
                "mode": {
                  "type": "SaveMode",
                  "id": 5
                },
                "sort_column_names": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 6
                },
                "partitioning_columns": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 7
                },
                "bucket_by": {
                  "type": "BucketBy",
                  "id": 8
                },
                "options": {
                  "keyType": "string",
                  "type": "string",
                  "id": 9
                },
                "clustering_columns": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 10
                },
                "with_schema_evolution": {
                  "type": "bool",
                  "id": 11
                }
              },
              "nested": {
                "SaveTable": {
                  "fields": {
                    "table_name": {
                      "type": "string",
                      "id": 1
                    },
                    "save_method": {
                      "type": "TableSaveMethod",
                      "id": 2
                    }
                  },
                  "nested": {
                    "TableSaveMethod": {
                      "values": {
                        "TABLE_SAVE_METHOD_UNSPECIFIED": 0,
                        "TABLE_SAVE_METHOD_SAVE_AS_TABLE": 1,
                        "TABLE_SAVE_METHOD_INSERT_INTO": 2
                      }
                    }
                  }
                },
                "BucketBy": {
                  "fields": {
                    "bucket_column_names": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 1
                    },
                    "num_buckets": {
                      "type": "int32",
                      "id": 2
                    }
                  }
                },
                "SaveMode": {
                  "values": {
                    "SAVE_MODE_UNSPECIFIED": 0,
                    "SAVE_MODE_APPEND": 1,
                    "SAVE_MODE_OVERWRITE": 2,
                    "SAVE_MODE_ERROR_IF_EXISTS": 3,
                    "SAVE_MODE_IGNORE": 4
                  }
                }
              }
            },
            "WriteOperationV2": {
              "oneofs": {
                "_provider": {
                  "oneof": [
                    "provider"
                  ]
                }
              },
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "table_name": {
                  "type": "string",
                  "id": 2
                },
                "provider": {
                  "type": "string",
                  "id": 3,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "partitioning_columns": {
                  "rule": "repeated",
                  "type": "Expression",
                  "id": 4
                },
                "options": {
                  "keyType": "string",
                  "type": "string",
                  "id": 5
                },
                "table_properties": {
                  "keyType": "string",
                  "type": "string",
                  "id": 6
                },
                "mode": {
                  "type": "Mode",
                  "id": 7
                },
                "overwrite_condition": {
                  "type": "Expression",
                  "id": 8
                },
                "clustering_columns": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 9
                },
                "with_schema_evolution": {
                  "type": "bool",
                  "id": 10
                }
              },
              "nested": {
                "Mode": {
                  "values": {
                    "MODE_UNSPECIFIED": 0,
                    "MODE_CREATE": 1,
                    "MODE_OVERWRITE": 2,
                    "MODE_OVERWRITE_PARTITIONS": 3,
                    "MODE_APPEND": 4,
                    "MODE_REPLACE": 5,
                    "MODE_CREATE_OR_REPLACE": 6
                  }
                }
              }
            },
            "WriteStreamOperationStart": {
              "oneofs": {
                "trigger": {
                  "oneof": [
                    "processing_time_interval",
                    "available_now",
                    "once",
                    "continuous_checkpoint_interval",
                    "real_time_batch_duration"
                  ]
                },
                "sink_destination": {
                  "oneof": [
                    "path",
                    "table_name"
                  ]
                }
              },
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "format": {
                  "type": "string",
                  "id": 2
                },
                "options": {
                  "keyType": "string",
                  "type": "string",
                  "id": 3
                },
                "partitioning_column_names": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 4
                },
                "processing_time_interval": {
                  "type": "string",
                  "id": 5
                },
                "available_now": {
                  "type": "bool",
                  "id": 6
                },
                "once": {
                  "type": "bool",
                  "id": 7
                },
                "continuous_checkpoint_interval": {
                  "type": "string",
                  "id": 8
                },
                "real_time_batch_duration": {
                  "type": "string",
                  "id": 100
                },
                "output_mode": {
                  "type": "string",
                  "id": 9
                },
                "query_name": {
                  "type": "string",
                  "id": 10
                },
                "path": {
                  "type": "string",
                  "id": 11
                },
                "table_name": {
                  "type": "string",
                  "id": 12
                },
                "foreach_writer": {
                  "type": "StreamingForeachFunction",
                  "id": 13
                },
                "foreach_batch": {
                  "type": "StreamingForeachFunction",
                  "id": 14
                },
                "clustering_column_names": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 15
                }
              }
            },
            "StreamingForeachFunction": {
              "oneofs": {
                "function": {
                  "oneof": [
                    "python_function",
                    "scala_function"
                  ]
                }
              },
              "fields": {
                "python_function": {
                  "type": "PythonUDF",
                  "id": 1
                },
                "scala_function": {
                  "type": "ScalarScalaUDF",
                  "id": 2
                }
              }
            },
            "WriteStreamOperationStartResult": {
              "oneofs": {
                "_query_started_event_json": {
                  "oneof": [
                    "query_started_event_json"
                  ]
                }
              },
              "fields": {
                "query_id": {
                  "type": "StreamingQueryInstanceId",
                  "id": 1
                },
                "name": {
                  "type": "string",
                  "id": 2
                },
                "query_started_event_json": {
                  "type": "string",
                  "id": 3,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "StreamingQueryInstanceId": {
              "fields": {
                "id": {
                  "type": "string",
                  "id": 1
                },
                "run_id": {
                  "type": "string",
                  "id": 2
                }
              }
            },
            "StreamingQueryCommand": {
              "oneofs": {
                "command": {
                  "oneof": [
                    "status",
                    "last_progress",
                    "recent_progress",
                    "stop",
                    "process_all_available",
                    "explain",
                    "exception",
                    "await_termination"
                  ]
                }
              },
              "fields": {
                "query_id": {
                  "type": "StreamingQueryInstanceId",
                  "id": 1
                },
                "status": {
                  "type": "bool",
                  "id": 2
                },
                "last_progress": {
                  "type": "bool",
                  "id": 3
                },
                "recent_progress": {
                  "type": "bool",
                  "id": 4
                },
                "stop": {
                  "type": "bool",
                  "id": 5
                },
                "process_all_available": {
                  "type": "bool",
                  "id": 6
                },
                "explain": {
                  "type": "ExplainCommand",
                  "id": 7
                },
                "exception": {
                  "type": "bool",
                  "id": 8
                },
                "await_termination": {
                  "type": "AwaitTerminationCommand",
                  "id": 9
                }
              },
              "nested": {
                "ExplainCommand": {
                  "fields": {
                    "extended": {
                      "type": "bool",
                      "id": 1
                    }
                  }
                },
                "AwaitTerminationCommand": {
                  "oneofs": {
                    "_timeout_ms": {
                      "oneof": [
                        "timeout_ms"
                      ]
                    }
                  },
                  "fields": {
                    "timeout_ms": {
                      "type": "int64",
                      "id": 2,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                }
              }
            },
            "StreamingQueryCommandResult": {
              "oneofs": {
                "result_type": {
                  "oneof": [
                    "status",
                    "recent_progress",
                    "explain",
                    "exception",
                    "await_termination"
                  ]
                }
              },
              "fields": {
                "query_id": {
                  "type": "StreamingQueryInstanceId",
                  "id": 1
                },
                "status": {
                  "type": "StatusResult",
                  "id": 2
                },
                "recent_progress": {
                  "type": "RecentProgressResult",
                  "id": 3
                },
                "explain": {
                  "type": "ExplainResult",
                  "id": 4
                },
                "exception": {
                  "type": "ExceptionResult",
                  "id": 5
                },
                "await_termination": {
                  "type": "AwaitTerminationResult",
                  "id": 6
                }
              },
              "nested": {
                "StatusResult": {
                  "fields": {
                    "status_message": {
                      "type": "string",
                      "id": 1
                    },
                    "is_data_available": {
                      "type": "bool",
                      "id": 2
                    },
                    "is_trigger_active": {
                      "type": "bool",
                      "id": 3
                    },
                    "is_active": {
                      "type": "bool",
                      "id": 4
                    }
                  }
                },
                "RecentProgressResult": {
                  "fields": {
                    "recent_progress_json": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 5
                    }
                  }
                },
                "ExplainResult": {
                  "fields": {
                    "result": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "ExceptionResult": {
                  "oneofs": {
                    "_exception_message": {
                      "oneof": [
                        "exception_message"
                      ]
                    },
                    "_error_class": {
                      "oneof": [
                        "error_class"
                      ]
                    },
                    "_stack_trace": {
                      "oneof": [
                        "stack_trace"
                      ]
                    }
                  },
                  "fields": {
                    "exception_message": {
                      "type": "string",
                      "id": 1,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "error_class": {
                      "type": "string",
                      "id": 2,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "stack_trace": {
                      "type": "string",
                      "id": 3,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "AwaitTerminationResult": {
                  "fields": {
                    "terminated": {
                      "type": "bool",
                      "id": 1
                    }
                  }
                }
              }
            },
            "StreamingQueryManagerCommand": {
              "oneofs": {
                "command": {
                  "oneof": [
                    "active",
                    "get_query",
                    "await_any_termination",
                    "reset_terminated",
                    "add_listener",
                    "remove_listener",
                    "list_listeners"
                  ]
                }
              },
              "fields": {
                "active": {
                  "type": "bool",
                  "id": 1
                },
                "get_query": {
                  "type": "string",
                  "id": 2
                },
                "await_any_termination": {
                  "type": "AwaitAnyTerminationCommand",
                  "id": 3
                },
                "reset_terminated": {
                  "type": "bool",
                  "id": 4
                },
                "add_listener": {
                  "type": "StreamingQueryListenerCommand",
                  "id": 5
                },
                "remove_listener": {
                  "type": "StreamingQueryListenerCommand",
                  "id": 6
                },
                "list_listeners": {
                  "type": "bool",
                  "id": 7
                }
              },
              "nested": {
                "AwaitAnyTerminationCommand": {
                  "oneofs": {
                    "_timeout_ms": {
                      "oneof": [
                        "timeout_ms"
                      ]
                    }
                  },
                  "fields": {
                    "timeout_ms": {
                      "type": "int64",
                      "id": 1,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "StreamingQueryListenerCommand": {
                  "oneofs": {
                    "_python_listener_payload": {
                      "oneof": [
                        "python_listener_payload"
                      ]
                    }
                  },
                  "fields": {
                    "listener_payload": {
                      "type": "bytes",
                      "id": 1
                    },
                    "python_listener_payload": {
                      "type": "PythonUDF",
                      "id": 2,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "id": {
                      "type": "string",
                      "id": 3
                    }
                  }
                }
              }
            },
            "StreamingQueryManagerCommandResult": {
              "oneofs": {
                "result_type": {
                  "oneof": [
                    "active",
                    "query",
                    "await_any_termination",
                    "reset_terminated",
                    "add_listener",
                    "remove_listener",
                    "list_listeners"
                  ]
                }
              },
              "fields": {
                "active": {
                  "type": "ActiveResult",
                  "id": 1
                },
                "query": {
                  "type": "StreamingQueryInstance",
                  "id": 2
                },
                "await_any_termination": {
                  "type": "AwaitAnyTerminationResult",
                  "id": 3
                },
                "reset_terminated": {
                  "type": "bool",
                  "id": 4
                },
                "add_listener": {
                  "type": "bool",
                  "id": 5
                },
                "remove_listener": {
                  "type": "bool",
                  "id": 6
                },
                "list_listeners": {
                  "type": "ListStreamingQueryListenerResult",
                  "id": 7
                }
              },
              "nested": {
                "ActiveResult": {
                  "fields": {
                    "active_queries": {
                      "rule": "repeated",
                      "type": "StreamingQueryInstance",
                      "id": 1
                    }
                  }
                },
                "StreamingQueryInstance": {
                  "oneofs": {
                    "_name": {
                      "oneof": [
                        "name"
                      ]
                    }
                  },
                  "fields": {
                    "id": {
                      "type": "StreamingQueryInstanceId",
                      "id": 1
                    },
                    "name": {
                      "type": "string",
                      "id": 2,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "AwaitAnyTerminationResult": {
                  "fields": {
                    "terminated": {
                      "type": "bool",
                      "id": 1
                    }
                  }
                },
                "StreamingQueryListenerInstance": {
                  "fields": {
                    "listener_payload": {
                      "type": "bytes",
                      "id": 1
                    }
                  }
                },
                "ListStreamingQueryListenerResult": {
                  "fields": {
                    "listener_ids": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 1
                    }
                  }
                }
              }
            },
            "StreamingQueryListenerBusCommand": {
              "oneofs": {
                "command": {
                  "oneof": [
                    "add_listener_bus_listener",
                    "remove_listener_bus_listener"
                  ]
                }
              },
              "fields": {
                "add_listener_bus_listener": {
                  "type": "bool",
                  "id": 1
                },
                "remove_listener_bus_listener": {
                  "type": "bool",
                  "id": 2
                }
              }
            },
            "StreamingQueryEventType": {
              "values": {
                "QUERY_PROGRESS_UNSPECIFIED": 0,
                "QUERY_PROGRESS_EVENT": 1,
                "QUERY_TERMINATED_EVENT": 2,
                "QUERY_IDLE_EVENT": 3
              }
            },
            "StreamingQueryListenerEvent": {
              "fields": {
                "event_json": {
                  "type": "string",
                  "id": 1
                },
                "event_type": {
                  "type": "StreamingQueryEventType",
                  "id": 2
                }
              }
            },
            "StreamingQueryListenerEventsResult": {
              "oneofs": {
                "_listener_bus_listener_added": {
                  "oneof": [
                    "listener_bus_listener_added"
                  ]
                }
              },
              "fields": {
                "events": {
                  "rule": "repeated",
                  "type": "StreamingQueryListenerEvent",
                  "id": 1
                },
                "listener_bus_listener_added": {
                  "type": "bool",
                  "id": 2,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "GetResourcesCommand": {
              "fields": {}
            },
            "GetResourcesCommandResult": {
              "fields": {
                "resources": {
                  "keyType": "string",
                  "type": "ResourceInformation",
                  "id": 1
                }
              }
            },
            "CreateResourceProfileCommand": {
              "fields": {
                "profile": {
                  "type": "ResourceProfile",
                  "id": 1
                }
              }
            },
            "CreateResourceProfileCommandResult": {
              "fields": {
                "profile_id": {
                  "type": "int32",
                  "id": 1
                }
              }
            },
            "RemoveCachedRemoteRelationCommand": {
              "fields": {
                "relation": {
                  "type": "CachedRemoteRelation",
                  "id": 1
                }
              }
            },
            "CheckpointCommand": {
              "oneofs": {
                "_storage_level": {
                  "oneof": [
                    "storage_level"
                  ]
                }
              },
              "fields": {
                "relation": {
                  "type": "Relation",
                  "id": 1
                },
                "local": {
                  "type": "bool",
                  "id": 2
                },
                "eager": {
                  "type": "bool",
                  "id": 3
                },
                "storage_level": {
                  "type": "StorageLevel",
                  "id": 4,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "MergeIntoTableCommand": {
              "fields": {
                "target_table_name": {
                  "type": "string",
                  "id": 1
                },
                "source_table_plan": {
                  "type": "Relation",
                  "id": 2
                },
                "merge_condition": {
                  "type": "Expression",
                  "id": 3
                },
                "match_actions": {
                  "rule": "repeated",
                  "type": "Expression",
                  "id": 4
                },
                "not_matched_actions": {
                  "rule": "repeated",
                  "type": "Expression",
                  "id": 5
                },
                "not_matched_by_source_actions": {
                  "rule": "repeated",
                  "type": "Expression",
                  "id": 6
                },
                "with_schema_evolution": {
                  "type": "bool",
                  "id": 7
                }
              }
            },
            "ExecuteExternalCommand": {
              "fields": {
                "runner": {
                  "type": "string",
                  "id": 1
                },
                "command": {
                  "type": "string",
                  "id": 2
                },
                "options": {
                  "keyType": "string",
                  "type": "string",
                  "id": 3
                }
              }
            },
            "StorageLevel": {
              "fields": {
                "use_disk": {
                  "type": "bool",
                  "id": 1
                },
                "use_memory": {
                  "type": "bool",
                  "id": 2
                },
                "use_off_heap": {
                  "type": "bool",
                  "id": 3
                },
                "deserialized": {
                  "type": "bool",
                  "id": 4
                },
                "replication": {
                  "type": "int32",
                  "id": 5
                }
              }
            },
            "ResourceInformation": {
              "fields": {
                "name": {
                  "type": "string",
                  "id": 1
                },
                "addresses": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 2
                }
              }
            },
            "ExecutorResourceRequest": {
              "oneofs": {
                "_discovery_script": {
                  "oneof": [
                    "discovery_script"
                  ]
                },
                "_vendor": {
                  "oneof": [
                    "vendor"
                  ]
                }
              },
              "fields": {
                "resource_name": {
                  "type": "string",
                  "id": 1
                },
                "amount": {
                  "type": "int64",
                  "id": 2
                },
                "discovery_script": {
                  "type": "string",
                  "id": 3,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "vendor": {
                  "type": "string",
                  "id": 4,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "TaskResourceRequest": {
              "fields": {
                "resource_name": {
                  "type": "string",
                  "id": 1
                },
                "amount": {
                  "type": "double",
                  "id": 2
                }
              }
            },
            "ResourceProfile": {
              "fields": {
                "executor_resources": {
                  "keyType": "string",
                  "type": "ExecutorResourceRequest",
                  "id": 1
                },
                "task_resources": {
                  "keyType": "string",
                  "type": "TaskResourceRequest",
                  "id": 2
                }
              }
            },
            "Origin": {
              "oneofs": {
                "function": {
                  "oneof": [
                    "python_origin",
                    "jvm_origin"
                  ]
                }
              },
              "fields": {
                "python_origin": {
                  "type": "PythonOrigin",
                  "id": 1
                },
                "jvm_origin": {
                  "type": "JvmOrigin",
                  "id": 2
                }
              }
            },
            "PythonOrigin": {
              "fields": {
                "fragment": {
                  "type": "string",
                  "id": 1
                },
                "call_site": {
                  "type": "string",
                  "id": 2
                }
              }
            },
            "JvmOrigin": {
              "oneofs": {
                "_line": {
                  "oneof": [
                    "line"
                  ]
                },
                "_start_position": {
                  "oneof": [
                    "start_position"
                  ]
                },
                "_start_index": {
                  "oneof": [
                    "start_index"
                  ]
                },
                "_stop_index": {
                  "oneof": [
                    "stop_index"
                  ]
                },
                "_sql_text": {
                  "oneof": [
                    "sql_text"
                  ]
                },
                "_object_type": {
                  "oneof": [
                    "object_type"
                  ]
                },
                "_object_name": {
                  "oneof": [
                    "object_name"
                  ]
                }
              },
              "fields": {
                "line": {
                  "type": "int32",
                  "id": 1,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "start_position": {
                  "type": "int32",
                  "id": 2,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "start_index": {
                  "type": "int32",
                  "id": 3,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "stop_index": {
                  "type": "int32",
                  "id": 4,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "sql_text": {
                  "type": "string",
                  "id": 5,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "object_type": {
                  "type": "string",
                  "id": 6,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "object_name": {
                  "type": "string",
                  "id": 7,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "stack_trace": {
                  "rule": "repeated",
                  "type": "StackTraceElement",
                  "id": 8
                }
              }
            },
            "StackTraceElement": {
              "oneofs": {
                "_class_loader_name": {
                  "oneof": [
                    "class_loader_name"
                  ]
                },
                "_module_name": {
                  "oneof": [
                    "module_name"
                  ]
                },
                "_module_version": {
                  "oneof": [
                    "module_version"
                  ]
                },
                "_file_name": {
                  "oneof": [
                    "file_name"
                  ]
                }
              },
              "fields": {
                "class_loader_name": {
                  "type": "string",
                  "id": 1,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "module_name": {
                  "type": "string",
                  "id": 2,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "module_version": {
                  "type": "string",
                  "id": 3,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "declaring_class": {
                  "type": "string",
                  "id": 4
                },
                "method_name": {
                  "type": "string",
                  "id": 5
                },
                "file_name": {
                  "type": "string",
                  "id": 6,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "line_number": {
                  "type": "int32",
                  "id": 7
                }
              }
            },
            "ResolvedIdentifier": {
              "fields": {
                "catalog_name": {
                  "type": "string",
                  "id": 1
                },
                "namespace": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 2
                },
                "table_name": {
                  "type": "string",
                  "id": 3
                }
              }
            },
            "Bools": {
              "fields": {
                "values": {
                  "rule": "repeated",
                  "type": "bool",
                  "id": 1
                }
              }
            },
            "Ints": {
              "fields": {
                "values": {
                  "rule": "repeated",
                  "type": "int32",
                  "id": 1
                }
              }
            },
            "Longs": {
              "fields": {
                "values": {
                  "rule": "repeated",
                  "type": "int64",
                  "id": 1
                }
              }
            },
            "Floats": {
              "fields": {
                "values": {
                  "rule": "repeated",
                  "type": "float",
                  "id": 1
                }
              }
            },
            "Doubles": {
              "fields": {
                "values": {
                  "rule": "repeated",
                  "type": "double",
                  "id": 1
                }
              }
            },
            "Strings": {
              "fields": {
                "values": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 1
                }
              }
            },
            "Expression": {
              "oneofs": {
                "expr_type": {
                  "oneof": [
                    "literal",
                    "unresolved_attribute",
                    "unresolved_function",
                    "expression_string",
                    "unresolved_star",
                    "alias",
                    "cast",
                    "unresolved_regex",
                    "sort_order",
                    "lambda_function",
                    "window",
                    "unresolved_extract_value",
                    "update_fields",
                    "unresolved_named_lambda_variable",
                    "common_inline_user_defined_function",
                    "call_function",
                    "named_argument_expression",
                    "merge_action",
                    "typed_aggregate_expression",
                    "subquery_expression",
                    "direct_shuffle_partition_id",
                    "extension"
                  ]
                }
              },
              "fields": {
                "common": {
                  "type": "ExpressionCommon",
                  "id": 18
                },
                "literal": {
                  "type": "Literal",
                  "id": 1
                },
                "unresolved_attribute": {
                  "type": "UnresolvedAttribute",
                  "id": 2
                },
                "unresolved_function": {
                  "type": "UnresolvedFunction",
                  "id": 3
                },
                "expression_string": {
                  "type": "ExpressionString",
                  "id": 4
                },
                "unresolved_star": {
                  "type": "UnresolvedStar",
                  "id": 5
                },
                "alias": {
                  "type": "Alias",
                  "id": 6
                },
                "cast": {
                  "type": "Cast",
                  "id": 7
                },
                "unresolved_regex": {
                  "type": "UnresolvedRegex",
                  "id": 8
                },
                "sort_order": {
                  "type": "SortOrder",
                  "id": 9
                },
                "lambda_function": {
                  "type": "LambdaFunction",
                  "id": 10
                },
                "window": {
                  "type": "Window",
                  "id": 11
                },
                "unresolved_extract_value": {
                  "type": "UnresolvedExtractValue",
                  "id": 12
                },
                "update_fields": {
                  "type": "UpdateFields",
                  "id": 13
                },
                "unresolved_named_lambda_variable": {
                  "type": "UnresolvedNamedLambdaVariable",
                  "id": 14
                },
                "common_inline_user_defined_function": {
                  "type": "CommonInlineUserDefinedFunction",
                  "id": 15
                },
                "call_function": {
                  "type": "CallFunction",
                  "id": 16
                },
                "named_argument_expression": {
                  "type": "NamedArgumentExpression",
                  "id": 17
                },
                "merge_action": {
                  "type": "MergeAction",
                  "id": 19
                },
                "typed_aggregate_expression": {
                  "type": "TypedAggregateExpression",
                  "id": 20
                },
                "subquery_expression": {
                  "type": "SubqueryExpression",
                  "id": 21
                },
                "direct_shuffle_partition_id": {
                  "type": "DirectShufflePartitionID",
                  "id": 22
                },
                "extension": {
                  "type": "google.protobuf.Any",
                  "id": 999
                }
              },
              "nested": {
                "Window": {
                  "fields": {
                    "window_function": {
                      "type": "Expression",
                      "id": 1
                    },
                    "partition_spec": {
                      "rule": "repeated",
                      "type": "Expression",
                      "id": 2
                    },
                    "order_spec": {
                      "rule": "repeated",
                      "type": "SortOrder",
                      "id": 3
                    },
                    "frame_spec": {
                      "type": "WindowFrame",
                      "id": 4
                    }
                  },
                  "nested": {
                    "WindowFrame": {
                      "fields": {
                        "frame_type": {
                          "type": "FrameType",
                          "id": 1
                        },
                        "lower": {
                          "type": "FrameBoundary",
                          "id": 2
                        },
                        "upper": {
                          "type": "FrameBoundary",
                          "id": 3
                        }
                      },
                      "nested": {
                        "FrameType": {
                          "values": {
                            "FRAME_TYPE_UNDEFINED": 0,
                            "FRAME_TYPE_ROW": 1,
                            "FRAME_TYPE_RANGE": 2
                          }
                        },
                        "FrameBoundary": {
                          "oneofs": {
                            "boundary": {
                              "oneof": [
                                "current_row",
                                "unbounded",
                                "value"
                              ]
                            }
                          },
                          "fields": {
                            "current_row": {
                              "type": "bool",
                              "id": 1
                            },
                            "unbounded": {
                              "type": "bool",
                              "id": 2
                            },
                            "value": {
                              "type": "Expression",
                              "id": 3
                            }
                          }
                        }
                      }
                    }
                  }
                },
                "SortOrder": {
                  "fields": {
                    "child": {
                      "type": "Expression",
                      "id": 1
                    },
                    "direction": {
                      "type": "SortDirection",
                      "id": 2
                    },
                    "null_ordering": {
                      "type": "NullOrdering",
                      "id": 3
                    }
                  },
                  "nested": {
                    "SortDirection": {
                      "values": {
                        "SORT_DIRECTION_UNSPECIFIED": 0,
                        "SORT_DIRECTION_ASCENDING": 1,
                        "SORT_DIRECTION_DESCENDING": 2
                      }
                    },
                    "NullOrdering": {
                      "values": {
                        "SORT_NULLS_UNSPECIFIED": 0,
                        "SORT_NULLS_FIRST": 1,
                        "SORT_NULLS_LAST": 2
                      }
                    }
                  }
                },
                "DirectShufflePartitionID": {
                  "fields": {
                    "child": {
                      "type": "Expression",
                      "id": 1
                    }
                  }
                },
                "Cast": {
                  "oneofs": {
                    "cast_to_type": {
                      "oneof": [
                        "type",
                        "type_str"
                      ]
                    }
                  },
                  "fields": {
                    "expr": {
                      "type": "Expression",
                      "id": 1
                    },
                    "type": {
                      "type": "DataType",
                      "id": 2
                    },
                    "type_str": {
                      "type": "string",
                      "id": 3
                    },
                    "eval_mode": {
                      "type": "EvalMode",
                      "id": 4
                    }
                  },
                  "nested": {
                    "EvalMode": {
                      "values": {
                        "EVAL_MODE_UNSPECIFIED": 0,
                        "EVAL_MODE_LEGACY": 1,
                        "EVAL_MODE_ANSI": 2,
                        "EVAL_MODE_TRY": 3
                      }
                    }
                  }
                },
                "Literal": {
                  "oneofs": {
                    "literal_type": {
                      "oneof": [
                        "null",
                        "binary",
                        "boolean",
                        "byte",
                        "short",
                        "integer",
                        "long",
                        "float",
                        "double",
                        "decimal",
                        "string",
                        "date",
                        "timestamp",
                        "timestamp_ntz",
                        "calendar_interval",
                        "year_month_interval",
                        "day_time_interval",
                        "array",
                        "map",
                        "struct",
                        "specialized_array",
                        "time"
                      ]
                    }
                  },
                  "fields": {
                    "null": {
                      "type": "DataType",
                      "id": 1
                    },
                    "binary": {
                      "type": "bytes",
                      "id": 2
                    },
                    "boolean": {
                      "type": "bool",
                      "id": 3
                    },
                    "byte": {
                      "type": "int32",
                      "id": 4
                    },
                    "short": {
                      "type": "int32",
                      "id": 5
                    },
                    "integer": {
                      "type": "int32",
                      "id": 6
                    },
                    "long": {
                      "type": "int64",
                      "id": 7
                    },
                    "float": {
                      "type": "float",
                      "id": 10
                    },
                    "double": {
                      "type": "double",
                      "id": 11
                    },
                    "decimal": {
                      "type": "Decimal",
                      "id": 12
                    },
                    "string": {
                      "type": "string",
                      "id": 13
                    },
                    "date": {
                      "type": "int32",
                      "id": 16
                    },
                    "timestamp": {
                      "type": "int64",
                      "id": 17
                    },
                    "timestamp_ntz": {
                      "type": "int64",
                      "id": 18
                    },
                    "calendar_interval": {
                      "type": "CalendarInterval",
                      "id": 19
                    },
                    "year_month_interval": {
                      "type": "int32",
                      "id": 20
                    },
                    "day_time_interval": {
                      "type": "int64",
                      "id": 21
                    },
                    "array": {
                      "type": "Array",
                      "id": 22
                    },
                    "map": {
                      "type": "Map",
                      "id": 23
                    },
                    "struct": {
                      "type": "Struct",
                      "id": 24
                    },
                    "specialized_array": {
                      "type": "SpecializedArray",
                      "id": 25
                    },
                    "time": {
                      "type": "Time",
                      "id": 26
                    },
                    "data_type": {
                      "type": "DataType",
                      "id": 100
                    }
                  },
                  "reserved": [
                    [
                      27,
                      27
                    ],
                    [
                      28,
                      28
                    ]
                  ],
                  "nested": {
                    "Decimal": {
                      "oneofs": {
                        "_precision": {
                          "oneof": [
                            "precision"
                          ]
                        },
                        "_scale": {
                          "oneof": [
                            "scale"
                          ]
                        }
                      },
                      "fields": {
                        "value": {
                          "type": "string",
                          "id": 1
                        },
                        "precision": {
                          "type": "int32",
                          "id": 2,
                          "options": {
                            "proto3_optional": true
                          }
                        },
                        "scale": {
                          "type": "int32",
                          "id": 3,
                          "options": {
                            "proto3_optional": true
                          }
                        }
                      }
                    },
                    "CalendarInterval": {
                      "fields": {
                        "months": {
                          "type": "int32",
                          "id": 1
                        },
                        "days": {
                          "type": "int32",
                          "id": 2
                        },
                        "microseconds": {
                          "type": "int64",
                          "id": 3
                        }
                      }
                    },
                    "Array": {
                      "fields": {
                        "element_type": {
                          "type": "DataType",
                          "id": 1,
                          "options": {
                            "deprecated": true
                          }
                        },
                        "elements": {
                          "rule": "repeated",
                          "type": "Literal",
                          "id": 2
                        }
                      }
                    },
                    "Map": {
                      "fields": {
                        "key_type": {
                          "type": "DataType",
                          "id": 1,
                          "options": {
                            "deprecated": true
                          }
                        },
                        "value_type": {
                          "type": "DataType",
                          "id": 2,
                          "options": {
                            "deprecated": true
                          }
                        },
                        "keys": {
                          "rule": "repeated",
                          "type": "Literal",
                          "id": 3
                        },
                        "values": {
                          "rule": "repeated",
                          "type": "Literal",
                          "id": 4
                        }
                      }
                    },
                    "Struct": {
                      "fields": {
                        "struct_type": {
                          "type": "DataType",
                          "id": 1,
                          "options": {
                            "deprecated": true
                          }
                        },
                        "elements": {
                          "rule": "repeated",
                          "type": "Literal",
                          "id": 2
                        }
                      }
                    },
                    "SpecializedArray": {
                      "oneofs": {
                        "value_type": {
                          "oneof": [
                            "bools",
                            "ints",
                            "longs",
                            "floats",
                            "doubles",
                            "strings"
                          ]
                        }
                      },
                      "fields": {
                        "bools": {
                          "type": "Bools",
                          "id": 1
                        },
                        "ints": {
                          "type": "Ints",
                          "id": 2
                        },
                        "longs": {
                          "type": "Longs",
                          "id": 3
                        },
                        "floats": {
                          "type": "Floats",
                          "id": 4
                        },
                        "doubles": {
                          "type": "Doubles",
                          "id": 5
                        },
                        "strings": {
                          "type": "Strings",
                          "id": 6
                        }
                      }
                    },
                    "Time": {
                      "oneofs": {
                        "_precision": {
                          "oneof": [
                            "precision"
                          ]
                        }
                      },
                      "fields": {
                        "nano": {
                          "type": "int64",
                          "id": 1
                        },
                        "precision": {
                          "type": "int32",
                          "id": 2,
                          "options": {
                            "proto3_optional": true
                          }
                        }
                      }
                    }
                  }
                },
                "UnresolvedAttribute": {
                  "oneofs": {
                    "_plan_id": {
                      "oneof": [
                        "plan_id"
                      ]
                    },
                    "_is_metadata_column": {
                      "oneof": [
                        "is_metadata_column"
                      ]
                    }
                  },
                  "fields": {
                    "unparsed_identifier": {
                      "type": "string",
                      "id": 1
                    },
                    "plan_id": {
                      "type": "int64",
                      "id": 2,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "is_metadata_column": {
                      "type": "bool",
                      "id": 3,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "UnresolvedFunction": {
                  "oneofs": {
                    "_is_internal": {
                      "oneof": [
                        "is_internal"
                      ]
                    }
                  },
                  "fields": {
                    "function_name": {
                      "type": "string",
                      "id": 1
                    },
                    "arguments": {
                      "rule": "repeated",
                      "type": "Expression",
                      "id": 2
                    },
                    "is_distinct": {
                      "type": "bool",
                      "id": 3
                    },
                    "is_user_defined_function": {
                      "type": "bool",
                      "id": 4
                    },
                    "is_internal": {
                      "type": "bool",
                      "id": 5,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "ExpressionString": {
                  "fields": {
                    "expression": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "UnresolvedStar": {
                  "oneofs": {
                    "_unparsed_target": {
                      "oneof": [
                        "unparsed_target"
                      ]
                    },
                    "_plan_id": {
                      "oneof": [
                        "plan_id"
                      ]
                    }
                  },
                  "fields": {
                    "unparsed_target": {
                      "type": "string",
                      "id": 1,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "plan_id": {
                      "type": "int64",
                      "id": 2,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "UnresolvedRegex": {
                  "oneofs": {
                    "_plan_id": {
                      "oneof": [
                        "plan_id"
                      ]
                    }
                  },
                  "fields": {
                    "col_name": {
                      "type": "string",
                      "id": 1
                    },
                    "plan_id": {
                      "type": "int64",
                      "id": 2,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "UnresolvedExtractValue": {
                  "fields": {
                    "child": {
                      "type": "Expression",
                      "id": 1
                    },
                    "extraction": {
                      "type": "Expression",
                      "id": 2
                    }
                  }
                },
                "UpdateFields": {
                  "fields": {
                    "struct_expression": {
                      "type": "Expression",
                      "id": 1
                    },
                    "field_name": {
                      "type": "string",
                      "id": 2
                    },
                    "value_expression": {
                      "type": "Expression",
                      "id": 3
                    }
                  }
                },
                "Alias": {
                  "oneofs": {
                    "_metadata": {
                      "oneof": [
                        "metadata"
                      ]
                    }
                  },
                  "fields": {
                    "expr": {
                      "type": "Expression",
                      "id": 1
                    },
                    "name": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 2
                    },
                    "metadata": {
                      "type": "string",
                      "id": 3,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "LambdaFunction": {
                  "fields": {
                    "function": {
                      "type": "Expression",
                      "id": 1
                    },
                    "arguments": {
                      "rule": "repeated",
                      "type": "Expression.UnresolvedNamedLambdaVariable",
                      "id": 2
                    }
                  }
                },
                "UnresolvedNamedLambdaVariable": {
                  "fields": {
                    "name_parts": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 1
                    }
                  }
                }
              }
            },
            "ExpressionCommon": {
              "fields": {
                "origin": {
                  "type": "Origin",
                  "id": 1
                }
              }
            },
            "CommonInlineUserDefinedFunction": {
              "oneofs": {
                "function": {
                  "oneof": [
                    "python_udf",
                    "scalar_scala_udf",
                    "java_udf"
                  ]
                }
              },
              "fields": {
                "function_name": {
                  "type": "string",
                  "id": 1
                },
                "deterministic": {
                  "type": "bool",
                  "id": 2
                },
                "arguments": {
                  "rule": "repeated",
                  "type": "Expression",
                  "id": 3
                },
                "python_udf": {
                  "type": "PythonUDF",
                  "id": 4
                },
                "scalar_scala_udf": {
                  "type": "ScalarScalaUDF",
                  "id": 5
                },
                "java_udf": {
                  "type": "JavaUDF",
                  "id": 6
                },
                "is_distinct": {
                  "type": "bool",
                  "id": 7
                }
              }
            },
            "PythonUDF": {
              "fields": {
                "output_type": {
                  "type": "DataType",
                  "id": 1
                },
                "eval_type": {
                  "type": "int32",
                  "id": 2
                },
                "command": {
                  "type": "bytes",
                  "id": 3
                },
                "python_ver": {
                  "type": "string",
                  "id": 4
                },
                "additional_includes": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 5
                }
              }
            },
            "ScalarScalaUDF": {
              "fields": {
                "payload": {
                  "type": "bytes",
                  "id": 1
                },
                "inputTypes": {
                  "rule": "repeated",
                  "type": "DataType",
                  "id": 2
                },
                "outputType": {
                  "type": "DataType",
                  "id": 3
                },
                "nullable": {
                  "type": "bool",
                  "id": 4
                },
                "aggregate": {
                  "type": "bool",
                  "id": 5
                }
              }
            },
            "JavaUDF": {
              "oneofs": {
                "_output_type": {
                  "oneof": [
                    "output_type"
                  ]
                }
              },
              "fields": {
                "class_name": {
                  "type": "string",
                  "id": 1
                },
                "output_type": {
                  "type": "DataType",
                  "id": 2,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "aggregate": {
                  "type": "bool",
                  "id": 3
                }
              }
            },
            "TypedAggregateExpression": {
              "fields": {
                "scalar_scala_udf": {
                  "type": "ScalarScalaUDF",
                  "id": 1
                }
              }
            },
            "CallFunction": {
              "fields": {
                "function_name": {
                  "type": "string",
                  "id": 1
                },
                "arguments": {
                  "rule": "repeated",
                  "type": "Expression",
                  "id": 2
                }
              }
            },
            "NamedArgumentExpression": {
              "fields": {
                "key": {
                  "type": "string",
                  "id": 1
                },
                "value": {
                  "type": "Expression",
                  "id": 2
                }
              }
            },
            "MergeAction": {
              "oneofs": {
                "_condition": {
                  "oneof": [
                    "condition"
                  ]
                }
              },
              "fields": {
                "action_type": {
                  "type": "ActionType",
                  "id": 1
                },
                "condition": {
                  "type": "Expression",
                  "id": 2,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "assignments": {
                  "rule": "repeated",
                  "type": "Assignment",
                  "id": 3
                }
              },
              "nested": {
                "ActionType": {
                  "values": {
                    "ACTION_TYPE_INVALID": 0,
                    "ACTION_TYPE_DELETE": 1,
                    "ACTION_TYPE_INSERT": 2,
                    "ACTION_TYPE_INSERT_STAR": 3,
                    "ACTION_TYPE_UPDATE": 4,
                    "ACTION_TYPE_UPDATE_STAR": 5
                  }
                },
                "Assignment": {
                  "fields": {
                    "key": {
                      "type": "Expression",
                      "id": 1
                    },
                    "value": {
                      "type": "Expression",
                      "id": 2
                    }
                  }
                }
              }
            },
            "SubqueryExpression": {
              "oneofs": {
                "_table_arg_options": {
                  "oneof": [
                    "table_arg_options"
                  ]
                }
              },
              "fields": {
                "plan_id": {
                  "type": "int64",
                  "id": 1
                },
                "subquery_type": {
                  "type": "SubqueryType",
                  "id": 2
                },
                "table_arg_options": {
                  "type": "TableArgOptions",
                  "id": 3,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "in_subquery_values": {
                  "rule": "repeated",
                  "type": "Expression",
                  "id": 4
                }
              },
              "nested": {
                "SubqueryType": {
                  "values": {
                    "SUBQUERY_TYPE_UNKNOWN": 0,
                    "SUBQUERY_TYPE_SCALAR": 1,
                    "SUBQUERY_TYPE_EXISTS": 2,
                    "SUBQUERY_TYPE_TABLE_ARG": 3,
                    "SUBQUERY_TYPE_IN": 4
                  }
                },
                "TableArgOptions": {
                  "oneofs": {
                    "_with_single_partition": {
                      "oneof": [
                        "with_single_partition"
                      ]
                    }
                  },
                  "fields": {
                    "partition_spec": {
                      "rule": "repeated",
                      "type": "Expression",
                      "id": 1
                    },
                    "order_spec": {
                      "rule": "repeated",
                      "type": "Expression.SortOrder",
                      "id": 2
                    },
                    "with_single_partition": {
                      "type": "bool",
                      "id": 3,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                }
              }
            },
            "DataType": {
              "oneofs": {
                "kind": {
                  "oneof": [
                    "null",
                    "binary",
                    "boolean",
                    "byte",
                    "short",
                    "integer",
                    "long",
                    "float",
                    "double",
                    "decimal",
                    "string",
                    "char",
                    "var_char",
                    "date",
                    "timestamp",
                    "timestamp_ntz",
                    "calendar_interval",
                    "year_month_interval",
                    "day_time_interval",
                    "array",
                    "struct",
                    "map",
                    "variant",
                    "udt",
                    "geometry",
                    "geography",
                    "unparsed",
                    "time"
                  ]
                }
              },
              "fields": {
                "null": {
                  "type": "NULL",
                  "id": 1
                },
                "binary": {
                  "type": "Binary",
                  "id": 2
                },
                "boolean": {
                  "type": "Boolean",
                  "id": 3
                },
                "byte": {
                  "type": "Byte",
                  "id": 4
                },
                "short": {
                  "type": "Short",
                  "id": 5
                },
                "integer": {
                  "type": "Integer",
                  "id": 6
                },
                "long": {
                  "type": "Long",
                  "id": 7
                },
                "float": {
                  "type": "Float",
                  "id": 8
                },
                "double": {
                  "type": "Double",
                  "id": 9
                },
                "decimal": {
                  "type": "Decimal",
                  "id": 10
                },
                "string": {
                  "type": "String",
                  "id": 11
                },
                "char": {
                  "type": "Char",
                  "id": 12
                },
                "var_char": {
                  "type": "VarChar",
                  "id": 13
                },
                "date": {
                  "type": "Date",
                  "id": 14
                },
                "timestamp": {
                  "type": "Timestamp",
                  "id": 15
                },
                "timestamp_ntz": {
                  "type": "TimestampNTZ",
                  "id": 16
                },
                "calendar_interval": {
                  "type": "CalendarInterval",
                  "id": 17
                },
                "year_month_interval": {
                  "type": "YearMonthInterval",
                  "id": 18
                },
                "day_time_interval": {
                  "type": "DayTimeInterval",
                  "id": 19
                },
                "array": {
                  "type": "Array",
                  "id": 20
                },
                "struct": {
                  "type": "Struct",
                  "id": 21
                },
                "map": {
                  "type": "Map",
                  "id": 22
                },
                "variant": {
                  "type": "Variant",
                  "id": 25
                },
                "udt": {
                  "type": "UDT",
                  "id": 23
                },
                "geometry": {
                  "type": "Geometry",
                  "id": 26
                },
                "geography": {
                  "type": "Geography",
                  "id": 27
                },
                "unparsed": {
                  "type": "Unparsed",
                  "id": 24
                },
                "time": {
                  "type": "Time",
                  "id": 28
                }
              },
              "nested": {
                "Boolean": {
                  "fields": {
                    "type_variation_reference": {
                      "type": "uint32",
                      "id": 1
                    }
                  }
                },
                "Byte": {
                  "fields": {
                    "type_variation_reference": {
                      "type": "uint32",
                      "id": 1
                    }
                  }
                },
                "Short": {
                  "fields": {
                    "type_variation_reference": {
                      "type": "uint32",
                      "id": 1
                    }
                  }
                },
                "Integer": {
                  "fields": {
                    "type_variation_reference": {
                      "type": "uint32",
                      "id": 1
                    }
                  }
                },
                "Long": {
                  "fields": {
                    "type_variation_reference": {
                      "type": "uint32",
                      "id": 1
                    }
                  }
                },
                "Float": {
                  "fields": {
                    "type_variation_reference": {
                      "type": "uint32",
                      "id": 1
                    }
                  }
                },
                "Double": {
                  "fields": {
                    "type_variation_reference": {
                      "type": "uint32",
                      "id": 1
                    }
                  }
                },
                "String": {
                  "fields": {
                    "type_variation_reference": {
                      "type": "uint32",
                      "id": 1
                    },
                    "collation": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "Binary": {
                  "fields": {
                    "type_variation_reference": {
                      "type": "uint32",
                      "id": 1
                    }
                  }
                },
                "NULL": {
                  "fields": {
                    "type_variation_reference": {
                      "type": "uint32",
                      "id": 1
                    }
                  }
                },
                "Timestamp": {
                  "fields": {
                    "type_variation_reference": {
                      "type": "uint32",
                      "id": 1
                    }
                  }
                },
                "Date": {
                  "fields": {
                    "type_variation_reference": {
                      "type": "uint32",
                      "id": 1
                    }
                  }
                },
                "TimestampNTZ": {
                  "fields": {
                    "type_variation_reference": {
                      "type": "uint32",
                      "id": 1
                    }
                  }
                },
                "Time": {
                  "oneofs": {
                    "_precision": {
                      "oneof": [
                        "precision"
                      ]
                    }
                  },
                  "fields": {
                    "precision": {
                      "type": "int32",
                      "id": 1,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "type_variation_reference": {
                      "type": "uint32",
                      "id": 2
                    }
                  }
                },
                "CalendarInterval": {
                  "fields": {
                    "type_variation_reference": {
                      "type": "uint32",
                      "id": 1
                    }
                  }
                },
                "YearMonthInterval": {
                  "oneofs": {
                    "_start_field": {
                      "oneof": [
                        "start_field"
                      ]
                    },
                    "_end_field": {
                      "oneof": [
                        "end_field"
                      ]
                    }
                  },
                  "fields": {
                    "start_field": {
                      "type": "int32",
                      "id": 1,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "end_field": {
                      "type": "int32",
                      "id": 2,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "type_variation_reference": {
                      "type": "uint32",
                      "id": 3
                    }
                  }
                },
                "DayTimeInterval": {
                  "oneofs": {
                    "_start_field": {
                      "oneof": [
                        "start_field"
                      ]
                    },
                    "_end_field": {
                      "oneof": [
                        "end_field"
                      ]
                    }
                  },
                  "fields": {
                    "start_field": {
                      "type": "int32",
                      "id": 1,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "end_field": {
                      "type": "int32",
                      "id": 2,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "type_variation_reference": {
                      "type": "uint32",
                      "id": 3
                    }
                  }
                },
                "Char": {
                  "fields": {
                    "length": {
                      "type": "int32",
                      "id": 1
                    },
                    "type_variation_reference": {
                      "type": "uint32",
                      "id": 2
                    }
                  }
                },
                "VarChar": {
                  "fields": {
                    "length": {
                      "type": "int32",
                      "id": 1
                    },
                    "type_variation_reference": {
                      "type": "uint32",
                      "id": 2
                    }
                  }
                },
                "Decimal": {
                  "oneofs": {
                    "_scale": {
                      "oneof": [
                        "scale"
                      ]
                    },
                    "_precision": {
                      "oneof": [
                        "precision"
                      ]
                    }
                  },
                  "fields": {
                    "scale": {
                      "type": "int32",
                      "id": 1,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "precision": {
                      "type": "int32",
                      "id": 2,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "type_variation_reference": {
                      "type": "uint32",
                      "id": 3
                    }
                  }
                },
                "StructField": {
                  "oneofs": {
                    "_metadata": {
                      "oneof": [
                        "metadata"
                      ]
                    }
                  },
                  "fields": {
                    "name": {
                      "type": "string",
                      "id": 1
                    },
                    "data_type": {
                      "type": "DataType",
                      "id": 2
                    },
                    "nullable": {
                      "type": "bool",
                      "id": 3
                    },
                    "metadata": {
                      "type": "string",
                      "id": 4,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "Struct": {
                  "fields": {
                    "fields": {
                      "rule": "repeated",
                      "type": "StructField",
                      "id": 1
                    },
                    "type_variation_reference": {
                      "type": "uint32",
                      "id": 2
                    }
                  }
                },
                "Array": {
                  "fields": {
                    "element_type": {
                      "type": "DataType",
                      "id": 1
                    },
                    "contains_null": {
                      "type": "bool",
                      "id": 2
                    },
                    "type_variation_reference": {
                      "type": "uint32",
                      "id": 3
                    }
                  }
                },
                "Map": {
                  "fields": {
                    "key_type": {
                      "type": "DataType",
                      "id": 1
                    },
                    "value_type": {
                      "type": "DataType",
                      "id": 2
                    },
                    "value_contains_null": {
                      "type": "bool",
                      "id": 3
                    },
                    "type_variation_reference": {
                      "type": "uint32",
                      "id": 4
                    }
                  }
                },
                "Geometry": {
                  "fields": {
                    "srid": {
                      "type": "int32",
                      "id": 1
                    },
                    "type_variation_reference": {
                      "type": "uint32",
                      "id": 2
                    }
                  }
                },
                "Geography": {
                  "fields": {
                    "srid": {
                      "type": "int32",
                      "id": 1
                    },
                    "type_variation_reference": {
                      "type": "uint32",
                      "id": 2
                    }
                  }
                },
                "Variant": {
                  "fields": {
                    "type_variation_reference": {
                      "type": "uint32",
                      "id": 1
                    }
                  }
                },
                "UDT": {
                  "oneofs": {
                    "_jvm_class": {
                      "oneof": [
                        "jvm_class"
                      ]
                    },
                    "_python_class": {
                      "oneof": [
                        "python_class"
                      ]
                    },
                    "_serialized_python_class": {
                      "oneof": [
                        "serialized_python_class"
                      ]
                    },
                    "_sql_type": {
                      "oneof": [
                        "sql_type"
                      ]
                    }
                  },
                  "fields": {
                    "type": {
                      "type": "string",
                      "id": 1
                    },
                    "jvm_class": {
                      "type": "string",
                      "id": 2,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "python_class": {
                      "type": "string",
                      "id": 3,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "serialized_python_class": {
                      "type": "string",
                      "id": 4,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "sql_type": {
                      "type": "DataType",
                      "id": 5,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "Unparsed": {
                  "fields": {
                    "data_type_string": {
                      "type": "string",
                      "id": 1
                    }
                  }
                }
              }
            },
            "Relation": {
              "oneofs": {
                "rel_type": {
                  "oneof": [
                    "read",
                    "project",
                    "filter",
                    "join",
                    "set_op",
                    "sort",
                    "limit",
                    "aggregate",
                    "sql",
                    "local_relation",
                    "sample",
                    "offset",
                    "deduplicate",
                    "range",
                    "subquery_alias",
                    "repartition",
                    "to_df",
                    "with_columns_renamed",
                    "show_string",
                    "drop",
                    "tail",
                    "with_columns",
                    "hint",
                    "unpivot",
                    "to_schema",
                    "repartition_by_expression",
                    "map_partitions",
                    "collect_metrics",
                    "parse",
                    "group_map",
                    "co_group_map",
                    "with_watermark",
                    "apply_in_pandas_with_state",
                    "html_string",
                    "cached_local_relation",
                    "cached_remote_relation",
                    "common_inline_user_defined_table_function",
                    "as_of_join",
                    "common_inline_user_defined_data_source",
                    "with_relations",
                    "transpose",
                    "unresolved_table_valued_function",
                    "lateral_join",
                    "chunked_cached_local_relation",
                    "relation_changes",
                    "nearest_by_join",
                    "fill_na",
                    "drop_na",
                    "replace",
                    "summary",
                    "crosstab",
                    "describe",
                    "cov",
                    "corr",
                    "approx_quantile",
                    "freq_items",
                    "sample_by",
                    "catalog",
                    "ml_relation",
                    "extension",
                    "unknown"
                  ]
                }
              },
              "fields": {
                "common": {
                  "type": "RelationCommon",
                  "id": 1
                },
                "read": {
                  "type": "Read",
                  "id": 2
                },
                "project": {
                  "type": "Project",
                  "id": 3
                },
                "filter": {
                  "type": "Filter",
                  "id": 4
                },
                "join": {
                  "type": "Join",
                  "id": 5
                },
                "set_op": {
                  "type": "SetOperation",
                  "id": 6
                },
                "sort": {
                  "type": "Sort",
                  "id": 7
                },
                "limit": {
                  "type": "Limit",
                  "id": 8
                },
                "aggregate": {
                  "type": "Aggregate",
                  "id": 9
                },
                "sql": {
                  "type": "SQL",
                  "id": 10
                },
                "local_relation": {
                  "type": "LocalRelation",
                  "id": 11
                },
                "sample": {
                  "type": "Sample",
                  "id": 12
                },
                "offset": {
                  "type": "Offset",
                  "id": 13
                },
                "deduplicate": {
                  "type": "Deduplicate",
                  "id": 14
                },
                "range": {
                  "type": "Range",
                  "id": 15
                },
                "subquery_alias": {
                  "type": "SubqueryAlias",
                  "id": 16
                },
                "repartition": {
                  "type": "Repartition",
                  "id": 17
                },
                "to_df": {
                  "type": "ToDF",
                  "id": 18
                },
                "with_columns_renamed": {
                  "type": "WithColumnsRenamed",
                  "id": 19
                },
                "show_string": {
                  "type": "ShowString",
                  "id": 20
                },
                "drop": {
                  "type": "Drop",
                  "id": 21
                },
                "tail": {
                  "type": "Tail",
                  "id": 22
                },
                "with_columns": {
                  "type": "WithColumns",
                  "id": 23
                },
                "hint": {
                  "type": "Hint",
                  "id": 24
                },
                "unpivot": {
                  "type": "Unpivot",
                  "id": 25
                },
                "to_schema": {
                  "type": "ToSchema",
                  "id": 26
                },
                "repartition_by_expression": {
                  "type": "RepartitionByExpression",
                  "id": 27
                },
                "map_partitions": {
                  "type": "MapPartitions",
                  "id": 28
                },
                "collect_metrics": {
                  "type": "CollectMetrics",
                  "id": 29
                },
                "parse": {
                  "type": "Parse",
                  "id": 30
                },
                "group_map": {
                  "type": "GroupMap",
                  "id": 31
                },
                "co_group_map": {
                  "type": "CoGroupMap",
                  "id": 32
                },
                "with_watermark": {
                  "type": "WithWatermark",
                  "id": 33
                },
                "apply_in_pandas_with_state": {
                  "type": "ApplyInPandasWithState",
                  "id": 34
                },
                "html_string": {
                  "type": "HtmlString",
                  "id": 35
                },
                "cached_local_relation": {
                  "type": "CachedLocalRelation",
                  "id": 36
                },
                "cached_remote_relation": {
                  "type": "CachedRemoteRelation",
                  "id": 37
                },
                "common_inline_user_defined_table_function": {
                  "type": "CommonInlineUserDefinedTableFunction",
                  "id": 38
                },
                "as_of_join": {
                  "type": "AsOfJoin",
                  "id": 39
                },
                "common_inline_user_defined_data_source": {
                  "type": "CommonInlineUserDefinedDataSource",
                  "id": 40
                },
                "with_relations": {
                  "type": "WithRelations",
                  "id": 41
                },
                "transpose": {
                  "type": "Transpose",
                  "id": 42
                },
                "unresolved_table_valued_function": {
                  "type": "UnresolvedTableValuedFunction",
                  "id": 43
                },
                "lateral_join": {
                  "type": "LateralJoin",
                  "id": 44
                },
                "chunked_cached_local_relation": {
                  "type": "ChunkedCachedLocalRelation",
                  "id": 45
                },
                "relation_changes": {
                  "type": "RelationChanges",
                  "id": 46
                },
                "nearest_by_join": {
                  "type": "NearestByJoin",
                  "id": 47
                },
                "fill_na": {
                  "type": "NAFill",
                  "id": 90
                },
                "drop_na": {
                  "type": "NADrop",
                  "id": 91
                },
                "replace": {
                  "type": "NAReplace",
                  "id": 92
                },
                "summary": {
                  "type": "StatSummary",
                  "id": 100
                },
                "crosstab": {
                  "type": "StatCrosstab",
                  "id": 101
                },
                "describe": {
                  "type": "StatDescribe",
                  "id": 102
                },
                "cov": {
                  "type": "StatCov",
                  "id": 103
                },
                "corr": {
                  "type": "StatCorr",
                  "id": 104
                },
                "approx_quantile": {
                  "type": "StatApproxQuantile",
                  "id": 105
                },
                "freq_items": {
                  "type": "StatFreqItems",
                  "id": 106
                },
                "sample_by": {
                  "type": "StatSampleBy",
                  "id": 107
                },
                "catalog": {
                  "type": "Catalog",
                  "id": 200
                },
                "ml_relation": {
                  "type": "MlRelation",
                  "id": 300
                },
                "extension": {
                  "type": "google.protobuf.Any",
                  "id": 998
                },
                "unknown": {
                  "type": "Unknown",
                  "id": 999
                }
              }
            },
            "MlRelation": {
              "oneofs": {
                "ml_type": {
                  "oneof": [
                    "transform",
                    "fetch"
                  ]
                },
                "_model_summary_dataset": {
                  "oneof": [
                    "model_summary_dataset"
                  ]
                }
              },
              "fields": {
                "transform": {
                  "type": "Transform",
                  "id": 1
                },
                "fetch": {
                  "type": "Fetch",
                  "id": 2
                },
                "model_summary_dataset": {
                  "type": "Relation",
                  "id": 3,
                  "options": {
                    "proto3_optional": true
                  }
                }
              },
              "nested": {
                "Transform": {
                  "oneofs": {
                    "operator": {
                      "oneof": [
                        "obj_ref",
                        "transformer"
                      ]
                    }
                  },
                  "fields": {
                    "obj_ref": {
                      "type": "ObjectRef",
                      "id": 1
                    },
                    "transformer": {
                      "type": "MlOperator",
                      "id": 2
                    },
                    "input": {
                      "type": "Relation",
                      "id": 3
                    },
                    "params": {
                      "type": "MlParams",
                      "id": 4
                    }
                  }
                }
              }
            },
            "Fetch": {
              "fields": {
                "obj_ref": {
                  "type": "ObjectRef",
                  "id": 1
                },
                "methods": {
                  "rule": "repeated",
                  "type": "Method",
                  "id": 2
                }
              },
              "nested": {
                "Method": {
                  "fields": {
                    "method": {
                      "type": "string",
                      "id": 1
                    },
                    "args": {
                      "rule": "repeated",
                      "type": "Args",
                      "id": 2
                    }
                  },
                  "nested": {
                    "Args": {
                      "oneofs": {
                        "args_type": {
                          "oneof": [
                            "param",
                            "input"
                          ]
                        }
                      },
                      "fields": {
                        "param": {
                          "type": "Expression.Literal",
                          "id": 1
                        },
                        "input": {
                          "type": "Relation",
                          "id": 2
                        }
                      }
                    }
                  }
                }
              }
            },
            "Unknown": {
              "fields": {}
            },
            "RelationCommon": {
              "oneofs": {
                "_plan_id": {
                  "oneof": [
                    "plan_id"
                  ]
                }
              },
              "fields": {
                "source_info": {
                  "type": "string",
                  "id": 1,
                  "options": {
                    "deprecated": true
                  }
                },
                "plan_id": {
                  "type": "int64",
                  "id": 2,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "origin": {
                  "type": "Origin",
                  "id": 3
                }
              }
            },
            "SQL": {
              "fields": {
                "query": {
                  "type": "string",
                  "id": 1
                },
                "args": {
                  "keyType": "string",
                  "type": "Expression.Literal",
                  "id": 2,
                  "options": {
                    "deprecated": true
                  }
                },
                "pos_args": {
                  "rule": "repeated",
                  "type": "Expression.Literal",
                  "id": 3,
                  "options": {
                    "deprecated": true
                  }
                },
                "named_arguments": {
                  "keyType": "string",
                  "type": "Expression",
                  "id": 4
                },
                "pos_arguments": {
                  "rule": "repeated",
                  "type": "Expression",
                  "id": 5
                }
              }
            },
            "WithRelations": {
              "fields": {
                "root": {
                  "type": "Relation",
                  "id": 1
                },
                "references": {
                  "rule": "repeated",
                  "type": "Relation",
                  "id": 2
                }
              }
            },
            "Read": {
              "oneofs": {
                "read_type": {
                  "oneof": [
                    "named_table",
                    "data_source"
                  ]
                }
              },
              "fields": {
                "named_table": {
                  "type": "NamedTable",
                  "id": 1
                },
                "data_source": {
                  "type": "DataSource",
                  "id": 2
                },
                "is_streaming": {
                  "type": "bool",
                  "id": 3
                }
              },
              "nested": {
                "NamedTable": {
                  "fields": {
                    "unparsed_identifier": {
                      "type": "string",
                      "id": 1
                    },
                    "options": {
                      "keyType": "string",
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "DataSource": {
                  "oneofs": {
                    "_format": {
                      "oneof": [
                        "format"
                      ]
                    },
                    "_schema": {
                      "oneof": [
                        "schema"
                      ]
                    },
                    "_source_name": {
                      "oneof": [
                        "source_name"
                      ]
                    }
                  },
                  "fields": {
                    "format": {
                      "type": "string",
                      "id": 1,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "schema": {
                      "type": "string",
                      "id": 2,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "options": {
                      "keyType": "string",
                      "type": "string",
                      "id": 3
                    },
                    "paths": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 4
                    },
                    "predicates": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 5
                    },
                    "source_name": {
                      "type": "string",
                      "id": 6,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                }
              }
            },
            "RelationChanges": {
              "fields": {
                "unparsed_identifier": {
                  "type": "string",
                  "id": 1
                },
                "options": {
                  "keyType": "string",
                  "type": "string",
                  "id": 2
                },
                "is_streaming": {
                  "type": "bool",
                  "id": 3
                }
              }
            },
            "Project": {
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "expressions": {
                  "rule": "repeated",
                  "type": "Expression",
                  "id": 3
                }
              }
            },
            "Filter": {
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "condition": {
                  "type": "Expression",
                  "id": 2
                }
              }
            },
            "Join": {
              "oneofs": {
                "_join_data_type": {
                  "oneof": [
                    "join_data_type"
                  ]
                }
              },
              "fields": {
                "left": {
                  "type": "Relation",
                  "id": 1
                },
                "right": {
                  "type": "Relation",
                  "id": 2
                },
                "join_condition": {
                  "type": "Expression",
                  "id": 3
                },
                "join_type": {
                  "type": "JoinType",
                  "id": 4
                },
                "using_columns": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 5
                },
                "join_data_type": {
                  "type": "JoinDataType",
                  "id": 6,
                  "options": {
                    "proto3_optional": true
                  }
                }
              },
              "nested": {
                "JoinType": {
                  "values": {
                    "JOIN_TYPE_UNSPECIFIED": 0,
                    "JOIN_TYPE_INNER": 1,
                    "JOIN_TYPE_FULL_OUTER": 2,
                    "JOIN_TYPE_LEFT_OUTER": 3,
                    "JOIN_TYPE_RIGHT_OUTER": 4,
                    "JOIN_TYPE_LEFT_ANTI": 5,
                    "JOIN_TYPE_LEFT_SEMI": 6,
                    "JOIN_TYPE_CROSS": 7
                  }
                },
                "JoinDataType": {
                  "fields": {
                    "is_left_struct": {
                      "type": "bool",
                      "id": 1
                    },
                    "is_right_struct": {
                      "type": "bool",
                      "id": 2
                    }
                  }
                }
              }
            },
            "SetOperation": {
              "oneofs": {
                "_is_all": {
                  "oneof": [
                    "is_all"
                  ]
                },
                "_by_name": {
                  "oneof": [
                    "by_name"
                  ]
                },
                "_allow_missing_columns": {
                  "oneof": [
                    "allow_missing_columns"
                  ]
                }
              },
              "fields": {
                "left_input": {
                  "type": "Relation",
                  "id": 1
                },
                "right_input": {
                  "type": "Relation",
                  "id": 2
                },
                "set_op_type": {
                  "type": "SetOpType",
                  "id": 3
                },
                "is_all": {
                  "type": "bool",
                  "id": 4,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "by_name": {
                  "type": "bool",
                  "id": 5,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "allow_missing_columns": {
                  "type": "bool",
                  "id": 6,
                  "options": {
                    "proto3_optional": true
                  }
                }
              },
              "nested": {
                "SetOpType": {
                  "values": {
                    "SET_OP_TYPE_UNSPECIFIED": 0,
                    "SET_OP_TYPE_INTERSECT": 1,
                    "SET_OP_TYPE_UNION": 2,
                    "SET_OP_TYPE_EXCEPT": 3
                  }
                }
              }
            },
            "Limit": {
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "limit": {
                  "type": "int32",
                  "id": 2
                }
              }
            },
            "Offset": {
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "offset": {
                  "type": "int32",
                  "id": 2
                }
              }
            },
            "Tail": {
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "limit": {
                  "type": "int32",
                  "id": 2
                }
              }
            },
            "Aggregate": {
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "group_type": {
                  "type": "GroupType",
                  "id": 2
                },
                "grouping_expressions": {
                  "rule": "repeated",
                  "type": "Expression",
                  "id": 3
                },
                "aggregate_expressions": {
                  "rule": "repeated",
                  "type": "Expression",
                  "id": 4
                },
                "pivot": {
                  "type": "Pivot",
                  "id": 5
                },
                "grouping_sets": {
                  "rule": "repeated",
                  "type": "GroupingSets",
                  "id": 6
                }
              },
              "nested": {
                "GroupType": {
                  "values": {
                    "GROUP_TYPE_UNSPECIFIED": 0,
                    "GROUP_TYPE_GROUPBY": 1,
                    "GROUP_TYPE_ROLLUP": 2,
                    "GROUP_TYPE_CUBE": 3,
                    "GROUP_TYPE_PIVOT": 4,
                    "GROUP_TYPE_GROUPING_SETS": 5
                  }
                },
                "Pivot": {
                  "fields": {
                    "col": {
                      "type": "Expression",
                      "id": 1
                    },
                    "values": {
                      "rule": "repeated",
                      "type": "Expression.Literal",
                      "id": 2
                    }
                  }
                },
                "GroupingSets": {
                  "fields": {
                    "grouping_set": {
                      "rule": "repeated",
                      "type": "Expression",
                      "id": 1
                    }
                  }
                }
              }
            },
            "Sort": {
              "oneofs": {
                "_is_global": {
                  "oneof": [
                    "is_global"
                  ]
                }
              },
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "order": {
                  "rule": "repeated",
                  "type": "Expression.SortOrder",
                  "id": 2
                },
                "is_global": {
                  "type": "bool",
                  "id": 3,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "Drop": {
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "columns": {
                  "rule": "repeated",
                  "type": "Expression",
                  "id": 2
                },
                "column_names": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 3
                }
              }
            },
            "Deduplicate": {
              "oneofs": {
                "_all_columns_as_keys": {
                  "oneof": [
                    "all_columns_as_keys"
                  ]
                },
                "_within_watermark": {
                  "oneof": [
                    "within_watermark"
                  ]
                }
              },
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "column_names": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 2
                },
                "all_columns_as_keys": {
                  "type": "bool",
                  "id": 3,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "within_watermark": {
                  "type": "bool",
                  "id": 4,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "LocalRelation": {
              "oneofs": {
                "_data": {
                  "oneof": [
                    "data"
                  ]
                },
                "_schema": {
                  "oneof": [
                    "schema"
                  ]
                }
              },
              "fields": {
                "data": {
                  "type": "bytes",
                  "id": 1,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "schema": {
                  "type": "string",
                  "id": 2,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "CachedLocalRelation": {
              "fields": {
                "hash": {
                  "type": "string",
                  "id": 3
                }
              },
              "reserved": [
                [
                  1,
                  1
                ],
                [
                  2,
                  2
                ],
                "userId",
                "sessionId"
              ]
            },
            "ChunkedCachedLocalRelation": {
              "oneofs": {
                "_schemaHash": {
                  "oneof": [
                    "schemaHash"
                  ]
                }
              },
              "fields": {
                "dataHashes": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 1
                },
                "schemaHash": {
                  "type": "string",
                  "id": 2,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "CachedRemoteRelation": {
              "fields": {
                "relation_id": {
                  "type": "string",
                  "id": 1
                }
              }
            },
            "Sample": {
              "oneofs": {
                "_with_replacement": {
                  "oneof": [
                    "with_replacement"
                  ]
                },
                "_seed": {
                  "oneof": [
                    "seed"
                  ]
                }
              },
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "lower_bound": {
                  "type": "double",
                  "id": 2
                },
                "upper_bound": {
                  "type": "double",
                  "id": 3
                },
                "with_replacement": {
                  "type": "bool",
                  "id": 4,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "seed": {
                  "type": "int64",
                  "id": 5,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "deterministic_order": {
                  "type": "bool",
                  "id": 6
                }
              }
            },
            "Range": {
              "oneofs": {
                "_start": {
                  "oneof": [
                    "start"
                  ]
                },
                "_num_partitions": {
                  "oneof": [
                    "num_partitions"
                  ]
                }
              },
              "fields": {
                "start": {
                  "type": "int64",
                  "id": 1,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "end": {
                  "type": "int64",
                  "id": 2
                },
                "step": {
                  "type": "int64",
                  "id": 3
                },
                "num_partitions": {
                  "type": "int32",
                  "id": 4,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "SubqueryAlias": {
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "alias": {
                  "type": "string",
                  "id": 2
                },
                "qualifier": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 3
                }
              }
            },
            "Repartition": {
              "oneofs": {
                "_shuffle": {
                  "oneof": [
                    "shuffle"
                  ]
                }
              },
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "num_partitions": {
                  "type": "int32",
                  "id": 2
                },
                "shuffle": {
                  "type": "bool",
                  "id": 3,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "ShowString": {
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "num_rows": {
                  "type": "int32",
                  "id": 2
                },
                "truncate": {
                  "type": "int32",
                  "id": 3
                },
                "vertical": {
                  "type": "bool",
                  "id": 4
                }
              }
            },
            "HtmlString": {
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "num_rows": {
                  "type": "int32",
                  "id": 2
                },
                "truncate": {
                  "type": "int32",
                  "id": 3
                }
              }
            },
            "StatSummary": {
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "statistics": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 2
                }
              }
            },
            "StatDescribe": {
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "cols": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 2
                }
              }
            },
            "StatCrosstab": {
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "col1": {
                  "type": "string",
                  "id": 2
                },
                "col2": {
                  "type": "string",
                  "id": 3
                }
              }
            },
            "StatCov": {
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "col1": {
                  "type": "string",
                  "id": 2
                },
                "col2": {
                  "type": "string",
                  "id": 3
                }
              }
            },
            "StatCorr": {
              "oneofs": {
                "_method": {
                  "oneof": [
                    "method"
                  ]
                }
              },
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "col1": {
                  "type": "string",
                  "id": 2
                },
                "col2": {
                  "type": "string",
                  "id": 3
                },
                "method": {
                  "type": "string",
                  "id": 4,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "StatApproxQuantile": {
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "cols": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 2
                },
                "probabilities": {
                  "rule": "repeated",
                  "type": "double",
                  "id": 3
                },
                "relative_error": {
                  "type": "double",
                  "id": 4
                }
              }
            },
            "StatFreqItems": {
              "oneofs": {
                "_support": {
                  "oneof": [
                    "support"
                  ]
                }
              },
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "cols": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 2
                },
                "support": {
                  "type": "double",
                  "id": 3,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "StatSampleBy": {
              "oneofs": {
                "_seed": {
                  "oneof": [
                    "seed"
                  ]
                }
              },
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "col": {
                  "type": "Expression",
                  "id": 2
                },
                "fractions": {
                  "rule": "repeated",
                  "type": "Fraction",
                  "id": 3
                },
                "seed": {
                  "type": "int64",
                  "id": 5,
                  "options": {
                    "proto3_optional": true
                  }
                }
              },
              "nested": {
                "Fraction": {
                  "fields": {
                    "stratum": {
                      "type": "Expression.Literal",
                      "id": 1
                    },
                    "fraction": {
                      "type": "double",
                      "id": 2
                    }
                  }
                }
              }
            },
            "NAFill": {
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "cols": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 2
                },
                "values": {
                  "rule": "repeated",
                  "type": "Expression.Literal",
                  "id": 3
                }
              }
            },
            "NADrop": {
              "oneofs": {
                "_min_non_nulls": {
                  "oneof": [
                    "min_non_nulls"
                  ]
                }
              },
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "cols": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 2
                },
                "min_non_nulls": {
                  "type": "int32",
                  "id": 3,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "NAReplace": {
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "cols": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 2
                },
                "replacements": {
                  "rule": "repeated",
                  "type": "Replacement",
                  "id": 3
                }
              },
              "nested": {
                "Replacement": {
                  "fields": {
                    "old_value": {
                      "type": "Expression.Literal",
                      "id": 1
                    },
                    "new_value": {
                      "type": "Expression.Literal",
                      "id": 2
                    }
                  }
                }
              }
            },
            "ToDF": {
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "column_names": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 2
                }
              }
            },
            "WithColumnsRenamed": {
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "rename_columns_map": {
                  "keyType": "string",
                  "type": "string",
                  "id": 2,
                  "options": {
                    "deprecated": true
                  }
                },
                "renames": {
                  "rule": "repeated",
                  "type": "Rename",
                  "id": 3
                }
              },
              "nested": {
                "Rename": {
                  "fields": {
                    "col_name": {
                      "type": "string",
                      "id": 1
                    },
                    "new_col_name": {
                      "type": "string",
                      "id": 2
                    }
                  }
                }
              }
            },
            "WithColumns": {
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "aliases": {
                  "rule": "repeated",
                  "type": "Expression.Alias",
                  "id": 2
                }
              }
            },
            "WithWatermark": {
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "event_time": {
                  "type": "string",
                  "id": 2
                },
                "delay_threshold": {
                  "type": "string",
                  "id": 3
                }
              }
            },
            "Hint": {
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "name": {
                  "type": "string",
                  "id": 2
                },
                "parameters": {
                  "rule": "repeated",
                  "type": "Expression",
                  "id": 3
                }
              }
            },
            "Unpivot": {
              "oneofs": {
                "_values": {
                  "oneof": [
                    "values"
                  ]
                }
              },
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "ids": {
                  "rule": "repeated",
                  "type": "Expression",
                  "id": 2
                },
                "values": {
                  "type": "Values",
                  "id": 3,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "variable_column_name": {
                  "type": "string",
                  "id": 4
                },
                "value_column_name": {
                  "type": "string",
                  "id": 5
                }
              },
              "nested": {
                "Values": {
                  "fields": {
                    "values": {
                      "rule": "repeated",
                      "type": "Expression",
                      "id": 1
                    }
                  }
                }
              }
            },
            "Transpose": {
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "index_columns": {
                  "rule": "repeated",
                  "type": "Expression",
                  "id": 2
                }
              }
            },
            "UnresolvedTableValuedFunction": {
              "fields": {
                "function_name": {
                  "type": "string",
                  "id": 1
                },
                "arguments": {
                  "rule": "repeated",
                  "type": "Expression",
                  "id": 2
                }
              }
            },
            "ToSchema": {
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "schema": {
                  "type": "DataType",
                  "id": 2
                }
              }
            },
            "RepartitionByExpression": {
              "oneofs": {
                "_num_partitions": {
                  "oneof": [
                    "num_partitions"
                  ]
                }
              },
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "partition_exprs": {
                  "rule": "repeated",
                  "type": "Expression",
                  "id": 2
                },
                "num_partitions": {
                  "type": "int32",
                  "id": 3,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "MapPartitions": {
              "oneofs": {
                "_is_barrier": {
                  "oneof": [
                    "is_barrier"
                  ]
                },
                "_profile_id": {
                  "oneof": [
                    "profile_id"
                  ]
                }
              },
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "func": {
                  "type": "CommonInlineUserDefinedFunction",
                  "id": 2
                },
                "is_barrier": {
                  "type": "bool",
                  "id": 3,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "profile_id": {
                  "type": "int32",
                  "id": 4,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "GroupMap": {
              "oneofs": {
                "_is_map_groups_with_state": {
                  "oneof": [
                    "is_map_groups_with_state"
                  ]
                },
                "_output_mode": {
                  "oneof": [
                    "output_mode"
                  ]
                },
                "_timeout_conf": {
                  "oneof": [
                    "timeout_conf"
                  ]
                },
                "_state_schema": {
                  "oneof": [
                    "state_schema"
                  ]
                },
                "_transform_with_state_info": {
                  "oneof": [
                    "transform_with_state_info"
                  ]
                }
              },
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "grouping_expressions": {
                  "rule": "repeated",
                  "type": "Expression",
                  "id": 2
                },
                "func": {
                  "type": "CommonInlineUserDefinedFunction",
                  "id": 3
                },
                "sorting_expressions": {
                  "rule": "repeated",
                  "type": "Expression",
                  "id": 4
                },
                "initial_input": {
                  "type": "Relation",
                  "id": 5
                },
                "initial_grouping_expressions": {
                  "rule": "repeated",
                  "type": "Expression",
                  "id": 6
                },
                "is_map_groups_with_state": {
                  "type": "bool",
                  "id": 7,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "output_mode": {
                  "type": "string",
                  "id": 8,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "timeout_conf": {
                  "type": "string",
                  "id": 9,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "state_schema": {
                  "type": "DataType",
                  "id": 10,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "transform_with_state_info": {
                  "type": "TransformWithStateInfo",
                  "id": 11,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "TransformWithStateInfo": {
              "oneofs": {
                "_event_time_column_name": {
                  "oneof": [
                    "event_time_column_name"
                  ]
                },
                "_output_schema": {
                  "oneof": [
                    "output_schema"
                  ]
                }
              },
              "fields": {
                "time_mode": {
                  "type": "string",
                  "id": 1
                },
                "event_time_column_name": {
                  "type": "string",
                  "id": 2,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "output_schema": {
                  "type": "DataType",
                  "id": 3,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "CoGroupMap": {
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "input_grouping_expressions": {
                  "rule": "repeated",
                  "type": "Expression",
                  "id": 2
                },
                "other": {
                  "type": "Relation",
                  "id": 3
                },
                "other_grouping_expressions": {
                  "rule": "repeated",
                  "type": "Expression",
                  "id": 4
                },
                "func": {
                  "type": "CommonInlineUserDefinedFunction",
                  "id": 5
                },
                "input_sorting_expressions": {
                  "rule": "repeated",
                  "type": "Expression",
                  "id": 6
                },
                "other_sorting_expressions": {
                  "rule": "repeated",
                  "type": "Expression",
                  "id": 7
                }
              }
            },
            "ApplyInPandasWithState": {
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "grouping_expressions": {
                  "rule": "repeated",
                  "type": "Expression",
                  "id": 2
                },
                "func": {
                  "type": "CommonInlineUserDefinedFunction",
                  "id": 3
                },
                "output_schema": {
                  "type": "string",
                  "id": 4
                },
                "state_schema": {
                  "type": "string",
                  "id": 5
                },
                "output_mode": {
                  "type": "string",
                  "id": 6
                },
                "timeout_conf": {
                  "type": "string",
                  "id": 7
                }
              }
            },
            "CommonInlineUserDefinedTableFunction": {
              "oneofs": {
                "function": {
                  "oneof": [
                    "python_udtf"
                  ]
                }
              },
              "fields": {
                "function_name": {
                  "type": "string",
                  "id": 1
                },
                "deterministic": {
                  "type": "bool",
                  "id": 2
                },
                "arguments": {
                  "rule": "repeated",
                  "type": "Expression",
                  "id": 3
                },
                "python_udtf": {
                  "type": "PythonUDTF",
                  "id": 4
                }
              }
            },
            "PythonUDTF": {
              "oneofs": {
                "_return_type": {
                  "oneof": [
                    "return_type"
                  ]
                }
              },
              "fields": {
                "return_type": {
                  "type": "DataType",
                  "id": 1,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "eval_type": {
                  "type": "int32",
                  "id": 2
                },
                "command": {
                  "type": "bytes",
                  "id": 3
                },
                "python_ver": {
                  "type": "string",
                  "id": 4
                }
              }
            },
            "CommonInlineUserDefinedDataSource": {
              "oneofs": {
                "data_source": {
                  "oneof": [
                    "python_data_source"
                  ]
                }
              },
              "fields": {
                "name": {
                  "type": "string",
                  "id": 1
                },
                "python_data_source": {
                  "type": "PythonDataSource",
                  "id": 2
                }
              }
            },
            "PythonDataSource": {
              "fields": {
                "command": {
                  "type": "bytes",
                  "id": 1
                },
                "python_ver": {
                  "type": "string",
                  "id": 2
                }
              }
            },
            "CollectMetrics": {
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "name": {
                  "type": "string",
                  "id": 2
                },
                "metrics": {
                  "rule": "repeated",
                  "type": "Expression",
                  "id": 3
                }
              }
            },
            "Parse": {
              "oneofs": {
                "_schema": {
                  "oneof": [
                    "schema"
                  ]
                }
              },
              "fields": {
                "input": {
                  "type": "Relation",
                  "id": 1
                },
                "format": {
                  "type": "ParseFormat",
                  "id": 2
                },
                "schema": {
                  "type": "DataType",
                  "id": 3,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "options": {
                  "keyType": "string",
                  "type": "string",
                  "id": 4
                }
              },
              "nested": {
                "ParseFormat": {
                  "values": {
                    "PARSE_FORMAT_UNSPECIFIED": 0,
                    "PARSE_FORMAT_CSV": 1,
                    "PARSE_FORMAT_JSON": 2,
                    "PARSE_FORMAT_XML": 3
                  }
                }
              }
            },
            "AsOfJoin": {
              "fields": {
                "left": {
                  "type": "Relation",
                  "id": 1
                },
                "right": {
                  "type": "Relation",
                  "id": 2
                },
                "left_as_of": {
                  "type": "Expression",
                  "id": 3
                },
                "right_as_of": {
                  "type": "Expression",
                  "id": 4
                },
                "join_expr": {
                  "type": "Expression",
                  "id": 5
                },
                "using_columns": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 6
                },
                "join_type": {
                  "type": "string",
                  "id": 7
                },
                "tolerance": {
                  "type": "Expression",
                  "id": 8
                },
                "allow_exact_matches": {
                  "type": "bool",
                  "id": 9
                },
                "direction": {
                  "type": "string",
                  "id": 10
                }
              }
            },
            "LateralJoin": {
              "fields": {
                "left": {
                  "type": "Relation",
                  "id": 1
                },
                "right": {
                  "type": "Relation",
                  "id": 2
                },
                "join_condition": {
                  "type": "Expression",
                  "id": 3
                },
                "join_type": {
                  "type": "Join.JoinType",
                  "id": 4
                }
              }
            },
            "NearestByJoin": {
              "fields": {
                "left": {
                  "type": "Relation",
                  "id": 1
                },
                "right": {
                  "type": "Relation",
                  "id": 2
                },
                "ranking_expression": {
                  "type": "Expression",
                  "id": 3
                },
                "num_results": {
                  "type": "int32",
                  "id": 4
                },
                "join_type": {
                  "type": "string",
                  "id": 5
                },
                "mode": {
                  "type": "string",
                  "id": 6
                },
                "direction": {
                  "type": "string",
                  "id": 7
                }
              }
            },
            "Catalog": {
              "oneofs": {
                "cat_type": {
                  "oneof": [
                    "current_database",
                    "set_current_database",
                    "list_databases",
                    "list_tables",
                    "list_functions",
                    "list_columns",
                    "get_database",
                    "get_table",
                    "get_function",
                    "database_exists",
                    "table_exists",
                    "function_exists",
                    "create_external_table",
                    "create_table",
                    "drop_temp_view",
                    "drop_global_temp_view",
                    "recover_partitions",
                    "is_cached",
                    "cache_table",
                    "uncache_table",
                    "clear_cache",
                    "refresh_table",
                    "refresh_by_path",
                    "current_catalog",
                    "set_current_catalog",
                    "list_catalogs",
                    "drop_table",
                    "drop_view",
                    "create_database",
                    "drop_database",
                    "list_partitions",
                    "list_views",
                    "get_table_properties",
                    "get_create_table_string",
                    "truncate_table",
                    "analyze_table"
                  ]
                }
              },
              "fields": {
                "current_database": {
                  "type": "CurrentDatabase",
                  "id": 1
                },
                "set_current_database": {
                  "type": "SetCurrentDatabase",
                  "id": 2
                },
                "list_databases": {
                  "type": "ListDatabases",
                  "id": 3
                },
                "list_tables": {
                  "type": "ListTables",
                  "id": 4
                },
                "list_functions": {
                  "type": "ListFunctions",
                  "id": 5
                },
                "list_columns": {
                  "type": "ListColumns",
                  "id": 6
                },
                "get_database": {
                  "type": "GetDatabase",
                  "id": 7
                },
                "get_table": {
                  "type": "GetTable",
                  "id": 8
                },
                "get_function": {
                  "type": "GetFunction",
                  "id": 9
                },
                "database_exists": {
                  "type": "DatabaseExists",
                  "id": 10
                },
                "table_exists": {
                  "type": "TableExists",
                  "id": 11
                },
                "function_exists": {
                  "type": "FunctionExists",
                  "id": 12
                },
                "create_external_table": {
                  "type": "CreateExternalTable",
                  "id": 13
                },
                "create_table": {
                  "type": "CreateTable",
                  "id": 14
                },
                "drop_temp_view": {
                  "type": "DropTempView",
                  "id": 15
                },
                "drop_global_temp_view": {
                  "type": "DropGlobalTempView",
                  "id": 16
                },
                "recover_partitions": {
                  "type": "RecoverPartitions",
                  "id": 17
                },
                "is_cached": {
                  "type": "IsCached",
                  "id": 18
                },
                "cache_table": {
                  "type": "CacheTable",
                  "id": 19
                },
                "uncache_table": {
                  "type": "UncacheTable",
                  "id": 20
                },
                "clear_cache": {
                  "type": "ClearCache",
                  "id": 21
                },
                "refresh_table": {
                  "type": "RefreshTable",
                  "id": 22
                },
                "refresh_by_path": {
                  "type": "RefreshByPath",
                  "id": 23
                },
                "current_catalog": {
                  "type": "CurrentCatalog",
                  "id": 24
                },
                "set_current_catalog": {
                  "type": "SetCurrentCatalog",
                  "id": 25
                },
                "list_catalogs": {
                  "type": "ListCatalogs",
                  "id": 26
                },
                "drop_table": {
                  "type": "DropTable",
                  "id": 27
                },
                "drop_view": {
                  "type": "DropView",
                  "id": 28
                },
                "create_database": {
                  "type": "CreateDatabase",
                  "id": 29
                },
                "drop_database": {
                  "type": "DropDatabase",
                  "id": 30
                },
                "list_partitions": {
                  "type": "ListPartitions",
                  "id": 31
                },
                "list_views": {
                  "type": "ListViews",
                  "id": 32
                },
                "get_table_properties": {
                  "type": "GetTableProperties",
                  "id": 33
                },
                "get_create_table_string": {
                  "type": "GetCreateTableString",
                  "id": 34
                },
                "truncate_table": {
                  "type": "TruncateTable",
                  "id": 35
                },
                "analyze_table": {
                  "type": "AnalyzeTable",
                  "id": 36
                }
              }
            },
            "CurrentDatabase": {
              "fields": {}
            },
            "SetCurrentDatabase": {
              "fields": {
                "db_name": {
                  "type": "string",
                  "id": 1
                }
              }
            },
            "ListDatabases": {
              "oneofs": {
                "_pattern": {
                  "oneof": [
                    "pattern"
                  ]
                }
              },
              "fields": {
                "pattern": {
                  "type": "string",
                  "id": 1,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "ListTables": {
              "oneofs": {
                "_db_name": {
                  "oneof": [
                    "db_name"
                  ]
                },
                "_pattern": {
                  "oneof": [
                    "pattern"
                  ]
                }
              },
              "fields": {
                "db_name": {
                  "type": "string",
                  "id": 1,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "pattern": {
                  "type": "string",
                  "id": 2,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "ListFunctions": {
              "oneofs": {
                "_db_name": {
                  "oneof": [
                    "db_name"
                  ]
                },
                "_pattern": {
                  "oneof": [
                    "pattern"
                  ]
                }
              },
              "fields": {
                "db_name": {
                  "type": "string",
                  "id": 1,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "pattern": {
                  "type": "string",
                  "id": 2,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "ListColumns": {
              "oneofs": {
                "_db_name": {
                  "oneof": [
                    "db_name"
                  ]
                }
              },
              "fields": {
                "table_name": {
                  "type": "string",
                  "id": 1
                },
                "db_name": {
                  "type": "string",
                  "id": 2,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "GetDatabase": {
              "fields": {
                "db_name": {
                  "type": "string",
                  "id": 1
                }
              }
            },
            "GetTable": {
              "oneofs": {
                "_db_name": {
                  "oneof": [
                    "db_name"
                  ]
                }
              },
              "fields": {
                "table_name": {
                  "type": "string",
                  "id": 1
                },
                "db_name": {
                  "type": "string",
                  "id": 2,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "GetFunction": {
              "oneofs": {
                "_db_name": {
                  "oneof": [
                    "db_name"
                  ]
                }
              },
              "fields": {
                "function_name": {
                  "type": "string",
                  "id": 1
                },
                "db_name": {
                  "type": "string",
                  "id": 2,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "DatabaseExists": {
              "fields": {
                "db_name": {
                  "type": "string",
                  "id": 1
                }
              }
            },
            "TableExists": {
              "oneofs": {
                "_db_name": {
                  "oneof": [
                    "db_name"
                  ]
                }
              },
              "fields": {
                "table_name": {
                  "type": "string",
                  "id": 1
                },
                "db_name": {
                  "type": "string",
                  "id": 2,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "FunctionExists": {
              "oneofs": {
                "_db_name": {
                  "oneof": [
                    "db_name"
                  ]
                }
              },
              "fields": {
                "function_name": {
                  "type": "string",
                  "id": 1
                },
                "db_name": {
                  "type": "string",
                  "id": 2,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "CreateExternalTable": {
              "oneofs": {
                "_path": {
                  "oneof": [
                    "path"
                  ]
                },
                "_source": {
                  "oneof": [
                    "source"
                  ]
                },
                "_schema": {
                  "oneof": [
                    "schema"
                  ]
                }
              },
              "fields": {
                "table_name": {
                  "type": "string",
                  "id": 1
                },
                "path": {
                  "type": "string",
                  "id": 2,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "source": {
                  "type": "string",
                  "id": 3,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "schema": {
                  "type": "DataType",
                  "id": 4,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "options": {
                  "keyType": "string",
                  "type": "string",
                  "id": 5
                }
              }
            },
            "CreateTable": {
              "oneofs": {
                "_path": {
                  "oneof": [
                    "path"
                  ]
                },
                "_source": {
                  "oneof": [
                    "source"
                  ]
                },
                "_description": {
                  "oneof": [
                    "description"
                  ]
                },
                "_schema": {
                  "oneof": [
                    "schema"
                  ]
                }
              },
              "fields": {
                "table_name": {
                  "type": "string",
                  "id": 1
                },
                "path": {
                  "type": "string",
                  "id": 2,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "source": {
                  "type": "string",
                  "id": 3,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "description": {
                  "type": "string",
                  "id": 4,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "schema": {
                  "type": "DataType",
                  "id": 5,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "options": {
                  "keyType": "string",
                  "type": "string",
                  "id": 6
                }
              }
            },
            "DropTempView": {
              "fields": {
                "view_name": {
                  "type": "string",
                  "id": 1
                }
              }
            },
            "DropGlobalTempView": {
              "fields": {
                "view_name": {
                  "type": "string",
                  "id": 1
                }
              }
            },
            "RecoverPartitions": {
              "fields": {
                "table_name": {
                  "type": "string",
                  "id": 1
                }
              }
            },
            "IsCached": {
              "fields": {
                "table_name": {
                  "type": "string",
                  "id": 1
                }
              }
            },
            "CacheTable": {
              "oneofs": {
                "_storage_level": {
                  "oneof": [
                    "storage_level"
                  ]
                }
              },
              "fields": {
                "table_name": {
                  "type": "string",
                  "id": 1
                },
                "storage_level": {
                  "type": "StorageLevel",
                  "id": 2,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "UncacheTable": {
              "fields": {
                "table_name": {
                  "type": "string",
                  "id": 1
                }
              }
            },
            "ClearCache": {
              "fields": {}
            },
            "RefreshTable": {
              "fields": {
                "table_name": {
                  "type": "string",
                  "id": 1
                }
              }
            },
            "RefreshByPath": {
              "fields": {
                "path": {
                  "type": "string",
                  "id": 1
                }
              }
            },
            "CurrentCatalog": {
              "fields": {}
            },
            "SetCurrentCatalog": {
              "fields": {
                "catalog_name": {
                  "type": "string",
                  "id": 1
                }
              }
            },
            "ListCatalogs": {
              "oneofs": {
                "_pattern": {
                  "oneof": [
                    "pattern"
                  ]
                }
              },
              "fields": {
                "pattern": {
                  "type": "string",
                  "id": 1,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "DropTable": {
              "fields": {
                "table_name": {
                  "type": "string",
                  "id": 1
                },
                "if_exists": {
                  "type": "bool",
                  "id": 2
                },
                "purge": {
                  "type": "bool",
                  "id": 3
                }
              }
            },
            "DropView": {
              "fields": {
                "view_name": {
                  "type": "string",
                  "id": 1
                },
                "if_exists": {
                  "type": "bool",
                  "id": 2
                }
              }
            },
            "CreateDatabase": {
              "fields": {
                "db_name": {
                  "type": "string",
                  "id": 1
                },
                "if_not_exists": {
                  "type": "bool",
                  "id": 2
                },
                "properties": {
                  "keyType": "string",
                  "type": "string",
                  "id": 3
                }
              }
            },
            "DropDatabase": {
              "fields": {
                "db_name": {
                  "type": "string",
                  "id": 1
                },
                "if_exists": {
                  "type": "bool",
                  "id": 2
                },
                "cascade": {
                  "type": "bool",
                  "id": 3
                }
              }
            },
            "ListPartitions": {
              "fields": {
                "table_name": {
                  "type": "string",
                  "id": 1
                }
              }
            },
            "ListViews": {
              "oneofs": {
                "_db_name": {
                  "oneof": [
                    "db_name"
                  ]
                },
                "_pattern": {
                  "oneof": [
                    "pattern"
                  ]
                }
              },
              "fields": {
                "db_name": {
                  "type": "string",
                  "id": 1,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "pattern": {
                  "type": "string",
                  "id": 2,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "GetTableProperties": {
              "fields": {
                "table_name": {
                  "type": "string",
                  "id": 1
                }
              }
            },
            "GetCreateTableString": {
              "fields": {
                "table_name": {
                  "type": "string",
                  "id": 1
                },
                "as_serde": {
                  "type": "bool",
                  "id": 2
                }
              }
            },
            "TruncateTable": {
              "fields": {
                "table_name": {
                  "type": "string",
                  "id": 1
                }
              }
            },
            "AnalyzeTable": {
              "fields": {
                "table_name": {
                  "type": "string",
                  "id": 1
                },
                "no_scan": {
                  "type": "bool",
                  "id": 2
                }
              }
            },
            "MlParams": {
              "fields": {
                "params": {
                  "keyType": "string",
                  "type": "Expression.Literal",
                  "id": 1
                }
              }
            },
            "MlOperator": {
              "fields": {
                "name": {
                  "type": "string",
                  "id": 1
                },
                "uid": {
                  "type": "string",
                  "id": 2
                },
                "type": {
                  "type": "OperatorType",
                  "id": 3
                }
              },
              "nested": {
                "OperatorType": {
                  "values": {
                    "OPERATOR_TYPE_UNSPECIFIED": 0,
                    "OPERATOR_TYPE_ESTIMATOR": 1,
                    "OPERATOR_TYPE_TRANSFORMER": 2,
                    "OPERATOR_TYPE_EVALUATOR": 3,
                    "OPERATOR_TYPE_MODEL": 4
                  }
                }
              }
            },
            "ObjectRef": {
              "fields": {
                "id": {
                  "type": "string",
                  "id": 1
                }
              }
            },
            "MlCommand": {
              "oneofs": {
                "command": {
                  "oneof": [
                    "fit",
                    "fetch",
                    "delete",
                    "write",
                    "read",
                    "evaluate",
                    "clean_cache",
                    "get_cache_info",
                    "create_summary",
                    "get_model_size"
                  ]
                }
              },
              "fields": {
                "fit": {
                  "type": "Fit",
                  "id": 1
                },
                "fetch": {
                  "type": "Fetch",
                  "id": 2
                },
                "delete": {
                  "type": "Delete",
                  "id": 3
                },
                "write": {
                  "type": "Write",
                  "id": 4
                },
                "read": {
                  "type": "Read",
                  "id": 5
                },
                "evaluate": {
                  "type": "Evaluate",
                  "id": 6
                },
                "clean_cache": {
                  "type": "CleanCache",
                  "id": 7
                },
                "get_cache_info": {
                  "type": "GetCacheInfo",
                  "id": 8
                },
                "create_summary": {
                  "type": "CreateSummary",
                  "id": 9
                },
                "get_model_size": {
                  "type": "GetModelSize",
                  "id": 10
                }
              },
              "nested": {
                "Fit": {
                  "oneofs": {
                    "_params": {
                      "oneof": [
                        "params"
                      ]
                    }
                  },
                  "fields": {
                    "estimator": {
                      "type": "MlOperator",
                      "id": 1
                    },
                    "params": {
                      "type": "MlParams",
                      "id": 2,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "dataset": {
                      "type": "Relation",
                      "id": 3
                    }
                  }
                },
                "Delete": {
                  "oneofs": {
                    "_evict_only": {
                      "oneof": [
                        "evict_only"
                      ]
                    }
                  },
                  "fields": {
                    "obj_refs": {
                      "rule": "repeated",
                      "type": "ObjectRef",
                      "id": 1
                    },
                    "evict_only": {
                      "type": "bool",
                      "id": 2,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "CleanCache": {
                  "fields": {}
                },
                "GetCacheInfo": {
                  "fields": {}
                },
                "Write": {
                  "oneofs": {
                    "type": {
                      "oneof": [
                        "operator",
                        "obj_ref"
                      ]
                    },
                    "_params": {
                      "oneof": [
                        "params"
                      ]
                    },
                    "_should_overwrite": {
                      "oneof": [
                        "should_overwrite"
                      ]
                    }
                  },
                  "fields": {
                    "operator": {
                      "type": "MlOperator",
                      "id": 1
                    },
                    "obj_ref": {
                      "type": "ObjectRef",
                      "id": 2
                    },
                    "params": {
                      "type": "MlParams",
                      "id": 3,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "path": {
                      "type": "string",
                      "id": 4
                    },
                    "should_overwrite": {
                      "type": "bool",
                      "id": 5,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "options": {
                      "keyType": "string",
                      "type": "string",
                      "id": 6
                    }
                  }
                },
                "Read": {
                  "fields": {
                    "operator": {
                      "type": "MlOperator",
                      "id": 1
                    },
                    "path": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "Evaluate": {
                  "oneofs": {
                    "_params": {
                      "oneof": [
                        "params"
                      ]
                    }
                  },
                  "fields": {
                    "evaluator": {
                      "type": "MlOperator",
                      "id": 1
                    },
                    "params": {
                      "type": "MlParams",
                      "id": 2,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "dataset": {
                      "type": "Relation",
                      "id": 3
                    }
                  }
                },
                "CreateSummary": {
                  "fields": {
                    "model_ref": {
                      "type": "ObjectRef",
                      "id": 1
                    },
                    "dataset": {
                      "type": "Relation",
                      "id": 2
                    }
                  }
                },
                "GetModelSize": {
                  "fields": {
                    "model_ref": {
                      "type": "ObjectRef",
                      "id": 1
                    }
                  }
                }
              }
            },
            "MlCommandResult": {
              "oneofs": {
                "result_type": {
                  "oneof": [
                    "param",
                    "summary",
                    "operator_info"
                  ]
                }
              },
              "fields": {
                "param": {
                  "type": "Expression.Literal",
                  "id": 1
                },
                "summary": {
                  "type": "string",
                  "id": 2
                },
                "operator_info": {
                  "type": "MlOperatorInfo",
                  "id": 3
                }
              },
              "nested": {
                "MlOperatorInfo": {
                  "oneofs": {
                    "type": {
                      "oneof": [
                        "obj_ref",
                        "name"
                      ]
                    },
                    "_uid": {
                      "oneof": [
                        "uid"
                      ]
                    },
                    "_params": {
                      "oneof": [
                        "params"
                      ]
                    },
                    "_warning_message": {
                      "oneof": [
                        "warning_message"
                      ]
                    }
                  },
                  "fields": {
                    "obj_ref": {
                      "type": "ObjectRef",
                      "id": 1
                    },
                    "name": {
                      "type": "string",
                      "id": 2
                    },
                    "uid": {
                      "type": "string",
                      "id": 3,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "params": {
                      "type": "MlParams",
                      "id": 4,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "warning_message": {
                      "type": "string",
                      "id": 5,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                }
              }
            },
            "PipelineCommand": {
              "oneofs": {
                "command_type": {
                  "oneof": [
                    "create_dataflow_graph",
                    "define_output",
                    "define_flow",
                    "drop_dataflow_graph",
                    "start_run",
                    "define_sql_graph_elements",
                    "get_query_function_execution_signal_stream",
                    "define_flow_query_function_result",
                    "execute_output_flows",
                    "extension"
                  ]
                }
              },
              "fields": {
                "create_dataflow_graph": {
                  "type": "CreateDataflowGraph",
                  "id": 1
                },
                "define_output": {
                  "type": "DefineOutput",
                  "id": 2
                },
                "define_flow": {
                  "type": "DefineFlow",
                  "id": 3
                },
                "drop_dataflow_graph": {
                  "type": "DropDataflowGraph",
                  "id": 4
                },
                "start_run": {
                  "type": "StartRun",
                  "id": 5
                },
                "define_sql_graph_elements": {
                  "type": "DefineSqlGraphElements",
                  "id": 6
                },
                "get_query_function_execution_signal_stream": {
                  "type": "GetQueryFunctionExecutionSignalStream",
                  "id": 7
                },
                "define_flow_query_function_result": {
                  "type": "DefineFlowQueryFunctionResult",
                  "id": 8
                },
                "execute_output_flows": {
                  "type": "ExecuteOutputFlows",
                  "id": 9
                },
                "extension": {
                  "type": "google.protobuf.Any",
                  "id": 999
                }
              },
              "nested": {
                "CreateDataflowGraph": {
                  "oneofs": {
                    "_default_catalog": {
                      "oneof": [
                        "default_catalog"
                      ]
                    },
                    "_default_database": {
                      "oneof": [
                        "default_database"
                      ]
                    }
                  },
                  "fields": {
                    "default_catalog": {
                      "type": "string",
                      "id": 1,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "default_database": {
                      "type": "string",
                      "id": 2,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "sql_conf": {
                      "keyType": "string",
                      "type": "string",
                      "id": 5
                    }
                  }
                },
                "DropDataflowGraph": {
                  "oneofs": {
                    "_dataflow_graph_id": {
                      "oneof": [
                        "dataflow_graph_id"
                      ]
                    }
                  },
                  "fields": {
                    "dataflow_graph_id": {
                      "type": "string",
                      "id": 1,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "DefineOutput": {
                  "oneofs": {
                    "_dataflow_graph_id": {
                      "oneof": [
                        "dataflow_graph_id"
                      ]
                    },
                    "_output_name": {
                      "oneof": [
                        "output_name"
                      ]
                    },
                    "_output_type": {
                      "oneof": [
                        "output_type"
                      ]
                    },
                    "_comment": {
                      "oneof": [
                        "comment"
                      ]
                    },
                    "_source_code_location": {
                      "oneof": [
                        "source_code_location"
                      ]
                    },
                    "details": {
                      "oneof": [
                        "table_details",
                        "sink_details",
                        "extension"
                      ]
                    }
                  },
                  "fields": {
                    "dataflow_graph_id": {
                      "type": "string",
                      "id": 1,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "output_name": {
                      "type": "string",
                      "id": 2,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "output_type": {
                      "type": "OutputType",
                      "id": 3,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "comment": {
                      "type": "string",
                      "id": 4,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "source_code_location": {
                      "type": "SourceCodeLocation",
                      "id": 5,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "table_details": {
                      "type": "TableDetails",
                      "id": 6
                    },
                    "sink_details": {
                      "type": "SinkDetails",
                      "id": 7
                    },
                    "extension": {
                      "type": "google.protobuf.Any",
                      "id": 999
                    }
                  },
                  "nested": {
                    "TableDetails": {
                      "oneofs": {
                        "_format": {
                          "oneof": [
                            "format"
                          ]
                        },
                        "schema": {
                          "oneof": [
                            "schema_data_type",
                            "schema_string"
                          ]
                        }
                      },
                      "fields": {
                        "table_properties": {
                          "keyType": "string",
                          "type": "string",
                          "id": 1
                        },
                        "partition_cols": {
                          "rule": "repeated",
                          "type": "string",
                          "id": 2
                        },
                        "format": {
                          "type": "string",
                          "id": 3,
                          "options": {
                            "proto3_optional": true
                          }
                        },
                        "schema_data_type": {
                          "type": "spark.connect.DataType",
                          "id": 4
                        },
                        "schema_string": {
                          "type": "string",
                          "id": 5
                        },
                        "clustering_columns": {
                          "rule": "repeated",
                          "type": "string",
                          "id": 6
                        }
                      }
                    },
                    "SinkDetails": {
                      "oneofs": {
                        "_format": {
                          "oneof": [
                            "format"
                          ]
                        }
                      },
                      "fields": {
                        "options": {
                          "keyType": "string",
                          "type": "string",
                          "id": 1
                        },
                        "format": {
                          "type": "string",
                          "id": 2,
                          "options": {
                            "proto3_optional": true
                          }
                        }
                      }
                    }
                  }
                },
                "DefineFlow": {
                  "oneofs": {
                    "_dataflow_graph_id": {
                      "oneof": [
                        "dataflow_graph_id"
                      ]
                    },
                    "_flow_name": {
                      "oneof": [
                        "flow_name"
                      ]
                    },
                    "_target_dataset_name": {
                      "oneof": [
                        "target_dataset_name"
                      ]
                    },
                    "_client_id": {
                      "oneof": [
                        "client_id"
                      ]
                    },
                    "_source_code_location": {
                      "oneof": [
                        "source_code_location"
                      ]
                    },
                    "details": {
                      "oneof": [
                        "relation_flow_details",
                        "auto_cdc_flow_details",
                        "extension"
                      ]
                    },
                    "_once": {
                      "oneof": [
                        "once"
                      ]
                    }
                  },
                  "fields": {
                    "dataflow_graph_id": {
                      "type": "string",
                      "id": 1,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "flow_name": {
                      "type": "string",
                      "id": 2,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "target_dataset_name": {
                      "type": "string",
                      "id": 3,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "sql_conf": {
                      "keyType": "string",
                      "type": "string",
                      "id": 4
                    },
                    "client_id": {
                      "type": "string",
                      "id": 5,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "source_code_location": {
                      "type": "SourceCodeLocation",
                      "id": 6,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "relation_flow_details": {
                      "type": "WriteRelationFlowDetails",
                      "id": 7
                    },
                    "auto_cdc_flow_details": {
                      "type": "AutoCdcFlowDetails",
                      "id": 10
                    },
                    "extension": {
                      "type": "google.protobuf.Any",
                      "id": 999
                    },
                    "once": {
                      "type": "bool",
                      "id": 8,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  },
                  "nested": {
                    "WriteRelationFlowDetails": {
                      "oneofs": {
                        "_relation": {
                          "oneof": [
                            "relation"
                          ]
                        }
                      },
                      "fields": {
                        "relation": {
                          "type": "spark.connect.Relation",
                          "id": 1,
                          "options": {
                            "proto3_optional": true
                          }
                        }
                      }
                    },
                    "AutoCdcFlowDetails": {
                      "oneofs": {
                        "_source": {
                          "oneof": [
                            "source"
                          ]
                        },
                        "_sequence_by": {
                          "oneof": [
                            "sequence_by"
                          ]
                        },
                        "_apply_as_deletes": {
                          "oneof": [
                            "apply_as_deletes"
                          ]
                        },
                        "_apply_as_truncates": {
                          "oneof": [
                            "apply_as_truncates"
                          ]
                        }
                      },
                      "fields": {
                        "source": {
                          "type": "string",
                          "id": 1,
                          "options": {
                            "proto3_optional": true
                          }
                        },
                        "keys": {
                          "rule": "repeated",
                          "type": "Expression",
                          "id": 2
                        },
                        "sequence_by": {
                          "type": "Expression",
                          "id": 3,
                          "options": {
                            "proto3_optional": true
                          }
                        },
                        "apply_as_deletes": {
                          "type": "Expression",
                          "id": 6,
                          "options": {
                            "proto3_optional": true
                          }
                        },
                        "apply_as_truncates": {
                          "type": "Expression",
                          "id": 7,
                          "options": {
                            "proto3_optional": true
                          }
                        },
                        "column_list": {
                          "rule": "repeated",
                          "type": "Expression",
                          "id": 8
                        },
                        "except_column_list": {
                          "rule": "repeated",
                          "type": "Expression",
                          "id": 9
                        },
                        "stored_as_scd_type": {
                          "type": "SCDType",
                          "id": 10
                        },
                        "ignore_null_updates_column_list": {
                          "rule": "repeated",
                          "type": "Expression",
                          "id": 14
                        },
                        "ignore_null_updates_except_column_list": {
                          "rule": "repeated",
                          "type": "Expression",
                          "id": 15
                        }
                      }
                    },
                    "SCDType": {
                      "values": {
                        "SCD_TYPE_UNSPECIFIED": 0,
                        "SCD_TYPE_1": 1
                      }
                    },
                    "Response": {
                      "oneofs": {
                        "_flow_name": {
                          "oneof": [
                            "flow_name"
                          ]
                        }
                      },
                      "fields": {
                        "flow_name": {
                          "type": "string",
                          "id": 1,
                          "options": {
                            "proto3_optional": true
                          }
                        }
                      }
                    }
                  }
                },
                "ExecuteOutputFlows": {
                  "oneofs": {
                    "_define_output": {
                      "oneof": [
                        "define_output"
                      ]
                    },
                    "_full_refresh": {
                      "oneof": [
                        "full_refresh"
                      ]
                    },
                    "_storage": {
                      "oneof": [
                        "storage"
                      ]
                    }
                  },
                  "fields": {
                    "define_output": {
                      "type": "DefineOutput",
                      "id": 1,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "define_flows": {
                      "rule": "repeated",
                      "type": "DefineFlow",
                      "id": 2
                    },
                    "full_refresh": {
                      "type": "bool",
                      "id": 3,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "storage": {
                      "type": "string",
                      "id": 4,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "extension": {
                      "rule": "repeated",
                      "type": "google.protobuf.Any",
                      "id": 999
                    }
                  }
                },
                "StartRun": {
                  "oneofs": {
                    "_dataflow_graph_id": {
                      "oneof": [
                        "dataflow_graph_id"
                      ]
                    },
                    "_full_refresh_all": {
                      "oneof": [
                        "full_refresh_all"
                      ]
                    },
                    "_dry": {
                      "oneof": [
                        "dry"
                      ]
                    },
                    "_storage": {
                      "oneof": [
                        "storage"
                      ]
                    }
                  },
                  "fields": {
                    "dataflow_graph_id": {
                      "type": "string",
                      "id": 1,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "full_refresh_selection": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 2
                    },
                    "full_refresh_all": {
                      "type": "bool",
                      "id": 3,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "refresh_selection": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 4
                    },
                    "dry": {
                      "type": "bool",
                      "id": 5,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "storage": {
                      "type": "string",
                      "id": 6,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "DefineSqlGraphElements": {
                  "oneofs": {
                    "_dataflow_graph_id": {
                      "oneof": [
                        "dataflow_graph_id"
                      ]
                    },
                    "_sql_file_path": {
                      "oneof": [
                        "sql_file_path"
                      ]
                    },
                    "_sql_text": {
                      "oneof": [
                        "sql_text"
                      ]
                    }
                  },
                  "fields": {
                    "dataflow_graph_id": {
                      "type": "string",
                      "id": 1,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "sql_file_path": {
                      "type": "string",
                      "id": 2,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "sql_text": {
                      "type": "string",
                      "id": 3,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "GetQueryFunctionExecutionSignalStream": {
                  "oneofs": {
                    "_dataflow_graph_id": {
                      "oneof": [
                        "dataflow_graph_id"
                      ]
                    },
                    "_client_id": {
                      "oneof": [
                        "client_id"
                      ]
                    }
                  },
                  "fields": {
                    "dataflow_graph_id": {
                      "type": "string",
                      "id": 1,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "client_id": {
                      "type": "string",
                      "id": 2,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "DefineFlowQueryFunctionResult": {
                  "oneofs": {
                    "_flow_name": {
                      "oneof": [
                        "flow_name"
                      ]
                    },
                    "_flow_identifier": {
                      "oneof": [
                        "flow_identifier"
                      ]
                    },
                    "_dataflow_graph_id": {
                      "oneof": [
                        "dataflow_graph_id"
                      ]
                    },
                    "_relation": {
                      "oneof": [
                        "relation"
                      ]
                    }
                  },
                  "fields": {
                    "flow_name": {
                      "type": "string",
                      "id": 1,
                      "options": {
                        "deprecated": true,
                        "proto3_optional": true
                      }
                    },
                    "flow_identifier": {
                      "type": "ResolvedIdentifier",
                      "id": 4,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "dataflow_graph_id": {
                      "type": "string",
                      "id": 2,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "relation": {
                      "type": "spark.connect.Relation",
                      "id": 3,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                }
              }
            },
            "PipelineCommandResult": {
              "oneofs": {
                "result_type": {
                  "oneof": [
                    "create_dataflow_graph_result",
                    "define_output_result",
                    "define_flow_result"
                  ]
                }
              },
              "fields": {
                "create_dataflow_graph_result": {
                  "type": "CreateDataflowGraphResult",
                  "id": 1
                },
                "define_output_result": {
                  "type": "DefineOutputResult",
                  "id": 2
                },
                "define_flow_result": {
                  "type": "DefineFlowResult",
                  "id": 3
                }
              },
              "nested": {
                "CreateDataflowGraphResult": {
                  "oneofs": {
                    "_dataflow_graph_id": {
                      "oneof": [
                        "dataflow_graph_id"
                      ]
                    }
                  },
                  "fields": {
                    "dataflow_graph_id": {
                      "type": "string",
                      "id": 1,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "DefineOutputResult": {
                  "oneofs": {
                    "_resolved_identifier": {
                      "oneof": [
                        "resolved_identifier"
                      ]
                    }
                  },
                  "fields": {
                    "resolved_identifier": {
                      "type": "ResolvedIdentifier",
                      "id": 1,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "DefineFlowResult": {
                  "oneofs": {
                    "_resolved_identifier": {
                      "oneof": [
                        "resolved_identifier"
                      ]
                    }
                  },
                  "fields": {
                    "resolved_identifier": {
                      "type": "ResolvedIdentifier",
                      "id": 1,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                }
              }
            },
            "OutputType": {
              "values": {
                "OUTPUT_TYPE_UNSPECIFIED": 0,
                "MATERIALIZED_VIEW": 1,
                "TABLE": 2,
                "TEMPORARY_VIEW": 3,
                "SINK": 4
              }
            },
            "PipelineEventResult": {
              "fields": {
                "event": {
                  "type": "PipelineEvent",
                  "id": 1
                }
              }
            },
            "PipelineEvent": {
              "oneofs": {
                "_message": {
                  "oneof": [
                    "message"
                  ]
                }
              },
              "fields": {
                "timestamp": {
                  "type": "google.protobuf.Timestamp",
                  "id": 1
                },
                "message": {
                  "type": "string",
                  "id": 2,
                  "options": {
                    "proto3_optional": true
                  }
                }
              }
            },
            "SourceCodeLocation": {
              "oneofs": {
                "_file_name": {
                  "oneof": [
                    "file_name"
                  ]
                },
                "_line_number": {
                  "oneof": [
                    "line_number"
                  ]
                },
                "_definition_path": {
                  "oneof": [
                    "definition_path"
                  ]
                }
              },
              "fields": {
                "file_name": {
                  "type": "string",
                  "id": 1,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "line_number": {
                  "type": "int32",
                  "id": 2,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "definition_path": {
                  "type": "string",
                  "id": 3,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "extension": {
                  "rule": "repeated",
                  "type": "google.protobuf.Any",
                  "id": 999
                }
              }
            },
            "PipelineQueryFunctionExecutionSignal": {
              "fields": {
                "flow_names": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 1,
                  "options": {
                    "deprecated": true
                  }
                },
                "flow_identifiers": {
                  "rule": "repeated",
                  "type": "ResolvedIdentifier",
                  "id": 2
                }
              }
            },
            "PipelineAnalysisContext": {
              "oneofs": {
                "_dataflow_graph_id": {
                  "oneof": [
                    "dataflow_graph_id"
                  ]
                },
                "_definition_path": {
                  "oneof": [
                    "definition_path"
                  ]
                },
                "_flow_name": {
                  "oneof": [
                    "flow_name"
                  ]
                },
                "_flow_identifier": {
                  "oneof": [
                    "flow_identifier"
                  ]
                }
              },
              "fields": {
                "dataflow_graph_id": {
                  "type": "string",
                  "id": 1,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "definition_path": {
                  "type": "string",
                  "id": 2,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "flow_name": {
                  "type": "string",
                  "id": 3,
                  "options": {
                    "deprecated": true,
                    "proto3_optional": true
                  }
                },
                "flow_identifier": {
                  "type": "ResolvedIdentifier",
                  "id": 4,
                  "options": {
                    "proto3_optional": true
                  }
                },
                "extension": {
                  "rule": "repeated",
                  "type": "google.protobuf.Any",
                  "id": 999
                }
              }
            }
          }
        }
      }
    },
    "google": {
      "nested": {
        "protobuf": {
          "nested": {
            "Any": {
              "fields": {
                "type_url": {
                  "type": "string",
                  "id": 1
                },
                "value": {
                  "type": "bytes",
                  "id": 2
                }
              }
            },
            "Timestamp": {
              "fields": {
                "seconds": {
                  "type": "int64",
                  "id": 1
                },
                "nanos": {
                  "type": "int32",
                  "id": 2
                }
              }
            }
          }
        }
      }
    }
  }
} as Parameters<typeof fromJSON>[0];
