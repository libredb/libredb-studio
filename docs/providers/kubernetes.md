# Kubernetes

Studio reads one Kubernetes cluster over the API server's REST API: a tree of the `Cluster` pseudo-container and the namespaces, a YAML view of every built-in object, and a kubectl-subset console.
It is read-only in this version, whatever the connection's read-only flag says.

## Object edit (#789)

No kind declares `acceptsRowWrites` or `acceptsSourceEdits`: this version reads a cluster and never writes to it, so the YAML view offers no edit.
