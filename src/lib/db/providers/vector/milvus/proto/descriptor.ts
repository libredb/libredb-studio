// GENERATED FILE - do not edit. Run: node scripts/generate-milvus-descriptor.mjs
//
// Source: the milvus-proto go-api/v3.0.2 .proto files vendored in this directory (README.md), via
// scripts/generate-milvus-descriptor.mjs. tests/unit/db/milvus/descriptor.test.ts fails on drift.

import type { fromJSON } from "@grpc/proto-loader";

// Asserted, not annotated: protobufjs 7.6.6's typings omit fields its own toJSON writes (see the generator).
// biome-ignore format: generated; the literal is JSON.stringify output, so a proto upgrade diffs line by line.
export const MILVUS_DESCRIPTOR = {
  "nested": {
    "milvus": {
      "nested": {
        "proto": {
          "nested": {
            "milvus": {
              "options": {
                "go_package": "github.com/milvus-io/milvus-proto/go-api/v3/milvuspb",
                "java_multiple_files": true,
                "java_package": "io.milvus.grpc",
                "java_outer_classname": "MilvusProto",
                "java_generate_equals_and_hash": true,
                "csharp_namespace": "Milvus.Client.Grpc"
              },
              "nested": {
                "MilvusService": {
                  "methods": {
                    "CreateCollection": {
                      "requestType": "CreateCollectionRequest",
                      "responseType": "common.Status"
                    },
                    "DropCollection": {
                      "requestType": "DropCollectionRequest",
                      "responseType": "common.Status"
                    },
                    "HasCollection": {
                      "requestType": "HasCollectionRequest",
                      "responseType": "BoolResponse"
                    },
                    "LoadCollection": {
                      "requestType": "LoadCollectionRequest",
                      "responseType": "common.Status"
                    },
                    "ReleaseCollection": {
                      "requestType": "ReleaseCollectionRequest",
                      "responseType": "common.Status"
                    },
                    "DescribeCollection": {
                      "requestType": "DescribeCollectionRequest",
                      "responseType": "DescribeCollectionResponse"
                    },
                    "BatchDescribeCollection": {
                      "requestType": "BatchDescribeCollectionRequest",
                      "responseType": "BatchDescribeCollectionResponse"
                    },
                    "GetCollectionStatistics": {
                      "requestType": "GetCollectionStatisticsRequest",
                      "responseType": "GetCollectionStatisticsResponse"
                    },
                    "ShowCollections": {
                      "requestType": "ShowCollectionsRequest",
                      "responseType": "ShowCollectionsResponse"
                    },
                    "AlterCollection": {
                      "requestType": "AlterCollectionRequest",
                      "responseType": "common.Status"
                    },
                    "AlterCollectionField": {
                      "requestType": "AlterCollectionFieldRequest",
                      "responseType": "common.Status"
                    },
                    "AddCollectionFunction": {
                      "requestType": "AddCollectionFunctionRequest",
                      "responseType": "common.Status"
                    },
                    "AlterCollectionFunction": {
                      "requestType": "AlterCollectionFunctionRequest",
                      "responseType": "common.Status"
                    },
                    "DropCollectionFunction": {
                      "requestType": "DropCollectionFunctionRequest",
                      "responseType": "common.Status"
                    },
                    "TruncateCollection": {
                      "requestType": "TruncateCollectionRequest",
                      "responseType": "TruncateCollectionResponse"
                    },
                    "CreatePartition": {
                      "requestType": "CreatePartitionRequest",
                      "responseType": "common.Status"
                    },
                    "DropPartition": {
                      "requestType": "DropPartitionRequest",
                      "responseType": "common.Status"
                    },
                    "HasPartition": {
                      "requestType": "HasPartitionRequest",
                      "responseType": "BoolResponse"
                    },
                    "LoadPartitions": {
                      "requestType": "LoadPartitionsRequest",
                      "responseType": "common.Status"
                    },
                    "Prewarm": {
                      "requestType": "PrewarmRequest",
                      "responseType": "PrewarmResponse"
                    },
                    "DescribePrewarmTask": {
                      "requestType": "DescribePrewarmTaskRequest",
                      "responseType": "DescribePrewarmTaskResponse"
                    },
                    "ReleasePartitions": {
                      "requestType": "ReleasePartitionsRequest",
                      "responseType": "common.Status"
                    },
                    "GetPartitionStatistics": {
                      "requestType": "GetPartitionStatisticsRequest",
                      "responseType": "GetPartitionStatisticsResponse"
                    },
                    "ShowPartitions": {
                      "requestType": "ShowPartitionsRequest",
                      "responseType": "ShowPartitionsResponse"
                    },
                    "CreateNamespace": {
                      "requestType": "CreateNamespaceRequest",
                      "responseType": "CreateNamespaceResponse"
                    },
                    "DescribeNamespace": {
                      "requestType": "DescribeNamespaceRequest",
                      "responseType": "DescribeNamespaceResponse"
                    },
                    "ListNamespaces": {
                      "requestType": "ListNamespacesRequest",
                      "responseType": "ListNamespacesResponse"
                    },
                    "DropNamespace": {
                      "requestType": "DropNamespaceRequest",
                      "responseType": "DropNamespaceResponse"
                    },
                    "HasNamespace": {
                      "requestType": "HasNamespaceRequest",
                      "responseType": "HasNamespaceResponse"
                    },
                    "GetNamespaceStats": {
                      "requestType": "GetNamespaceStatsRequest",
                      "responseType": "GetNamespaceStatsResponse"
                    },
                    "GetLoadingProgress": {
                      "requestType": "GetLoadingProgressRequest",
                      "responseType": "GetLoadingProgressResponse"
                    },
                    "GetLoadState": {
                      "requestType": "GetLoadStateRequest",
                      "responseType": "GetLoadStateResponse"
                    },
                    "CreateAlias": {
                      "requestType": "CreateAliasRequest",
                      "responseType": "common.Status"
                    },
                    "DropAlias": {
                      "requestType": "DropAliasRequest",
                      "responseType": "common.Status"
                    },
                    "AlterAlias": {
                      "requestType": "AlterAliasRequest",
                      "responseType": "common.Status"
                    },
                    "DescribeAlias": {
                      "requestType": "DescribeAliasRequest",
                      "responseType": "DescribeAliasResponse"
                    },
                    "ListAliases": {
                      "requestType": "ListAliasesRequest",
                      "responseType": "ListAliasesResponse"
                    },
                    "CreateIndex": {
                      "requestType": "CreateIndexRequest",
                      "responseType": "common.Status"
                    },
                    "AlterIndex": {
                      "requestType": "AlterIndexRequest",
                      "responseType": "common.Status"
                    },
                    "DescribeIndex": {
                      "requestType": "DescribeIndexRequest",
                      "responseType": "DescribeIndexResponse"
                    },
                    "GetIndexStatistics": {
                      "requestType": "GetIndexStatisticsRequest",
                      "responseType": "GetIndexStatisticsResponse"
                    },
                    "GetIndexState": {
                      "requestType": "GetIndexStateRequest",
                      "responseType": "GetIndexStateResponse",
                      "options": {
                        "deprecated": true
                      },
                      "parsedOptions": [
                        {
                          "deprecated": true
                        }
                      ]
                    },
                    "GetIndexBuildProgress": {
                      "requestType": "GetIndexBuildProgressRequest",
                      "responseType": "GetIndexBuildProgressResponse",
                      "options": {
                        "deprecated": true
                      },
                      "parsedOptions": [
                        {
                          "deprecated": true
                        }
                      ]
                    },
                    "DropIndex": {
                      "requestType": "DropIndexRequest",
                      "responseType": "common.Status"
                    },
                    "Insert": {
                      "requestType": "InsertRequest",
                      "responseType": "MutationResult"
                    },
                    "Delete": {
                      "requestType": "DeleteRequest",
                      "responseType": "MutationResult"
                    },
                    "Upsert": {
                      "requestType": "UpsertRequest",
                      "responseType": "MutationResult"
                    },
                    "Search": {
                      "requestType": "SearchRequest",
                      "responseType": "SearchResults"
                    },
                    "HybridSearch": {
                      "requestType": "HybridSearchRequest",
                      "responseType": "SearchResults"
                    },
                    "Flush": {
                      "requestType": "FlushRequest",
                      "responseType": "FlushResponse"
                    },
                    "Query": {
                      "requestType": "QueryRequest",
                      "responseType": "QueryResults"
                    },
                    "CalcDistance": {
                      "requestType": "CalcDistanceRequest",
                      "responseType": "CalcDistanceResults"
                    },
                    "FlushAll": {
                      "requestType": "FlushAllRequest",
                      "responseType": "FlushAllResponse"
                    },
                    "AddCollectionField": {
                      "requestType": "AddCollectionFieldRequest",
                      "responseType": "common.Status"
                    },
                    "AddCollectionStructField": {
                      "requestType": "AddCollectionStructFieldRequest",
                      "responseType": "common.Status"
                    },
                    "GetFlushState": {
                      "requestType": "GetFlushStateRequest",
                      "responseType": "GetFlushStateResponse"
                    },
                    "GetFlushAllState": {
                      "requestType": "GetFlushAllStateRequest",
                      "responseType": "GetFlushAllStateResponse"
                    },
                    "GetPersistentSegmentInfo": {
                      "requestType": "GetPersistentSegmentInfoRequest",
                      "responseType": "GetPersistentSegmentInfoResponse"
                    },
                    "GetQuerySegmentInfo": {
                      "requestType": "GetQuerySegmentInfoRequest",
                      "responseType": "GetQuerySegmentInfoResponse"
                    },
                    "GetReplicas": {
                      "requestType": "GetReplicasRequest",
                      "responseType": "GetReplicasResponse"
                    },
                    "Dummy": {
                      "requestType": "DummyRequest",
                      "responseType": "DummyResponse"
                    },
                    "RegisterLink": {
                      "requestType": "RegisterLinkRequest",
                      "responseType": "RegisterLinkResponse"
                    },
                    "GetMetrics": {
                      "requestType": "GetMetricsRequest",
                      "responseType": "GetMetricsResponse"
                    },
                    "GetComponentStates": {
                      "requestType": "GetComponentStatesRequest",
                      "responseType": "ComponentStates"
                    },
                    "LoadBalance": {
                      "requestType": "LoadBalanceRequest",
                      "responseType": "common.Status"
                    },
                    "GetCompactionState": {
                      "requestType": "GetCompactionStateRequest",
                      "responseType": "GetCompactionStateResponse"
                    },
                    "ManualCompaction": {
                      "requestType": "ManualCompactionRequest",
                      "responseType": "ManualCompactionResponse"
                    },
                    "GetCompactionStateWithPlans": {
                      "requestType": "GetCompactionPlansRequest",
                      "responseType": "GetCompactionPlansResponse"
                    },
                    "Import": {
                      "requestType": "ImportRequest",
                      "responseType": "ImportResponse"
                    },
                    "GetImportState": {
                      "requestType": "GetImportStateRequest",
                      "responseType": "GetImportStateResponse"
                    },
                    "ListImportTasks": {
                      "requestType": "ListImportTasksRequest",
                      "responseType": "ListImportTasksResponse"
                    },
                    "CreateCredential": {
                      "requestType": "CreateCredentialRequest",
                      "responseType": "common.Status"
                    },
                    "UpdateCredential": {
                      "requestType": "UpdateCredentialRequest",
                      "responseType": "common.Status"
                    },
                    "DeleteCredential": {
                      "requestType": "DeleteCredentialRequest",
                      "responseType": "common.Status"
                    },
                    "ListCredUsers": {
                      "requestType": "ListCredUsersRequest",
                      "responseType": "ListCredUsersResponse"
                    },
                    "CreateRole": {
                      "requestType": "CreateRoleRequest",
                      "responseType": "common.Status"
                    },
                    "AlterRole": {
                      "requestType": "AlterRoleRequest",
                      "responseType": "common.Status"
                    },
                    "DropRole": {
                      "requestType": "DropRoleRequest",
                      "responseType": "common.Status"
                    },
                    "OperateUserRole": {
                      "requestType": "OperateUserRoleRequest",
                      "responseType": "common.Status"
                    },
                    "SelectRole": {
                      "requestType": "SelectRoleRequest",
                      "responseType": "SelectRoleResponse"
                    },
                    "SelectUser": {
                      "requestType": "SelectUserRequest",
                      "responseType": "SelectUserResponse"
                    },
                    "OperatePrivilege": {
                      "requestType": "OperatePrivilegeRequest",
                      "responseType": "common.Status"
                    },
                    "OperatePrivilegeV2": {
                      "requestType": "OperatePrivilegeV2Request",
                      "responseType": "common.Status"
                    },
                    "SelectGrant": {
                      "requestType": "SelectGrantRequest",
                      "responseType": "SelectGrantResponse"
                    },
                    "GetVersion": {
                      "requestType": "GetVersionRequest",
                      "responseType": "GetVersionResponse"
                    },
                    "CheckHealth": {
                      "requestType": "CheckHealthRequest",
                      "responseType": "CheckHealthResponse"
                    },
                    "CreateResourceGroup": {
                      "requestType": "CreateResourceGroupRequest",
                      "responseType": "common.Status"
                    },
                    "DropResourceGroup": {
                      "requestType": "DropResourceGroupRequest",
                      "responseType": "common.Status"
                    },
                    "UpdateResourceGroups": {
                      "requestType": "UpdateResourceGroupsRequest",
                      "responseType": "common.Status"
                    },
                    "TransferNode": {
                      "requestType": "TransferNodeRequest",
                      "responseType": "common.Status"
                    },
                    "TransferReplica": {
                      "requestType": "TransferReplicaRequest",
                      "responseType": "common.Status"
                    },
                    "ListResourceGroups": {
                      "requestType": "ListResourceGroupsRequest",
                      "responseType": "ListResourceGroupsResponse"
                    },
                    "DescribeResourceGroup": {
                      "requestType": "DescribeResourceGroupRequest",
                      "responseType": "DescribeResourceGroupResponse"
                    },
                    "RenameCollection": {
                      "requestType": "RenameCollectionRequest",
                      "responseType": "common.Status"
                    },
                    "ListIndexedSegment": {
                      "requestType": "feder.ListIndexedSegmentRequest",
                      "responseType": "feder.ListIndexedSegmentResponse"
                    },
                    "DescribeSegmentIndexData": {
                      "requestType": "feder.DescribeSegmentIndexDataRequest",
                      "responseType": "feder.DescribeSegmentIndexDataResponse"
                    },
                    "Connect": {
                      "requestType": "ConnectRequest",
                      "responseType": "ConnectResponse"
                    },
                    "AllocTimestamp": {
                      "requestType": "AllocTimestampRequest",
                      "responseType": "AllocTimestampResponse"
                    },
                    "CreateDatabase": {
                      "requestType": "CreateDatabaseRequest",
                      "responseType": "common.Status"
                    },
                    "DropDatabase": {
                      "requestType": "DropDatabaseRequest",
                      "responseType": "common.Status"
                    },
                    "ListDatabases": {
                      "requestType": "ListDatabasesRequest",
                      "responseType": "ListDatabasesResponse"
                    },
                    "AlterDatabase": {
                      "requestType": "AlterDatabaseRequest",
                      "responseType": "common.Status"
                    },
                    "DescribeDatabase": {
                      "requestType": "DescribeDatabaseRequest",
                      "responseType": "DescribeDatabaseResponse"
                    },
                    "ReplicateMessage": {
                      "requestType": "ReplicateMessageRequest",
                      "responseType": "ReplicateMessageResponse",
                      "options": {
                        "deprecated": true
                      },
                      "parsedOptions": [
                        {
                          "deprecated": true
                        }
                      ]
                    },
                    "BackupRBAC": {
                      "requestType": "BackupRBACMetaRequest",
                      "responseType": "BackupRBACMetaResponse"
                    },
                    "RestoreRBAC": {
                      "requestType": "RestoreRBACMetaRequest",
                      "responseType": "common.Status"
                    },
                    "CreatePrivilegeGroup": {
                      "requestType": "CreatePrivilegeGroupRequest",
                      "responseType": "common.Status"
                    },
                    "DropPrivilegeGroup": {
                      "requestType": "DropPrivilegeGroupRequest",
                      "responseType": "common.Status"
                    },
                    "ListPrivilegeGroups": {
                      "requestType": "ListPrivilegeGroupsRequest",
                      "responseType": "ListPrivilegeGroupsResponse"
                    },
                    "OperatePrivilegeGroup": {
                      "requestType": "OperatePrivilegeGroupRequest",
                      "responseType": "common.Status"
                    },
                    "RunAnalyzer": {
                      "requestType": "RunAnalyzerRequest",
                      "responseType": "RunAnalyzerResponse"
                    },
                    "AddFileResource": {
                      "requestType": "AddFileResourceRequest",
                      "responseType": "common.Status"
                    },
                    "RemoveFileResource": {
                      "requestType": "RemoveFileResourceRequest",
                      "responseType": "common.Status"
                    },
                    "ListFileResources": {
                      "requestType": "ListFileResourcesRequest",
                      "responseType": "ListFileResourcesResponse"
                    },
                    "AddUserTags": {
                      "requestType": "AddUserTagsRequest",
                      "responseType": "common.Status"
                    },
                    "DeleteUserTags": {
                      "requestType": "DeleteUserTagsRequest",
                      "responseType": "common.Status"
                    },
                    "GetUserTags": {
                      "requestType": "GetUserTagsRequest",
                      "responseType": "GetUserTagsResponse"
                    },
                    "ListUsersWithTag": {
                      "requestType": "ListUsersWithTagRequest",
                      "responseType": "ListUsersWithTagResponse"
                    },
                    "CreateRowPolicy": {
                      "requestType": "CreateRowPolicyRequest",
                      "responseType": "common.Status"
                    },
                    "DropRowPolicy": {
                      "requestType": "DropRowPolicyRequest",
                      "responseType": "common.Status"
                    },
                    "ListRowPolicies": {
                      "requestType": "ListRowPoliciesRequest",
                      "responseType": "ListRowPoliciesResponse"
                    },
                    "UpdateReplicateConfiguration": {
                      "requestType": "UpdateReplicateConfigurationRequest",
                      "responseType": "common.Status"
                    },
                    "GetReplicateConfiguration": {
                      "requestType": "GetReplicateConfigurationRequest",
                      "responseType": "GetReplicateConfigurationResponse"
                    },
                    "GetReplicateInfo": {
                      "requestType": "GetReplicateInfoRequest",
                      "responseType": "GetReplicateInfoResponse"
                    },
                    "CreateReplicateStream": {
                      "requestType": "ReplicateRequest",
                      "requestStream": true,
                      "responseType": "ReplicateResponse",
                      "responseStream": true
                    },
                    "DumpMessages": {
                      "requestType": "DumpMessagesRequest",
                      "responseType": "DumpMessagesResponse",
                      "responseStream": true
                    },
                    "ComputePhraseMatchSlop": {
                      "requestType": "ComputePhraseMatchSlopRequest",
                      "responseType": "ComputePhraseMatchSlopResponse"
                    },
                    "CreateSnapshot": {
                      "requestType": "CreateSnapshotRequest",
                      "responseType": "common.Status"
                    },
                    "DropSnapshot": {
                      "requestType": "DropSnapshotRequest",
                      "responseType": "common.Status"
                    },
                    "ListSnapshots": {
                      "requestType": "ListSnapshotsRequest",
                      "responseType": "ListSnapshotsResponse"
                    },
                    "DescribeSnapshot": {
                      "requestType": "DescribeSnapshotRequest",
                      "responseType": "DescribeSnapshotResponse"
                    },
                    "RestoreSnapshot": {
                      "requestType": "RestoreSnapshotRequest",
                      "responseType": "RestoreSnapshotResponse"
                    },
                    "RestoreExternalSnapshot": {
                      "requestType": "RestoreExternalSnapshotRequest",
                      "responseType": "RestoreExternalSnapshotResponse"
                    },
                    "ExportSnapshot": {
                      "requestType": "ExportSnapshotRequest",
                      "responseType": "ExportSnapshotResponse"
                    },
                    "GetExportSnapshotState": {
                      "requestType": "GetExportSnapshotStateRequest",
                      "responseType": "GetExportSnapshotStateResponse"
                    },
                    "GetRestoreSnapshotState": {
                      "requestType": "GetRestoreSnapshotStateRequest",
                      "responseType": "GetRestoreSnapshotStateResponse"
                    },
                    "ListRestoreSnapshotJobs": {
                      "requestType": "ListRestoreSnapshotJobsRequest",
                      "responseType": "ListRestoreSnapshotJobsResponse"
                    },
                    "PinSnapshotData": {
                      "requestType": "PinSnapshotDataRequest",
                      "responseType": "PinSnapshotDataResponse"
                    },
                    "UnpinSnapshotData": {
                      "requestType": "UnpinSnapshotDataRequest",
                      "responseType": "common.Status"
                    },
                    "AlterCollectionSchema": {
                      "requestType": "AlterCollectionSchemaRequest",
                      "responseType": "AlterCollectionSchemaResponse"
                    },
                    "BatchUpdateManifest": {
                      "requestType": "BatchUpdateManifestRequest",
                      "responseType": "common.Status"
                    },
                    "RefreshExternalCollection": {
                      "requestType": "RefreshExternalCollectionRequest",
                      "responseType": "RefreshExternalCollectionResponse"
                    },
                    "GetRefreshExternalCollectionProgress": {
                      "requestType": "GetRefreshExternalCollectionProgressRequest",
                      "responseType": "GetRefreshExternalCollectionProgressResponse"
                    },
                    "ListRefreshExternalCollectionJobs": {
                      "requestType": "ListRefreshExternalCollectionJobsRequest",
                      "responseType": "ListRefreshExternalCollectionJobsResponse"
                    }
                  }
                },
                "ClientTelemetryService": {
                  "methods": {
                    "ClientHeartbeat": {
                      "requestType": "ClientHeartbeatRequest",
                      "responseType": "ClientHeartbeatResponse"
                    },
                    "GetClientTelemetry": {
                      "requestType": "GetClientTelemetryRequest",
                      "responseType": "GetClientTelemetryResponse"
                    },
                    "PushClientCommand": {
                      "requestType": "PushClientCommandRequest",
                      "responseType": "PushClientCommandResponse"
                    },
                    "DeleteClientCommand": {
                      "requestType": "DeleteClientCommandRequest",
                      "responseType": "DeleteClientCommandResponse"
                    }
                  }
                },
                "CreateAliasRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeCreateAlias",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "alias": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "DropAliasRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeDropAlias",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "alias": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "AlterAliasRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeCreateAlias",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "alias": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "DescribeAliasRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeDescribeAlias",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "alias": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "DescribeAliasResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "alias": {
                      "type": "string",
                      "id": 3
                    },
                    "collection": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "ListAliasesRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeListAliases",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "ListAliasesResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "aliases": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "CreateCollectionRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeCreateCollection",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "schema": {
                      "type": "bytes",
                      "id": 4
                    },
                    "shards_num": {
                      "type": "int32",
                      "id": 5
                    },
                    "consistency_level": {
                      "type": "common.ConsistencyLevel",
                      "id": 6
                    },
                    "properties": {
                      "rule": "repeated",
                      "type": "common.KeyValuePair",
                      "id": 7
                    },
                    "num_partitions": {
                      "type": "int64",
                      "id": 8
                    }
                  }
                },
                "DropCollectionRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeDropCollection",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "AlterCollectionRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeCreateCollection",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "collectionID": {
                      "type": "int64",
                      "id": 4
                    },
                    "properties": {
                      "rule": "repeated",
                      "type": "common.KeyValuePair",
                      "id": 5
                    },
                    "delete_keys": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 6
                    }
                  }
                },
                "AlterCollectionFieldRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeCreateCollection",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "field_name": {
                      "type": "string",
                      "id": 4
                    },
                    "properties": {
                      "rule": "repeated",
                      "type": "common.KeyValuePair",
                      "id": 5
                    },
                    "delete_keys": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 6
                    }
                  }
                },
                "HasCollectionRequest": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "time_stamp": {
                      "type": "uint64",
                      "id": 4
                    }
                  }
                },
                "BoolResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "value": {
                      "type": "bool",
                      "id": 2
                    }
                  }
                },
                "StringResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "value": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "DescribeCollectionRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeDescribeCollection",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "collectionID": {
                      "type": "int64",
                      "id": 4
                    },
                    "time_stamp": {
                      "type": "uint64",
                      "id": 5
                    }
                  }
                },
                "DescribeCollectionResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "schema": {
                      "type": "schema.CollectionSchema",
                      "id": 2
                    },
                    "collectionID": {
                      "type": "int64",
                      "id": 3
                    },
                    "virtual_channel_names": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 4
                    },
                    "physical_channel_names": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 5
                    },
                    "created_timestamp": {
                      "type": "uint64",
                      "id": 6
                    },
                    "created_utc_timestamp": {
                      "type": "uint64",
                      "id": 7
                    },
                    "shards_num": {
                      "type": "int32",
                      "id": 8
                    },
                    "aliases": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 9
                    },
                    "start_positions": {
                      "rule": "repeated",
                      "type": "common.KeyDataPair",
                      "id": 10
                    },
                    "consistency_level": {
                      "type": "common.ConsistencyLevel",
                      "id": 11
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 12
                    },
                    "properties": {
                      "rule": "repeated",
                      "type": "common.KeyValuePair",
                      "id": 13
                    },
                    "db_name": {
                      "type": "string",
                      "id": 14
                    },
                    "num_partitions": {
                      "type": "int64",
                      "id": 15
                    },
                    "db_id": {
                      "type": "int64",
                      "id": 16
                    },
                    "request_time": {
                      "type": "uint64",
                      "id": 17
                    },
                    "update_timestamp": {
                      "type": "uint64",
                      "id": 18
                    },
                    "update_timestamp_str": {
                      "type": "string",
                      "id": 19
                    }
                  }
                },
                "BatchDescribeCollectionRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeDescribeCollection",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "db_name": {
                      "type": "string",
                      "id": 1
                    },
                    "collection_name": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 2
                    },
                    "collectionID": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 3
                    }
                  }
                },
                "BatchDescribeCollectionResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "responses": {
                      "rule": "repeated",
                      "type": "DescribeCollectionResponse",
                      "id": 2
                    }
                  }
                },
                "LoadCollectionRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeLoad",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "replica_number": {
                      "type": "int32",
                      "id": 4
                    },
                    "resource_groups": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 5
                    },
                    "refresh": {
                      "type": "bool",
                      "id": 6
                    },
                    "load_fields": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 7
                    },
                    "skip_load_dynamic_field": {
                      "type": "bool",
                      "id": 8
                    },
                    "load_params": {
                      "keyType": "string",
                      "type": "string",
                      "id": 9
                    }
                  }
                },
                "ReleaseCollectionRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeRelease",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "GetStatisticsRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeGetStatistics",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "partition_names": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 4
                    },
                    "guarantee_timestamp": {
                      "type": "uint64",
                      "id": 5
                    }
                  }
                },
                "GetStatisticsResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "stats": {
                      "rule": "repeated",
                      "type": "common.KeyValuePair",
                      "id": 2
                    }
                  }
                },
                "GetCollectionStatisticsRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeGetStatistics",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "GetCollectionStatisticsResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "stats": {
                      "rule": "repeated",
                      "type": "common.KeyValuePair",
                      "id": 2
                    }
                  }
                },
                "ShowType": {
                  "options": {
                    "deprecated": true
                  },
                  "values": {
                    "All": 0,
                    "InMemory": 1
                  }
                },
                "ShowCollectionsRequest": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "time_stamp": {
                      "type": "uint64",
                      "id": 3
                    },
                    "type": {
                      "type": "ShowType",
                      "id": 4
                    },
                    "collection_names": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 5,
                      "options": {
                        "deprecated": true
                      }
                    }
                  }
                },
                "ShowCollectionsResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "collection_names": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 2
                    },
                    "collection_ids": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 3
                    },
                    "created_timestamps": {
                      "rule": "repeated",
                      "type": "uint64",
                      "id": 4
                    },
                    "created_utc_timestamps": {
                      "rule": "repeated",
                      "type": "uint64",
                      "id": 5
                    },
                    "inMemory_percentages": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 6,
                      "options": {
                        "deprecated": true
                      }
                    },
                    "query_service_available": {
                      "rule": "repeated",
                      "type": "bool",
                      "id": 7
                    },
                    "shards_num": {
                      "rule": "repeated",
                      "type": "int32",
                      "id": 8
                    }
                  }
                },
                "CreatePartitionRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeCreatePartition",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "partition_name": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "DropPartitionRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeDropPartition",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "partition_name": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "HasPartitionRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeHasPartition",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "partition_name": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "LoadPartitionsRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeLoad",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "partition_names": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 4
                    },
                    "replica_number": {
                      "type": "int32",
                      "id": 5
                    },
                    "resource_groups": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 6
                    },
                    "refresh": {
                      "type": "bool",
                      "id": 7
                    },
                    "load_fields": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 8
                    },
                    "skip_load_dynamic_field": {
                      "type": "bool",
                      "id": 9
                    },
                    "load_params": {
                      "keyType": "string",
                      "type": "string",
                      "id": 10
                    }
                  }
                },
                "PrewarmRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeLoad",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "oneofs": {
                    "_namespace": {
                      "oneof": [
                        "namespace"
                      ]
                    }
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "namespace": {
                      "type": "string",
                      "id": 4,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "replica_number": {
                      "type": "int32",
                      "id": 5
                    },
                    "resource_groups": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 6
                    },
                    "load_fields": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 7
                    },
                    "skip_load_dynamic_field": {
                      "type": "bool",
                      "id": 8
                    },
                    "load_params": {
                      "keyType": "string",
                      "type": "string",
                      "id": 9
                    },
                    "ttl_seconds": {
                      "type": "int64",
                      "id": 10
                    },
                    "priority": {
                      "type": "string",
                      "id": 11
                    }
                  }
                },
                "PrewarmTaskState": {
                  "values": {
                    "PrewarmTaskStateUnknown": 0,
                    "PrewarmTaskStatePending": 1,
                    "PrewarmTaskStateWarming": 2,
                    "PrewarmTaskStateCompleted": 3,
                    "PrewarmTaskStateFailed": 4
                  }
                },
                "PrewarmResponse": {
                  "oneofs": {
                    "_namespace": {
                      "oneof": [
                        "namespace"
                      ]
                    }
                  },
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "taskID": {
                      "type": "string",
                      "id": 2
                    },
                    "namespace": {
                      "type": "string",
                      "id": 3,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "DescribePrewarmTaskRequest": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "taskID": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "DescribePrewarmTaskResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "taskID": {
                      "type": "string",
                      "id": 2
                    },
                    "state": {
                      "type": "PrewarmTaskState",
                      "id": 3
                    },
                    "progress": {
                      "type": "int32",
                      "id": 4
                    },
                    "error_message": {
                      "type": "string",
                      "id": 5
                    }
                  }
                },
                "ReleasePartitionsRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeRelease",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "partition_names": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "GetPartitionStatisticsRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeGetStatistics",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "partition_name": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "GetPartitionStatisticsResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "stats": {
                      "rule": "repeated",
                      "type": "common.KeyValuePair",
                      "id": 2
                    }
                  }
                },
                "ShowPartitionsRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeShowPartitions",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "collectionID": {
                      "type": "int64",
                      "id": 4
                    },
                    "partition_names": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 5
                    },
                    "type": {
                      "type": "ShowType",
                      "id": 6,
                      "options": {
                        "deprecated": true
                      }
                    }
                  }
                },
                "ShowPartitionsResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "partition_names": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 2
                    },
                    "partitionIDs": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 3
                    },
                    "created_timestamps": {
                      "rule": "repeated",
                      "type": "uint64",
                      "id": 4
                    },
                    "created_utc_timestamps": {
                      "rule": "repeated",
                      "type": "uint64",
                      "id": 5
                    },
                    "inMemory_percentages": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 6,
                      "options": {
                        "deprecated": true
                      }
                    }
                  }
                },
                "NamespaceStats": {
                  "fields": {
                    "stats": {
                      "rule": "repeated",
                      "type": "common.KeyValuePair",
                      "id": 1
                    },
                    "approx_entity_count": {
                      "type": "int64",
                      "id": 2
                    },
                    "entity_count": {
                      "type": "int64",
                      "id": 3
                    },
                    "entity_count_type": {
                      "type": "string",
                      "id": 4
                    },
                    "logical_bytes": {
                      "type": "int64",
                      "id": 5
                    },
                    "last_write_timestamp": {
                      "type": "uint64",
                      "id": 6
                    },
                    "last_write_utc_timestamp": {
                      "type": "uint64",
                      "id": 7
                    }
                  }
                },
                "NamespaceInfo": {
                  "fields": {
                    "collection_name": {
                      "type": "string",
                      "id": 1
                    },
                    "namespace_name": {
                      "type": "string",
                      "id": 2
                    },
                    "created_timestamp": {
                      "type": "uint64",
                      "id": 3
                    },
                    "created_utc_timestamp": {
                      "type": "uint64",
                      "id": 4
                    },
                    "state": {
                      "type": "string",
                      "id": 5
                    },
                    "stats": {
                      "type": "NamespaceStats",
                      "id": 6
                    }
                  }
                },
                "CreateNamespaceRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeCreatePartition",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "namespace_name": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "CreateNamespaceResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "namespace": {
                      "type": "NamespaceInfo",
                      "id": 2
                    }
                  }
                },
                "DescribeNamespaceRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeShowPartitions",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "namespace_name": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "DescribeNamespaceResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "namespace": {
                      "type": "NamespaceInfo",
                      "id": 2
                    }
                  }
                },
                "ListNamespacesRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeShowPartitions",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "prefix": {
                      "type": "string",
                      "id": 4
                    },
                    "page_size": {
                      "type": "int64",
                      "id": 5
                    },
                    "page_token": {
                      "type": "string",
                      "id": 6
                    }
                  }
                },
                "ListNamespacesResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "namespaces": {
                      "rule": "repeated",
                      "type": "NamespaceInfo",
                      "id": 2
                    },
                    "next_page_token": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "DropNamespaceRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeDropPartition",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "namespace_name": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "DropNamespaceResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "namespace": {
                      "type": "NamespaceInfo",
                      "id": 2
                    }
                  }
                },
                "HasNamespaceRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeHasPartition",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "namespace_name": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "HasNamespaceResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "value": {
                      "type": "bool",
                      "id": 2
                    }
                  }
                },
                "GetNamespaceStatsRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeShowPartitions",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "namespace_name": {
                      "type": "string",
                      "id": 4
                    },
                    "exact": {
                      "type": "bool",
                      "id": 5
                    }
                  }
                },
                "GetNamespaceStatsResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "namespace_name": {
                      "type": "string",
                      "id": 2
                    },
                    "stats": {
                      "type": "NamespaceStats",
                      "id": 3
                    }
                  }
                },
                "DescribeSegmentRequest": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "collectionID": {
                      "type": "int64",
                      "id": 2
                    },
                    "segmentID": {
                      "type": "int64",
                      "id": 3
                    }
                  }
                },
                "DescribeSegmentResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "indexID": {
                      "type": "int64",
                      "id": 2
                    },
                    "buildID": {
                      "type": "int64",
                      "id": 3
                    },
                    "enable_index": {
                      "type": "bool",
                      "id": 4
                    },
                    "fieldID": {
                      "type": "int64",
                      "id": 5
                    }
                  }
                },
                "ShowSegmentsRequest": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "collectionID": {
                      "type": "int64",
                      "id": 2
                    },
                    "partitionID": {
                      "type": "int64",
                      "id": 3
                    }
                  }
                },
                "ShowSegmentsResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "segmentIDs": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 2
                    }
                  }
                },
                "CreateIndexRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeCreateIndex",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "field_name": {
                      "type": "string",
                      "id": 4
                    },
                    "extra_params": {
                      "rule": "repeated",
                      "type": "common.KeyValuePair",
                      "id": 5
                    },
                    "index_name": {
                      "type": "string",
                      "id": 6
                    }
                  }
                },
                "AlterIndexRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeCreateIndex",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "index_name": {
                      "type": "string",
                      "id": 4
                    },
                    "extra_params": {
                      "rule": "repeated",
                      "type": "common.KeyValuePair",
                      "id": 5
                    },
                    "delete_keys": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 6
                    }
                  }
                },
                "DescribeIndexRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeIndexDetail",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "field_name": {
                      "type": "string",
                      "id": 4
                    },
                    "index_name": {
                      "type": "string",
                      "id": 5
                    },
                    "timestamp": {
                      "type": "uint64",
                      "id": 6
                    }
                  }
                },
                "IndexDescription": {
                  "fields": {
                    "index_name": {
                      "type": "string",
                      "id": 1
                    },
                    "indexID": {
                      "type": "int64",
                      "id": 2
                    },
                    "params": {
                      "rule": "repeated",
                      "type": "common.KeyValuePair",
                      "id": 3
                    },
                    "field_name": {
                      "type": "string",
                      "id": 4
                    },
                    "indexed_rows": {
                      "type": "int64",
                      "id": 5
                    },
                    "total_rows": {
                      "type": "int64",
                      "id": 6
                    },
                    "state": {
                      "type": "common.IndexState",
                      "id": 7
                    },
                    "index_state_fail_reason": {
                      "type": "string",
                      "id": 8
                    },
                    "pending_index_rows": {
                      "type": "int64",
                      "id": 9
                    },
                    "min_index_version": {
                      "type": "int32",
                      "id": 10
                    },
                    "max_index_version": {
                      "type": "int32",
                      "id": 11
                    }
                  }
                },
                "DescribeIndexResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "index_descriptions": {
                      "rule": "repeated",
                      "type": "IndexDescription",
                      "id": 2
                    }
                  }
                },
                "GetIndexBuildProgressRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeIndexDetail",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "field_name": {
                      "type": "string",
                      "id": 4
                    },
                    "index_name": {
                      "type": "string",
                      "id": 5
                    }
                  }
                },
                "GetIndexBuildProgressResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "indexed_rows": {
                      "type": "int64",
                      "id": 2
                    },
                    "total_rows": {
                      "type": "int64",
                      "id": 3
                    }
                  }
                },
                "GetIndexStateRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeIndexDetail",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "field_name": {
                      "type": "string",
                      "id": 4
                    },
                    "index_name": {
                      "type": "string",
                      "id": 5
                    }
                  }
                },
                "GetIndexStateResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "state": {
                      "type": "common.IndexState",
                      "id": 2
                    },
                    "fail_reason": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "DropIndexRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeDropIndex",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "field_name": {
                      "type": "string",
                      "id": 4
                    },
                    "index_name": {
                      "type": "string",
                      "id": 5
                    }
                  }
                },
                "InsertRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeInsert",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "oneofs": {
                    "_namespace": {
                      "oneof": [
                        "namespace"
                      ]
                    }
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "partition_name": {
                      "type": "string",
                      "id": 4
                    },
                    "fields_data": {
                      "rule": "repeated",
                      "type": "schema.FieldData",
                      "id": 5
                    },
                    "hash_keys": {
                      "rule": "repeated",
                      "type": "uint32",
                      "id": 6
                    },
                    "num_rows": {
                      "type": "uint32",
                      "id": 7
                    },
                    "schema_timestamp": {
                      "type": "uint64",
                      "id": 8
                    },
                    "namespace": {
                      "type": "string",
                      "id": 9,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "AddCollectionFieldRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeAddCollectionField",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "collectionID": {
                      "type": "int64",
                      "id": 4
                    },
                    "schema": {
                      "type": "bytes",
                      "id": 5
                    }
                  }
                },
                "AddCollectionStructFieldRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeAddCollectionField",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "collectionID": {
                      "type": "int64",
                      "id": 4
                    },
                    "struct_array_field_schema": {
                      "type": "schema.StructArrayFieldSchema",
                      "id": 5
                    }
                  }
                },
                "AddCollectionFunctionRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeCreateCollection",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "collectionID": {
                      "type": "int64",
                      "id": 4
                    },
                    "functionSchema": {
                      "type": "schema.FunctionSchema",
                      "id": 5
                    }
                  }
                },
                "AlterCollectionFunctionRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeCreateCollection",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "collectionID": {
                      "type": "int64",
                      "id": 4
                    },
                    "function_name": {
                      "type": "string",
                      "id": 5
                    },
                    "functionSchema": {
                      "type": "schema.FunctionSchema",
                      "id": 6
                    }
                  }
                },
                "DropCollectionFunctionRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeCreateCollection",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "collectionID": {
                      "type": "int64",
                      "id": 4
                    },
                    "function_name": {
                      "type": "string",
                      "id": 5
                    }
                  }
                },
                "UpsertRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeUpsert",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "oneofs": {
                    "_namespace": {
                      "oneof": [
                        "namespace"
                      ]
                    }
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "partition_name": {
                      "type": "string",
                      "id": 4
                    },
                    "fields_data": {
                      "rule": "repeated",
                      "type": "schema.FieldData",
                      "id": 5
                    },
                    "hash_keys": {
                      "rule": "repeated",
                      "type": "uint32",
                      "id": 6
                    },
                    "num_rows": {
                      "type": "uint32",
                      "id": 7
                    },
                    "schema_timestamp": {
                      "type": "uint64",
                      "id": 8
                    },
                    "partial_update": {
                      "type": "bool",
                      "id": 9
                    },
                    "namespace": {
                      "type": "string",
                      "id": 10,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "field_ops": {
                      "rule": "repeated",
                      "type": "schema.FieldPartialUpdateOp",
                      "id": 11
                    }
                  }
                },
                "MutationResult": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "IDs": {
                      "type": "schema.IDs",
                      "id": 2
                    },
                    "succ_index": {
                      "rule": "repeated",
                      "type": "uint32",
                      "id": 3
                    },
                    "err_index": {
                      "rule": "repeated",
                      "type": "uint32",
                      "id": 4
                    },
                    "acknowledged": {
                      "type": "bool",
                      "id": 5
                    },
                    "insert_cnt": {
                      "type": "int64",
                      "id": 6
                    },
                    "delete_cnt": {
                      "type": "int64",
                      "id": 7
                    },
                    "upsert_cnt": {
                      "type": "int64",
                      "id": 8
                    },
                    "timestamp": {
                      "type": "uint64",
                      "id": 9
                    }
                  }
                },
                "DeleteRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeDelete",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "oneofs": {
                    "_namespace": {
                      "oneof": [
                        "namespace"
                      ]
                    }
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "partition_name": {
                      "type": "string",
                      "id": 4
                    },
                    "expr": {
                      "type": "string",
                      "id": 5
                    },
                    "hash_keys": {
                      "rule": "repeated",
                      "type": "uint32",
                      "id": 6
                    },
                    "consistency_level": {
                      "type": "common.ConsistencyLevel",
                      "id": 7
                    },
                    "expr_template_values": {
                      "keyType": "string",
                      "type": "schema.TemplateValue",
                      "id": 8
                    },
                    "namespace": {
                      "type": "string",
                      "id": 9,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "SubSearchRequest": {
                  "oneofs": {
                    "_namespace": {
                      "oneof": [
                        "namespace"
                      ]
                    }
                  },
                  "fields": {
                    "dsl": {
                      "type": "string",
                      "id": 1
                    },
                    "placeholder_group": {
                      "type": "bytes",
                      "id": 2
                    },
                    "dsl_type": {
                      "type": "common.DslType",
                      "id": 3
                    },
                    "search_params": {
                      "rule": "repeated",
                      "type": "common.KeyValuePair",
                      "id": 4
                    },
                    "nq": {
                      "type": "int64",
                      "id": 5
                    },
                    "expr_template_values": {
                      "keyType": "string",
                      "type": "schema.TemplateValue",
                      "id": 6
                    },
                    "namespace": {
                      "type": "string",
                      "id": 7,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "SearchRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeSearch",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "oneofs": {
                    "search_input": {
                      "oneof": [
                        "placeholder_group",
                        "ids"
                      ]
                    },
                    "_namespace": {
                      "oneof": [
                        "namespace"
                      ]
                    }
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "partition_names": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 4
                    },
                    "dsl": {
                      "type": "string",
                      "id": 5
                    },
                    "placeholder_group": {
                      "type": "bytes",
                      "id": 6
                    },
                    "ids": {
                      "type": "schema.IDs",
                      "id": 22
                    },
                    "dsl_type": {
                      "type": "common.DslType",
                      "id": 7
                    },
                    "output_fields": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 8
                    },
                    "search_params": {
                      "rule": "repeated",
                      "type": "common.KeyValuePair",
                      "id": 9
                    },
                    "travel_timestamp": {
                      "type": "uint64",
                      "id": 10
                    },
                    "guarantee_timestamp": {
                      "type": "uint64",
                      "id": 11
                    },
                    "nq": {
                      "type": "int64",
                      "id": 12
                    },
                    "not_return_all_meta": {
                      "type": "bool",
                      "id": 13
                    },
                    "consistency_level": {
                      "type": "common.ConsistencyLevel",
                      "id": 14
                    },
                    "use_default_consistency": {
                      "type": "bool",
                      "id": 15
                    },
                    "search_by_primary_keys": {
                      "type": "bool",
                      "id": 16,
                      "options": {
                        "deprecated": true
                      }
                    },
                    "sub_reqs": {
                      "rule": "repeated",
                      "type": "SubSearchRequest",
                      "id": 17
                    },
                    "expr_template_values": {
                      "keyType": "string",
                      "type": "schema.TemplateValue",
                      "id": 18
                    },
                    "function_score": {
                      "type": "schema.FunctionScore",
                      "id": 19
                    },
                    "namespace": {
                      "type": "string",
                      "id": 20,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "highlighter": {
                      "type": "common.Highlighter",
                      "id": 21
                    },
                    "search_aggregation": {
                      "type": "common.SearchAggregationSpec",
                      "id": 23
                    },
                    "function_chains": {
                      "rule": "repeated",
                      "type": "schema.FunctionChain",
                      "id": 24
                    }
                  }
                },
                "Hits": {
                  "fields": {
                    "IDs": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 1
                    },
                    "row_data": {
                      "rule": "repeated",
                      "type": "bytes",
                      "id": 2
                    },
                    "scores": {
                      "rule": "repeated",
                      "type": "float",
                      "id": 3
                    }
                  }
                },
                "SearchResults": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "results": {
                      "type": "schema.SearchResultData",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "session_ts": {
                      "type": "uint64",
                      "id": 4
                    }
                  }
                },
                "HybridSearchRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeSearch",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "oneofs": {
                    "_namespace": {
                      "oneof": [
                        "namespace"
                      ]
                    }
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "partition_names": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 4
                    },
                    "requests": {
                      "rule": "repeated",
                      "type": "SearchRequest",
                      "id": 5
                    },
                    "rank_params": {
                      "rule": "repeated",
                      "type": "common.KeyValuePair",
                      "id": 6
                    },
                    "travel_timestamp": {
                      "type": "uint64",
                      "id": 7
                    },
                    "guarantee_timestamp": {
                      "type": "uint64",
                      "id": 8
                    },
                    "not_return_all_meta": {
                      "type": "bool",
                      "id": 9
                    },
                    "output_fields": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 10
                    },
                    "consistency_level": {
                      "type": "common.ConsistencyLevel",
                      "id": 11
                    },
                    "use_default_consistency": {
                      "type": "bool",
                      "id": 12
                    },
                    "function_score": {
                      "type": "schema.FunctionScore",
                      "id": 13
                    },
                    "namespace": {
                      "type": "string",
                      "id": 14,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "function_chains": {
                      "rule": "repeated",
                      "type": "schema.FunctionChain",
                      "id": 15
                    }
                  }
                },
                "FlushRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeFlush",
                    "(common.privilege_ext_obj).object_name_indexs": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_names": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "FlushResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "coll_segIDs": {
                      "keyType": "string",
                      "type": "schema.LongArray",
                      "id": 3
                    },
                    "flush_coll_segIDs": {
                      "keyType": "string",
                      "type": "schema.LongArray",
                      "id": 4
                    },
                    "coll_seal_times": {
                      "keyType": "string",
                      "type": "int64",
                      "id": 5
                    },
                    "coll_flush_ts": {
                      "keyType": "string",
                      "type": "uint64",
                      "id": 6
                    },
                    "channel_cps": {
                      "keyType": "string",
                      "type": "msg.MsgPosition",
                      "id": 7
                    }
                  }
                },
                "QueryRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeQuery",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "oneofs": {
                    "_namespace": {
                      "oneof": [
                        "namespace"
                      ]
                    }
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "expr": {
                      "type": "string",
                      "id": 4
                    },
                    "output_fields": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 5
                    },
                    "partition_names": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 6
                    },
                    "travel_timestamp": {
                      "type": "uint64",
                      "id": 7
                    },
                    "guarantee_timestamp": {
                      "type": "uint64",
                      "id": 8
                    },
                    "query_params": {
                      "rule": "repeated",
                      "type": "common.KeyValuePair",
                      "id": 9
                    },
                    "not_return_all_meta": {
                      "type": "bool",
                      "id": 10
                    },
                    "consistency_level": {
                      "type": "common.ConsistencyLevel",
                      "id": 11
                    },
                    "use_default_consistency": {
                      "type": "bool",
                      "id": 12
                    },
                    "expr_template_values": {
                      "keyType": "string",
                      "type": "schema.TemplateValue",
                      "id": 13
                    },
                    "namespace": {
                      "type": "string",
                      "id": 14,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "ElementIndices": {
                  "fields": {
                    "indices": {
                      "type": "schema.LongArray",
                      "id": 1
                    }
                  }
                },
                "QueryResults": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "fields_data": {
                      "rule": "repeated",
                      "type": "schema.FieldData",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "output_fields": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 4
                    },
                    "session_ts": {
                      "type": "uint64",
                      "id": 5
                    },
                    "primary_field_name": {
                      "type": "string",
                      "id": 6
                    },
                    "element_indices": {
                      "rule": "repeated",
                      "type": "ElementIndices",
                      "id": 7
                    }
                  }
                },
                "QueryCursor": {
                  "oneofs": {
                    "cursor_pk": {
                      "oneof": [
                        "str_pk",
                        "int_pk"
                      ]
                    }
                  },
                  "fields": {
                    "session_ts": {
                      "type": "uint64",
                      "id": 1
                    },
                    "str_pk": {
                      "type": "string",
                      "id": 2
                    },
                    "int_pk": {
                      "type": "int64",
                      "id": 3
                    }
                  }
                },
                "VectorIDs": {
                  "fields": {
                    "collection_name": {
                      "type": "string",
                      "id": 1
                    },
                    "field_name": {
                      "type": "string",
                      "id": 2
                    },
                    "id_array": {
                      "type": "schema.IDs",
                      "id": 3
                    },
                    "partition_names": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "VectorsArray": {
                  "oneofs": {
                    "array": {
                      "oneof": [
                        "id_array",
                        "data_array"
                      ]
                    }
                  },
                  "fields": {
                    "id_array": {
                      "type": "VectorIDs",
                      "id": 1
                    },
                    "data_array": {
                      "type": "schema.VectorField",
                      "id": 2
                    }
                  }
                },
                "CalcDistanceRequest": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "op_left": {
                      "type": "VectorsArray",
                      "id": 2
                    },
                    "op_right": {
                      "type": "VectorsArray",
                      "id": 3
                    },
                    "params": {
                      "rule": "repeated",
                      "type": "common.KeyValuePair",
                      "id": 4
                    }
                  }
                },
                "CalcDistanceResults": {
                  "oneofs": {
                    "array": {
                      "oneof": [
                        "int_dist",
                        "float_dist"
                      ]
                    }
                  },
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "int_dist": {
                      "type": "schema.IntArray",
                      "id": 2
                    },
                    "float_dist": {
                      "type": "schema.FloatArray",
                      "id": 3
                    }
                  }
                },
                "FlushAllTarget": {
                  "fields": {
                    "db_name": {
                      "type": "string",
                      "id": 1
                    },
                    "collection_names": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "FlushAllRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeFlushAll",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2,
                      "options": {
                        "deprecated": true
                      }
                    },
                    "flush_targets": {
                      "rule": "repeated",
                      "type": "FlushAllTarget",
                      "id": 3,
                      "options": {
                        "deprecated": true
                      }
                    }
                  }
                },
                "ClusterInfo": {
                  "fields": {
                    "cluster_id": {
                      "type": "string",
                      "id": 1
                    },
                    "cchannel": {
                      "type": "string",
                      "id": 2
                    },
                    "pchannels": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "FlushAllResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "flush_all_ts": {
                      "type": "uint64",
                      "id": 2,
                      "options": {
                        "deprecated": true
                      }
                    },
                    "flush_results": {
                      "rule": "repeated",
                      "type": "FlushAllResult",
                      "id": 3,
                      "options": {
                        "deprecated": true
                      }
                    },
                    "flush_all_msgs": {
                      "keyType": "string",
                      "type": "common.ImmutableMessage",
                      "id": 4
                    },
                    "cluster_info": {
                      "type": "ClusterInfo",
                      "id": 5
                    }
                  }
                },
                "FlushAllResult": {
                  "fields": {
                    "db_name": {
                      "type": "string",
                      "id": 1
                    },
                    "collection_results": {
                      "rule": "repeated",
                      "type": "FlushCollectionResult",
                      "id": 2
                    }
                  }
                },
                "FlushCollectionResult": {
                  "fields": {
                    "collection_name": {
                      "type": "string",
                      "id": 1
                    },
                    "segment_ids": {
                      "type": "schema.LongArray",
                      "id": 2
                    },
                    "flush_segment_ids": {
                      "type": "schema.LongArray",
                      "id": 3
                    },
                    "seal_time": {
                      "type": "int64",
                      "id": 4
                    },
                    "flush_ts": {
                      "type": "uint64",
                      "id": 5
                    },
                    "channel_cps": {
                      "keyType": "string",
                      "type": "msg.MsgPosition",
                      "id": 6
                    }
                  }
                },
                "PersistentSegmentInfo": {
                  "fields": {
                    "segmentID": {
                      "type": "int64",
                      "id": 1
                    },
                    "collectionID": {
                      "type": "int64",
                      "id": 2
                    },
                    "partitionID": {
                      "type": "int64",
                      "id": 3
                    },
                    "num_rows": {
                      "type": "int64",
                      "id": 4
                    },
                    "state": {
                      "type": "common.SegmentState",
                      "id": 5
                    },
                    "level": {
                      "type": "common.SegmentLevel",
                      "id": 6
                    },
                    "is_sorted": {
                      "type": "bool",
                      "id": 7
                    },
                    "storage_version": {
                      "type": "int64",
                      "id": 8
                    },
                    "insert_channel": {
                      "type": "string",
                      "id": 9
                    },
                    "compaction_from": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 10
                    }
                  }
                },
                "GetPersistentSegmentInfoRequest": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "dbName": {
                      "type": "string",
                      "id": 2
                    },
                    "collectionName": {
                      "type": "string",
                      "id": 3
                    },
                    "states": {
                      "rule": "repeated",
                      "type": "common.SegmentState",
                      "id": 4
                    }
                  }
                },
                "GetPersistentSegmentInfoResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "infos": {
                      "rule": "repeated",
                      "type": "PersistentSegmentInfo",
                      "id": 2
                    }
                  }
                },
                "QuerySegmentInfo": {
                  "fields": {
                    "segmentID": {
                      "type": "int64",
                      "id": 1
                    },
                    "collectionID": {
                      "type": "int64",
                      "id": 2
                    },
                    "partitionID": {
                      "type": "int64",
                      "id": 3
                    },
                    "mem_size": {
                      "type": "int64",
                      "id": 4
                    },
                    "num_rows": {
                      "type": "int64",
                      "id": 5
                    },
                    "index_name": {
                      "type": "string",
                      "id": 6
                    },
                    "indexID": {
                      "type": "int64",
                      "id": 7
                    },
                    "nodeID": {
                      "type": "int64",
                      "id": 8,
                      "options": {
                        "deprecated": true
                      }
                    },
                    "state": {
                      "type": "common.SegmentState",
                      "id": 9
                    },
                    "nodeIds": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 10
                    },
                    "level": {
                      "type": "common.SegmentLevel",
                      "id": 11
                    },
                    "is_sorted": {
                      "type": "bool",
                      "id": 12
                    },
                    "storage_version": {
                      "type": "int64",
                      "id": 13
                    }
                  }
                },
                "GetQuerySegmentInfoRequest": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "dbName": {
                      "type": "string",
                      "id": 2
                    },
                    "collectionName": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "GetQuerySegmentInfoResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "infos": {
                      "rule": "repeated",
                      "type": "QuerySegmentInfo",
                      "id": 2
                    }
                  }
                },
                "DummyRequest": {
                  "fields": {
                    "request_type": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "DummyResponse": {
                  "fields": {
                    "response": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "RegisterLinkRequest": {
                  "fields": {}
                },
                "RegisterLinkResponse": {
                  "fields": {
                    "address": {
                      "type": "common.Address",
                      "id": 1
                    },
                    "status": {
                      "type": "common.Status",
                      "id": 2
                    }
                  }
                },
                "GetMetricsRequest": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "request": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "GetMetricsResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "response": {
                      "type": "string",
                      "id": 2
                    },
                    "component_name": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "ComponentInfo": {
                  "fields": {
                    "nodeID": {
                      "type": "int64",
                      "id": 1
                    },
                    "role": {
                      "type": "string",
                      "id": 2
                    },
                    "state_code": {
                      "type": "common.StateCode",
                      "id": 3
                    },
                    "extra_info": {
                      "rule": "repeated",
                      "type": "common.KeyValuePair",
                      "id": 4
                    }
                  }
                },
                "ComponentStates": {
                  "fields": {
                    "state": {
                      "type": "ComponentInfo",
                      "id": 1
                    },
                    "subcomponent_states": {
                      "rule": "repeated",
                      "type": "ComponentInfo",
                      "id": 2
                    },
                    "status": {
                      "type": "common.Status",
                      "id": 3
                    }
                  }
                },
                "GetComponentStatesRequest": {
                  "fields": {}
                },
                "LoadBalanceRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeLoadBalance",
                    "(common.privilege_ext_obj).object_name_index": 5
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "src_nodeID": {
                      "type": "int64",
                      "id": 2
                    },
                    "dst_nodeIDs": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 3
                    },
                    "sealed_segmentIDs": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 4
                    },
                    "collectionName": {
                      "type": "string",
                      "id": 5
                    },
                    "db_name": {
                      "type": "string",
                      "id": 6
                    }
                  }
                },
                "ManualCompactionRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeCompaction",
                    "(common.privilege_ext_obj).object_name_index": 4
                  },
                  "fields": {
                    "collectionID": {
                      "type": "int64",
                      "id": 1
                    },
                    "timetravel": {
                      "type": "uint64",
                      "id": 2
                    },
                    "majorCompaction": {
                      "type": "bool",
                      "id": 3
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 4
                    },
                    "db_name": {
                      "type": "string",
                      "id": 5
                    },
                    "partition_id": {
                      "type": "int64",
                      "id": 6
                    },
                    "channel": {
                      "type": "string",
                      "id": 7
                    },
                    "segment_ids": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 8
                    },
                    "l0Compaction": {
                      "type": "bool",
                      "id": 9
                    },
                    "target_size": {
                      "type": "int64",
                      "id": 10
                    }
                  }
                },
                "ManualCompactionResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "compactionID": {
                      "type": "int64",
                      "id": 2
                    },
                    "compactionPlanCount": {
                      "type": "int32",
                      "id": 3
                    }
                  }
                },
                "GetCompactionStateRequest": {
                  "fields": {
                    "compactionID": {
                      "type": "int64",
                      "id": 1
                    }
                  }
                },
                "GetCompactionStateResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "state": {
                      "type": "common.CompactionState",
                      "id": 2
                    },
                    "executingPlanNo": {
                      "type": "int64",
                      "id": 3
                    },
                    "timeoutPlanNo": {
                      "type": "int64",
                      "id": 4
                    },
                    "completedPlanNo": {
                      "type": "int64",
                      "id": 5
                    },
                    "failedPlanNo": {
                      "type": "int64",
                      "id": 6
                    }
                  }
                },
                "GetCompactionPlansRequest": {
                  "fields": {
                    "compactionID": {
                      "type": "int64",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "collection_id": {
                      "type": "int64",
                      "id": 4
                    }
                  }
                },
                "GetCompactionPlansResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "state": {
                      "type": "common.CompactionState",
                      "id": 2
                    },
                    "mergeInfos": {
                      "rule": "repeated",
                      "type": "CompactionMergeInfo",
                      "id": 3
                    }
                  }
                },
                "CompactionMergeInfo": {
                  "fields": {
                    "sources": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 1
                    },
                    "target": {
                      "type": "int64",
                      "id": 2
                    },
                    "plan_id": {
                      "type": "int64",
                      "id": 3
                    },
                    "trigger_id": {
                      "type": "int64",
                      "id": 4
                    },
                    "collection_id": {
                      "type": "int64",
                      "id": 5
                    },
                    "partition_id": {
                      "type": "int64",
                      "id": 6
                    },
                    "channel": {
                      "type": "string",
                      "id": 7
                    },
                    "type": {
                      "type": "common.CompactionType",
                      "id": 8
                    },
                    "state": {
                      "type": "common.CompactionTaskState",
                      "id": 9
                    },
                    "failure_reason": {
                      "type": "string",
                      "id": 10
                    },
                    "targets": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 11
                    }
                  }
                },
                "GetFlushStateRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeGetFlushState",
                    "(common.privilege_ext_obj).object_name_index": 4
                  },
                  "fields": {
                    "segmentIDs": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 1
                    },
                    "flush_ts": {
                      "type": "uint64",
                      "id": 2
                    },
                    "db_name": {
                      "type": "string",
                      "id": 3
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "GetFlushStateResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "flushed": {
                      "type": "bool",
                      "id": 2
                    }
                  }
                },
                "GetFlushAllStateRequest": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "flush_all_ts": {
                      "type": "uint64",
                      "id": 2,
                      "options": {
                        "deprecated": true
                      }
                    },
                    "db_name": {
                      "type": "string",
                      "id": 3,
                      "options": {
                        "deprecated": true
                      }
                    },
                    "flush_targets": {
                      "rule": "repeated",
                      "type": "FlushAllTarget",
                      "id": 4,
                      "options": {
                        "deprecated": true
                      }
                    },
                    "flush_all_tss": {
                      "keyType": "string",
                      "type": "uint64",
                      "id": 5
                    }
                  }
                },
                "GetFlushAllStateResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "flushed": {
                      "type": "bool",
                      "id": 2
                    },
                    "flush_states": {
                      "rule": "repeated",
                      "type": "FlushAllState",
                      "id": 3,
                      "options": {
                        "deprecated": true
                      }
                    }
                  }
                },
                "FlushAllState": {
                  "fields": {
                    "db_name": {
                      "type": "string",
                      "id": 1
                    },
                    "collection_flush_states": {
                      "keyType": "string",
                      "type": "bool",
                      "id": 2
                    }
                  }
                },
                "ImportRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeImport",
                    "(common.privilege_ext_obj).object_name_index": 1
                  },
                  "fields": {
                    "collection_name": {
                      "type": "string",
                      "id": 1
                    },
                    "partition_name": {
                      "type": "string",
                      "id": 2
                    },
                    "channel_names": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 3
                    },
                    "row_based": {
                      "type": "bool",
                      "id": 4
                    },
                    "files": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 5
                    },
                    "options": {
                      "rule": "repeated",
                      "type": "common.KeyValuePair",
                      "id": 6
                    },
                    "db_name": {
                      "type": "string",
                      "id": 7
                    },
                    "clustering_info": {
                      "type": "bytes",
                      "id": 8
                    }
                  }
                },
                "ImportResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "tasks": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 2
                    }
                  }
                },
                "GetImportStateRequest": {
                  "fields": {
                    "task": {
                      "type": "int64",
                      "id": 1
                    }
                  }
                },
                "GetImportStateResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "state": {
                      "type": "common.ImportState",
                      "id": 2
                    },
                    "row_count": {
                      "type": "int64",
                      "id": 3
                    },
                    "id_list": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 4
                    },
                    "infos": {
                      "rule": "repeated",
                      "type": "common.KeyValuePair",
                      "id": 5
                    },
                    "id": {
                      "type": "int64",
                      "id": 6
                    },
                    "collection_id": {
                      "type": "int64",
                      "id": 7
                    },
                    "segment_ids": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 8
                    },
                    "create_ts": {
                      "type": "int64",
                      "id": 9
                    }
                  }
                },
                "ListImportTasksRequest": {
                  "fields": {
                    "collection_name": {
                      "type": "string",
                      "id": 1
                    },
                    "limit": {
                      "type": "int64",
                      "id": 2
                    },
                    "db_name": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "ListImportTasksResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "tasks": {
                      "rule": "repeated",
                      "type": "GetImportStateResponse",
                      "id": 2
                    }
                  }
                },
                "GetReplicasRequest": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "collectionID": {
                      "type": "int64",
                      "id": 2
                    },
                    "with_shard_nodes": {
                      "type": "bool",
                      "id": 3
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 4
                    },
                    "db_name": {
                      "type": "string",
                      "id": 5
                    }
                  }
                },
                "GetReplicasResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "replicas": {
                      "rule": "repeated",
                      "type": "ReplicaInfo",
                      "id": 2
                    }
                  }
                },
                "ReplicaInfo": {
                  "fields": {
                    "replicaID": {
                      "type": "int64",
                      "id": 1
                    },
                    "collectionID": {
                      "type": "int64",
                      "id": 2
                    },
                    "partition_ids": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 3
                    },
                    "shard_replicas": {
                      "rule": "repeated",
                      "type": "ShardReplica",
                      "id": 4
                    },
                    "node_ids": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 5
                    },
                    "resource_group_name": {
                      "type": "string",
                      "id": 6
                    },
                    "num_outbound_node": {
                      "keyType": "string",
                      "type": "int32",
                      "id": 7
                    }
                  }
                },
                "ShardReplica": {
                  "fields": {
                    "leaderID": {
                      "type": "int64",
                      "id": 1
                    },
                    "leader_addr": {
                      "type": "string",
                      "id": 2
                    },
                    "dm_channel_name": {
                      "type": "string",
                      "id": 3
                    },
                    "node_ids": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 4
                    }
                  }
                },
                "ProxyService": {
                  "methods": {
                    "RegisterLink": {
                      "requestType": "RegisterLinkRequest",
                      "responseType": "RegisterLinkResponse"
                    }
                  }
                },
                "CreateCredentialRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeCreateOwnership",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "oneofs": {
                    "_description": {
                      "oneof": [
                        "description"
                      ]
                    }
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "username": {
                      "type": "string",
                      "id": 2
                    },
                    "password": {
                      "type": "string",
                      "id": 3
                    },
                    "created_utc_timestamps": {
                      "type": "uint64",
                      "id": 4
                    },
                    "modified_utc_timestamps": {
                      "type": "uint64",
                      "id": 5
                    },
                    "description": {
                      "type": "string",
                      "id": 6,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "UpdateCredentialRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "User",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeUpdateUser",
                    "(common.privilege_ext_obj).object_name_index": 2
                  },
                  "oneofs": {
                    "_description": {
                      "oneof": [
                        "description"
                      ]
                    }
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "username": {
                      "type": "string",
                      "id": 2
                    },
                    "oldPassword": {
                      "type": "string",
                      "id": 3
                    },
                    "newPassword": {
                      "type": "string",
                      "id": 4
                    },
                    "created_utc_timestamps": {
                      "type": "uint64",
                      "id": 5
                    },
                    "modified_utc_timestamps": {
                      "type": "uint64",
                      "id": 6
                    },
                    "description": {
                      "type": "string",
                      "id": 7,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "DeleteCredentialRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeDropOwnership",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "username": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "ListCredUsersResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "usernames": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "ListCredUsersRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeSelectOwnership",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    }
                  }
                },
                "RoleEntity": {
                  "fields": {
                    "name": {
                      "type": "string",
                      "id": 1
                    },
                    "description": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "UserEntity": {
                  "fields": {
                    "name": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "CreateRoleRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeCreateOwnership",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "entity": {
                      "type": "RoleEntity",
                      "id": 2
                    }
                  }
                },
                "AlterRoleRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeCreateOwnership",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "role_name": {
                      "type": "string",
                      "id": 2
                    },
                    "description": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "DropRoleRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeDropOwnership",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "role_name": {
                      "type": "string",
                      "id": 2
                    },
                    "force_drop": {
                      "type": "bool",
                      "id": 3
                    }
                  }
                },
                "CreatePrivilegeGroupRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeCreatePrivilegeGroup",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "group_name": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "DropPrivilegeGroupRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeDropPrivilegeGroup",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "group_name": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "ListPrivilegeGroupsRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeListPrivilegeGroups",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    }
                  }
                },
                "ListPrivilegeGroupsResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "privilege_groups": {
                      "rule": "repeated",
                      "type": "PrivilegeGroupInfo",
                      "id": 2
                    }
                  }
                },
                "OperatePrivilegeGroupRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeOperatePrivilegeGroup",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "group_name": {
                      "type": "string",
                      "id": 2
                    },
                    "privileges": {
                      "rule": "repeated",
                      "type": "PrivilegeEntity",
                      "id": 3
                    },
                    "type": {
                      "type": "OperatePrivilegeGroupType",
                      "id": 4
                    }
                  }
                },
                "OperatePrivilegeGroupType": {
                  "values": {
                    "AddPrivilegesToGroup": 0,
                    "RemovePrivilegesFromGroup": 1
                  }
                },
                "OperateUserRoleType": {
                  "values": {
                    "AddUserToRole": 0,
                    "RemoveUserFromRole": 1
                  }
                },
                "OperateUserRoleRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeManageOwnership",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "username": {
                      "type": "string",
                      "id": 2
                    },
                    "role_name": {
                      "type": "string",
                      "id": 3
                    },
                    "type": {
                      "type": "OperateUserRoleType",
                      "id": 4
                    }
                  }
                },
                "PrivilegeGroupInfo": {
                  "fields": {
                    "group_name": {
                      "type": "string",
                      "id": 1
                    },
                    "privileges": {
                      "rule": "repeated",
                      "type": "PrivilegeEntity",
                      "id": 2
                    }
                  }
                },
                "SelectRoleRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeSelectOwnership",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "role": {
                      "type": "RoleEntity",
                      "id": 2
                    },
                    "include_user_info": {
                      "type": "bool",
                      "id": 3
                    }
                  }
                },
                "RoleResult": {
                  "fields": {
                    "role": {
                      "type": "RoleEntity",
                      "id": 1
                    },
                    "users": {
                      "rule": "repeated",
                      "type": "UserEntity",
                      "id": 2
                    }
                  }
                },
                "SelectRoleResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "results": {
                      "rule": "repeated",
                      "type": "RoleResult",
                      "id": 2
                    }
                  }
                },
                "SelectUserRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "User",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeSelectUser",
                    "(common.privilege_ext_obj).object_name_index": 2
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "user": {
                      "type": "UserEntity",
                      "id": 2
                    },
                    "include_role_info": {
                      "type": "bool",
                      "id": 3
                    }
                  }
                },
                "UserResult": {
                  "fields": {
                    "user": {
                      "type": "UserEntity",
                      "id": 1
                    },
                    "roles": {
                      "rule": "repeated",
                      "type": "RoleEntity",
                      "id": 2
                    },
                    "description": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "SelectUserResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "results": {
                      "rule": "repeated",
                      "type": "UserResult",
                      "id": 2
                    }
                  }
                },
                "ObjectEntity": {
                  "fields": {
                    "name": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "PrivilegeEntity": {
                  "fields": {
                    "name": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "GrantorEntity": {
                  "fields": {
                    "user": {
                      "type": "UserEntity",
                      "id": 1
                    },
                    "privilege": {
                      "type": "PrivilegeEntity",
                      "id": 2
                    }
                  }
                },
                "GrantPrivilegeEntity": {
                  "fields": {
                    "entities": {
                      "rule": "repeated",
                      "type": "GrantorEntity",
                      "id": 1
                    }
                  }
                },
                "GrantEntity": {
                  "fields": {
                    "role": {
                      "type": "RoleEntity",
                      "id": 1
                    },
                    "object": {
                      "type": "ObjectEntity",
                      "id": 2
                    },
                    "object_name": {
                      "type": "string",
                      "id": 3
                    },
                    "grantor": {
                      "type": "GrantorEntity",
                      "id": 4
                    },
                    "db_name": {
                      "type": "string",
                      "id": 5
                    }
                  }
                },
                "PrivilegeLevel": {
                  "values": {
                    "Cluster": 0,
                    "Database": 1,
                    "Collection": 2
                  }
                },
                "SelectGrantRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeSelectOwnership",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "entity": {
                      "type": "GrantEntity",
                      "id": 2
                    }
                  }
                },
                "SelectGrantResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "entities": {
                      "rule": "repeated",
                      "type": "GrantEntity",
                      "id": 2
                    }
                  }
                },
                "OperatePrivilegeType": {
                  "values": {
                    "Grant": 0,
                    "Revoke": 1
                  }
                },
                "OperatePrivilegeRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeManageOwnership",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "entity": {
                      "type": "GrantEntity",
                      "id": 2
                    },
                    "type": {
                      "type": "OperatePrivilegeType",
                      "id": 3
                    },
                    "version": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "OperatePrivilegeV2Request": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeManageOwnership",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "role": {
                      "type": "RoleEntity",
                      "id": 2
                    },
                    "grantor": {
                      "type": "GrantorEntity",
                      "id": 3
                    },
                    "type": {
                      "type": "OperatePrivilegeType",
                      "id": 4
                    },
                    "db_name": {
                      "type": "string",
                      "id": 5
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 6
                    }
                  }
                },
                "UserInfo": {
                  "fields": {
                    "user": {
                      "type": "string",
                      "id": 1
                    },
                    "password": {
                      "type": "string",
                      "id": 2
                    },
                    "roles": {
                      "rule": "repeated",
                      "type": "RoleEntity",
                      "id": 3
                    }
                  }
                },
                "RBACMeta": {
                  "fields": {
                    "users": {
                      "rule": "repeated",
                      "type": "UserInfo",
                      "id": 1
                    },
                    "roles": {
                      "rule": "repeated",
                      "type": "milvus.RoleEntity",
                      "id": 2
                    },
                    "grants": {
                      "rule": "repeated",
                      "type": "milvus.GrantEntity",
                      "id": 3
                    },
                    "privilege_groups": {
                      "rule": "repeated",
                      "type": "milvus.PrivilegeGroupInfo",
                      "id": 4
                    }
                  }
                },
                "BackupRBACMetaRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeBackupRBAC",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    }
                  }
                },
                "BackupRBACMetaResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "RBAC_meta": {
                      "type": "RBACMeta",
                      "id": 2
                    }
                  }
                },
                "RestoreRBACMetaRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeRestoreRBAC",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "RBAC_meta": {
                      "type": "RBACMeta",
                      "id": 2
                    }
                  }
                },
                "GetLoadingProgressRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeGetLoadState",
                    "(common.privilege_ext_obj).object_name_index": 2
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 2
                    },
                    "partition_names": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 3
                    },
                    "db_name": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "GetLoadingProgressResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "progress": {
                      "type": "int64",
                      "id": 2
                    },
                    "refresh_progress": {
                      "type": "int64",
                      "id": 3
                    }
                  }
                },
                "GetLoadStateRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeGetLoadState",
                    "(common.privilege_ext_obj).object_name_index": 2
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 2
                    },
                    "partition_names": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 3
                    },
                    "db_name": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "GetLoadStateResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "state": {
                      "type": "common.LoadState",
                      "id": 2
                    }
                  }
                },
                "MilvusExt": {
                  "fields": {
                    "version": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "milvus_ext_obj": {
                  "type": "MilvusExt",
                  "id": 1001,
                  "extend": "google.protobuf.FileOptions"
                },
                "GetVersionRequest": {
                  "fields": {}
                },
                "GetVersionResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "version": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "QuotaState": {
                  "values": {
                    "Unknown": 0,
                    "ReadLimited": 2,
                    "WriteLimited": 3,
                    "DenyToRead": 4,
                    "DenyToWrite": 5,
                    "DenyToDDL": 6
                  }
                },
                "CheckHealthRequest": {
                  "fields": {}
                },
                "CheckHealthResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "isHealthy": {
                      "type": "bool",
                      "id": 2
                    },
                    "reasons": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 3
                    },
                    "quota_states": {
                      "rule": "repeated",
                      "type": "QuotaState",
                      "id": 4
                    }
                  }
                },
                "CreateResourceGroupRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeCreateResourceGroup",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "resource_group": {
                      "type": "string",
                      "id": 2
                    },
                    "config": {
                      "type": "rg.ResourceGroupConfig",
                      "id": 3
                    }
                  }
                },
                "UpdateResourceGroupsRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeUpdateResourceGroups",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "resource_groups": {
                      "keyType": "string",
                      "type": "rg.ResourceGroupConfig",
                      "id": 2
                    }
                  }
                },
                "DropResourceGroupRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeDropResourceGroup",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "resource_group": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "TransferNodeRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeTransferNode",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "source_resource_group": {
                      "type": "string",
                      "id": 2
                    },
                    "target_resource_group": {
                      "type": "string",
                      "id": 3
                    },
                    "num_node": {
                      "type": "int32",
                      "id": 4
                    }
                  }
                },
                "TransferReplicaRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeTransferReplica",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "source_resource_group": {
                      "type": "string",
                      "id": 2
                    },
                    "target_resource_group": {
                      "type": "string",
                      "id": 3
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 4
                    },
                    "num_replica": {
                      "type": "int64",
                      "id": 5
                    },
                    "db_name": {
                      "type": "string",
                      "id": 6
                    }
                  }
                },
                "ListResourceGroupsRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeListResourceGroups",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    }
                  }
                },
                "ListResourceGroupsResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "resource_groups": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "DescribeResourceGroupRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeDescribeResourceGroup",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "resource_group": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "DescribeResourceGroupResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "resource_group": {
                      "type": "ResourceGroup",
                      "id": 2
                    }
                  }
                },
                "ResourceGroup": {
                  "fields": {
                    "name": {
                      "type": "string",
                      "id": 1
                    },
                    "capacity": {
                      "type": "int32",
                      "id": 2
                    },
                    "num_available_node": {
                      "type": "int32",
                      "id": 3
                    },
                    "num_loaded_replica": {
                      "keyType": "string",
                      "type": "int32",
                      "id": 4
                    },
                    "num_outgoing_node": {
                      "keyType": "string",
                      "type": "int32",
                      "id": 5
                    },
                    "num_incoming_node": {
                      "keyType": "string",
                      "type": "int32",
                      "id": 6
                    },
                    "config": {
                      "type": "rg.ResourceGroupConfig",
                      "id": 7
                    },
                    "nodes": {
                      "rule": "repeated",
                      "type": "common.NodeInfo",
                      "id": 8
                    }
                  }
                },
                "RenameCollectionRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeRenameCollection",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "oldName": {
                      "type": "string",
                      "id": 3
                    },
                    "newName": {
                      "type": "string",
                      "id": 4
                    },
                    "newDBName": {
                      "type": "string",
                      "id": 5
                    }
                  }
                },
                "GetIndexStatisticsRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeIndexDetail",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "index_name": {
                      "type": "string",
                      "id": 4
                    },
                    "timestamp": {
                      "type": "uint64",
                      "id": 5
                    }
                  }
                },
                "GetIndexStatisticsResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "index_descriptions": {
                      "rule": "repeated",
                      "type": "IndexDescription",
                      "id": 2
                    }
                  }
                },
                "ConnectRequest": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "client_info": {
                      "type": "common.ClientInfo",
                      "id": 2
                    }
                  }
                },
                "ConnectResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "server_info": {
                      "type": "common.ServerInfo",
                      "id": 2
                    },
                    "identifier": {
                      "type": "int64",
                      "id": 3
                    }
                  }
                },
                "AllocTimestampRequest": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    }
                  }
                },
                "AllocTimestampResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "timestamp": {
                      "type": "uint64",
                      "id": 2
                    }
                  }
                },
                "CreateDatabaseRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeCreateDatabase",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "properties": {
                      "rule": "repeated",
                      "type": "common.KeyValuePair",
                      "id": 3
                    }
                  }
                },
                "DropDatabaseRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeDropDatabase",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "ListDatabasesRequest": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    }
                  }
                },
                "ListDatabasesResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "db_names": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 2
                    },
                    "created_timestamp": {
                      "rule": "repeated",
                      "type": "uint64",
                      "id": 3
                    },
                    "db_ids": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 4
                    }
                  }
                },
                "AlterDatabaseRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeAlterDatabase",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "db_id": {
                      "type": "string",
                      "id": 3
                    },
                    "properties": {
                      "rule": "repeated",
                      "type": "common.KeyValuePair",
                      "id": 4
                    },
                    "delete_keys": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 5
                    }
                  }
                },
                "DescribeDatabaseRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeDescribeDatabase",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "DescribeDatabaseResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "dbID": {
                      "type": "int64",
                      "id": 3
                    },
                    "created_timestamp": {
                      "type": "uint64",
                      "id": 4
                    },
                    "properties": {
                      "rule": "repeated",
                      "type": "common.KeyValuePair",
                      "id": 5
                    }
                  }
                },
                "ReplicateMessageRequest": {
                  "options": {
                    "deprecated": true
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "channel_name": {
                      "type": "string",
                      "id": 2
                    },
                    "BeginTs": {
                      "type": "uint64",
                      "id": 3
                    },
                    "EndTs": {
                      "type": "uint64",
                      "id": 4
                    },
                    "Msgs": {
                      "rule": "repeated",
                      "type": "bytes",
                      "id": 5
                    },
                    "StartPositions": {
                      "rule": "repeated",
                      "type": "msg.MsgPosition",
                      "id": 6
                    },
                    "EndPositions": {
                      "rule": "repeated",
                      "type": "msg.MsgPosition",
                      "id": 7
                    }
                  }
                },
                "ReplicateMessageResponse": {
                  "options": {
                    "deprecated": true
                  },
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "position": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "ImportAuthPlaceholder": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeImport",
                    "(common.privilege_ext_obj).object_name_index": 2
                  },
                  "fields": {
                    "db_name": {
                      "type": "string",
                      "id": 1
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 2
                    },
                    "partition_name": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "GetImportProgressAuthPlaceholder": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeGetImportProgress",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "db_name": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "ListImportsAuthPlaceholder": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeListImport",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "db_name": {
                      "type": "string",
                      "id": 3
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "RunAnalyzerRequest": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "analyzer_params": {
                      "type": "string",
                      "id": 2
                    },
                    "placeholder": {
                      "rule": "repeated",
                      "type": "bytes",
                      "id": 3
                    },
                    "with_detail": {
                      "type": "bool",
                      "id": 4
                    },
                    "with_hash": {
                      "type": "bool",
                      "id": 5
                    },
                    "db_name": {
                      "type": "string",
                      "id": 6
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 7
                    },
                    "field_name": {
                      "type": "string",
                      "id": 8
                    },
                    "analyzer_names": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 9
                    }
                  }
                },
                "AnalyzerToken": {
                  "fields": {
                    "token": {
                      "type": "string",
                      "id": 1
                    },
                    "start_offset": {
                      "type": "int64",
                      "id": 2
                    },
                    "end_offset": {
                      "type": "int64",
                      "id": 3
                    },
                    "position": {
                      "type": "int64",
                      "id": 4
                    },
                    "position_length": {
                      "type": "int64",
                      "id": 5
                    },
                    "hash": {
                      "type": "uint32",
                      "id": 6
                    }
                  }
                },
                "AnalyzerResult": {
                  "fields": {
                    "tokens": {
                      "rule": "repeated",
                      "type": "AnalyzerToken",
                      "id": 1
                    }
                  }
                },
                "RunAnalyzerResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "results": {
                      "rule": "repeated",
                      "type": "AnalyzerResult",
                      "id": 2
                    }
                  }
                },
                "FileResourceInfo": {
                  "fields": {
                    "id": {
                      "type": "int64",
                      "id": 1
                    },
                    "name": {
                      "type": "string",
                      "id": 2
                    },
                    "path": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "AddFileResourceRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeAddFileResource",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "name": {
                      "type": "string",
                      "id": 2
                    },
                    "path": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "RemoveFileResourceRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeRemoveFileResource",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "name": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "ListFileResourcesRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeListFileResources",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    }
                  }
                },
                "ListFileResourcesResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "resources": {
                      "rule": "repeated",
                      "type": "FileResourceInfo",
                      "id": 2
                    }
                  }
                },
                "RowPolicyAction": {
                  "values": {
                    "Query": 0,
                    "Search": 1,
                    "Insert": 2,
                    "Delete": 3,
                    "Upsert": 4
                  }
                },
                "AddUserTagsRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "User",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeUpdateUser",
                    "(common.privilege_ext_obj).object_name_index": 2
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "user_name": {
                      "type": "string",
                      "id": 2
                    },
                    "tags": {
                      "keyType": "string",
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "DeleteUserTagsRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "User",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeUpdateUser",
                    "(common.privilege_ext_obj).object_name_index": 2
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "user_name": {
                      "type": "string",
                      "id": 2
                    },
                    "tag_keys": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "GetUserTagsRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "User",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeSelectUser",
                    "(common.privilege_ext_obj).object_name_index": 2
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "user_name": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "GetUserTagsResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "tags": {
                      "keyType": "string",
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "ListUsersWithTagRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "User",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeSelectUser",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "tag_key": {
                      "type": "string",
                      "id": 2
                    },
                    "tag_value": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "ListUsersWithTagResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "user_names": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "CreateRowPolicyRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeCreateOwnership",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "policy_name": {
                      "type": "string",
                      "id": 4
                    },
                    "actions": {
                      "rule": "repeated",
                      "type": "RowPolicyAction",
                      "id": 5
                    },
                    "roles": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 6
                    },
                    "using_expr": {
                      "type": "string",
                      "id": 7
                    },
                    "check_expr": {
                      "type": "string",
                      "id": 8
                    },
                    "description": {
                      "type": "string",
                      "id": 9
                    }
                  }
                },
                "DropRowPolicyRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeDropOwnership",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "policy_name": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "ListRowPoliciesRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeSelectOwnership",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "RowPolicy": {
                  "fields": {
                    "policy_name": {
                      "type": "string",
                      "id": 1
                    },
                    "actions": {
                      "rule": "repeated",
                      "type": "RowPolicyAction",
                      "id": 2
                    },
                    "roles": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 3
                    },
                    "using_expr": {
                      "type": "string",
                      "id": 4
                    },
                    "check_expr": {
                      "type": "string",
                      "id": 5
                    },
                    "description": {
                      "type": "string",
                      "id": 6
                    },
                    "created_at": {
                      "type": "int64",
                      "id": 7
                    }
                  }
                },
                "ListRowPoliciesResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "policies": {
                      "rule": "repeated",
                      "type": "RowPolicy",
                      "id": 2
                    },
                    "db_name": {
                      "type": "string",
                      "id": 3
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "UpdateReplicateConfigurationRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeUpdateReplicateConfiguration",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "replicate_configuration": {
                      "type": "common.ReplicateConfiguration",
                      "id": 1
                    },
                    "force_promote": {
                      "type": "bool",
                      "id": 2
                    }
                  }
                },
                "GetReplicateConfigurationRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeGetReplicateConfiguration",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {}
                },
                "GetReplicateConfigurationResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "configuration": {
                      "type": "common.ReplicateConfiguration",
                      "id": 2
                    }
                  }
                },
                "GetReplicateInfoRequest": {
                  "fields": {
                    "source_cluster_id": {
                      "type": "string",
                      "id": 1
                    },
                    "target_pchannel": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "GetReplicateInfoResponse": {
                  "fields": {
                    "checkpoint": {
                      "type": "common.ReplicateCheckpoint",
                      "id": 1
                    },
                    "salvage_checkpoint": {
                      "type": "common.ReplicateCheckpoint",
                      "id": 2
                    }
                  }
                },
                "ReplicateMessage": {
                  "fields": {
                    "source_cluster_id": {
                      "type": "string",
                      "id": 1
                    },
                    "message": {
                      "type": "common.ImmutableMessage",
                      "id": 2
                    }
                  }
                },
                "ReplicateRequest": {
                  "oneofs": {
                    "request": {
                      "oneof": [
                        "replicate_message"
                      ]
                    }
                  },
                  "fields": {
                    "replicate_message": {
                      "type": "ReplicateMessage",
                      "id": 1
                    }
                  }
                },
                "ReplicateConfirmedMessageInfo": {
                  "fields": {
                    "confirmed_time_tick": {
                      "type": "uint64",
                      "id": 1
                    }
                  }
                },
                "ReplicateResponse": {
                  "oneofs": {
                    "response": {
                      "oneof": [
                        "replicate_confirmed_message_info"
                      ]
                    }
                  },
                  "fields": {
                    "replicate_confirmed_message_info": {
                      "type": "ReplicateConfirmedMessageInfo",
                      "id": 1
                    }
                  }
                },
                "DumpMessagesRequest": {
                  "fields": {
                    "pchannel": {
                      "type": "string",
                      "id": 1
                    },
                    "start_message_id": {
                      "type": "common.MessageID",
                      "id": 2
                    },
                    "start_timetick": {
                      "type": "uint64",
                      "id": 3
                    },
                    "end_timetick": {
                      "type": "uint64",
                      "id": 4
                    },
                    "include_start_message": {
                      "type": "bool",
                      "id": 5
                    }
                  }
                },
                "DumpMessagesResponse": {
                  "oneofs": {
                    "response": {
                      "oneof": [
                        "status",
                        "message"
                      ]
                    }
                  },
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "message": {
                      "type": "common.ImmutableMessage",
                      "id": 2
                    }
                  }
                },
                "TruncateCollectionRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeDropCollection",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "TruncateCollectionResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    }
                  }
                },
                "ComputePhraseMatchSlopRequest": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "analyzer_params": {
                      "type": "string",
                      "id": 2
                    },
                    "query_text": {
                      "type": "string",
                      "id": 3
                    },
                    "data_texts": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "ComputePhraseMatchSlopResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "is_match": {
                      "rule": "repeated",
                      "type": "bool",
                      "id": 2
                    },
                    "slops": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 3
                    }
                  }
                },
                "CreateSnapshotRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeCreateSnapshot",
                    "(common.privilege_ext_obj).object_name_index": 5
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "name": {
                      "type": "string",
                      "id": 2
                    },
                    "description": {
                      "type": "string",
                      "id": 3
                    },
                    "db_name": {
                      "type": "string",
                      "id": 4
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 5
                    },
                    "compaction_protection_seconds": {
                      "type": "int64",
                      "id": 6
                    }
                  }
                },
                "DropSnapshotRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeDropSnapshot",
                    "(common.privilege_ext_obj).object_name_index": 4
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "name": {
                      "type": "string",
                      "id": 2
                    },
                    "db_name": {
                      "type": "string",
                      "id": 3
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "ListSnapshotsRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeListSnapshots",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "ListSnapshotsResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "snapshots": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "DescribeSnapshotRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeDescribeSnapshot",
                    "(common.privilege_ext_obj).object_name_index": 4
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "name": {
                      "type": "string",
                      "id": 2
                    },
                    "db_name": {
                      "type": "string",
                      "id": 3
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "DescribeSnapshotResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "name": {
                      "type": "string",
                      "id": 2
                    },
                    "description": {
                      "type": "string",
                      "id": 3
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 4
                    },
                    "partition_names": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 5
                    },
                    "create_ts": {
                      "type": "int64",
                      "id": 6
                    },
                    "s3_location": {
                      "type": "string",
                      "id": 7
                    }
                  }
                },
                "RestoreSnapshotRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeRestoreSnapshot",
                    "(common.privilege_ext_obj).object_name_index": 4
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "name": {
                      "type": "string",
                      "id": 2
                    },
                    "db_name": {
                      "type": "string",
                      "id": 3
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 4
                    },
                    "rewrite_data": {
                      "type": "bool",
                      "id": 5
                    },
                    "target_db_name": {
                      "type": "string",
                      "id": 6
                    },
                    "target_collection_name": {
                      "type": "string",
                      "id": 7
                    }
                  }
                },
                "RestoreSnapshotResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "job_id": {
                      "type": "int64",
                      "id": 2
                    }
                  }
                },
                "RestoreExternalSnapshotRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeRestoreExternalSnapshot",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "target_collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "snapshot_metadata_uri": {
                      "type": "string",
                      "id": 4
                    },
                    "external_spec": {
                      "type": "string",
                      "id": 5
                    }
                  }
                },
                "RestoreExternalSnapshotResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "job_id": {
                      "type": "int64",
                      "id": 2
                    }
                  }
                },
                "ExportSnapshotRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeExportSnapshot",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "name": {
                      "type": "string",
                      "id": 2
                    },
                    "db_name": {
                      "type": "string",
                      "id": 3
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 4
                    },
                    "target_s3_path": {
                      "type": "string",
                      "id": 5
                    },
                    "external_spec": {
                      "type": "string",
                      "id": 6
                    }
                  }
                },
                "ExportSnapshotResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "snapshot_metadata_uri": {
                      "type": "string",
                      "id": 2,
                      "options": {
                        "deprecated": true
                      }
                    },
                    "job_id": {
                      "type": "int64",
                      "id": 3
                    }
                  }
                },
                "RestoreSnapshotState": {
                  "values": {
                    "RestoreSnapshotNone": 0,
                    "RestoreSnapshotPending": 1,
                    "RestoreSnapshotExecuting": 2,
                    "RestoreSnapshotCompleted": 3,
                    "RestoreSnapshotFailed": 4
                  }
                },
                "RestoreSnapshotInfo": {
                  "fields": {
                    "job_id": {
                      "type": "int64",
                      "id": 1
                    },
                    "snapshot_name": {
                      "type": "string",
                      "id": 2
                    },
                    "db_name": {
                      "type": "string",
                      "id": 3
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 4
                    },
                    "state": {
                      "type": "RestoreSnapshotState",
                      "id": 5
                    },
                    "progress": {
                      "type": "int32",
                      "id": 6
                    },
                    "reason": {
                      "type": "string",
                      "id": 7
                    },
                    "start_time": {
                      "type": "uint64",
                      "id": 8
                    },
                    "time_cost": {
                      "type": "uint64",
                      "id": 9
                    }
                  }
                },
                "GetRestoreSnapshotStateRequest": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "job_id": {
                      "type": "int64",
                      "id": 2
                    }
                  }
                },
                "GetRestoreSnapshotStateResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "info": {
                      "type": "RestoreSnapshotInfo",
                      "id": 2
                    }
                  }
                },
                "ListRestoreSnapshotJobsRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeRestoreSnapshot",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "ListRestoreSnapshotJobsResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "jobs": {
                      "rule": "repeated",
                      "type": "RestoreSnapshotInfo",
                      "id": 2
                    }
                  }
                },
                "PinSnapshotDataRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegePinSnapshotData",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "name": {
                      "type": "string",
                      "id": 2
                    },
                    "db_name": {
                      "type": "string",
                      "id": 3
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 4
                    },
                    "ttl_seconds": {
                      "type": "int64",
                      "id": 5
                    }
                  }
                },
                "PinSnapshotDataResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "pin_id": {
                      "type": "int64",
                      "id": 2
                    }
                  }
                },
                "UnpinSnapshotDataRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeUnpinSnapshotData",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "pin_id": {
                      "type": "int64",
                      "id": 2
                    }
                  }
                },
                "AlterCollectionSchemaRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeAlterCollectionSchema",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "collectionID": {
                      "type": "int64",
                      "id": 4
                    },
                    "action": {
                      "type": "Action",
                      "id": 5
                    }
                  },
                  "nested": {
                    "FieldInfo": {
                      "fields": {
                        "field_schema": {
                          "type": "schema.FieldSchema",
                          "id": 1
                        },
                        "index_name": {
                          "type": "string",
                          "id": 2
                        },
                        "extra_params": {
                          "rule": "repeated",
                          "type": "common.KeyValuePair",
                          "id": 3
                        }
                      }
                    },
                    "AddRequest": {
                      "fields": {
                        "field_infos": {
                          "rule": "repeated",
                          "type": "FieldInfo",
                          "id": 1
                        },
                        "func_schema": {
                          "rule": "repeated",
                          "type": "schema.FunctionSchema",
                          "id": 2
                        },
                        "do_physical_backfill": {
                          "type": "bool",
                          "id": 3
                        }
                      }
                    },
                    "DropRequest": {
                      "oneofs": {
                        "identifier": {
                          "oneof": [
                            "field_name",
                            "field_id",
                            "function_name"
                          ]
                        }
                      },
                      "fields": {
                        "field_name": {
                          "type": "string",
                          "id": 1
                        },
                        "field_id": {
                          "type": "int64",
                          "id": 2
                        },
                        "function_name": {
                          "type": "string",
                          "id": 3
                        },
                        "drop_function_output_fields": {
                          "type": "bool",
                          "id": 4
                        }
                      }
                    },
                    "Action": {
                      "oneofs": {
                        "op": {
                          "oneof": [
                            "add_request",
                            "drop_request"
                          ]
                        }
                      },
                      "fields": {
                        "add_request": {
                          "type": "AddRequest",
                          "id": 1
                        },
                        "drop_request": {
                          "type": "DropRequest",
                          "id": 2
                        }
                      }
                    }
                  }
                },
                "AlterCollectionSchemaResponse": {
                  "fields": {
                    "alter_status": {
                      "type": "common.Status",
                      "id": 1
                    }
                  }
                },
                "BatchUpdateManifestRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeInsert",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "field_names": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 4
                    },
                    "items": {
                      "rule": "repeated",
                      "type": "BatchUpdateManifestItem",
                      "id": 5
                    }
                  }
                },
                "BatchUpdateManifestItem": {
                  "fields": {
                    "segment_id": {
                      "type": "int64",
                      "id": 1
                    },
                    "manifest_version": {
                      "type": "int64",
                      "id": 2
                    }
                  }
                },
                "ClientHeartbeatRequest": {
                  "fields": {
                    "client_info": {
                      "type": "common.ClientInfo",
                      "id": 1
                    },
                    "report_timestamp": {
                      "type": "int64",
                      "id": 2
                    },
                    "metrics": {
                      "rule": "repeated",
                      "type": "common.OperationMetrics",
                      "id": 3
                    },
                    "command_replies": {
                      "rule": "repeated",
                      "type": "common.CommandReply",
                      "id": 4
                    },
                    "config_hash": {
                      "type": "string",
                      "id": 5
                    },
                    "last_command_timestamp": {
                      "type": "int64",
                      "id": 6
                    }
                  }
                },
                "ClientHeartbeatResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "server_timestamp": {
                      "type": "int64",
                      "id": 2
                    },
                    "commands": {
                      "rule": "repeated",
                      "type": "common.ClientCommand",
                      "id": 3
                    }
                  }
                },
                "GetClientTelemetryRequest": {
                  "fields": {
                    "database": {
                      "type": "string",
                      "id": 1
                    },
                    "client_id": {
                      "type": "string",
                      "id": 2
                    },
                    "include_metrics": {
                      "type": "bool",
                      "id": 3
                    }
                  }
                },
                "ClientTelemetry": {
                  "fields": {
                    "client_info": {
                      "type": "common.ClientInfo",
                      "id": 1
                    },
                    "last_heartbeat_time": {
                      "type": "int64",
                      "id": 2
                    },
                    "status": {
                      "type": "string",
                      "id": 3
                    },
                    "databases": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 4
                    },
                    "metrics": {
                      "rule": "repeated",
                      "type": "common.OperationMetrics",
                      "id": 5
                    }
                  }
                },
                "GetClientTelemetryResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "clients": {
                      "rule": "repeated",
                      "type": "ClientTelemetry",
                      "id": 2
                    },
                    "aggregated": {
                      "type": "common.Metrics",
                      "id": 3
                    }
                  }
                },
                "PushClientCommandRequest": {
                  "fields": {
                    "command_type": {
                      "type": "string",
                      "id": 1
                    },
                    "payload": {
                      "type": "bytes",
                      "id": 2
                    },
                    "target_client_id": {
                      "type": "string",
                      "id": 3
                    },
                    "target_database": {
                      "type": "string",
                      "id": 4
                    },
                    "ttl_seconds": {
                      "type": "int64",
                      "id": 5
                    },
                    "persistent": {
                      "type": "bool",
                      "id": 6
                    }
                  }
                },
                "PushClientCommandResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "command_id": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "DeleteClientCommandRequest": {
                  "fields": {
                    "command_id": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "DeleteClientCommandResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    }
                  }
                },
                "RefreshExternalCollectionState": {
                  "values": {
                    "RefreshPending": 0,
                    "RefreshInProgress": 1,
                    "RefreshCompleted": 2,
                    "RefreshFailed": 3
                  }
                },
                "RefreshExternalCollectionRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Collection",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeRefreshExternalCollection",
                    "(common.privilege_ext_obj).object_name_index": 3
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "external_source": {
                      "type": "string",
                      "id": 4
                    },
                    "external_spec": {
                      "type": "string",
                      "id": 5
                    }
                  }
                },
                "RefreshExternalCollectionResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "job_id": {
                      "type": "int64",
                      "id": 2
                    }
                  }
                },
                "GetRefreshExternalCollectionProgressRequest": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "job_id": {
                      "type": "int64",
                      "id": 2
                    }
                  }
                },
                "RefreshExternalCollectionJobInfo": {
                  "fields": {
                    "job_id": {
                      "type": "int64",
                      "id": 1
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 2
                    },
                    "state": {
                      "type": "RefreshExternalCollectionState",
                      "id": 3
                    },
                    "progress": {
                      "type": "int64",
                      "id": 4
                    },
                    "reason": {
                      "type": "string",
                      "id": 5
                    },
                    "external_source": {
                      "type": "string",
                      "id": 6
                    },
                    "start_time": {
                      "type": "int64",
                      "id": 7
                    },
                    "end_time": {
                      "type": "int64",
                      "id": 8
                    },
                    "external_spec": {
                      "type": "string",
                      "id": 9
                    }
                  }
                },
                "GetRefreshExternalCollectionProgressResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "job_info": {
                      "type": "RefreshExternalCollectionJobInfo",
                      "id": 2
                    }
                  }
                },
                "ListRefreshExternalCollectionJobsRequest": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "ListRefreshExternalCollectionJobsResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "jobs": {
                      "rule": "repeated",
                      "type": "RefreshExternalCollectionJobInfo",
                      "id": 2
                    }
                  }
                },
                "ExportSnapshotState": {
                  "values": {
                    "ExportSnapshotNone": 0,
                    "ExportSnapshotPending": 1,
                    "ExportSnapshotExecuting": 2,
                    "ExportSnapshotCompleted": 3,
                    "ExportSnapshotFailed": 4
                  }
                },
                "ExportSnapshotInfo": {
                  "fields": {
                    "job_id": {
                      "type": "int64",
                      "id": 1
                    },
                    "snapshot_name": {
                      "type": "string",
                      "id": 2
                    },
                    "db_name": {
                      "type": "string",
                      "id": 3
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 4
                    },
                    "state": {
                      "type": "ExportSnapshotState",
                      "id": 5
                    },
                    "progress": {
                      "type": "int32",
                      "id": 6
                    },
                    "reason": {
                      "type": "string",
                      "id": 7
                    },
                    "start_time": {
                      "type": "uint64",
                      "id": 8
                    },
                    "time_cost": {
                      "type": "uint64",
                      "id": 9
                    },
                    "total_files": {
                      "type": "int64",
                      "id": 10
                    },
                    "copied_files": {
                      "type": "int64",
                      "id": 11
                    },
                    "snapshot_metadata_uri": {
                      "type": "string",
                      "id": 12
                    },
                    "total_bytes": {
                      "type": "int64",
                      "id": 13
                    }
                  }
                },
                "GetExportSnapshotStateRequest": {
                  "options": {
                    "(common.privilege_ext_obj).object_type": "Global",
                    "(common.privilege_ext_obj).object_privilege": "PrivilegeExportSnapshot",
                    "(common.privilege_ext_obj).object_name_index": -1
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "job_id": {
                      "type": "int64",
                      "id": 2
                    }
                  }
                },
                "GetExportSnapshotStateResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "info": {
                      "type": "ExportSnapshotInfo",
                      "id": 2
                    }
                  }
                }
              }
            },
            "common": {
              "options": {
                "go_package": "github.com/milvus-io/milvus-proto/go-api/v3/commonpb",
                "java_multiple_files": true,
                "java_package": "io.milvus.grpc",
                "java_outer_classname": "CommonProto",
                "java_generate_equals_and_hash": true,
                "csharp_namespace": "Milvus.Client.Grpc"
              },
              "nested": {
                "ErrorCode": {
                  "options": {
                    "deprecated": true
                  },
                  "values": {
                    "Success": 0,
                    "UnexpectedError": 1,
                    "ConnectFailed": 2,
                    "PermissionDenied": 3,
                    "CollectionNotExists": 4,
                    "IllegalArgument": 5,
                    "IllegalDimension": 7,
                    "IllegalIndexType": 8,
                    "IllegalCollectionName": 9,
                    "IllegalTOPK": 10,
                    "IllegalRowRecord": 11,
                    "IllegalVectorID": 12,
                    "IllegalSearchResult": 13,
                    "FileNotFound": 14,
                    "MetaFailed": 15,
                    "CacheFailed": 16,
                    "CannotCreateFolder": 17,
                    "CannotCreateFile": 18,
                    "CannotDeleteFolder": 19,
                    "CannotDeleteFile": 20,
                    "BuildIndexError": 21,
                    "IllegalNLIST": 22,
                    "IllegalMetricType": 23,
                    "OutOfMemory": 24,
                    "IndexNotExist": 25,
                    "EmptyCollection": 26,
                    "UpdateImportTaskFailure": 27,
                    "CollectionNameNotFound": 28,
                    "CreateCredentialFailure": 29,
                    "UpdateCredentialFailure": 30,
                    "DeleteCredentialFailure": 31,
                    "GetCredentialFailure": 32,
                    "ListCredUsersFailure": 33,
                    "GetUserFailure": 34,
                    "CreateRoleFailure": 35,
                    "DropRoleFailure": 36,
                    "OperateUserRoleFailure": 37,
                    "SelectRoleFailure": 38,
                    "SelectUserFailure": 39,
                    "SelectResourceFailure": 40,
                    "OperatePrivilegeFailure": 41,
                    "SelectGrantFailure": 42,
                    "RefreshPolicyInfoCacheFailure": 43,
                    "ListPolicyFailure": 44,
                    "NotShardLeader": 45,
                    "NoReplicaAvailable": 46,
                    "SegmentNotFound": 47,
                    "ForceDeny": 48,
                    "RateLimit": 49,
                    "NodeIDNotMatch": 50,
                    "UpsertAutoIDTrue": 51,
                    "InsufficientMemoryToLoad": 52,
                    "MemoryQuotaExhausted": 53,
                    "DiskQuotaExhausted": 54,
                    "TimeTickLongDelay": 55,
                    "NotReadyServe": 56,
                    "NotReadyCoordActivating": 57,
                    "CreatePrivilegeGroupFailure": 58,
                    "DropPrivilegeGroupFailure": 59,
                    "ListPrivilegeGroupsFailure": 60,
                    "OperatePrivilegeGroupFailure": 61,
                    "SchemaMismatch": 62,
                    "DataCoordNA": 100,
                    "DDRequestRace": 1000
                  }
                },
                "IndexState": {
                  "values": {
                    "IndexStateNone": 0,
                    "Unissued": 1,
                    "InProgress": 2,
                    "Finished": 3,
                    "Failed": 4,
                    "Retry": 5
                  }
                },
                "SegmentState": {
                  "values": {
                    "SegmentStateNone": 0,
                    "NotExist": 1,
                    "Growing": 2,
                    "Sealed": 3,
                    "Flushed": 4,
                    "Flushing": 5,
                    "Dropped": 6,
                    "Importing": 7
                  }
                },
                "SegmentLevel": {
                  "values": {
                    "Legacy": 0,
                    "L0": 1,
                    "L1": 2,
                    "L2": 3
                  }
                },
                "Status": {
                  "fields": {
                    "error_code": {
                      "type": "ErrorCode",
                      "id": 1,
                      "options": {
                        "deprecated": true
                      }
                    },
                    "reason": {
                      "type": "string",
                      "id": 2
                    },
                    "code": {
                      "type": "int32",
                      "id": 3
                    },
                    "retriable": {
                      "type": "bool",
                      "id": 4
                    },
                    "detail": {
                      "type": "string",
                      "id": 5
                    },
                    "extra_info": {
                      "keyType": "string",
                      "type": "string",
                      "id": 6
                    }
                  }
                },
                "KeyValuePair": {
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
                "KeyDataPair": {
                  "fields": {
                    "key": {
                      "type": "string",
                      "id": 1
                    },
                    "data": {
                      "type": "bytes",
                      "id": 2
                    }
                  }
                },
                "Blob": {
                  "fields": {
                    "value": {
                      "type": "bytes",
                      "id": 1
                    }
                  }
                },
                "PlaceholderType": {
                  "values": {
                    "None": 0,
                    "BinaryVector": 100,
                    "FloatVector": 101,
                    "Float16Vector": 102,
                    "BFloat16Vector": 103,
                    "SparseFloatVector": 104,
                    "Int8Vector": 105,
                    "Int64": 5,
                    "VarChar": 21,
                    "EmbListBinaryVector": 300,
                    "EmbListFloatVector": 301,
                    "EmbListFloat16Vector": 302,
                    "EmbListBFloat16Vector": 303,
                    "EmbListSparseFloatVector": 304,
                    "EmbListInt8Vector": 305
                  }
                },
                "PlaceholderValue": {
                  "fields": {
                    "tag": {
                      "type": "string",
                      "id": 1
                    },
                    "type": {
                      "type": "PlaceholderType",
                      "id": 2
                    },
                    "values": {
                      "rule": "repeated",
                      "type": "bytes",
                      "id": 3
                    },
                    "element_level": {
                      "type": "bool",
                      "id": 4
                    }
                  }
                },
                "PlaceholderGroup": {
                  "fields": {
                    "placeholders": {
                      "rule": "repeated",
                      "type": "PlaceholderValue",
                      "id": 1
                    }
                  }
                },
                "Address": {
                  "fields": {
                    "ip": {
                      "type": "string",
                      "id": 1
                    },
                    "port": {
                      "type": "int64",
                      "id": 2
                    }
                  }
                },
                "MsgType": {
                  "valuesOptions": {
                    "Replicate": {
                      "deprecated": true
                    }
                  },
                  "values": {
                    "Undefined": 0,
                    "CreateCollection": 100,
                    "DropCollection": 101,
                    "HasCollection": 102,
                    "DescribeCollection": 103,
                    "ShowCollections": 104,
                    "GetSystemConfigs": 105,
                    "LoadCollection": 106,
                    "ReleaseCollection": 107,
                    "CreateAlias": 108,
                    "DropAlias": 109,
                    "AlterAlias": 110,
                    "AlterCollection": 111,
                    "RenameCollection": 112,
                    "DescribeAlias": 113,
                    "ListAliases": 114,
                    "AlterCollectionField": 115,
                    "AddCollectionFunction": 116,
                    "AlterCollectionFunction": 117,
                    "DropCollectionFunction": 118,
                    "TruncateCollection": 119,
                    "CreatePartition": 200,
                    "DropPartition": 201,
                    "HasPartition": 202,
                    "DescribePartition": 203,
                    "ShowPartitions": 204,
                    "LoadPartitions": 205,
                    "ReleasePartitions": 206,
                    "ShowSegments": 250,
                    "DescribeSegment": 251,
                    "LoadSegments": 252,
                    "ReleaseSegments": 253,
                    "HandoffSegments": 254,
                    "LoadBalanceSegments": 255,
                    "DescribeSegments": 256,
                    "FederListIndexedSegment": 257,
                    "FederDescribeSegmentIndexData": 258,
                    "CreateIndex": 300,
                    "DescribeIndex": 301,
                    "DropIndex": 302,
                    "GetIndexStatistics": 303,
                    "AlterIndex": 304,
                    "Insert": 400,
                    "Delete": 401,
                    "Flush": 402,
                    "ResendSegmentStats": 403,
                    "Upsert": 404,
                    "ManualFlush": 405,
                    "FlushSegment": 406,
                    "CreateSegment": 407,
                    "Import": 408,
                    "FlushAll": 409,
                    "Search": 500,
                    "SearchResult": 501,
                    "GetIndexState": 502,
                    "GetIndexBuildProgress": 503,
                    "GetCollectionStatistics": 504,
                    "GetPartitionStatistics": 505,
                    "Retrieve": 506,
                    "RetrieveResult": 507,
                    "WatchDmChannels": 508,
                    "RemoveDmChannels": 509,
                    "WatchQueryChannels": 510,
                    "RemoveQueryChannels": 511,
                    "SealedSegmentsChangeInfo": 512,
                    "WatchDeltaChannels": 513,
                    "GetShardLeaders": 514,
                    "GetReplicas": 515,
                    "UnsubDmChannel": 516,
                    "GetDistribution": 517,
                    "SyncDistribution": 518,
                    "RunAnalyzer": 519,
                    "SegmentInfo": 600,
                    "SystemInfo": 601,
                    "GetRecoveryInfo": 602,
                    "GetSegmentState": 603,
                    "TimeTick": 1200,
                    "QueryNodeStats": 1201,
                    "LoadIndex": 1202,
                    "RequestID": 1203,
                    "RequestTSO": 1204,
                    "AllocateSegment": 1205,
                    "SegmentStatistics": 1206,
                    "SegmentFlushDone": 1207,
                    "DataNodeTt": 1208,
                    "Connect": 1209,
                    "ListClientInfos": 1210,
                    "AllocTimestamp": 1211,
                    "Replicate": 1212,
                    "CreateCredential": 1500,
                    "GetCredential": 1501,
                    "DeleteCredential": 1502,
                    "UpdateCredential": 1503,
                    "ListCredUsernames": 1504,
                    "CreateRole": 1600,
                    "DropRole": 1601,
                    "OperateUserRole": 1602,
                    "SelectRole": 1603,
                    "SelectUser": 1604,
                    "SelectResource": 1605,
                    "OperatePrivilege": 1606,
                    "SelectGrant": 1607,
                    "RefreshPolicyInfoCache": 1608,
                    "ListPolicy": 1609,
                    "CreatePrivilegeGroup": 1610,
                    "DropPrivilegeGroup": 1611,
                    "ListPrivilegeGroups": 1612,
                    "OperatePrivilegeGroup": 1613,
                    "OperatePrivilegeV2": 1614,
                    "AlterRole": 1615,
                    "CreateResourceGroup": 1700,
                    "DropResourceGroup": 1701,
                    "ListResourceGroups": 1702,
                    "DescribeResourceGroup": 1703,
                    "TransferNode": 1704,
                    "TransferReplica": 1705,
                    "UpdateResourceGroups": 1706,
                    "CreateDatabase": 1801,
                    "DropDatabase": 1802,
                    "ListDatabases": 1803,
                    "AlterDatabase": 1804,
                    "DescribeDatabase": 1805,
                    "AddCollectionField": 1900,
                    "AlterWAL": 2000,
                    "CreateSnapshot": 2100,
                    "DropSnapshot": 2101,
                    "ListSnapshots": 2102,
                    "DescribeSnapshot": 2103,
                    "RestoreSnapshot": 2104,
                    "GetRestoreSnapshotState": 2105,
                    "ListRestoreSnapshotJobs": 2106,
                    "PinSnapshotData": 2107,
                    "UnpinSnapshotData": 2108,
                    "RestoreExternalSnapshot": 2109,
                    "ExportSnapshot": 2110,
                    "AlterCollectionSchema": 2200,
                    "RefreshExternalCollection": 2300,
                    "GetRefreshExternalCollectionProgress": 2301,
                    "ListRefreshExternalCollectionJobs": 2302,
                    "GetExportSnapshotState": 2111
                  }
                },
                "MsgBase": {
                  "fields": {
                    "msg_type": {
                      "type": "MsgType",
                      "id": 1
                    },
                    "msgID": {
                      "type": "int64",
                      "id": 2
                    },
                    "timestamp": {
                      "type": "uint64",
                      "id": 3
                    },
                    "sourceID": {
                      "type": "int64",
                      "id": 4
                    },
                    "targetID": {
                      "type": "int64",
                      "id": 5
                    },
                    "properties": {
                      "keyType": "string",
                      "type": "string",
                      "id": 6
                    },
                    "replicateInfo": {
                      "type": "ReplicateInfo",
                      "id": 7,
                      "options": {
                        "deprecated": true
                      }
                    }
                  }
                },
                "ReplicateInfo": {
                  "options": {
                    "deprecated": true
                  },
                  "fields": {
                    "isReplicate": {
                      "type": "bool",
                      "id": 1
                    },
                    "msgTimestamp": {
                      "type": "uint64",
                      "id": 2
                    },
                    "replicateID": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "DslType": {
                  "values": {
                    "Dsl": 0,
                    "BoolExprV1": 1
                  }
                },
                "MsgHeader": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    }
                  }
                },
                "DMLMsgHeader": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "shardName": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "CompactionState": {
                  "values": {
                    "UndefiedState": 0,
                    "Executing": 1,
                    "Completed": 2
                  }
                },
                "CompactionTaskState": {
                  "values": {
                    "CompactionTaskStateUnknown": 0,
                    "CompactionTaskStateExecuting": 1,
                    "CompactionTaskStatePipelining": 2,
                    "CompactionTaskStateCompleted": 3,
                    "CompactionTaskStateFailed": 4,
                    "CompactionTaskStateTimeout": 5,
                    "CompactionTaskStateAnalyzing": 6,
                    "CompactionTaskStateIndexing": 7,
                    "CompactionTaskStateCleaned": 8,
                    "CompactionTaskStateMetaSaved": 9,
                    "CompactionTaskStateStatistic": 10
                  }
                },
                "CompactionType": {
                  "values": {
                    "CompactionTypeUndefined": 0,
                    "CompactionTypeMerge": 2,
                    "CompactionTypeMix": 3,
                    "CompactionTypeSingle": 4,
                    "CompactionTypeMinor": 5,
                    "CompactionTypeMajor": 6,
                    "CompactionTypeLevel0Delete": 7,
                    "CompactionTypeClustering": 8,
                    "CompactionTypeSort": 9,
                    "CompactionTypePartitionKeySort": 10,
                    "CompactionTypeClusteringPartitionKeySort": 11,
                    "CompactionTypeBumpSchemaVersion": 12
                  },
                  "reserved": [
                    [
                      1,
                      1
                    ]
                  ]
                },
                "ConsistencyLevel": {
                  "values": {
                    "Strong": 0,
                    "Session": 1,
                    "Bounded": 2,
                    "Eventually": 3,
                    "Customized": 4
                  }
                },
                "ImportState": {
                  "values": {
                    "ImportPending": 0,
                    "ImportFailed": 1,
                    "ImportStarted": 2,
                    "ImportPersisted": 5,
                    "ImportFlushed": 8,
                    "ImportCompleted": 6,
                    "ImportFailedAndCleaned": 7
                  }
                },
                "ObjectType": {
                  "values": {
                    "Collection": 0,
                    "Global": 1,
                    "User": 2
                  }
                },
                "ObjectPrivilege": {
                  "values": {
                    "PrivilegeAll": 0,
                    "PrivilegeCreateCollection": 1,
                    "PrivilegeDropCollection": 2,
                    "PrivilegeDescribeCollection": 3,
                    "PrivilegeShowCollections": 4,
                    "PrivilegeLoad": 5,
                    "PrivilegeRelease": 6,
                    "PrivilegeCompaction": 7,
                    "PrivilegeInsert": 8,
                    "PrivilegeDelete": 9,
                    "PrivilegeGetStatistics": 10,
                    "PrivilegeCreateIndex": 11,
                    "PrivilegeIndexDetail": 12,
                    "PrivilegeDropIndex": 13,
                    "PrivilegeSearch": 14,
                    "PrivilegeFlush": 15,
                    "PrivilegeQuery": 16,
                    "PrivilegeLoadBalance": 17,
                    "PrivilegeImport": 18,
                    "PrivilegeCreateOwnership": 19,
                    "PrivilegeUpdateUser": 20,
                    "PrivilegeDropOwnership": 21,
                    "PrivilegeSelectOwnership": 22,
                    "PrivilegeManageOwnership": 23,
                    "PrivilegeSelectUser": 24,
                    "PrivilegeUpsert": 25,
                    "PrivilegeCreateResourceGroup": 26,
                    "PrivilegeDropResourceGroup": 27,
                    "PrivilegeDescribeResourceGroup": 28,
                    "PrivilegeListResourceGroups": 29,
                    "PrivilegeTransferNode": 30,
                    "PrivilegeTransferReplica": 31,
                    "PrivilegeGetLoadingProgress": 32,
                    "PrivilegeGetLoadState": 33,
                    "PrivilegeRenameCollection": 34,
                    "PrivilegeCreateDatabase": 35,
                    "PrivilegeDropDatabase": 36,
                    "PrivilegeListDatabases": 37,
                    "PrivilegeFlushAll": 38,
                    "PrivilegeCreatePartition": 39,
                    "PrivilegeDropPartition": 40,
                    "PrivilegeShowPartitions": 41,
                    "PrivilegeHasPartition": 42,
                    "PrivilegeGetFlushState": 43,
                    "PrivilegeCreateAlias": 44,
                    "PrivilegeDropAlias": 45,
                    "PrivilegeDescribeAlias": 46,
                    "PrivilegeListAliases": 47,
                    "PrivilegeUpdateResourceGroups": 48,
                    "PrivilegeAlterDatabase": 49,
                    "PrivilegeDescribeDatabase": 50,
                    "PrivilegeBackupRBAC": 51,
                    "PrivilegeRestoreRBAC": 52,
                    "PrivilegeGroupReadOnly": 53,
                    "PrivilegeGroupReadWrite": 54,
                    "PrivilegeGroupAdmin": 55,
                    "PrivilegeCreatePrivilegeGroup": 56,
                    "PrivilegeDropPrivilegeGroup": 57,
                    "PrivilegeListPrivilegeGroups": 58,
                    "PrivilegeOperatePrivilegeGroup": 59,
                    "PrivilegeGroupClusterReadOnly": 60,
                    "PrivilegeGroupClusterReadWrite": 61,
                    "PrivilegeGroupClusterAdmin": 62,
                    "PrivilegeGroupDatabaseReadOnly": 63,
                    "PrivilegeGroupDatabaseReadWrite": 64,
                    "PrivilegeGroupDatabaseAdmin": 65,
                    "PrivilegeGroupCollectionReadOnly": 66,
                    "PrivilegeGroupCollectionReadWrite": 67,
                    "PrivilegeGroupCollectionAdmin": 68,
                    "PrivilegeGetImportProgress": 69,
                    "PrivilegeListImport": 70,
                    "PrivilegeAddCollectionField": 71,
                    "PrivilegeAddFileResource": 72,
                    "PrivilegeRemoveFileResource": 73,
                    "PrivilegeListFileResources": 74,
                    "PrivilegeUpdateReplicateConfiguration": 78,
                    "PrivilegeCreateSnapshot": 79,
                    "PrivilegeDropSnapshot": 80,
                    "PrivilegeDescribeSnapshot": 81,
                    "PrivilegeListSnapshots": 82,
                    "PrivilegeRestoreSnapshot": 83,
                    "PrivilegeAlterCollectionSchema": 84,
                    "PrivilegeGetReplicateConfiguration": 85,
                    "PrivilegeRefreshExternalCollection": 86,
                    "PrivilegePinSnapshotData": 87,
                    "PrivilegeUnpinSnapshotData": 88,
                    "PrivilegeRestoreExternalSnapshot": 89,
                    "PrivilegeExportSnapshot": 90
                  }
                },
                "PrivilegeExt": {
                  "fields": {
                    "object_type": {
                      "type": "ObjectType",
                      "id": 1
                    },
                    "object_privilege": {
                      "type": "ObjectPrivilege",
                      "id": 2
                    },
                    "object_name_index": {
                      "type": "int32",
                      "id": 3
                    },
                    "object_name_indexs": {
                      "type": "int32",
                      "id": 4
                    }
                  }
                },
                "privilege_ext_obj": {
                  "type": "PrivilegeExt",
                  "id": 1001,
                  "extend": "google.protobuf.MessageOptions"
                },
                "StateCode": {
                  "values": {
                    "Initializing": 0,
                    "Healthy": 1,
                    "Abnormal": 2,
                    "StandBy": 3,
                    "Stopping": 4
                  }
                },
                "LoadState": {
                  "values": {
                    "LoadStateNotExist": 0,
                    "LoadStateNotLoad": 1,
                    "LoadStateLoading": 2,
                    "LoadStateLoaded": 3
                  }
                },
                "SegmentStats": {
                  "fields": {
                    "SegmentID": {
                      "type": "int64",
                      "id": 1
                    },
                    "NumRows": {
                      "type": "int64",
                      "id": 2
                    }
                  }
                },
                "ClientInfo": {
                  "fields": {
                    "sdk_type": {
                      "type": "string",
                      "id": 1
                    },
                    "sdk_version": {
                      "type": "string",
                      "id": 2
                    },
                    "local_time": {
                      "type": "string",
                      "id": 3
                    },
                    "user": {
                      "type": "string",
                      "id": 4
                    },
                    "host": {
                      "type": "string",
                      "id": 5
                    },
                    "reserved": {
                      "keyType": "string",
                      "type": "string",
                      "id": 6
                    }
                  }
                },
                "Metrics": {
                  "fields": {
                    "request_count": {
                      "type": "int64",
                      "id": 1
                    },
                    "success_count": {
                      "type": "int64",
                      "id": 2
                    },
                    "error_count": {
                      "type": "int64",
                      "id": 3
                    },
                    "avg_latency_ms": {
                      "type": "double",
                      "id": 4
                    },
                    "p99_latency_ms": {
                      "type": "double",
                      "id": 5
                    },
                    "max_latency_ms": {
                      "type": "double",
                      "id": 6
                    }
                  }
                },
                "OperationMetrics": {
                  "fields": {
                    "operation": {
                      "type": "string",
                      "id": 1
                    },
                    "global": {
                      "type": "Metrics",
                      "id": 2
                    },
                    "collection_metrics": {
                      "keyType": "string",
                      "type": "Metrics",
                      "id": 3
                    }
                  }
                },
                "ClientCommand": {
                  "fields": {
                    "command_id": {
                      "type": "string",
                      "id": 1
                    },
                    "command_type": {
                      "type": "string",
                      "id": 2
                    },
                    "payload": {
                      "type": "bytes",
                      "id": 3
                    },
                    "create_time": {
                      "type": "int64",
                      "id": 4
                    },
                    "persistent": {
                      "type": "bool",
                      "id": 5
                    },
                    "target_scope": {
                      "type": "string",
                      "id": 6
                    }
                  }
                },
                "CommandReply": {
                  "fields": {
                    "command_id": {
                      "type": "string",
                      "id": 1
                    },
                    "success": {
                      "type": "bool",
                      "id": 2
                    },
                    "error_message": {
                      "type": "string",
                      "id": 3
                    },
                    "payload": {
                      "type": "bytes",
                      "id": 4
                    }
                  }
                },
                "ServerInfo": {
                  "fields": {
                    "build_tags": {
                      "type": "string",
                      "id": 1
                    },
                    "build_time": {
                      "type": "string",
                      "id": 2
                    },
                    "git_commit": {
                      "type": "string",
                      "id": 3
                    },
                    "go_version": {
                      "type": "string",
                      "id": 4
                    },
                    "deploy_mode": {
                      "type": "string",
                      "id": 5
                    },
                    "reserved": {
                      "keyType": "string",
                      "type": "string",
                      "id": 6
                    }
                  }
                },
                "NodeInfo": {
                  "fields": {
                    "node_id": {
                      "type": "int64",
                      "id": 1
                    },
                    "address": {
                      "type": "string",
                      "id": 2
                    },
                    "hostname": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "LoadPriority": {
                  "values": {
                    "HIGH": 0,
                    "LOW": 1
                  }
                },
                "WALName": {
                  "values": {
                    "Unknown": 0,
                    "RocksMQ": 1,
                    "Pulsar": 2,
                    "Kafka": 3,
                    "WoodPecker": 4,
                    "Test": 999
                  }
                },
                "ReplicateConfiguration": {
                  "fields": {
                    "clusters": {
                      "rule": "repeated",
                      "type": "MilvusCluster",
                      "id": 1
                    },
                    "cross_cluster_topology": {
                      "rule": "repeated",
                      "type": "CrossClusterTopology",
                      "id": 2
                    }
                  }
                },
                "ConnectionParam": {
                  "fields": {
                    "uri": {
                      "type": "string",
                      "id": 1
                    },
                    "token": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "MilvusCluster": {
                  "fields": {
                    "cluster_id": {
                      "type": "string",
                      "id": 1
                    },
                    "connection_param": {
                      "type": "ConnectionParam",
                      "id": 2
                    },
                    "pchannels": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "CrossClusterTopology": {
                  "fields": {
                    "source_cluster_id": {
                      "type": "string",
                      "id": 1
                    },
                    "target_cluster_id": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "MessageID": {
                  "fields": {
                    "id": {
                      "type": "string",
                      "id": 1
                    },
                    "WAL_name": {
                      "type": "common.WALName",
                      "id": 2
                    }
                  }
                },
                "ImmutableMessage": {
                  "fields": {
                    "id": {
                      "type": "MessageID",
                      "id": 1
                    },
                    "payload": {
                      "type": "bytes",
                      "id": 2
                    },
                    "properties": {
                      "keyType": "string",
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "ReplicateCheckpoint": {
                  "fields": {
                    "cluster_id": {
                      "type": "string",
                      "id": 1
                    },
                    "pchannel": {
                      "type": "string",
                      "id": 2
                    },
                    "message_id": {
                      "type": "common.MessageID",
                      "id": 3
                    },
                    "time_tick": {
                      "type": "uint64",
                      "id": 4
                    }
                  }
                },
                "HighlightData": {
                  "fields": {
                    "fragments": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 1
                    },
                    "scores": {
                      "rule": "repeated",
                      "type": "float",
                      "id": 2
                    }
                  }
                },
                "HighlightResult": {
                  "fields": {
                    "field_name": {
                      "type": "string",
                      "id": 1
                    },
                    "datas": {
                      "rule": "repeated",
                      "type": "HighlightData",
                      "id": 2
                    }
                  }
                },
                "HighlightType": {
                  "values": {
                    "Lexical": 0,
                    "Semantic": 1
                  }
                },
                "Highlighter": {
                  "fields": {
                    "type": {
                      "type": "HighlightType",
                      "id": 1
                    },
                    "params": {
                      "rule": "repeated",
                      "type": "KeyValuePair",
                      "id": 2
                    }
                  }
                },
                "MetricAggSpec": {
                  "fields": {
                    "op": {
                      "type": "string",
                      "id": 1
                    },
                    "field_name": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "SortSpec": {
                  "fields": {
                    "field_name": {
                      "type": "string",
                      "id": 1
                    },
                    "direction": {
                      "type": "string",
                      "id": 2
                    },
                    "null_first": {
                      "type": "bool",
                      "id": 3
                    }
                  }
                },
                "TopHitsSpec": {
                  "fields": {
                    "size": {
                      "type": "int64",
                      "id": 1
                    },
                    "sort": {
                      "rule": "repeated",
                      "type": "SortSpec",
                      "id": 2
                    }
                  }
                },
                "OrderSpec": {
                  "fields": {
                    "key": {
                      "type": "string",
                      "id": 1
                    },
                    "direction": {
                      "type": "string",
                      "id": 2
                    },
                    "null_first": {
                      "type": "bool",
                      "id": 3
                    }
                  }
                },
                "SearchAggregationSpec": {
                  "fields": {
                    "fields": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 1
                    },
                    "size": {
                      "type": "int64",
                      "id": 2
                    },
                    "metrics": {
                      "keyType": "string",
                      "type": "MetricAggSpec",
                      "id": 3
                    },
                    "order": {
                      "rule": "repeated",
                      "type": "OrderSpec",
                      "id": 4
                    },
                    "top_hits": {
                      "type": "TopHitsSpec",
                      "id": 5
                    },
                    "sub_aggregation": {
                      "type": "SearchAggregationSpec",
                      "id": 6
                    },
                    "search_size": {
                      "type": "int64",
                      "id": 7
                    }
                  }
                },
                "IDRange": {
                  "fields": {
                    "begin": {
                      "type": "int64",
                      "id": 1
                    },
                    "end": {
                      "type": "int64",
                      "id": 2
                    }
                  }
                }
              }
            },
            "rg": {
              "options": {
                "go_package": "github.com/milvus-io/milvus-proto/go-api/v3/rgpb",
                "java_multiple_files": true,
                "java_package": "io.milvus.grpc",
                "java_outer_classname": "ResourceGroupProto",
                "java_generate_equals_and_hash": true,
                "csharp_namespace": "Milvus.Client.Grpc"
              },
              "nested": {
                "ResourceGroupLimit": {
                  "fields": {
                    "node_num": {
                      "type": "int32",
                      "id": 1
                    }
                  }
                },
                "ResourceGroupTransfer": {
                  "fields": {
                    "resource_group": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "ResourceGroupNodeFilter": {
                  "fields": {
                    "node_labels": {
                      "rule": "repeated",
                      "type": "common.KeyValuePair",
                      "id": 1
                    }
                  }
                },
                "ResourceGroupConfig": {
                  "fields": {
                    "requests": {
                      "type": "ResourceGroupLimit",
                      "id": 1
                    },
                    "limits": {
                      "type": "ResourceGroupLimit",
                      "id": 2
                    },
                    "transfer_from": {
                      "rule": "repeated",
                      "type": "ResourceGroupTransfer",
                      "id": 3
                    },
                    "transfer_to": {
                      "rule": "repeated",
                      "type": "ResourceGroupTransfer",
                      "id": 4
                    },
                    "node_filter": {
                      "type": "ResourceGroupNodeFilter",
                      "id": 5
                    }
                  }
                }
              }
            },
            "schema": {
              "options": {
                "go_package": "github.com/milvus-io/milvus-proto/go-api/v3/schemapb",
                "java_multiple_files": true,
                "java_package": "io.milvus.grpc",
                "java_outer_classname": "SchemaProto",
                "java_generate_equals_and_hash": true,
                "csharp_namespace": "Milvus.Client.Grpc"
              },
              "nested": {
                "DataType": {
                  "values": {
                    "None": 0,
                    "Bool": 1,
                    "Int8": 2,
                    "Int16": 3,
                    "Int32": 4,
                    "Int64": 5,
                    "Float": 10,
                    "Double": 11,
                    "String": 20,
                    "VarChar": 21,
                    "Array": 22,
                    "JSON": 23,
                    "Geometry": 24,
                    "Text": 25,
                    "Timestamptz": 26,
                    "Mol": 27,
                    "Date": 28,
                    "Time": 29,
                    "Decimal": 30,
                    "BinaryVector": 100,
                    "FloatVector": 101,
                    "Float16Vector": 102,
                    "BFloat16Vector": 103,
                    "SparseFloatVector": 104,
                    "Int8Vector": 105,
                    "ArrayOfVector": 106,
                    "ArrayOfStruct": 200,
                    "Struct": 201
                  }
                },
                "FunctionType": {
                  "values": {
                    "Unknown": 0,
                    "BM25": 1,
                    "TextEmbedding": 2,
                    "Rerank": 3,
                    "MinHash": 4,
                    "MolFingerprint": 5
                  }
                },
                "FieldState": {
                  "values": {
                    "FieldCreated": 0,
                    "FieldCreating": 1,
                    "FieldDropping": 2,
                    "FieldDropped": 3
                  }
                },
                "FieldSchema": {
                  "fields": {
                    "fieldID": {
                      "type": "int64",
                      "id": 1
                    },
                    "name": {
                      "type": "string",
                      "id": 2
                    },
                    "is_primary_key": {
                      "type": "bool",
                      "id": 3
                    },
                    "description": {
                      "type": "string",
                      "id": 4
                    },
                    "data_type": {
                      "type": "DataType",
                      "id": 5
                    },
                    "type_params": {
                      "rule": "repeated",
                      "type": "common.KeyValuePair",
                      "id": 6
                    },
                    "index_params": {
                      "rule": "repeated",
                      "type": "common.KeyValuePair",
                      "id": 7
                    },
                    "autoID": {
                      "type": "bool",
                      "id": 8
                    },
                    "state": {
                      "type": "FieldState",
                      "id": 9
                    },
                    "element_type": {
                      "type": "DataType",
                      "id": 10
                    },
                    "default_value": {
                      "type": "ValueField",
                      "id": 11
                    },
                    "is_dynamic": {
                      "type": "bool",
                      "id": 12
                    },
                    "is_partition_key": {
                      "type": "bool",
                      "id": 13
                    },
                    "is_clustering_key": {
                      "type": "bool",
                      "id": 14
                    },
                    "nullable": {
                      "type": "bool",
                      "id": 15
                    },
                    "is_function_output": {
                      "type": "bool",
                      "id": 16
                    },
                    "external_field": {
                      "type": "string",
                      "id": 17
                    }
                  }
                },
                "FunctionSchema": {
                  "fields": {
                    "name": {
                      "type": "string",
                      "id": 1
                    },
                    "id": {
                      "type": "int64",
                      "id": 2
                    },
                    "description": {
                      "type": "string",
                      "id": 3
                    },
                    "type": {
                      "type": "FunctionType",
                      "id": 4
                    },
                    "input_field_names": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 5
                    },
                    "input_field_ids": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 6
                    },
                    "output_field_names": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 7
                    },
                    "output_field_ids": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 8
                    },
                    "params": {
                      "rule": "repeated",
                      "type": "common.KeyValuePair",
                      "id": 9
                    }
                  }
                },
                "FunctionScore": {
                  "fields": {
                    "functions": {
                      "rule": "repeated",
                      "type": "FunctionSchema",
                      "id": 1
                    },
                    "params": {
                      "rule": "repeated",
                      "type": "common.KeyValuePair",
                      "id": 2
                    }
                  }
                },
                "FunctionChainStage": {
                  "values": {
                    "FunctionChainStageUnspecified": 0,
                    "FunctionChainStageIngestion": 1,
                    "FunctionChainStagePreProcess": 2,
                    "FunctionChainStageL0Rerank": 3,
                    "FunctionChainStageL1Rerank": 4,
                    "FunctionChainStageL2Rerank": 5,
                    "FunctionChainStagePostProcess": 6
                  }
                },
                "FunctionChain": {
                  "fields": {
                    "name": {
                      "type": "string",
                      "id": 1
                    },
                    "stage": {
                      "type": "FunctionChainStage",
                      "id": 2
                    },
                    "ops": {
                      "rule": "repeated",
                      "type": "FunctionChainOp",
                      "id": 3
                    }
                  }
                },
                "FunctionChainOp": {
                  "fields": {
                    "op": {
                      "type": "string",
                      "id": 1
                    },
                    "expr": {
                      "type": "FunctionChainExpr",
                      "id": 2
                    },
                    "inputs": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 3
                    },
                    "outputs": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 4
                    },
                    "params": {
                      "keyType": "string",
                      "type": "FunctionParamValue",
                      "id": 5
                    }
                  }
                },
                "FunctionChainExpr": {
                  "fields": {
                    "name": {
                      "type": "string",
                      "id": 1
                    },
                    "args": {
                      "rule": "repeated",
                      "type": "FunctionChainExprArg",
                      "id": 2
                    },
                    "params": {
                      "keyType": "string",
                      "type": "FunctionParamValue",
                      "id": 3
                    }
                  }
                },
                "FunctionChainExprArg": {
                  "oneofs": {
                    "arg": {
                      "oneof": [
                        "column",
                        "literal"
                      ]
                    }
                  },
                  "fields": {
                    "column": {
                      "type": "FunctionChainColumnArg",
                      "id": 1
                    },
                    "literal": {
                      "type": "FunctionParamValue",
                      "id": 2
                    }
                  }
                },
                "FunctionChainColumnArg": {
                  "fields": {
                    "name": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "FunctionParamValue": {
                  "oneofs": {
                    "value": {
                      "oneof": [
                        "bool_value",
                        "int64_value",
                        "double_value",
                        "string_value",
                        "array_value",
                        "object_value",
                        "bytes_value"
                      ]
                    }
                  },
                  "fields": {
                    "bool_value": {
                      "type": "bool",
                      "id": 1
                    },
                    "int64_value": {
                      "type": "int64",
                      "id": 2
                    },
                    "double_value": {
                      "type": "double",
                      "id": 3
                    },
                    "string_value": {
                      "type": "string",
                      "id": 4
                    },
                    "array_value": {
                      "type": "FunctionParamArray",
                      "id": 5
                    },
                    "object_value": {
                      "type": "FunctionParamObject",
                      "id": 6
                    },
                    "bytes_value": {
                      "type": "bytes",
                      "id": 7
                    }
                  }
                },
                "FunctionParamArray": {
                  "fields": {
                    "values": {
                      "rule": "repeated",
                      "type": "FunctionParamValue",
                      "id": 1
                    }
                  }
                },
                "FunctionParamObject": {
                  "fields": {
                    "fields": {
                      "keyType": "string",
                      "type": "FunctionParamValue",
                      "id": 1
                    }
                  }
                },
                "CollectionSchema": {
                  "fields": {
                    "name": {
                      "type": "string",
                      "id": 1
                    },
                    "description": {
                      "type": "string",
                      "id": 2
                    },
                    "autoID": {
                      "type": "bool",
                      "id": 3,
                      "options": {
                        "deprecated": true
                      }
                    },
                    "fields": {
                      "rule": "repeated",
                      "type": "FieldSchema",
                      "id": 4
                    },
                    "enable_dynamic_field": {
                      "type": "bool",
                      "id": 5
                    },
                    "properties": {
                      "rule": "repeated",
                      "type": "common.KeyValuePair",
                      "id": 6
                    },
                    "functions": {
                      "rule": "repeated",
                      "type": "FunctionSchema",
                      "id": 7
                    },
                    "dbName": {
                      "type": "string",
                      "id": 8
                    },
                    "struct_array_fields": {
                      "rule": "repeated",
                      "type": "StructArrayFieldSchema",
                      "id": 9
                    },
                    "version": {
                      "type": "int32",
                      "id": 10
                    },
                    "external_source": {
                      "type": "string",
                      "id": 11
                    },
                    "external_spec": {
                      "type": "string",
                      "id": 12
                    },
                    "do_physical_backfill": {
                      "type": "bool",
                      "id": 13
                    },
                    "file_resource_ids": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 14
                    },
                    "enable_namespace": {
                      "type": "bool",
                      "id": 15
                    }
                  }
                },
                "StructArrayFieldSchema": {
                  "fields": {
                    "fieldID": {
                      "type": "int64",
                      "id": 1
                    },
                    "name": {
                      "type": "string",
                      "id": 2
                    },
                    "description": {
                      "type": "string",
                      "id": 3
                    },
                    "fields": {
                      "rule": "repeated",
                      "type": "FieldSchema",
                      "id": 4
                    },
                    "type_params": {
                      "rule": "repeated",
                      "type": "common.KeyValuePair",
                      "id": 5
                    },
                    "nullable": {
                      "type": "bool",
                      "id": 6
                    }
                  }
                },
                "BoolArray": {
                  "fields": {
                    "data": {
                      "rule": "repeated",
                      "type": "bool",
                      "id": 1
                    }
                  }
                },
                "IntArray": {
                  "fields": {
                    "data": {
                      "rule": "repeated",
                      "type": "int32",
                      "id": 1
                    }
                  }
                },
                "LongArray": {
                  "fields": {
                    "data": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 1
                    }
                  }
                },
                "FloatArray": {
                  "fields": {
                    "data": {
                      "rule": "repeated",
                      "type": "float",
                      "id": 1
                    }
                  }
                },
                "DoubleArray": {
                  "fields": {
                    "data": {
                      "rule": "repeated",
                      "type": "double",
                      "id": 1
                    }
                  }
                },
                "BytesArray": {
                  "fields": {
                    "data": {
                      "rule": "repeated",
                      "type": "bytes",
                      "id": 1
                    }
                  }
                },
                "StringArray": {
                  "fields": {
                    "data": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "ArrayArray": {
                  "fields": {
                    "data": {
                      "rule": "repeated",
                      "type": "ScalarField",
                      "id": 1
                    },
                    "element_type": {
                      "type": "DataType",
                      "id": 2
                    }
                  }
                },
                "JSONArray": {
                  "fields": {
                    "data": {
                      "rule": "repeated",
                      "type": "bytes",
                      "id": 1
                    }
                  }
                },
                "GeometryArray": {
                  "fields": {
                    "data": {
                      "rule": "repeated",
                      "type": "bytes",
                      "id": 1
                    }
                  }
                },
                "TimestamptzArray": {
                  "fields": {
                    "data": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 1
                    }
                  }
                },
                "DateArray": {
                  "fields": {
                    "data": {
                      "rule": "repeated",
                      "type": "int32",
                      "id": 1
                    }
                  }
                },
                "TimeArray": {
                  "fields": {
                    "data": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 1
                    }
                  }
                },
                "GeometryWktArray": {
                  "fields": {
                    "data": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "MolArray": {
                  "fields": {
                    "data": {
                      "rule": "repeated",
                      "type": "bytes",
                      "id": 1
                    }
                  }
                },
                "MolSmilesArray": {
                  "fields": {
                    "data": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "ValueField": {
                  "oneofs": {
                    "data": {
                      "oneof": [
                        "bool_data",
                        "int_data",
                        "long_data",
                        "float_data",
                        "double_data",
                        "string_data",
                        "bytes_data",
                        "timestamptz_data",
                        "date_data",
                        "time_data"
                      ]
                    }
                  },
                  "fields": {
                    "bool_data": {
                      "type": "bool",
                      "id": 1
                    },
                    "int_data": {
                      "type": "int32",
                      "id": 2
                    },
                    "long_data": {
                      "type": "int64",
                      "id": 3
                    },
                    "float_data": {
                      "type": "float",
                      "id": 4
                    },
                    "double_data": {
                      "type": "double",
                      "id": 5
                    },
                    "string_data": {
                      "type": "string",
                      "id": 6
                    },
                    "bytes_data": {
                      "type": "bytes",
                      "id": 7
                    },
                    "timestamptz_data": {
                      "type": "int64",
                      "id": 8
                    },
                    "date_data": {
                      "type": "int32",
                      "id": 9
                    },
                    "time_data": {
                      "type": "int64",
                      "id": 10
                    }
                  }
                },
                "ScalarField": {
                  "oneofs": {
                    "data": {
                      "oneof": [
                        "bool_data",
                        "int_data",
                        "long_data",
                        "float_data",
                        "double_data",
                        "string_data",
                        "bytes_data",
                        "array_data",
                        "json_data",
                        "geometry_data",
                        "timestamptz_data",
                        "geometry_wkt_data",
                        "mol_data",
                        "mol_smiles_data",
                        "date_data",
                        "time_data"
                      ]
                    }
                  },
                  "fields": {
                    "bool_data": {
                      "type": "BoolArray",
                      "id": 1
                    },
                    "int_data": {
                      "type": "IntArray",
                      "id": 2
                    },
                    "long_data": {
                      "type": "LongArray",
                      "id": 3
                    },
                    "float_data": {
                      "type": "FloatArray",
                      "id": 4
                    },
                    "double_data": {
                      "type": "DoubleArray",
                      "id": 5
                    },
                    "string_data": {
                      "type": "StringArray",
                      "id": 6
                    },
                    "bytes_data": {
                      "type": "BytesArray",
                      "id": 7
                    },
                    "array_data": {
                      "type": "ArrayArray",
                      "id": 8
                    },
                    "json_data": {
                      "type": "JSONArray",
                      "id": 9
                    },
                    "geometry_data": {
                      "type": "GeometryArray",
                      "id": 10
                    },
                    "timestamptz_data": {
                      "type": "TimestamptzArray",
                      "id": 11
                    },
                    "geometry_wkt_data": {
                      "type": "GeometryWktArray",
                      "id": 12
                    },
                    "mol_data": {
                      "type": "MolArray",
                      "id": 13
                    },
                    "mol_smiles_data": {
                      "type": "MolSmilesArray",
                      "id": 14
                    },
                    "date_data": {
                      "type": "DateArray",
                      "id": 15
                    },
                    "time_data": {
                      "type": "TimeArray",
                      "id": 16
                    }
                  }
                },
                "SparseFloatArray": {
                  "fields": {
                    "contents": {
                      "rule": "repeated",
                      "type": "bytes",
                      "id": 1
                    },
                    "dim": {
                      "type": "int64",
                      "id": 2
                    }
                  }
                },
                "VectorField": {
                  "oneofs": {
                    "data": {
                      "oneof": [
                        "float_vector",
                        "binary_vector",
                        "float16_vector",
                        "bfloat16_vector",
                        "sparse_float_vector",
                        "int8_vector",
                        "vector_array"
                      ]
                    }
                  },
                  "fields": {
                    "dim": {
                      "type": "int64",
                      "id": 1
                    },
                    "float_vector": {
                      "type": "FloatArray",
                      "id": 2
                    },
                    "binary_vector": {
                      "type": "bytes",
                      "id": 3
                    },
                    "float16_vector": {
                      "type": "bytes",
                      "id": 4
                    },
                    "bfloat16_vector": {
                      "type": "bytes",
                      "id": 5
                    },
                    "sparse_float_vector": {
                      "type": "SparseFloatArray",
                      "id": 6
                    },
                    "int8_vector": {
                      "type": "bytes",
                      "id": 7
                    },
                    "vector_array": {
                      "type": "VectorArray",
                      "id": 8
                    }
                  }
                },
                "VectorArray": {
                  "fields": {
                    "dim": {
                      "type": "int64",
                      "id": 1
                    },
                    "data": {
                      "rule": "repeated",
                      "type": "VectorField",
                      "id": 2
                    },
                    "element_type": {
                      "type": "DataType",
                      "id": 3
                    }
                  }
                },
                "StructArrayField": {
                  "fields": {
                    "fields": {
                      "rule": "repeated",
                      "type": "FieldData",
                      "id": 1
                    }
                  }
                },
                "FieldPartialUpdateOp": {
                  "fields": {
                    "field_name": {
                      "type": "string",
                      "id": 1
                    },
                    "op": {
                      "type": "OpType",
                      "id": 2
                    }
                  },
                  "nested": {
                    "OpType": {
                      "values": {
                        "REPLACE": 0,
                        "ARRAY_APPEND": 1,
                        "ARRAY_REMOVE": 2
                      }
                    }
                  }
                },
                "FieldData": {
                  "oneofs": {
                    "field": {
                      "oneof": [
                        "scalars",
                        "vectors",
                        "struct_arrays"
                      ]
                    }
                  },
                  "fields": {
                    "type": {
                      "type": "DataType",
                      "id": 1
                    },
                    "field_name": {
                      "type": "string",
                      "id": 2
                    },
                    "scalars": {
                      "type": "ScalarField",
                      "id": 3
                    },
                    "vectors": {
                      "type": "VectorField",
                      "id": 4
                    },
                    "struct_arrays": {
                      "type": "StructArrayField",
                      "id": 8
                    },
                    "field_id": {
                      "type": "int64",
                      "id": 5
                    },
                    "is_dynamic": {
                      "type": "bool",
                      "id": 6
                    },
                    "valid_data": {
                      "rule": "repeated",
                      "type": "bool",
                      "id": 7
                    }
                  }
                },
                "IDs": {
                  "oneofs": {
                    "id_field": {
                      "oneof": [
                        "int_id",
                        "str_id"
                      ]
                    }
                  },
                  "fields": {
                    "int_id": {
                      "type": "LongArray",
                      "id": 1
                    },
                    "str_id": {
                      "type": "StringArray",
                      "id": 2
                    }
                  }
                },
                "SearchIteratorV2Results": {
                  "fields": {
                    "token": {
                      "type": "string",
                      "id": 1
                    },
                    "last_bound": {
                      "type": "float",
                      "id": 2
                    }
                  }
                },
                "SearchResultData": {
                  "oneofs": {
                    "_search_iterator_v2_results": {
                      "oneof": [
                        "search_iterator_v2_results"
                      ]
                    }
                  },
                  "fields": {
                    "num_queries": {
                      "type": "int64",
                      "id": 1
                    },
                    "top_k": {
                      "type": "int64",
                      "id": 2
                    },
                    "fields_data": {
                      "rule": "repeated",
                      "type": "FieldData",
                      "id": 3
                    },
                    "scores": {
                      "rule": "repeated",
                      "type": "float",
                      "id": 4
                    },
                    "ids": {
                      "type": "IDs",
                      "id": 5
                    },
                    "topks": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 6
                    },
                    "output_fields": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 7
                    },
                    "group_by_field_value": {
                      "type": "FieldData",
                      "id": 8
                    },
                    "all_search_count": {
                      "type": "int64",
                      "id": 9
                    },
                    "distances": {
                      "rule": "repeated",
                      "type": "float",
                      "id": 10
                    },
                    "search_iterator_v2_results": {
                      "type": "SearchIteratorV2Results",
                      "id": 11,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "recalls": {
                      "rule": "repeated",
                      "type": "float",
                      "id": 12
                    },
                    "primary_field_name": {
                      "type": "string",
                      "id": 13
                    },
                    "highlight_results": {
                      "rule": "repeated",
                      "type": "common.HighlightResult",
                      "id": 14
                    },
                    "element_indices": {
                      "type": "LongArray",
                      "id": 15
                    },
                    "group_by_field_values": {
                      "rule": "repeated",
                      "type": "FieldData",
                      "id": 17
                    },
                    "agg_buckets": {
                      "rule": "repeated",
                      "type": "AggBucket",
                      "id": 18
                    },
                    "agg_topks": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 19
                    }
                  },
                  "reserved": [
                    [
                      16,
                      16
                    ]
                  ]
                },
                "AggBucket": {
                  "fields": {
                    "key": {
                      "rule": "repeated",
                      "type": "BucketKeyEntry",
                      "id": 1
                    },
                    "count": {
                      "type": "int64",
                      "id": 2
                    },
                    "metrics": {
                      "keyType": "string",
                      "type": "MetricValue",
                      "id": 3
                    },
                    "hits": {
                      "rule": "repeated",
                      "type": "AggHit",
                      "id": 4
                    },
                    "sub_groups": {
                      "rule": "repeated",
                      "type": "AggBucket",
                      "id": 5
                    }
                  }
                },
                "MetricValue": {
                  "oneofs": {
                    "value": {
                      "oneof": [
                        "int_val",
                        "double_val",
                        "string_val",
                        "bool_val"
                      ]
                    }
                  },
                  "fields": {
                    "int_val": {
                      "type": "int64",
                      "id": 1
                    },
                    "double_val": {
                      "type": "double",
                      "id": 2
                    },
                    "string_val": {
                      "type": "string",
                      "id": 3
                    },
                    "bool_val": {
                      "type": "bool",
                      "id": 4
                    }
                  }
                },
                "BucketKeyEntry": {
                  "oneofs": {
                    "value": {
                      "oneof": [
                        "int_val",
                        "string_val",
                        "bool_val"
                      ]
                    }
                  },
                  "fields": {
                    "field_id": {
                      "type": "int64",
                      "id": 1
                    },
                    "field_name": {
                      "type": "string",
                      "id": 2
                    },
                    "int_val": {
                      "type": "int64",
                      "id": 3
                    },
                    "string_val": {
                      "type": "string",
                      "id": 4
                    },
                    "bool_val": {
                      "type": "bool",
                      "id": 5
                    }
                  }
                },
                "AggHit": {
                  "oneofs": {
                    "pk": {
                      "oneof": [
                        "int_pk",
                        "str_pk"
                      ]
                    }
                  },
                  "fields": {
                    "int_pk": {
                      "type": "int64",
                      "id": 1
                    },
                    "str_pk": {
                      "type": "string",
                      "id": 2
                    },
                    "score": {
                      "type": "float",
                      "id": 3
                    },
                    "fields": {
                      "rule": "repeated",
                      "type": "AggHitField",
                      "id": 4
                    }
                  }
                },
                "AggHitField": {
                  "oneofs": {
                    "value": {
                      "oneof": [
                        "int_val",
                        "bool_val",
                        "float_val",
                        "double_val",
                        "string_val",
                        "bytes_val"
                      ]
                    }
                  },
                  "fields": {
                    "field_id": {
                      "type": "int64",
                      "id": 1
                    },
                    "field_name": {
                      "type": "string",
                      "id": 2
                    },
                    "int_val": {
                      "type": "int64",
                      "id": 3
                    },
                    "bool_val": {
                      "type": "bool",
                      "id": 4
                    },
                    "float_val": {
                      "type": "float",
                      "id": 5
                    },
                    "double_val": {
                      "type": "double",
                      "id": 6
                    },
                    "string_val": {
                      "type": "string",
                      "id": 7
                    },
                    "bytes_val": {
                      "type": "bytes",
                      "id": 8
                    }
                  }
                },
                "VectorClusteringInfo": {
                  "fields": {
                    "field": {
                      "type": "string",
                      "id": 1
                    },
                    "centroid": {
                      "type": "schema.VectorField",
                      "id": 2
                    }
                  }
                },
                "ScalarClusteringInfo": {
                  "fields": {
                    "field": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "ClusteringInfo": {
                  "fields": {
                    "vector_clustering_infos": {
                      "rule": "repeated",
                      "type": "VectorClusteringInfo",
                      "id": 1
                    },
                    "scalar_clustering_infos": {
                      "rule": "repeated",
                      "type": "ScalarClusteringInfo",
                      "id": 2
                    }
                  }
                },
                "TemplateValue": {
                  "oneofs": {
                    "val": {
                      "oneof": [
                        "bool_val",
                        "int64_val",
                        "float_val",
                        "string_val",
                        "array_val",
                        "bytes_val"
                      ]
                    }
                  },
                  "fields": {
                    "bool_val": {
                      "type": "bool",
                      "id": 1
                    },
                    "int64_val": {
                      "type": "int64",
                      "id": 2
                    },
                    "float_val": {
                      "type": "double",
                      "id": 3
                    },
                    "string_val": {
                      "type": "string",
                      "id": 4
                    },
                    "array_val": {
                      "type": "TemplateArrayValue",
                      "id": 5
                    },
                    "bytes_val": {
                      "type": "bytes",
                      "id": 6
                    }
                  }
                },
                "TemplateArrayValue": {
                  "oneofs": {
                    "data": {
                      "oneof": [
                        "bool_data",
                        "long_data",
                        "double_data",
                        "string_data",
                        "array_data",
                        "json_data"
                      ]
                    }
                  },
                  "fields": {
                    "bool_data": {
                      "type": "BoolArray",
                      "id": 1
                    },
                    "long_data": {
                      "type": "LongArray",
                      "id": 2
                    },
                    "double_data": {
                      "type": "DoubleArray",
                      "id": 3
                    },
                    "string_data": {
                      "type": "StringArray",
                      "id": 4
                    },
                    "array_data": {
                      "type": "TemplateArrayValueArray",
                      "id": 5
                    },
                    "json_data": {
                      "type": "JSONArray",
                      "id": 6
                    }
                  }
                },
                "TemplateArrayValueArray": {
                  "fields": {
                    "data": {
                      "rule": "repeated",
                      "type": "TemplateArrayValue",
                      "id": 1
                    }
                  }
                }
              }
            },
            "feder": {
              "options": {
                "go_package": "github.com/milvus-io/milvus-proto/go-api/v3/federpb"
              },
              "nested": {
                "SegmentIndexData": {
                  "fields": {
                    "segmentID": {
                      "type": "int64",
                      "id": 1
                    },
                    "index_data": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "FederSegmentSearchResult": {
                  "fields": {
                    "segmentID": {
                      "type": "int64",
                      "id": 1
                    },
                    "visit_info": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "ListIndexedSegmentRequest": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 2
                    },
                    "index_name": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "ListIndexedSegmentResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "segmentIDs": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 2
                    }
                  }
                },
                "DescribeSegmentIndexDataRequest": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 2
                    },
                    "index_name": {
                      "type": "string",
                      "id": 3
                    },
                    "segmentsIDs": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 4
                    }
                  }
                },
                "DescribeSegmentIndexDataResponse": {
                  "fields": {
                    "status": {
                      "type": "common.Status",
                      "id": 1
                    },
                    "index_data": {
                      "keyType": "int64",
                      "type": "feder.SegmentIndexData",
                      "id": 2
                    },
                    "index_params": {
                      "rule": "repeated",
                      "type": "common.KeyValuePair",
                      "id": 3
                    }
                  }
                }
              }
            },
            "msg": {
              "options": {
                "go_package": "github.com/milvus-io/milvus-proto/go-api/v3/msgpb"
              },
              "nested": {
                "InsertDataVersion": {
                  "values": {
                    "RowBased": 0,
                    "ColumnBased": 1
                  }
                },
                "InsertRequest": {
                  "oneofs": {
                    "_namespace": {
                      "oneof": [
                        "namespace"
                      ]
                    }
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "shardName": {
                      "type": "string",
                      "id": 2
                    },
                    "db_name": {
                      "type": "string",
                      "id": 3
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 4
                    },
                    "partition_name": {
                      "type": "string",
                      "id": 5
                    },
                    "dbID": {
                      "type": "int64",
                      "id": 6
                    },
                    "collectionID": {
                      "type": "int64",
                      "id": 7
                    },
                    "partitionID": {
                      "type": "int64",
                      "id": 8
                    },
                    "segmentID": {
                      "type": "int64",
                      "id": 9
                    },
                    "timestamps": {
                      "rule": "repeated",
                      "type": "uint64",
                      "id": 10
                    },
                    "rowIDs": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 11
                    },
                    "row_data": {
                      "rule": "repeated",
                      "type": "common.Blob",
                      "id": 12
                    },
                    "fields_data": {
                      "rule": "repeated",
                      "type": "schema.FieldData",
                      "id": 13
                    },
                    "num_rows": {
                      "type": "uint64",
                      "id": 14
                    },
                    "version": {
                      "type": "InsertDataVersion",
                      "id": 15
                    },
                    "namespace": {
                      "type": "string",
                      "id": 16,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "DeleteRequest": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "shardName": {
                      "type": "string",
                      "id": 2
                    },
                    "db_name": {
                      "type": "string",
                      "id": 3
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 4
                    },
                    "partition_name": {
                      "type": "string",
                      "id": 5
                    },
                    "dbID": {
                      "type": "int64",
                      "id": 6
                    },
                    "collectionID": {
                      "type": "int64",
                      "id": 7
                    },
                    "partitionID": {
                      "type": "int64",
                      "id": 8
                    },
                    "int64_primary_keys": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 9
                    },
                    "timestamps": {
                      "rule": "repeated",
                      "type": "uint64",
                      "id": 10
                    },
                    "num_rows": {
                      "type": "int64",
                      "id": 11
                    },
                    "primary_keys": {
                      "type": "schema.IDs",
                      "id": 12
                    },
                    "segment_id": {
                      "type": "int64",
                      "id": 13
                    },
                    "serialized_expr_plan": {
                      "type": "bytes",
                      "id": 14
                    }
                  }
                },
                "MsgPosition": {
                  "fields": {
                    "channel_name": {
                      "type": "string",
                      "id": 1
                    },
                    "msgID": {
                      "type": "bytes",
                      "id": 2
                    },
                    "msgGroup": {
                      "type": "string",
                      "id": 3
                    },
                    "timestamp": {
                      "type": "uint64",
                      "id": 4
                    },
                    "WAL_name": {
                      "type": "common.WALName",
                      "id": 5
                    }
                  }
                },
                "CreateCollectionRequest": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collectionName": {
                      "type": "string",
                      "id": 3
                    },
                    "partitionName": {
                      "type": "string",
                      "id": 4
                    },
                    "dbID": {
                      "type": "int64",
                      "id": 5
                    },
                    "collectionID": {
                      "type": "int64",
                      "id": 6
                    },
                    "partitionID": {
                      "type": "int64",
                      "id": 7,
                      "options": {
                        "deprecated": true
                      }
                    },
                    "schema": {
                      "type": "bytes",
                      "id": 8,
                      "options": {
                        "deprecated": true
                      }
                    },
                    "virtualChannelNames": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 9
                    },
                    "physicalChannelNames": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 10
                    },
                    "partitionIDs": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 11
                    },
                    "partitionNames": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 12
                    },
                    "collection_schema": {
                      "type": "schema.CollectionSchema",
                      "id": 13
                    }
                  }
                },
                "DropCollectionRequest": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collectionName": {
                      "type": "string",
                      "id": 3
                    },
                    "dbID": {
                      "type": "int64",
                      "id": 4
                    },
                    "collectionID": {
                      "type": "int64",
                      "id": 5
                    }
                  }
                },
                "CreatePartitionRequest": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "partition_name": {
                      "type": "string",
                      "id": 4
                    },
                    "dbID": {
                      "type": "int64",
                      "id": 5
                    },
                    "collectionID": {
                      "type": "int64",
                      "id": 6
                    },
                    "partitionID": {
                      "type": "int64",
                      "id": 7
                    }
                  }
                },
                "DropPartitionRequest": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "partition_name": {
                      "type": "string",
                      "id": 4
                    },
                    "dbID": {
                      "type": "int64",
                      "id": 5
                    },
                    "collectionID": {
                      "type": "int64",
                      "id": 6
                    },
                    "partitionID": {
                      "type": "int64",
                      "id": 7
                    }
                  }
                },
                "TimeTickMsg": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    }
                  }
                },
                "DataNodeTtMsg": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "channel_name": {
                      "type": "string",
                      "id": 2
                    },
                    "timestamp": {
                      "type": "uint64",
                      "id": 3
                    },
                    "segments_stats": {
                      "rule": "repeated",
                      "type": "common.SegmentStats",
                      "id": 4
                    }
                  }
                },
                "ReplicateMsg": {
                  "options": {
                    "deprecated": true
                  },
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "is_end": {
                      "type": "bool",
                      "id": 2
                    },
                    "is_cluster": {
                      "type": "bool",
                      "id": 3
                    },
                    "database": {
                      "type": "string",
                      "id": 4
                    },
                    "collection": {
                      "type": "string",
                      "id": 5
                    }
                  }
                },
                "ImportFile": {
                  "fields": {
                    "id": {
                      "type": "int64",
                      "id": 1
                    },
                    "paths": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 2
                    },
                    "pre_allocated_auto_ids": {
                      "type": "common.IDRange",
                      "id": 3
                    }
                  }
                },
                "ImportMsg": {
                  "fields": {
                    "base": {
                      "type": "common.MsgBase",
                      "id": 1
                    },
                    "db_name": {
                      "type": "string",
                      "id": 2
                    },
                    "collection_name": {
                      "type": "string",
                      "id": 3
                    },
                    "collectionID": {
                      "type": "int64",
                      "id": 4
                    },
                    "partitionIDs": {
                      "rule": "repeated",
                      "type": "int64",
                      "id": 5
                    },
                    "options": {
                      "keyType": "string",
                      "type": "string",
                      "id": 6
                    },
                    "files": {
                      "rule": "repeated",
                      "type": "ImportFile",
                      "id": 7
                    },
                    "schema": {
                      "type": "schema.CollectionSchema",
                      "id": 8
                    },
                    "jobID": {
                      "type": "int64",
                      "id": 9
                    }
                  }
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
        }
      }
    }
  }
} as Parameters<typeof fromJSON>[0];
