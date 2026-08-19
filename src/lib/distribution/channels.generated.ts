// GENERATED FILE - do not edit. Run: bun run channels:showcase
//
// Source: distribution/channels.yaml (live channels only), via
// scripts/generate-channel-showcase.mjs. CI fails on drift
// (bun run channels:showcase:check), so this file is always the inventory.

/** The row of the login hero's deploy block a channel belongs to. */
export type ShowcaseGroup = "containers" | "kubernetes" | "paas" | "packages";

/** Platforms a live channel serves, in the canonical order of distribution/channels.yaml. */
export type ShowcasePlatform = "linux" | "macos" | "windows" | "container" | "kubernetes" | "cloud";

export interface ShowcaseChannel {
  id: string;
  label: string;
  group: ShowcaseGroup;
}

export const LIVE_CHANNELS: readonly ShowcaseChannel[] = [
  { id: "github-release", label: "GitHub Releases", group: "packages" },
  { id: "docker-ghcr", label: "Docker image (GHCR)", group: "containers" },
  { id: "docker-hub-mirror", label: "Docker Hub mirror", group: "containers" },
  { id: "npm", label: "npm @libredb/studio", group: "packages" },
  { id: "helm", label: "Helm chart", group: "kubernetes" },
  { id: "homebrew", label: "Homebrew tap", group: "packages" },
  { id: "snap", label: "Snap Store", group: "packages" },
  { id: "linux-deb-rpm", label: "Linux .deb / .rpm", group: "packages" },
  { id: "appimage", label: "Desktop app (AppImage, .deb)", group: "packages" },
  { id: "railway-template", label: "Railway one-click template", group: "paas" },
  { id: "koyeb-deploy-button", label: "Koyeb deploy button", group: "paas" },
  { id: "fly-io", label: "Fly.io launch config", group: "paas" },
  { id: "render", label: "Render Blueprint", group: "paas" },
  { id: "unraid-ca", label: "Unraid Community Apps", group: "paas" },
  { id: "caprover-official", label: "CapRover official", group: "paas" },
  { id: "dokploy", label: "Dokploy template catalog", group: "paas" },
  { id: "cosmos", label: "Cosmos servapp marketplace", group: "paas" },
  { id: "kubero", label: "Kubero template catalog", group: "paas" },
  { id: "sealos", label: "Sealos App Store template", group: "paas" },
  { id: "truenas-scale", label: "TrueNAS SCALE apps", group: "paas" },
  { id: "rancher-partner", label: "Rancher Partner Charts", group: "kubernetes" },
  { id: "digitalocean", label: "DigitalOcean Marketplace", group: "paas" },
  { id: "winget", label: "winget", group: "packages" },
  { id: "flatpark", label: "FlatPark (Flatpak)", group: "packages" },
];

export const LIVE_PLATFORMS: readonly ShowcasePlatform[] = [
  "linux",
  "macos",
  "windows",
  "container",
  "kubernetes",
  "cloud",
];
