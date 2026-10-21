import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ICON_OUTPUT,
  ICON_SIZE,
  ICON_SOURCE,
  pngSize,
  writeMarketplaceIcon,
} from "../../../scripts/marketplace-icon.mjs";

const EXTENSION_ROOT = join(__dirname, "..", "..", "..");

describe("writeMarketplaceIcon", () => {
  let dir: string;
  let out: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "libredb-marketplace-icon-"));
    out = join(dir, "icon.png");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is a 128x128 PNG rendered from the brand mark into the path the manifest names", () => {
    assert.equal(ICON_SIZE, 128);
    assert.equal(ICON_SOURCE, "../public/logo.svg");
    assert.equal(ICON_OUTPUT, "media/icon.png");
  });

  it("renders the brand mark into a 128x128 PNG with alpha", async () => {
    await writeMarketplaceIcon(join(EXTENSION_ROOT, ICON_SOURCE), out);
    const png = readFileSync(out);
    assert.deepEqual(pngSize(png), { width: 128, height: 128 });
    assert.equal(png[25], 6); // IHDR colour type 6: RGBA
  });

  it("fits a wide source inside the square", async () => {
    const wide = join(dir, "wide.svg");
    writeFileSync(
      wide,
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><rect width="400" height="100"/></svg>',
    );
    await writeMarketplaceIcon(wide, out);
    assert.deepEqual(pngSize(readFileSync(out)), { width: 128, height: 128 });
  });

  it("refuses a missing source and writes nothing", async () => {
    await assert.rejects(writeMarketplaceIcon(join(dir, "none.svg"), out), /none\.svg/);
    assert.equal(existsSync(out), false);
  });
});

describe("pngSize", () => {
  it("reads the width and height a PNG's IHDR chunk declares", () => {
    const header = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
    header.write("IHDR", 12, "latin1");
    header.writeUInt32BE(300, 16);
    header.writeUInt32BE(20, 20);
    assert.deepEqual(pngSize(header), { width: 300, height: 20 });
  });

  it("refuses a buffer that is not a PNG", () => {
    assert.throws(() => pngSize(Buffer.from("GIF89a")), /not a PNG/);
  });
});
