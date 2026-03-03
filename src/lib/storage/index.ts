/**
 * Storage module — barrel export.
 * Import path `@/lib/storage` is preserved for all consumers.
 */

export { storage } from './storage-facade';
export type {
  StorageData,
  StorageCollection,
  ServerStorageProvider,
  StorageConfigResponse,
  StorageChangeDetail,
} from './types';
export { STORAGE_COLLECTIONS } from './types';
