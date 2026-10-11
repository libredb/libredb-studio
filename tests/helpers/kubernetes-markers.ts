/**
 * The fake values docker/kubernetes/sample.yaml plants, so a test can assert where each one must never appear: a
 * Secret value on no surface at all, and every one of them on no machine surface (the agent's walk, its packers and
 * the operations inventory). The Secret markers sit in the namespaces shop and restricted, which the fixture scrub
 * keeps as captured (`KUBERNETES_PLANTED_NAMESPACES`).
 */
export const KUBERNETES_SAMPLE_MARKERS = Object.freeze({
  secretValue: "k8s-marker-secret-value-3d9a",
  secretName: "k8s-marker-secret-name",
  configMapValue: "k8s-marker-configmap-value-71c4",
  envValue: "k8s-marker-env-value-0b52",
  labelValue: "k8s-marker-label-value",
  annotationValue: "k8s-marker-annotation-value-c8e1",
  /** Keys are secrets too: no ConfigMap or Secret key, and no label or annotation on one, reaches a machine surface. */
  configMapKey: "k8s-marker-cm-entry-9a4f",
  secretKey: "k8s-marker-secret-entry-5e21",
  labelKey: "libredb.dev/k8s-marker-label-name-2c6d",
  annotationKey: "libredb.dev/k8s-marker-annotation-name-8e0b",
});

/** The namespaces whose Secrets hold planted markers; every other Secret is emptied by the fixture scrub. */
export const KUBERNETES_PLANTED_NAMESPACES: readonly string[] = Object.freeze(["shop", "restricted"]);
