/**
 * The verified copy of one pinned sample asset to one target: the only thing the built-in samples do at boot
 * (src/lib/seed/samples.ts holds the table, the policy and the state; this module holds neither).
 *
 * No engine opens anything: the bytes are copied as they are, and no `-wal`, `-shm` or `.lock` file is created.
 */
import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { logger } from "@/lib/logger";
import type { SampleUnavailableReason } from "./types";

/** An asset file and the size and SHA-256 digest it must have. */
export interface PinnedAsset {
  readonly asset: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** The reasons a copy itself can fail, a subset of the reasons a sample is listed unavailable. */
export type SampleCopyFailure = Extract<
  SampleUnavailableReason,
  "asset-missing" | "asset-unreadable" | "digest-mismatch" | "copy-failed"
>;

/** A copy that failed, with its reason, the errno code of the error underneath when it has one, and that error. */
export class SampleCopyError extends Error {
  readonly reason: SampleCopyFailure;
  readonly code: string | undefined;

  constructor(reason: SampleCopyFailure, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SampleCopyError";
    this.reason = reason;
    this.code = errnoCode(cause);
  }
}

/** The errno code of an error, such as `EACCES`, when it has one. */
export function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

/** An error's message, or the text of a thrown value that is not an Error. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The target's state: present when any entry stat can follow is there, absent on ENOENT; any other error is thrown. */
async function targetPresent(target: string): Promise<boolean> {
  try {
    await fs.promises.stat(target);
    return true;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }
}

/**
 * Copy `pinned.asset` to `target` and resolve "copied", or resolve "present" when the target already exists; reject
 * with a SampleCopyError otherwise.
 *
 * 1. An existing target is never touched: "present".
 * 2. The asset must be a regular file (else `asset-missing`) of the pinned size (else `digest-mismatch`), checked
 *    before any byte is written. An asset that cannot be checked for another reason is `asset-unreadable`.
 * 3. The target's directory is created, and the temp `<target>.<pid>.<random UUID>.seeding` is opened exclusively
 *    (`wx`). The name is this copy's own, so two copies never share a temp, not even two processes with one pid on
 *    one data directory (replicas on a shared volume, each running the server as pid 1). A temp a crashed copy left
 *    behind is never touched, and stays until someone removes it.
 * 4. The asset is streamed into the temp and into a SHA-256; a stream that passes the pinned size is refused at once,
 *    and an asset that cannot be read is `asset-unreadable`.
 * 5. Size and digest must equal the pins (else `digest-mismatch`); the temp is flushed (`sync`) after its last write
 *    and closed, so a published file is complete across a power loss.
 * 6. The temp is renamed onto the target. A rename that fails while the target now exists means another seeder
 *    published first: the temp is removed and the answer is "present" (Windows refuses a rename over an open file).
 *
 * Any failure removes the temp and leaves no target; a temp that cannot be closed or removed is logged, and the first
 * error is the one reported. Every other failure in steps 3 to 6, on the data directory's side, is `copy-failed`, with
 * its errno code.
 *
 * Invariant: a rename replaces a file only when another seeder published it after this one's existence check, and
 * that file holds the same pinned bytes. A `link()` publish would refuse to replace anything, but filesystems without
 * hard links (FAT, exFAT, some SMB and FUSE mounts, Docker Desktop bind mounts) would turn a working copy into a
 * failure, so the rename is kept.
 */
export async function copySampleAsset(pinned: PinnedAsset, target: string): Promise<"copied" | "present"> {
  try {
    if (await targetPresent(target)) return "present";
  } catch (error) {
    throw new SampleCopyError("copy-failed", `Could not check the sample target ${target}: ${messageOf(error)}`, error);
  }

  let assetStats: fs.Stats;
  try {
    assetStats = await fs.promises.stat(pinned.asset);
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new SampleCopyError("asset-missing", `The sample asset ${pinned.asset} does not exist.`, error);
    }
    throw new SampleCopyError(
      "asset-unreadable",
      `Could not read the sample asset ${pinned.asset}: ${messageOf(error)}`,
      error,
    );
  }
  if (!assetStats.isFile()) {
    throw new SampleCopyError("asset-missing", `The sample asset ${pinned.asset} is not a regular file.`);
  }
  if (assetStats.size !== pinned.bytes) {
    throw new SampleCopyError(
      "digest-mismatch",
      `The sample asset ${pinned.asset} is ${assetStats.size} bytes, not the pinned ${pinned.bytes}.`,
    );
  }

