import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PUBLIC_DIR = join(import.meta.dir, "../../public");

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
}

interface WebManifest {
  name: string;
  short_name: string;
  start_url: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: ManifestIcon[];
}

function pngDimensions(file: string): { width: number; height: number } {
  const image = readFileSync(join(PUBLIC_DIR, file));
  expect(image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}

describe("web app manifest", () => {
  const manifest = JSON.parse(readFileSync(join(PUBLIC_DIR, "site.webmanifest"), "utf8")) as WebManifest;

  test("describes LibreDB Studio as an installable standalone app", () => {
    expect(manifest).toMatchObject({
      name: "LibreDB Studio",
      short_name: "LibreDB",
      start_url: "/",
      display: "standalone",
      theme_color: "#09090b",
      background_color: "#09090b",
    });
  });

  test("declares the two standard PNG app icon sizes", () => {
    expect(manifest.icons).toEqual([
      { src: "/web-app-icon-192x192.png", sizes: "192x192", type: "image/png" },
      { src: "/web-app-icon-512x512.png", sizes: "512x512", type: "image/png" },
    ]);
  });

  test.each([
    ["web-app-icon-192x192.png", 192],
    ["web-app-icon-512x512.png", 512],
    ["apple-touch-icon.png", 180],
  ])("%s is a valid square PNG with the advertised dimensions", (file, size) => {
    expect(pngDimensions(file)).toEqual({ width: size, height: size });
  });
});
