/**
 * Unit tests for the Docker Hub mirror's two identities.
 *
 * Why a test for YAML: `libredb` on Docker Hub was a user account until
 * 2026-09-01, so one variable could answer two different questions - who logs
 * in, and which namespace the image is published under. Converting it to an
 * organization split those answers apart: an organization cannot sign in, so
 * the login is now the owner user (`cevheri`), while the namespace must stay
 * `libredb` or every `docker run` line in the README points at nothing.
 *
 * The failure this guards is silent in both directions. Using the login name as
 * the namespace does not error - it publishes to `docker.io/<owner>/...`, a real
 * repository nobody pulls, while the mirror everyone does pull goes stale.
 * Using the namespace as the login fails the whole job, because buildx exports
 * every tag in one push and one rejected mirror tag takes GHCR down with it.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";

interface Step {
  name?: string;
  id?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string | boolean>;
}
interface Job {
  steps?: Step[];
}

const read = (file: string) =>
  parseYaml(fs.readFileSync(path.join(__dirname, "../../.github/workflows", file), "utf8")) as {
    jobs: Record<string, Job>;
  };

const dockerBuild = read("docker-build-push.yml");
const releaseArtifacts = read("release-artifacts.yml");

const allSteps = (wf: { jobs: Record<string, Job> }) => Object.values(wf.jobs).flatMap((j) => j.steps ?? []);

const logins = [...allSteps(dockerBuild), ...allSteps(releaseArtifacts)].filter(
  (s) => s.name === "Log in to Docker Hub",
);
const compose = allSteps(dockerBuild).find((s) => s.id === "images");

describe("the Docker Hub mirror's login identity", () => {
  test("both workflows log in, so neither is left anonymous", () => {
    // A floor, not an exact count: the assertion below is vacuous over an empty
    // list, and a renamed step would empty it without failing anything else.
    expect(logins.length).toBe(2);
  });

  test("every login uses the owner user, never the organization", () => {
    for (const login of logins) {
      expect(login.with?.username).toBe("${{ vars.DOCKER_HUB_USERNAME }}");
      expect(login.with?.username).not.toBe("${{ vars.DOCKER_HUB_ORGANIZATION }}");
    }
  });
});

describe("the Docker Hub mirror's namespace", () => {
  test("the image list is built from the organization, not the login user", () => {
    expect(compose?.env?.DH_ORGANIZATION).toBe("${{ vars.DOCKER_HUB_ORGANIZATION }}");
    expect(compose?.env?.DH_USERNAME).toBeUndefined();
  });

  test("the pushed image name interpolates the organization", () => {
    expect(compose?.run).toContain("$DH_ORGANIZATION");
    expect(compose?.run).not.toContain("$DH_USERNAME");
  });

  test("an unset organization leaves the mirror off rather than guessing a namespace", () => {
    // Falling back to the login user would publish to the wrong repository
    // silently, which is the failure this whole file exists to prevent.
    expect(compose?.run).toContain('[ -n "$DH_ORGANIZATION" ]');
  });
});
