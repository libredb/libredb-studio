// GENERATED FILE - do not edit. Run: node scripts/generate-etcd-descriptor.mjs
//
// Source: the etcd v3.7.2 .proto files vendored in this directory (README.md), via
// scripts/generate-etcd-descriptor.mjs. tests/unit/db/etcd/descriptor.test.ts fails on drift.

import type { fromJSON } from "@grpc/proto-loader";

// Asserted, not annotated: protobufjs 7.6.6's typings omit fields its own toJSON writes (see the generator).
// biome-ignore format: generated; the literal is JSON.stringify output, so a proto upgrade diffs line by line.
export const ETCD_DESCRIPTOR = {
  "nested": {
    "etcdserverpb": {
      "options": {
        "go_package": "go.etcd.io/etcd/api/v3/etcdserverpb",
        "(grpc.gateway.protoc_gen_openapiv2.options.openapiv2_swagger).security_definitions.security.key": "ApiKey",
        "(grpc.gateway.protoc_gen_openapiv2.options.openapiv2_swagger).security_definitions.security.value.type": "TYPE_API_KEY",
        "(grpc.gateway.protoc_gen_openapiv2.options.openapiv2_swagger).security_definitions.security.value.in": "IN_HEADER",
        "(grpc.gateway.protoc_gen_openapiv2.options.openapiv2_swagger).security_definitions.security.value.name": "Authorization",
        "(grpc.gateway.protoc_gen_openapiv2.options.openapiv2_swagger).security.security_requirement.key": "ApiKey"
      },
      "nested": {
        "KV": {
          "methods": {
            "Range": {
              "requestType": "RangeRequest",
              "responseType": "RangeResponse",
              "options": {
                "(google.api.http).post": "/v3/kv/range",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/kv/range",
                    "body": "*"
                  }
                }
              ]
            },
            "RangeStream": {
              "requestType": "RangeRequest",
              "responseType": "RangeStreamResponse",
              "responseStream": true
            },
            "Put": {
              "requestType": "PutRequest",
              "responseType": "PutResponse",
              "options": {
                "(google.api.http).post": "/v3/kv/put",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/kv/put",
                    "body": "*"
                  }
                }
              ]
            },
            "DeleteRange": {
              "requestType": "DeleteRangeRequest",
              "responseType": "DeleteRangeResponse",
              "options": {
                "(google.api.http).post": "/v3/kv/deleterange",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/kv/deleterange",
                    "body": "*"
                  }
                }
              ]
            },
            "Txn": {
              "requestType": "TxnRequest",
              "responseType": "TxnResponse",
              "options": {
                "(google.api.http).post": "/v3/kv/txn",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/kv/txn",
                    "body": "*"
                  }
                }
              ]
            },
            "Compact": {
              "requestType": "CompactionRequest",
              "responseType": "CompactionResponse",
              "options": {
                "(google.api.http).post": "/v3/kv/compaction",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/kv/compaction",
                    "body": "*"
                  }
                }
              ]
            }
          }
        },
        "Watch": {
          "methods": {
            "Watch": {
              "requestType": "WatchRequest",
              "requestStream": true,
              "responseType": "WatchResponse",
              "responseStream": true,
              "options": {
                "(google.api.http).post": "/v3/watch",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/watch",
                    "body": "*"
                  }
                }
              ]
            }
          }
        },
        "Lease": {
          "methods": {
            "LeaseGrant": {
              "requestType": "LeaseGrantRequest",
              "responseType": "LeaseGrantResponse",
              "options": {
                "(google.api.http).post": "/v3/lease/grant",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/lease/grant",
                    "body": "*"
                  }
                }
              ]
            },
            "LeaseRevoke": {
              "requestType": "LeaseRevokeRequest",
              "responseType": "LeaseRevokeResponse",
              "options": {
                "(google.api.http).post": "/v3/lease/revoke",
                "(google.api.http).body": "*",
                "(google.api.http).additional_bindings.post": "/v3/kv/lease/revoke",
                "(google.api.http).additional_bindings.body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/lease/revoke",
                    "body": "*",
                    "additional_bindings": {
                      "post": "/v3/kv/lease/revoke",
                      "body": "*"
                    }
                  }
                }
              ]
            },
            "LeaseKeepAlive": {
              "requestType": "LeaseKeepAliveRequest",
              "requestStream": true,
              "responseType": "LeaseKeepAliveResponse",
              "responseStream": true,
              "options": {
                "(google.api.http).post": "/v3/lease/keepalive",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/lease/keepalive",
                    "body": "*"
                  }
                }
              ]
            },
            "LeaseTimeToLive": {
              "requestType": "LeaseTimeToLiveRequest",
              "responseType": "LeaseTimeToLiveResponse",
              "options": {
                "(google.api.http).post": "/v3/lease/timetolive",
                "(google.api.http).body": "*",
                "(google.api.http).additional_bindings.post": "/v3/kv/lease/timetolive",
                "(google.api.http).additional_bindings.body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/lease/timetolive",
                    "body": "*",
                    "additional_bindings": {
                      "post": "/v3/kv/lease/timetolive",
                      "body": "*"
                    }
                  }
                }
              ]
            },
            "LeaseLeases": {
              "requestType": "LeaseLeasesRequest",
              "responseType": "LeaseLeasesResponse",
              "options": {
                "(google.api.http).post": "/v3/lease/leases",
                "(google.api.http).body": "*",
                "(google.api.http).additional_bindings.post": "/v3/kv/lease/leases",
                "(google.api.http).additional_bindings.body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/lease/leases",
                    "body": "*",
                    "additional_bindings": {
                      "post": "/v3/kv/lease/leases",
                      "body": "*"
                    }
                  }
                }
              ]
            }
          }
        },
        "Cluster": {
          "methods": {
            "MemberAdd": {
              "requestType": "MemberAddRequest",
              "responseType": "MemberAddResponse",
              "options": {
                "(google.api.http).post": "/v3/cluster/member/add",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/cluster/member/add",
                    "body": "*"
                  }
                }
              ]
            },
            "MemberRemove": {
              "requestType": "MemberRemoveRequest",
              "responseType": "MemberRemoveResponse",
              "options": {
                "(google.api.http).post": "/v3/cluster/member/remove",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/cluster/member/remove",
                    "body": "*"
                  }
                }
              ]
            },
            "MemberUpdate": {
              "requestType": "MemberUpdateRequest",
              "responseType": "MemberUpdateResponse",
              "options": {
                "(google.api.http).post": "/v3/cluster/member/update",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/cluster/member/update",
                    "body": "*"
                  }
                }
              ]
            },
            "MemberList": {
              "requestType": "MemberListRequest",
              "responseType": "MemberListResponse",
              "options": {
                "(google.api.http).post": "/v3/cluster/member/list",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/cluster/member/list",
                    "body": "*"
                  }
                }
              ]
            },
            "MemberPromote": {
              "requestType": "MemberPromoteRequest",
              "responseType": "MemberPromoteResponse",
              "options": {
                "(google.api.http).post": "/v3/cluster/member/promote",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/cluster/member/promote",
                    "body": "*"
                  }
                }
              ]
            }
          }
        },
        "Maintenance": {
          "methods": {
            "Alarm": {
              "requestType": "AlarmRequest",
              "responseType": "AlarmResponse",
              "options": {
                "(google.api.http).post": "/v3/maintenance/alarm",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/maintenance/alarm",
                    "body": "*"
                  }
                }
              ]
            },
            "Status": {
              "requestType": "StatusRequest",
              "responseType": "StatusResponse",
              "options": {
                "(google.api.http).post": "/v3/maintenance/status",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/maintenance/status",
                    "body": "*"
                  }
                }
              ]
            },
            "Defragment": {
              "requestType": "DefragmentRequest",
              "responseType": "DefragmentResponse",
              "options": {
                "(google.api.http).post": "/v3/maintenance/defragment",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/maintenance/defragment",
                    "body": "*"
                  }
                }
              ]
            },
            "Hash": {
              "requestType": "HashRequest",
              "responseType": "HashResponse",
              "options": {
                "(google.api.http).post": "/v3/maintenance/hash",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/maintenance/hash",
                    "body": "*"
                  }
                }
              ]
            },
            "HashKV": {
              "requestType": "HashKVRequest",
              "responseType": "HashKVResponse",
              "options": {
                "(google.api.http).post": "/v3/maintenance/hashkv",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/maintenance/hashkv",
                    "body": "*"
                  }
                }
              ]
            },
            "Snapshot": {
              "requestType": "SnapshotRequest",
              "responseType": "SnapshotResponse",
              "responseStream": true,
              "options": {
                "(google.api.http).post": "/v3/maintenance/snapshot",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/maintenance/snapshot",
                    "body": "*"
                  }
                }
              ]
            },
            "MoveLeader": {
              "requestType": "MoveLeaderRequest",
              "responseType": "MoveLeaderResponse",
              "options": {
                "(google.api.http).post": "/v3/maintenance/transfer-leadership",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/maintenance/transfer-leadership",
                    "body": "*"
                  }
                }
              ]
            },
            "Downgrade": {
              "requestType": "DowngradeRequest",
              "responseType": "DowngradeResponse",
              "options": {
                "(google.api.http).post": "/v3/maintenance/downgrade",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/maintenance/downgrade",
                    "body": "*"
                  }
                }
              ]
            }
          }
        },
        "Auth": {
          "methods": {
            "AuthEnable": {
              "requestType": "AuthEnableRequest",
              "responseType": "AuthEnableResponse",
              "options": {
                "(google.api.http).post": "/v3/auth/enable",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/auth/enable",
                    "body": "*"
                  }
                }
              ]
            },
            "AuthDisable": {
              "requestType": "AuthDisableRequest",
              "responseType": "AuthDisableResponse",
              "options": {
                "(google.api.http).post": "/v3/auth/disable",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/auth/disable",
                    "body": "*"
                  }
                }
              ]
            },
            "AuthStatus": {
              "requestType": "AuthStatusRequest",
              "responseType": "AuthStatusResponse",
              "options": {
                "(google.api.http).post": "/v3/auth/status",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/auth/status",
                    "body": "*"
                  }
                }
              ]
            },
            "Authenticate": {
              "requestType": "AuthenticateRequest",
              "responseType": "AuthenticateResponse",
              "options": {
                "(google.api.http).post": "/v3/auth/authenticate",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/auth/authenticate",
                    "body": "*"
                  }
                }
              ]
            },
            "UserAdd": {
              "requestType": "AuthUserAddRequest",
              "responseType": "AuthUserAddResponse",
              "options": {
                "(google.api.http).post": "/v3/auth/user/add",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/auth/user/add",
                    "body": "*"
                  }
                }
              ]
            },
            "UserGet": {
              "requestType": "AuthUserGetRequest",
              "responseType": "AuthUserGetResponse",
              "options": {
                "(google.api.http).post": "/v3/auth/user/get",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/auth/user/get",
                    "body": "*"
                  }
                }
              ]
            },
            "UserList": {
              "requestType": "AuthUserListRequest",
              "responseType": "AuthUserListResponse",
              "options": {
                "(google.api.http).post": "/v3/auth/user/list",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/auth/user/list",
                    "body": "*"
                  }
                }
              ]
            },
            "UserDelete": {
              "requestType": "AuthUserDeleteRequest",
              "responseType": "AuthUserDeleteResponse",
              "options": {
                "(google.api.http).post": "/v3/auth/user/delete",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/auth/user/delete",
                    "body": "*"
                  }
                }
              ]
            },
            "UserChangePassword": {
              "requestType": "AuthUserChangePasswordRequest",
              "responseType": "AuthUserChangePasswordResponse",
              "options": {
                "(google.api.http).post": "/v3/auth/user/changepw",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/auth/user/changepw",
                    "body": "*"
                  }
                }
              ]
            },
            "UserGrantRole": {
              "requestType": "AuthUserGrantRoleRequest",
              "responseType": "AuthUserGrantRoleResponse",
              "options": {
                "(google.api.http).post": "/v3/auth/user/grant",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/auth/user/grant",
                    "body": "*"
                  }
                }
              ]
            },
            "UserRevokeRole": {
              "requestType": "AuthUserRevokeRoleRequest",
              "responseType": "AuthUserRevokeRoleResponse",
              "options": {
                "(google.api.http).post": "/v3/auth/user/revoke",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/auth/user/revoke",
                    "body": "*"
                  }
                }
              ]
            },
            "RoleAdd": {
              "requestType": "AuthRoleAddRequest",
              "responseType": "AuthRoleAddResponse",
              "options": {
                "(google.api.http).post": "/v3/auth/role/add",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/auth/role/add",
                    "body": "*"
                  }
                }
              ]
            },
            "RoleGet": {
              "requestType": "AuthRoleGetRequest",
              "responseType": "AuthRoleGetResponse",
              "options": {
                "(google.api.http).post": "/v3/auth/role/get",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/auth/role/get",
                    "body": "*"
                  }
                }
              ]
            },
            "RoleList": {
              "requestType": "AuthRoleListRequest",
              "responseType": "AuthRoleListResponse",
              "options": {
                "(google.api.http).post": "/v3/auth/role/list",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/auth/role/list",
                    "body": "*"
                  }
                }
              ]
            },
            "RoleDelete": {
              "requestType": "AuthRoleDeleteRequest",
              "responseType": "AuthRoleDeleteResponse",
              "options": {
                "(google.api.http).post": "/v3/auth/role/delete",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/auth/role/delete",
                    "body": "*"
                  }
                }
              ]
            },
            "RoleGrantPermission": {
              "requestType": "AuthRoleGrantPermissionRequest",
              "responseType": "AuthRoleGrantPermissionResponse",
              "options": {
                "(google.api.http).post": "/v3/auth/role/grant",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/auth/role/grant",
                    "body": "*"
                  }
                }
              ]
            },
            "RoleRevokePermission": {
              "requestType": "AuthRoleRevokePermissionRequest",
              "responseType": "AuthRoleRevokePermissionResponse",
              "options": {
                "(google.api.http).post": "/v3/auth/role/revoke",
                "(google.api.http).body": "*"
              },
              "parsedOptions": [
                {
                  "(google.api.http)": {
                    "post": "/v3/auth/role/revoke",
                    "body": "*"
                  }
                }
              ]
            }
          }
        },
        "ResponseHeader": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "cluster_id": {
              "type": "uint64",
              "id": 1
            },
            "member_id": {
              "type": "uint64",
              "id": 2
            },
            "revision": {
              "type": "int64",
              "id": 3
            },
            "raft_term": {
              "type": "uint64",
              "id": 4
            }
          }
        },
        "RangeRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "key": {
              "type": "bytes",
              "id": 1
            },
            "range_end": {
              "type": "bytes",
              "id": 2
            },
            "limit": {
              "type": "int64",
              "id": 3
            },
            "revision": {
              "type": "int64",
              "id": 4
            },
            "sort_order": {
              "type": "SortOrder",
              "id": 5
            },
            "sort_target": {
              "type": "SortTarget",
              "id": 6
            },
            "serializable": {
              "type": "bool",
              "id": 7
            },
            "keys_only": {
              "type": "bool",
              "id": 8
            },
            "count_only": {
              "type": "bool",
              "id": 9
            },
            "min_mod_revision": {
              "type": "int64",
              "id": 10,
              "options": {
                "(versionpb.etcd_version_field)": "3.1"
              }
            },
            "max_mod_revision": {
              "type": "int64",
              "id": 11,
              "options": {
                "(versionpb.etcd_version_field)": "3.1"
              }
            },
            "min_create_revision": {
              "type": "int64",
              "id": 12,
              "options": {
                "(versionpb.etcd_version_field)": "3.1"
              }
            },
            "max_create_revision": {
              "type": "int64",
              "id": 13,
              "options": {
                "(versionpb.etcd_version_field)": "3.1"
              }
            }
          },
          "nested": {
            "SortOrder": {
              "options": {
                "(versionpb.etcd_version_enum)": "3.0"
              },
              "values": {
                "NONE": 0,
                "ASCEND": 1,
                "DESCEND": 2
              }
            },
            "SortTarget": {
              "options": {
                "(versionpb.etcd_version_enum)": "3.0"
              },
              "values": {
                "KEY": 0,
                "VERSION": 1,
                "CREATE": 2,
                "MOD": 3,
                "VALUE": 4
              }
            }
          }
        },
        "RangeResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            },
            "kvs": {
              "rule": "repeated",
              "type": "mvccpb.KeyValue",
              "id": 2
            },
            "more": {
              "type": "bool",
              "id": 3
            },
            "count": {
              "type": "int64",
              "id": 4
            }
          }
        },
        "PutRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "key": {
              "type": "bytes",
              "id": 1
            },
            "value": {
              "type": "bytes",
              "id": 2
            },
            "lease": {
              "type": "int64",
              "id": 3
            },
            "prev_kv": {
              "type": "bool",
              "id": 4,
              "options": {
                "(versionpb.etcd_version_field)": "3.1"
              }
            },
            "ignore_value": {
              "type": "bool",
              "id": 5,
              "options": {
                "(versionpb.etcd_version_field)": "3.2"
              }
            },
            "ignore_lease": {
              "type": "bool",
              "id": 6,
              "options": {
                "(versionpb.etcd_version_field)": "3.2"
              }
            }
          }
        },
        "PutResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            },
            "prev_kv": {
              "type": "mvccpb.KeyValue",
              "id": 2,
              "options": {
                "(versionpb.etcd_version_field)": "3.1"
              }
            }
          }
        },
        "DeleteRangeRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "key": {
              "type": "bytes",
              "id": 1
            },
            "range_end": {
              "type": "bytes",
              "id": 2
            },
            "prev_kv": {
              "type": "bool",
              "id": 3,
              "options": {
                "(versionpb.etcd_version_field)": "3.1"
              }
            }
          }
        },
        "DeleteRangeResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            },
            "deleted": {
              "type": "int64",
              "id": 2
            },
            "prev_kvs": {
              "rule": "repeated",
              "type": "mvccpb.KeyValue",
              "id": 3,
              "options": {
                "(versionpb.etcd_version_field)": "3.1"
              }
            }
          }
        },
        "RequestOp": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "oneofs": {
            "request": {
              "oneof": [
                "request_range",
                "request_put",
                "request_delete_range",
                "request_txn"
              ]
            }
          },
          "fields": {
            "request_range": {
              "type": "RangeRequest",
              "id": 1
            },
            "request_put": {
              "type": "PutRequest",
              "id": 2
            },
            "request_delete_range": {
              "type": "DeleteRangeRequest",
              "id": 3
            },
            "request_txn": {
              "type": "TxnRequest",
              "id": 4,
              "options": {
                "(versionpb.etcd_version_field)": "3.3"
              }
            }
          }
        },
        "ResponseOp": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "oneofs": {
            "response": {
              "oneof": [
                "response_range",
                "response_put",
                "response_delete_range",
                "response_txn"
              ]
            }
          },
          "fields": {
            "response_range": {
              "type": "RangeResponse",
              "id": 1
            },
            "response_put": {
              "type": "PutResponse",
              "id": 2
            },
            "response_delete_range": {
              "type": "DeleteRangeResponse",
              "id": 3
            },
            "response_txn": {
              "type": "TxnResponse",
              "id": 4,
              "options": {
                "(versionpb.etcd_version_field)": "3.3"
              }
            }
          }
        },
        "Compare": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "oneofs": {
            "target_union": {
              "oneof": [
                "version",
                "create_revision",
                "mod_revision",
                "value",
                "lease"
              ]
            }
          },
          "fields": {
            "result": {
              "type": "CompareResult",
              "id": 1
            },
            "target": {
              "type": "CompareTarget",
              "id": 2
            },
            "key": {
              "type": "bytes",
              "id": 3
            },
            "version": {
              "type": "int64",
              "id": 4
            },
            "create_revision": {
              "type": "int64",
              "id": 5
            },
            "mod_revision": {
              "type": "int64",
              "id": 6
            },
            "value": {
              "type": "bytes",
              "id": 7
            },
            "lease": {
              "type": "int64",
              "id": 8,
              "options": {
                "(versionpb.etcd_version_field)": "3.3"
              }
            },
            "range_end": {
              "type": "bytes",
              "id": 64,
              "options": {
                "(versionpb.etcd_version_field)": "3.3"
              }
            }
          },
          "nested": {
            "CompareResult": {
              "options": {
                "(versionpb.etcd_version_enum)": "3.0"
              },
              "valuesOptions": {
                "NOT_EQUAL": {
                  "(versionpb.etcd_version_enum_value)": "3.1"
                }
              },
              "values": {
                "EQUAL": 0,
                "GREATER": 1,
                "LESS": 2,
                "NOT_EQUAL": 3
              }
            },
            "CompareTarget": {
              "options": {
                "(versionpb.etcd_version_enum)": "3.0"
              },
              "valuesOptions": {
                "LEASE": {
                  "(versionpb.etcd_version_enum_value)": "3.3"
                }
              },
              "values": {
                "VERSION": 0,
                "CREATE": 1,
                "MOD": 2,
                "VALUE": 3,
                "LEASE": 4
              }
            }
          }
        },
        "TxnRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "compare": {
              "rule": "repeated",
              "type": "Compare",
              "id": 1
            },
            "success": {
              "rule": "repeated",
              "type": "RequestOp",
              "id": 2
            },
            "failure": {
              "rule": "repeated",
              "type": "RequestOp",
              "id": 3
            }
          }
        },
        "TxnResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            },
            "succeeded": {
              "type": "bool",
              "id": 2
            },
            "responses": {
              "rule": "repeated",
              "type": "ResponseOp",
              "id": 3
            }
          }
        },
        "CompactionRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "revision": {
              "type": "int64",
              "id": 1
            },
            "physical": {
              "type": "bool",
              "id": 2
            }
          }
        },
        "CompactionResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            }
          }
        },
        "HashRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {}
        },
        "HashKVRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.3"
          },
          "fields": {
            "revision": {
              "type": "int64",
              "id": 1
            }
          }
        },
        "HashKVResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.3"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            },
            "hash": {
              "type": "uint32",
              "id": 2
            },
            "compact_revision": {
              "type": "int64",
              "id": 3
            },
            "hash_revision": {
              "type": "int64",
              "id": 4,
              "options": {
                "(versionpb.etcd_version_field)": "3.6"
              }
            }
          }
        },
        "HashResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            },
            "hash": {
              "type": "uint32",
              "id": 2
            }
          }
        },
        "SnapshotRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.3"
          },
          "fields": {}
        },
        "SnapshotResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.3"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            },
            "remaining_bytes": {
              "type": "uint64",
              "id": 2
            },
            "blob": {
              "type": "bytes",
              "id": 3
            },
            "version": {
              "type": "string",
              "id": 4,
              "options": {
                "(versionpb.etcd_version_field)": "3.6"
              }
            }
          }
        },
        "WatchRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "oneofs": {
            "request_union": {
              "oneof": [
                "create_request",
                "cancel_request",
                "progress_request"
              ]
            }
          },
          "fields": {
            "create_request": {
              "type": "WatchCreateRequest",
              "id": 1
            },
            "cancel_request": {
              "type": "WatchCancelRequest",
              "id": 2
            },
            "progress_request": {
              "type": "WatchProgressRequest",
              "id": 3,
              "options": {
                "(versionpb.etcd_version_field)": "3.4"
              }
            }
          }
        },
        "WatchCreateRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "key": {
              "type": "bytes",
              "id": 1
            },
            "range_end": {
              "type": "bytes",
              "id": 2
            },
            "start_revision": {
              "type": "int64",
              "id": 3
            },
            "progress_notify": {
              "type": "bool",
              "id": 4
            },
            "filters": {
              "rule": "repeated",
              "type": "FilterType",
              "id": 5,
              "options": {
                "(versionpb.etcd_version_field)": "3.1"
              }
            },
            "prev_kv": {
              "type": "bool",
              "id": 6,
              "options": {
                "(versionpb.etcd_version_field)": "3.1"
              }
            },
            "watch_id": {
              "type": "int64",
              "id": 7,
              "options": {
                "(versionpb.etcd_version_field)": "3.4"
              }
            },
            "fragment": {
              "type": "bool",
              "id": 8,
              "options": {
                "(versionpb.etcd_version_field)": "3.4"
              }
            }
          },
          "nested": {
            "FilterType": {
              "options": {
                "(versionpb.etcd_version_enum)": "3.1"
              },
              "values": {
                "NOPUT": 0,
                "NODELETE": 1
              }
            }
          }
        },
        "WatchCancelRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.1"
          },
          "fields": {
            "watch_id": {
              "type": "int64",
              "id": 1,
              "options": {
                "(versionpb.etcd_version_field)": "3.1"
              }
            }
          }
        },
        "WatchProgressRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.4"
          },
          "fields": {}
        },
        "WatchResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            },
            "watch_id": {
              "type": "int64",
              "id": 2
            },
            "created": {
              "type": "bool",
              "id": 3
            },
            "canceled": {
              "type": "bool",
              "id": 4
            },
            "compact_revision": {
              "type": "int64",
              "id": 5
            },
            "cancel_reason": {
              "type": "string",
              "id": 6,
              "options": {
                "(versionpb.etcd_version_field)": "3.4"
              }
            },
            "fragment": {
              "type": "bool",
              "id": 7,
              "options": {
                "(versionpb.etcd_version_field)": "3.4"
              }
            },
            "events": {
              "rule": "repeated",
              "type": "mvccpb.Event",
              "id": 11
            }
          }
        },
        "LeaseGrantRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "TTL": {
              "type": "int64",
              "id": 1
            },
            "ID": {
              "type": "int64",
              "id": 2
            }
          }
        },
        "LeaseGrantResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            },
            "ID": {
              "type": "int64",
              "id": 2
            },
            "TTL": {
              "type": "int64",
              "id": 3
            },
            "error": {
              "type": "string",
              "id": 4
            }
          }
        },
        "LeaseRevokeRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "ID": {
              "type": "int64",
              "id": 1
            }
          }
        },
        "LeaseRevokeResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            }
          }
        },
        "LeaseCheckpoint": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.4"
          },
          "fields": {
            "ID": {
              "type": "int64",
              "id": 1
            },
            "remaining_TTL": {
              "type": "int64",
              "id": 2
            }
          }
        },
        "LeaseCheckpointRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.4"
          },
          "fields": {
            "checkpoints": {
              "rule": "repeated",
              "type": "LeaseCheckpoint",
              "id": 1
            }
          }
        },
        "LeaseCheckpointResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.4"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            }
          }
        },
        "LeaseKeepAliveRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "ID": {
              "type": "int64",
              "id": 1
            }
          }
        },
        "LeaseKeepAliveResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            },
            "ID": {
              "type": "int64",
              "id": 2
            },
            "TTL": {
              "type": "int64",
              "id": 3
            }
          }
        },
        "LeaseTimeToLiveRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.1"
          },
          "fields": {
            "ID": {
              "type": "int64",
              "id": 1
            },
            "keys": {
              "type": "bool",
              "id": 2
            }
          }
        },
        "LeaseTimeToLiveResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.1"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            },
            "ID": {
              "type": "int64",
              "id": 2
            },
            "TTL": {
              "type": "int64",
              "id": 3
            },
            "grantedTTL": {
              "type": "int64",
              "id": 4
            },
            "keys": {
              "rule": "repeated",
              "type": "bytes",
              "id": 5
            }
          }
        },
        "LeaseLeasesRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.3"
          },
          "fields": {}
        },
        "LeaseStatus": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.3"
          },
          "fields": {
            "ID": {
              "type": "int64",
              "id": 1
            }
          }
        },
        "LeaseLeasesResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.3"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            },
            "leases": {
              "rule": "repeated",
              "type": "LeaseStatus",
              "id": 2
            }
          }
        },
        "Member": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "ID": {
              "type": "uint64",
              "id": 1
            },
            "name": {
              "type": "string",
              "id": 2
            },
            "peerURLs": {
              "rule": "repeated",
              "type": "string",
              "id": 3
            },
            "clientURLs": {
              "rule": "repeated",
              "type": "string",
              "id": 4
            },
            "isLearner": {
              "type": "bool",
              "id": 5,
              "options": {
                "(versionpb.etcd_version_field)": "3.4"
              }
            }
          }
        },
        "MemberAddRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "peerURLs": {
              "rule": "repeated",
              "type": "string",
              "id": 1
            },
            "isLearner": {
              "type": "bool",
              "id": 2,
              "options": {
                "(versionpb.etcd_version_field)": "3.4"
              }
            }
          }
        },
        "MemberAddResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            },
            "member": {
              "type": "Member",
              "id": 2
            },
            "members": {
              "rule": "repeated",
              "type": "Member",
              "id": 3
            }
          }
        },
        "MemberRemoveRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "ID": {
              "type": "uint64",
              "id": 1
            }
          }
        },
        "MemberRemoveResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            },
            "members": {
              "rule": "repeated",
              "type": "Member",
              "id": 2
            }
          }
        },
        "MemberUpdateRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "ID": {
              "type": "uint64",
              "id": 1
            },
            "peerURLs": {
              "rule": "repeated",
              "type": "string",
              "id": 2
            }
          }
        },
        "MemberUpdateResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            },
            "members": {
              "rule": "repeated",
              "type": "Member",
              "id": 2,
              "options": {
                "(versionpb.etcd_version_field)": "3.1"
              }
            }
          }
        },
        "MemberListRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "linearizable": {
              "type": "bool",
              "id": 1,
              "options": {
                "(versionpb.etcd_version_field)": "3.5"
              }
            }
          }
        },
        "MemberListResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            },
            "members": {
              "rule": "repeated",
              "type": "Member",
              "id": 2
            }
          }
        },
        "MemberPromoteRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.4"
          },
          "fields": {
            "ID": {
              "type": "uint64",
              "id": 1
            }
          }
        },
        "MemberPromoteResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.4"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            },
            "members": {
              "rule": "repeated",
              "type": "Member",
              "id": 2
            }
          }
        },
        "DefragmentRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {}
        },
        "DefragmentResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            }
          }
        },
        "MoveLeaderRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.3"
          },
          "fields": {
            "targetID": {
              "type": "uint64",
              "id": 1
            }
          }
        },
        "MoveLeaderResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.3"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            }
          }
        },
        "AlarmType": {
          "options": {
            "(versionpb.etcd_version_enum)": "3.0"
          },
          "valuesOptions": {
            "CORRUPT": {
              "(versionpb.etcd_version_enum_value)": "3.3"
            }
          },
          "values": {
            "NONE": 0,
            "NOSPACE": 1,
            "CORRUPT": 2
          }
        },
        "AlarmRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "action": {
              "type": "AlarmAction",
              "id": 1
            },
            "memberID": {
              "type": "uint64",
              "id": 2
            },
            "alarm": {
              "type": "AlarmType",
              "id": 3
            }
          },
          "nested": {
            "AlarmAction": {
              "options": {
                "(versionpb.etcd_version_enum)": "3.0"
              },
              "values": {
                "GET": 0,
                "ACTIVATE": 1,
                "DEACTIVATE": 2
              }
            }
          }
        },
        "AlarmMember": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "memberID": {
              "type": "uint64",
              "id": 1
            },
            "alarm": {
              "type": "AlarmType",
              "id": 2
            }
          }
        },
        "AlarmResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            },
            "alarms": {
              "rule": "repeated",
              "type": "AlarmMember",
              "id": 2
            }
          }
        },
        "DowngradeRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.5"
          },
          "fields": {
            "action": {
              "type": "DowngradeAction",
              "id": 1
            },
            "version": {
              "type": "string",
              "id": 2
            }
          },
          "nested": {
            "DowngradeAction": {
              "options": {
                "(versionpb.etcd_version_enum)": "3.5"
              },
              "values": {
                "VALIDATE": 0,
                "ENABLE": 1,
                "CANCEL": 2
              }
            }
          }
        },
        "DowngradeResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.5"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            },
            "version": {
              "type": "string",
              "id": 2
            }
          }
        },
        "DowngradeVersionTestRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.6"
          },
          "fields": {
            "ver": {
              "type": "string",
              "id": 1
            }
          }
        },
        "StatusRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {}
        },
        "StatusResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            },
            "version": {
              "type": "string",
              "id": 2
            },
            "dbSize": {
              "type": "int64",
              "id": 3
            },
            "leader": {
              "type": "uint64",
              "id": 4
            },
            "raftIndex": {
              "type": "uint64",
              "id": 5
            },
            "raftTerm": {
              "type": "uint64",
              "id": 6
            },
            "raftAppliedIndex": {
              "type": "uint64",
              "id": 7,
              "options": {
                "(versionpb.etcd_version_field)": "3.4"
              }
            },
            "errors": {
              "rule": "repeated",
              "type": "string",
              "id": 8,
              "options": {
                "(versionpb.etcd_version_field)": "3.4"
              }
            },
            "dbSizeInUse": {
              "type": "int64",
              "id": 9,
              "options": {
                "(versionpb.etcd_version_field)": "3.4"
              }
            },
            "isLearner": {
              "type": "bool",
              "id": 10,
              "options": {
                "(versionpb.etcd_version_field)": "3.4"
              }
            },
            "storageVersion": {
              "type": "string",
              "id": 11,
              "options": {
                "(versionpb.etcd_version_field)": "3.6"
              }
            },
            "dbSizeQuota": {
              "type": "int64",
              "id": 12,
              "options": {
                "(versionpb.etcd_version_field)": "3.6"
              }
            },
            "downgradeInfo": {
              "type": "DowngradeInfo",
              "id": 13,
              "options": {
                "(versionpb.etcd_version_field)": "3.6"
              }
            }
          }
        },
        "DowngradeInfo": {
          "fields": {
            "enabled": {
              "type": "bool",
              "id": 1
            },
            "targetVersion": {
              "type": "string",
              "id": 2
            }
          }
        },
        "AuthEnableRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {}
        },
        "AuthDisableRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {}
        },
        "AuthStatusRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.5"
          },
          "fields": {}
        },
        "AuthenticateRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "name": {
              "type": "string",
              "id": 1
            },
            "password": {
              "type": "string",
              "id": 2
            }
          }
        },
        "AuthUserAddRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "name": {
              "type": "string",
              "id": 1
            },
            "password": {
              "type": "string",
              "id": 2
            },
            "options": {
              "type": "authpb.UserAddOptions",
              "id": 3,
              "options": {
                "(versionpb.etcd_version_field)": "3.4"
              }
            },
            "hashedPassword": {
              "type": "string",
              "id": 4,
              "options": {
                "(versionpb.etcd_version_field)": "3.5"
              }
            }
          }
        },
        "AuthUserGetRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "name": {
              "type": "string",
              "id": 1
            }
          }
        },
        "AuthUserDeleteRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "name": {
              "type": "string",
              "id": 1
            }
          }
        },
        "AuthUserChangePasswordRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "name": {
              "type": "string",
              "id": 1
            },
            "password": {
              "type": "string",
              "id": 2
            },
            "hashedPassword": {
              "type": "string",
              "id": 3,
              "options": {
                "(versionpb.etcd_version_field)": "3.5"
              }
            }
          }
        },
        "AuthUserGrantRoleRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "user": {
              "type": "string",
              "id": 1
            },
            "role": {
              "type": "string",
              "id": 2
            }
          }
        },
        "AuthUserRevokeRoleRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "name": {
              "type": "string",
              "id": 1
            },
            "role": {
              "type": "string",
              "id": 2
            }
          }
        },
        "AuthRoleAddRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "name": {
              "type": "string",
              "id": 1
            }
          }
        },
        "AuthRoleGetRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "role": {
              "type": "string",
              "id": 1
            }
          }
        },
        "AuthUserListRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {}
        },
        "AuthRoleListRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {}
        },
        "AuthRoleDeleteRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "role": {
              "type": "string",
              "id": 1
            }
          }
        },
        "AuthRoleGrantPermissionRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "name": {
              "type": "string",
              "id": 1
            },
            "perm": {
              "type": "authpb.Permission",
              "id": 2
            }
          }
        },
        "AuthRoleRevokePermissionRequest": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "role": {
              "type": "string",
              "id": 1
            },
            "key": {
              "type": "bytes",
              "id": 2
            },
            "range_end": {
              "type": "bytes",
              "id": 3
            }
          }
        },
        "AuthEnableResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            }
          }
        },
        "AuthDisableResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            }
          }
        },
        "AuthStatusResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.5"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            },
            "enabled": {
              "type": "bool",
              "id": 2
            },
            "authRevision": {
              "type": "uint64",
              "id": 3
            }
          }
        },
        "AuthenticateResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            },
            "token": {
              "type": "string",
              "id": 2
            }
          }
        },
        "AuthUserAddResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            }
          }
        },
        "AuthUserGetResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            },
            "roles": {
              "rule": "repeated",
              "type": "string",
              "id": 2
            }
          }
        },
        "AuthUserDeleteResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            }
          }
        },
        "AuthUserChangePasswordResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            }
          }
        },
        "AuthUserGrantRoleResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            }
          }
        },
        "AuthUserRevokeRoleResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            }
          }
        },
        "AuthRoleAddResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            }
          }
        },
        "AuthRoleGetResponse": {
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1,
              "options": {
                "(versionpb.etcd_version_field)": "3.0"
              }
            },
            "perm": {
              "rule": "repeated",
              "type": "authpb.Permission",
              "id": 2,
              "options": {
                "(versionpb.etcd_version_field)": "3.0"
              }
            }
          }
        },
        "AuthRoleListResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            },
            "roles": {
              "rule": "repeated",
              "type": "string",
              "id": 2
            }
          }
        },
        "AuthUserListResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            },
            "users": {
              "rule": "repeated",
              "type": "string",
              "id": 2
            }
          }
        },
        "AuthRoleDeleteResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            }
          }
        },
        "AuthRoleGrantPermissionResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            }
          }
        },
        "AuthRoleRevokePermissionResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.0"
          },
          "fields": {
            "header": {
              "type": "ResponseHeader",
              "id": 1
            }
          }
        },
        "RangeStreamResponse": {
          "options": {
            "(versionpb.etcd_version_msg)": "3.7"
          },
          "fields": {
            "range_response": {
              "type": "RangeResponse",
              "id": 1
            }
          }
        }
      }
    },
    "mvccpb": {
      "options": {
        "go_package": "go.etcd.io/etcd/api/v3/mvccpb"
      },
      "nested": {
        "KeyValue": {
          "fields": {
            "key": {
              "type": "bytes",
              "id": 1
            },
            "create_revision": {
              "type": "int64",
              "id": 2
            },
            "mod_revision": {
              "type": "int64",
              "id": 3
            },
            "version": {
              "type": "int64",
              "id": 4
            },
            "value": {
              "type": "bytes",
              "id": 5
            },
            "lease": {
              "type": "int64",
              "id": 6
            }
          }
        },
        "Event": {
          "fields": {
            "type": {
              "type": "EventType",
              "id": 1
            },
            "kv": {
              "type": "KeyValue",
              "id": 2
            },
            "prev_kv": {
              "type": "KeyValue",
              "id": 3
            }
          },
          "nested": {
            "EventType": {
              "values": {
                "PUT": 0,
                "DELETE": 1
              }
            }
          }
        }
      }
    },
    "authpb": {
      "options": {
        "go_package": "go.etcd.io/etcd/api/v3/authpb"
      },
      "nested": {
        "UserAddOptions": {
          "fields": {
            "no_password": {
              "type": "bool",
              "id": 1
            }
          }
        },
        "User": {
          "fields": {
            "name": {
              "type": "bytes",
              "id": 1
            },
            "password": {
              "type": "bytes",
              "id": 2
            },
            "roles": {
              "rule": "repeated",
              "type": "string",
              "id": 3
            },
            "options": {
              "type": "UserAddOptions",
              "id": 4
            }
          }
        },
        "Permission": {
          "fields": {
            "permType": {
              "type": "Type",
              "id": 1
            },
            "key": {
              "type": "bytes",
              "id": 2
            },
            "range_end": {
              "type": "bytes",
              "id": 3
            }
          },
          "nested": {
            "Type": {
              "values": {
                "READ": 0,
                "WRITE": 1,
                "READWRITE": 2
              }
            }
          }
        },
        "Role": {
          "fields": {
            "name": {
              "type": "bytes",
              "id": 1
            },
            "keyPermission": {
              "rule": "repeated",
              "type": "Permission",
              "id": 2
            }
          }
        }
      }
    },
    "versionpb": {
      "options": {
        "go_package": "go.etcd.io/etcd/api/v3/versionpb"
      },
      "nested": {
        "_etcd_version_msg": {
          "oneof": [
            "etcd_version_msg"
          ]
        },
        "etcd_version_msg": {
          "type": "string",
          "id": 50000,
          "extend": "google.protobuf.MessageOptions",
          "options": {
            "proto3_optional": true
          }
        },
        "_etcd_version_field": {
          "oneof": [
            "etcd_version_field"
          ]
        },
        "etcd_version_field": {
          "type": "string",
          "id": 50001,
          "extend": "google.protobuf.FieldOptions",
          "options": {
            "proto3_optional": true
          }
        },
        "_etcd_version_enum": {
          "oneof": [
            "etcd_version_enum"
          ]
        },
        "etcd_version_enum": {
          "type": "string",
          "id": 50002,
          "extend": "google.protobuf.EnumOptions",
          "options": {
            "proto3_optional": true
          }
        },
        "_etcd_version_enum_value": {
          "oneof": [
            "etcd_version_enum_value"
          ]
        },
        "etcd_version_enum_value": {
          "type": "string",
          "id": 50003,
          "extend": "google.protobuf.EnumValueOptions",
          "options": {
            "proto3_optional": true
          }
        }
      }
    },
    "google": {
      "nested": {
        "protobuf": {
          "nested": {
            "FileDescriptorSet": {
              "edition": "proto2",
              "fields": {
                "file": {
                  "rule": "repeated",
                  "type": "FileDescriptorProto",
                  "id": 1
                }
              },
              "extensions": [
                [
                  536000000,
                  536000000
                ]
              ]
            },
            "Edition": {
              "edition": "proto2",
              "values": {
                "EDITION_UNKNOWN": 0,
                "EDITION_LEGACY": 900,
                "EDITION_PROTO2": 998,
                "EDITION_PROTO3": 999,
                "EDITION_2023": 1000,
                "EDITION_2024": 1001,
                "EDITION_1_TEST_ONLY": 1,
                "EDITION_2_TEST_ONLY": 2,
                "EDITION_99997_TEST_ONLY": 99997,
                "EDITION_99998_TEST_ONLY": 99998,
                "EDITION_99999_TEST_ONLY": 99999,
                "EDITION_MAX": 2147483647
              }
            },
            "FileDescriptorProto": {
              "edition": "proto2",
              "fields": {
                "name": {
                  "type": "string",
                  "id": 1
                },
                "package": {
                  "type": "string",
                  "id": 2
                },
                "dependency": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 3
                },
                "publicDependency": {
                  "rule": "repeated",
                  "type": "int32",
                  "id": 10
                },
                "weakDependency": {
                  "rule": "repeated",
                  "type": "int32",
                  "id": 11
                },
                "optionDependency": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 15
                },
                "messageType": {
                  "rule": "repeated",
                  "type": "DescriptorProto",
                  "id": 4
                },
                "enumType": {
                  "rule": "repeated",
                  "type": "EnumDescriptorProto",
                  "id": 5
                },
                "service": {
                  "rule": "repeated",
                  "type": "ServiceDescriptorProto",
                  "id": 6
                },
                "extension": {
                  "rule": "repeated",
                  "type": "FieldDescriptorProto",
                  "id": 7
                },
                "options": {
                  "type": "FileOptions",
                  "id": 8
                },
                "sourceCodeInfo": {
                  "type": "SourceCodeInfo",
                  "id": 9
                },
                "syntax": {
                  "type": "string",
                  "id": 12
                },
                "edition": {
                  "type": "Edition",
                  "id": 14
                }
              }
            },
            "DescriptorProto": {
              "edition": "proto2",
              "fields": {
                "name": {
                  "type": "string",
                  "id": 1
                },
                "field": {
                  "rule": "repeated",
                  "type": "FieldDescriptorProto",
                  "id": 2
                },
                "extension": {
                  "rule": "repeated",
                  "type": "FieldDescriptorProto",
                  "id": 6
                },
                "nestedType": {
                  "rule": "repeated",
                  "type": "DescriptorProto",
                  "id": 3
                },
                "enumType": {
                  "rule": "repeated",
                  "type": "EnumDescriptorProto",
                  "id": 4
                },
                "extensionRange": {
                  "rule": "repeated",
                  "type": "ExtensionRange",
                  "id": 5
                },
                "oneofDecl": {
                  "rule": "repeated",
                  "type": "OneofDescriptorProto",
                  "id": 8
                },
                "options": {
                  "type": "MessageOptions",
                  "id": 7
                },
                "reservedRange": {
                  "rule": "repeated",
                  "type": "ReservedRange",
                  "id": 9
                },
                "reservedName": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 10
                },
                "visibility": {
                  "type": "SymbolVisibility",
                  "id": 11
                }
              },
              "nested": {
                "ExtensionRange": {
                  "fields": {
                    "start": {
                      "type": "int32",
                      "id": 1
                    },
                    "end": {
                      "type": "int32",
                      "id": 2
                    },
                    "options": {
                      "type": "ExtensionRangeOptions",
                      "id": 3
                    }
                  }
                },
                "ReservedRange": {
                  "fields": {
                    "start": {
                      "type": "int32",
                      "id": 1
                    },
                    "end": {
                      "type": "int32",
                      "id": 2
                    }
                  }
                }
              }
            },
            "ExtensionRangeOptions": {
              "edition": "proto2",
              "fields": {
                "uninterpretedOption": {
                  "rule": "repeated",
                  "type": "UninterpretedOption",
                  "id": 999
                },
                "declaration": {
                  "rule": "repeated",
                  "type": "Declaration",
                  "id": 2,
                  "options": {
                    "retention": "RETENTION_SOURCE"
                  }
                },
                "features": {
                  "type": "FeatureSet",
                  "id": 50
                },
                "verification": {
                  "type": "VerificationState",
                  "id": 3,
                  "options": {
                    "default": "UNVERIFIED",
                    "retention": "RETENTION_SOURCE"
                  }
                }
              },
              "extensions": [
                [
                  1000,
                  536870911
                ]
              ],
              "nested": {
                "Declaration": {
                  "fields": {
                    "number": {
                      "type": "int32",
                      "id": 1
                    },
                    "fullName": {
                      "type": "string",
                      "id": 2
                    },
                    "type": {
                      "type": "string",
                      "id": 3
                    },
                    "reserved": {
                      "type": "bool",
                      "id": 5
                    },
                    "repeated": {
                      "type": "bool",
                      "id": 6
                    }
                  },
                  "reserved": [
                    [
                      4,
                      4
                    ]
                  ]
                },
                "VerificationState": {
                  "values": {
                    "DECLARATION": 0,
                    "UNVERIFIED": 1
                  }
                }
              }
            },
            "FieldDescriptorProto": {
              "edition": "proto2",
              "fields": {
                "name": {
                  "type": "string",
                  "id": 1
                },
                "number": {
                  "type": "int32",
                  "id": 3
                },
                "label": {
                  "type": "Label",
                  "id": 4
                },
                "type": {
                  "type": "Type",
                  "id": 5
                },
                "typeName": {
                  "type": "string",
                  "id": 6
                },
                "extendee": {
                  "type": "string",
                  "id": 2
                },
                "defaultValue": {
                  "type": "string",
                  "id": 7
                },
                "oneofIndex": {
                  "type": "int32",
                  "id": 9
                },
                "jsonName": {
                  "type": "string",
                  "id": 10
                },
                "options": {
                  "type": "FieldOptions",
                  "id": 8
                },
                "proto3Optional": {
                  "type": "bool",
                  "id": 17
                }
              },
              "nested": {
                "Type": {
                  "values": {
                    "TYPE_DOUBLE": 1,
                    "TYPE_FLOAT": 2,
                    "TYPE_INT64": 3,
                    "TYPE_UINT64": 4,
                    "TYPE_INT32": 5,
                    "TYPE_FIXED64": 6,
                    "TYPE_FIXED32": 7,
                    "TYPE_BOOL": 8,
                    "TYPE_STRING": 9,
                    "TYPE_GROUP": 10,
                    "TYPE_MESSAGE": 11,
                    "TYPE_BYTES": 12,
                    "TYPE_UINT32": 13,
                    "TYPE_ENUM": 14,
                    "TYPE_SFIXED32": 15,
                    "TYPE_SFIXED64": 16,
                    "TYPE_SINT32": 17,
                    "TYPE_SINT64": 18
                  }
                },
                "Label": {
                  "values": {
                    "LABEL_OPTIONAL": 1,
                    "LABEL_REPEATED": 3,
                    "LABEL_REQUIRED": 2
                  }
                }
              }
            },
            "OneofDescriptorProto": {
              "edition": "proto2",
              "fields": {
                "name": {
                  "type": "string",
                  "id": 1
                },
                "options": {
                  "type": "OneofOptions",
                  "id": 2
                }
              }
            },
            "EnumDescriptorProto": {
              "edition": "proto2",
              "fields": {
                "name": {
                  "type": "string",
                  "id": 1
                },
                "value": {
                  "rule": "repeated",
                  "type": "EnumValueDescriptorProto",
                  "id": 2
                },
                "options": {
                  "type": "EnumOptions",
                  "id": 3
                },
                "reservedRange": {
                  "rule": "repeated",
                  "type": "EnumReservedRange",
                  "id": 4
                },
                "reservedName": {
                  "rule": "repeated",
                  "type": "string",
                  "id": 5
                },
                "visibility": {
                  "type": "SymbolVisibility",
                  "id": 6
                }
              },
              "nested": {
                "EnumReservedRange": {
                  "fields": {
                    "start": {
                      "type": "int32",
                      "id": 1
                    },
                    "end": {
                      "type": "int32",
                      "id": 2
                    }
                  }
                }
              }
            },
            "EnumValueDescriptorProto": {
              "edition": "proto2",
              "fields": {
                "name": {
                  "type": "string",
                  "id": 1
                },
                "number": {
                  "type": "int32",
                  "id": 2
                },
                "options": {
                  "type": "EnumValueOptions",
                  "id": 3
                }
              }
            },
            "ServiceDescriptorProto": {
              "edition": "proto2",
              "fields": {
                "name": {
                  "type": "string",
                  "id": 1
                },
                "method": {
                  "rule": "repeated",
                  "type": "MethodDescriptorProto",
                  "id": 2
                },
                "options": {
                  "type": "ServiceOptions",
                  "id": 3
                }
              }
            },
            "MethodDescriptorProto": {
              "edition": "proto2",
              "fields": {
                "name": {
                  "type": "string",
                  "id": 1
                },
                "inputType": {
                  "type": "string",
                  "id": 2
                },
                "outputType": {
                  "type": "string",
                  "id": 3
                },
                "options": {
                  "type": "MethodOptions",
                  "id": 4
                },
                "clientStreaming": {
                  "type": "bool",
                  "id": 5
                },
                "serverStreaming": {
                  "type": "bool",
                  "id": 6
                }
              }
            },
            "FileOptions": {
              "edition": "proto2",
              "fields": {
                "javaPackage": {
                  "type": "string",
                  "id": 1
                },
                "javaOuterClassname": {
                  "type": "string",
                  "id": 8
                },
                "javaMultipleFiles": {
                  "type": "bool",
                  "id": 10
                },
                "javaGenerateEqualsAndHash": {
                  "type": "bool",
                  "id": 20,
                  "options": {
                    "deprecated": true
                  }
                },
                "javaStringCheckUtf8": {
                  "type": "bool",
                  "id": 27
                },
                "optimizeFor": {
                  "type": "OptimizeMode",
                  "id": 9,
                  "options": {
                    "default": "SPEED"
                  }
                },
                "goPackage": {
                  "type": "string",
                  "id": 11
                },
                "ccGenericServices": {
                  "type": "bool",
                  "id": 16
                },
                "javaGenericServices": {
                  "type": "bool",
                  "id": 17
                },
                "pyGenericServices": {
                  "type": "bool",
                  "id": 18
                },
                "deprecated": {
                  "type": "bool",
                  "id": 23
                },
                "ccEnableArenas": {
                  "type": "bool",
                  "id": 31,
                  "options": {
                    "default": true
                  }
                },
                "objcClassPrefix": {
                  "type": "string",
                  "id": 36
                },
                "csharpNamespace": {
                  "type": "string",
                  "id": 37
                },
                "swiftPrefix": {
                  "type": "string",
                  "id": 39
                },
                "phpClassPrefix": {
                  "type": "string",
                  "id": 40
                },
                "phpNamespace": {
                  "type": "string",
                  "id": 41
                },
                "phpMetadataNamespace": {
                  "type": "string",
                  "id": 44
                },
                "rubyPackage": {
                  "type": "string",
                  "id": 45
                },
                "features": {
                  "type": "FeatureSet",
                  "id": 50
                },
                "uninterpretedOption": {
                  "rule": "repeated",
                  "type": "UninterpretedOption",
                  "id": 999
                }
              },
              "extensions": [
                [
                  1000,
                  536870911
                ]
              ],
              "reserved": [
                [
                  42,
                  42
                ],
                [
                  38,
                  38
                ],
                "php_generic_services"
              ],
              "nested": {
                "OptimizeMode": {
                  "values": {
                    "SPEED": 1,
                    "CODE_SIZE": 2,
                    "LITE_RUNTIME": 3
                  }
                }
              }
            },
            "MessageOptions": {
              "edition": "proto2",
              "fields": {
                "messageSetWireFormat": {
                  "type": "bool",
                  "id": 1
                },
                "noStandardDescriptorAccessor": {
                  "type": "bool",
                  "id": 2
                },
                "deprecated": {
                  "type": "bool",
                  "id": 3
                },
                "mapEntry": {
                  "type": "bool",
                  "id": 7
                },
                "deprecatedLegacyJsonFieldConflicts": {
                  "type": "bool",
                  "id": 11,
                  "options": {
                    "deprecated": true
                  }
                },
                "features": {
                  "type": "FeatureSet",
                  "id": 12
                },
                "uninterpretedOption": {
                  "rule": "repeated",
                  "type": "UninterpretedOption",
                  "id": 999
                }
              },
              "extensions": [
                [
                  1000,
                  536870911
                ]
              ],
              "reserved": [
                [
                  4,
                  4
                ],
                [
                  5,
                  5
                ],
                [
                  6,
                  6
                ],
                [
                  8,
                  8
                ],
                [
                  9,
                  9
                ]
              ]
            },
            "FieldOptions": {
              "edition": "proto2",
              "fields": {
                "ctype": {
                  "type": "CType",
                  "id": 1,
                  "options": {
                    "default": "STRING"
                  }
                },
                "packed": {
                  "type": "bool",
                  "id": 2
                },
                "jstype": {
                  "type": "JSType",
                  "id": 6,
                  "options": {
                    "default": "JS_NORMAL"
                  }
                },
                "lazy": {
                  "type": "bool",
                  "id": 5
                },
                "unverifiedLazy": {
                  "type": "bool",
                  "id": 15
                },
                "deprecated": {
                  "type": "bool",
                  "id": 3
                },
                "weak": {
                  "type": "bool",
                  "id": 10,
                  "options": {
                    "deprecated": true
                  }
                },
                "debugRedact": {
                  "type": "bool",
                  "id": 16
                },
                "retention": {
                  "type": "OptionRetention",
                  "id": 17
                },
                "targets": {
                  "rule": "repeated",
                  "type": "OptionTargetType",
                  "id": 19
                },
                "editionDefaults": {
                  "rule": "repeated",
                  "type": "EditionDefault",
                  "id": 20
                },
                "features": {
                  "type": "FeatureSet",
                  "id": 21
                },
                "featureSupport": {
                  "type": "FeatureSupport",
                  "id": 22
                },
                "uninterpretedOption": {
                  "rule": "repeated",
                  "type": "UninterpretedOption",
                  "id": 999
                }
              },
              "extensions": [
                [
                  1000,
                  536870911
                ]
              ],
              "reserved": [
                [
                  4,
                  4
                ],
                [
                  18,
                  18
                ]
              ],
              "nested": {
                "CType": {
                  "values": {
                    "STRING": 0,
                    "CORD": 1,
                    "STRING_PIECE": 2
                  }
                },
                "JSType": {
                  "values": {
                    "JS_NORMAL": 0,
                    "JS_STRING": 1,
                    "JS_NUMBER": 2
                  }
                },
                "OptionRetention": {
                  "values": {
                    "RETENTION_UNKNOWN": 0,
                    "RETENTION_RUNTIME": 1,
                    "RETENTION_SOURCE": 2
                  }
                },
                "OptionTargetType": {
                  "values": {
                    "TARGET_TYPE_UNKNOWN": 0,
                    "TARGET_TYPE_FILE": 1,
                    "TARGET_TYPE_EXTENSION_RANGE": 2,
                    "TARGET_TYPE_MESSAGE": 3,
                    "TARGET_TYPE_FIELD": 4,
                    "TARGET_TYPE_ONEOF": 5,
                    "TARGET_TYPE_ENUM": 6,
                    "TARGET_TYPE_ENUM_ENTRY": 7,
                    "TARGET_TYPE_SERVICE": 8,
                    "TARGET_TYPE_METHOD": 9
                  }
                },
                "EditionDefault": {
                  "fields": {
                    "edition": {
                      "type": "Edition",
                      "id": 3
                    },
                    "value": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "FeatureSupport": {
                  "fields": {
                    "editionIntroduced": {
                      "type": "Edition",
                      "id": 1
                    },
                    "editionDeprecated": {
                      "type": "Edition",
                      "id": 2
                    },
                    "deprecationWarning": {
                      "type": "string",
                      "id": 3
                    },
                    "editionRemoved": {
                      "type": "Edition",
                      "id": 4
                    }
                  }
                }
              }
            },
            "OneofOptions": {
              "edition": "proto2",
              "fields": {
                "features": {
                  "type": "FeatureSet",
                  "id": 1
                },
                "uninterpretedOption": {
                  "rule": "repeated",
                  "type": "UninterpretedOption",
                  "id": 999
                }
              },
              "extensions": [
                [
                  1000,
                  536870911
                ]
              ]
            },
            "EnumOptions": {
              "edition": "proto2",
              "fields": {
                "allowAlias": {
                  "type": "bool",
                  "id": 2
                },
                "deprecated": {
                  "type": "bool",
                  "id": 3
                },
                "deprecatedLegacyJsonFieldConflicts": {
                  "type": "bool",
                  "id": 6,
                  "options": {
                    "deprecated": true
                  }
                },
                "features": {
                  "type": "FeatureSet",
                  "id": 7
                },
                "uninterpretedOption": {
                  "rule": "repeated",
                  "type": "UninterpretedOption",
                  "id": 999
                }
              },
              "extensions": [
                [
                  1000,
                  536870911
                ]
              ],
              "reserved": [
                [
                  5,
                  5
                ]
              ]
            },
            "EnumValueOptions": {
              "edition": "proto2",
              "fields": {
                "deprecated": {
                  "type": "bool",
                  "id": 1
                },
                "features": {
                  "type": "FeatureSet",
                  "id": 2
                },
                "debugRedact": {
                  "type": "bool",
                  "id": 3
                },
                "featureSupport": {
                  "type": "FieldOptions.FeatureSupport",
                  "id": 4
                },
                "uninterpretedOption": {
                  "rule": "repeated",
                  "type": "UninterpretedOption",
                  "id": 999
                }
              },
              "extensions": [
                [
                  1000,
                  536870911
                ]
              ]
            },
            "ServiceOptions": {
              "edition": "proto2",
              "fields": {
                "features": {
                  "type": "FeatureSet",
                  "id": 34
                },
                "deprecated": {
                  "type": "bool",
                  "id": 33
                },
                "uninterpretedOption": {
                  "rule": "repeated",
                  "type": "UninterpretedOption",
                  "id": 999
                }
              },
              "extensions": [
                [
                  1000,
                  536870911
                ]
              ]
            },
            "MethodOptions": {
              "edition": "proto2",
              "fields": {
                "deprecated": {
                  "type": "bool",
                  "id": 33
                },
                "idempotencyLevel": {
                  "type": "IdempotencyLevel",
                  "id": 34,
                  "options": {
                    "default": "IDEMPOTENCY_UNKNOWN"
                  }
                },
                "features": {
                  "type": "FeatureSet",
                  "id": 35
                },
                "uninterpretedOption": {
                  "rule": "repeated",
                  "type": "UninterpretedOption",
                  "id": 999
                }
              },
              "extensions": [
                [
                  1000,
                  536870911
                ]
              ],
              "nested": {
                "IdempotencyLevel": {
                  "values": {
                    "IDEMPOTENCY_UNKNOWN": 0,
                    "NO_SIDE_EFFECTS": 1,
                    "IDEMPOTENT": 2
                  }
                }
              }
            },
            "UninterpretedOption": {
              "edition": "proto2",
              "fields": {
                "name": {
                  "rule": "repeated",
                  "type": "NamePart",
                  "id": 2
                },
                "identifierValue": {
                  "type": "string",
                  "id": 3
                },
                "positiveIntValue": {
                  "type": "uint64",
                  "id": 4
                },
                "negativeIntValue": {
                  "type": "int64",
                  "id": 5
                },
                "doubleValue": {
                  "type": "double",
                  "id": 6
                },
                "stringValue": {
                  "type": "bytes",
                  "id": 7
                },
                "aggregateValue": {
                  "type": "string",
                  "id": 8
                }
              },
              "nested": {
                "NamePart": {
                  "fields": {
                    "namePart": {
                      "rule": "required",
                      "type": "string",
                      "id": 1
                    },
                    "isExtension": {
                      "rule": "required",
                      "type": "bool",
                      "id": 2
                    }
                  }
                }
              }
            },
            "FeatureSet": {
              "edition": "proto2",
              "fields": {
                "fieldPresence": {
                  "type": "FieldPresence",
                  "id": 1,
                  "options": {
                    "retention": "RETENTION_RUNTIME",
                    "targets": "TARGET_TYPE_FILE",
                    "feature_support.edition_introduced": "EDITION_2023",
                    "edition_defaults.edition": "EDITION_2023",
                    "edition_defaults.value": "EXPLICIT"
                  }
                },
                "enumType": {
                  "type": "EnumType",
                  "id": 2,
                  "options": {
                    "retention": "RETENTION_RUNTIME",
                    "targets": "TARGET_TYPE_FILE",
                    "feature_support.edition_introduced": "EDITION_2023",
                    "edition_defaults.edition": "EDITION_PROTO3",
                    "edition_defaults.value": "OPEN"
                  }
                },
                "repeatedFieldEncoding": {
                  "type": "RepeatedFieldEncoding",
                  "id": 3,
                  "options": {
                    "retention": "RETENTION_RUNTIME",
                    "targets": "TARGET_TYPE_FILE",
                    "feature_support.edition_introduced": "EDITION_2023",
                    "edition_defaults.edition": "EDITION_PROTO3",
                    "edition_defaults.value": "PACKED"
                  }
                },
                "utf8Validation": {
                  "type": "Utf8Validation",
                  "id": 4,
                  "options": {
                    "retention": "RETENTION_RUNTIME",
                    "targets": "TARGET_TYPE_FILE",
                    "feature_support.edition_introduced": "EDITION_2023",
                    "edition_defaults.edition": "EDITION_PROTO3",
                    "edition_defaults.value": "VERIFY"
                  }
                },
                "messageEncoding": {
                  "type": "MessageEncoding",
                  "id": 5,
                  "options": {
                    "retention": "RETENTION_RUNTIME",
                    "targets": "TARGET_TYPE_FILE",
                    "feature_support.edition_introduced": "EDITION_2023",
                    "edition_defaults.edition": "EDITION_LEGACY",
                    "edition_defaults.value": "LENGTH_PREFIXED"
                  }
                },
                "jsonFormat": {
                  "type": "JsonFormat",
                  "id": 6,
                  "options": {
                    "retention": "RETENTION_RUNTIME",
                    "targets": "TARGET_TYPE_FILE",
                    "feature_support.edition_introduced": "EDITION_2023",
                    "edition_defaults.edition": "EDITION_PROTO3",
                    "edition_defaults.value": "ALLOW"
                  }
                },
                "enforceNamingStyle": {
                  "type": "EnforceNamingStyle",
                  "id": 7,
                  "options": {
                    "retention": "RETENTION_SOURCE",
                    "targets": "TARGET_TYPE_METHOD",
                    "feature_support.edition_introduced": "EDITION_2024",
                    "edition_defaults.edition": "EDITION_2024",
                    "edition_defaults.value": "STYLE2024"
                  }
                },
                "defaultSymbolVisibility": {
                  "type": "VisibilityFeature.DefaultSymbolVisibility",
                  "id": 8,
                  "options": {
                    "retention": "RETENTION_SOURCE",
                    "targets": "TARGET_TYPE_FILE",
                    "feature_support.edition_introduced": "EDITION_2024",
                    "edition_defaults.edition": "EDITION_2024",
                    "edition_defaults.value": "EXPORT_TOP_LEVEL"
                  }
                }
              },
              "extensions": [
                [
                  1000,
                  9994
                ],
                [
                  9995,
                  9999
                ],
                [
                  10000,
                  10000
                ]
              ],
              "reserved": [
                [
                  999,
                  999
                ]
              ],
              "nested": {
                "FieldPresence": {
                  "values": {
                    "FIELD_PRESENCE_UNKNOWN": 0,
                    "EXPLICIT": 1,
                    "IMPLICIT": 2,
                    "LEGACY_REQUIRED": 3
                  }
                },
                "EnumType": {
                  "values": {
                    "ENUM_TYPE_UNKNOWN": 0,
                    "OPEN": 1,
                    "CLOSED": 2
                  }
                },
                "RepeatedFieldEncoding": {
                  "values": {
                    "REPEATED_FIELD_ENCODING_UNKNOWN": 0,
                    "PACKED": 1,
                    "EXPANDED": 2
                  }
                },
                "Utf8Validation": {
                  "values": {
                    "UTF8_VALIDATION_UNKNOWN": 0,
                    "VERIFY": 2,
                    "NONE": 3
                  }
                },
                "MessageEncoding": {
                  "values": {
                    "MESSAGE_ENCODING_UNKNOWN": 0,
                    "LENGTH_PREFIXED": 1,
                    "DELIMITED": 2
                  }
                },
                "JsonFormat": {
                  "values": {
                    "JSON_FORMAT_UNKNOWN": 0,
                    "ALLOW": 1,
                    "LEGACY_BEST_EFFORT": 2
                  }
                },
                "EnforceNamingStyle": {
                  "values": {
                    "ENFORCE_NAMING_STYLE_UNKNOWN": 0,
                    "STYLE2024": 1,
                    "STYLE_LEGACY": 2
                  }
                },
                "VisibilityFeature": {
                  "fields": {},
                  "reserved": [
                    [
                      1,
                      536870911
                    ]
                  ],
                  "nested": {
                    "DefaultSymbolVisibility": {
                      "values": {
                        "DEFAULT_SYMBOL_VISIBILITY_UNKNOWN": 0,
                        "EXPORT_ALL": 1,
                        "EXPORT_TOP_LEVEL": 2,
                        "LOCAL_ALL": 3,
                        "STRICT": 4
                      }
                    }
                  }
                }
              }
            },
            "FeatureSetDefaults": {
              "edition": "proto2",
              "fields": {
                "defaults": {
                  "rule": "repeated",
                  "type": "FeatureSetEditionDefault",
                  "id": 1
                },
                "minimumEdition": {
                  "type": "Edition",
                  "id": 4
                },
                "maximumEdition": {
                  "type": "Edition",
                  "id": 5
                }
              },
              "nested": {
                "FeatureSetEditionDefault": {
                  "fields": {
                    "edition": {
                      "type": "Edition",
                      "id": 3
                    },
                    "overridableFeatures": {
                      "type": "FeatureSet",
                      "id": 4
                    },
                    "fixedFeatures": {
                      "type": "FeatureSet",
                      "id": 5
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
                    "features"
                  ]
                }
              }
            },
            "SourceCodeInfo": {
              "edition": "proto2",
              "fields": {
                "location": {
                  "rule": "repeated",
                  "type": "Location",
                  "id": 1
                }
              },
              "extensions": [
                [
                  536000000,
                  536000000
                ]
              ],
              "nested": {
                "Location": {
                  "fields": {
                    "path": {
                      "rule": "repeated",
                      "type": "int32",
                      "id": 1,
                      "options": {
                        "packed": true
                      }
                    },
                    "span": {
                      "rule": "repeated",
                      "type": "int32",
                      "id": 2,
                      "options": {
                        "packed": true
                      }
                    },
                    "leadingComments": {
                      "type": "string",
                      "id": 3
                    },
                    "trailingComments": {
                      "type": "string",
                      "id": 4
                    },
                    "leadingDetachedComments": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 6
                    }
                  }
                }
              }
            },
            "GeneratedCodeInfo": {
              "edition": "proto2",
              "fields": {
                "annotation": {
                  "rule": "repeated",
                  "type": "Annotation",
                  "id": 1
                }
              },
              "nested": {
                "Annotation": {
                  "fields": {
                    "path": {
                      "rule": "repeated",
                      "type": "int32",
                      "id": 1,
                      "options": {
                        "packed": true
                      }
                    },
                    "sourceFile": {
                      "type": "string",
                      "id": 2
                    },
                    "begin": {
                      "type": "int32",
                      "id": 3
                    },
                    "end": {
                      "type": "int32",
                      "id": 4
                    },
                    "semantic": {
                      "type": "Semantic",
                      "id": 5
                    }
                  },
                  "nested": {
                    "Semantic": {
                      "values": {
                        "NONE": 0,
                        "SET": 1,
                        "ALIAS": 2
                      }
                    }
                  }
                }
              }
            },
            "SymbolVisibility": {
              "edition": "proto2",
              "values": {
                "VISIBILITY_UNSET": 0,
                "VISIBILITY_LOCAL": 1,
                "VISIBILITY_EXPORT": 2
              }
            }
          }
        },
        "api": {}
      }
    },
    "grpc": {
      "nested": {
        "gateway": {
          "nested": {
            "protoc_gen_openapiv2": {
              "nested": {
                "options": {}
              }
            }
          }
        }
      }
    }
  }
} as Parameters<typeof fromJSON>[0];