  const temp = `${target}.${process.pid}.${randomUUID()}.seeding`;
  try {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await writeVerified(pinned, temp);
    try {
      await fs.promises.rename(temp, target);
    } catch (renameError) {
      if (!(await targetPresent(target))) throw renameError;
      await fs.promises.rm(temp, { force: true });
      return "present";
    }
    return "copied";
  } catch (error) {
    await removeTemp(temp);
    if (error instanceof SampleCopyError) throw error;
    throw new SampleCopyError(
      "copy-failed",
      `Could not copy the sample asset ${pinned.asset} to ${target}: ${messageOf(error)}`,
      error,
    );
  }
}

/**
 * Steps 3 (the exclusive open) to 5 of copySampleAsset: the temp holds the pinned bytes, flushed and closed. On a
 * failure the handle is closed and the failure rethrown; a close that fails then is logged and never replaces it. A
 * close that fails after a verified write is the failure.
 */
async function writeVerified(pinned: PinnedAsset, temp: string): Promise<void> {
  const handle = await fs.promises.open(temp, "wx");
  try {
    const digest = createHash("sha256");
    let count = 0;
    try {
      for await (const chunk of fs.createReadStream(pinned.asset)) {
        const bytes = chunk as Buffer;
        count += bytes.length;
        if (count > pinned.bytes) {
          throw new SampleCopyError(
            "digest-mismatch",
            `The sample asset ${pinned.asset} holds more than the pinned ${pinned.bytes} bytes.`,
          );
        }
        digest.update(bytes);
        await writeChunk(handle, bytes, temp);
      }
    } catch (error) {
      // The loop body throws nothing but a SampleCopyError, so any other error came from reading the asset.
      if (error instanceof SampleCopyError) throw error;
      throw new SampleCopyError(
        "asset-unreadable",
        `Could not read the sample asset ${pinned.asset}: ${messageOf(error)}`,
        error,
      );
    }
    const sha256 = digest.digest("hex");
    if (count !== pinned.bytes || sha256 !== pinned.sha256) {
      throw new SampleCopyError(
        "digest-mismatch",
        `The sample asset ${pinned.asset} (${count} bytes, sha256 ${sha256}) is not the pinned one (${pinned.bytes} bytes, sha256 ${pinned.sha256}).`,
      );
    }
    await handle.sync();
  } catch (error) {
    await closeAfterFailure(handle, temp);
    throw error;
  }
  await handle.close();
}

/** One chunk into the temp, whole: a write that fails or falls short is `copy-failed`. */
async function writeChunk(handle: fs.promises.FileHandle, bytes: Buffer, temp: string): Promise<void> {
  let written: number;
  try {
    ({ bytesWritten: written } = await handle.write(bytes, 0, bytes.length));
  } catch (error) {
    throw new SampleCopyError("copy-failed", `Could not write the sample temp ${temp}: ${messageOf(error)}`, error);
  }
  if (written !== bytes.length) {
    throw new SampleCopyError(
      "copy-failed",
      `Could not write the sample temp ${temp}: short write, ${written} of ${bytes.length} bytes`,
    );
  }
}

/** Close the temp after a failure; a close that fails is logged and never replaces the failure being reported. */
async function closeAfterFailure(handle: fs.promises.FileHandle, temp: string): Promise<void> {
  try {
    await handle.close();
  } catch (error) {
    logger.warn("Embedded sample temp not closed", { route: "instrumentation", temp, error: messageOf(error) });
  }
}

/** Remove the temp after a failure; a removal that fails is logged and never replaces the failure being reported. */
async function removeTemp(temp: string): Promise<void> {
  try {
    await fs.promises.rm(temp, { force: true });
  } catch (error) {
    logger.warn("Embedded sample temp not removed", { route: "instrumentation", temp, error: messageOf(error) });
  }
}
