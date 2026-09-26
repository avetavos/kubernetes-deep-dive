# Kubernetes Deep Dive

Bilingual (EN/TH) Astro + Starlight course teaching Kubernetes 1.37 /
kubectl 1.36 / kind 0.33 / Helm 4.3.

```sh
npm install
npm run dev       # local dev server
npm run build     # production build
npm run check     # EN/TH lesson parity (headings, quiz counts, code blocks)
npm run verify    # tools/verify-manifests.mjs — see Harness below
```

## Harness

`tools/verify-manifests.mjs` proves lesson manifests are actually correct
against a real Kubernetes API server. This course teaches YAML, not a
compiled language, so there's no `tsc`/`astro check` equivalent — the real
proof is `kubectl apply --dry-run=server`, which runs full OpenAPI schema
validation *and* every admission plugin against a real API server, so a
removed API version, an immutable-field change, or a missing CRD surfaces
the exact error a reader would hit copy-pasting the lesson. The harness owns
a real `kind` cluster (`verify-k8s`) the same way the sibling Astro/Svelte/
React/Next courses' `tools/verify-snippets.mjs` owns a throwaway framework
project ("the probe"): create once, reuse by default.

The fence-collection scanner (the quiz-array / `<SpotTheBug>` string-aware
walk that keeps a `` ``` `` inside a template literal from confusing a naive
fence regex) is ported from this repo's own `tools/check-parity.mjs`, not
re-derived.

```sh
npm run verify                                  # dry-run=server every collected yaml
                                                 # fence, bash -n every bash fence, tsc
                                                 # --noEmit ts fences (auto if any exist)
node tools/verify-manifests.mjs --all-yaml      # ALSO collect any yaml fence containing
                                                 # `apiVersion:` even with no path comment
                                                 # (skips `{{` Helm-template fences) —
                                                 # baseline mode for a corpus that hasn't
                                                 # added path comments yet
node tools/verify-manifests.mjs --ts            # force the tsc probe step
node tools/verify-manifests.mjs --fresh         # delete + recreate verify-k8s first
node tools/verify-manifests.mjs --delete        # delete verify-k8s and exit
node tools/verify-manifests.mjs --apply <module>/<lesson>
                                                 # real apply into a fresh temp namespace,
                                                 # wait for Ready, print get all/events,
                                                 # delete the namespace (always)
node tools/verify-manifests.mjs --self-test     # harness self-check
```

### Fence convention

A collectible fence's first line is a path comment naming the real file it
represents; the line is kept (inert) in the written file, same as the
sibling courses' snippet harnesses.

- `` ```yaml `` — first line `# k8s/<...>.yaml` (path must start `k8s/`,
  end `.yaml`). A trailing ` — <note>` after the path is tolerated.
- `` ```bash `` — first line `# scripts/<name>.sh` — syntax-checked with
  `bash -n`, not executed.
- `` ```ts `` — first line `// src/<...>.ts` — written into `tools/probe/`
  (a tiny gitignored npm project with `@kubernetes/client-node@2` +
  `typescript`) and type-checked with `tsc --noEmit`. Runs automatically
  whenever at least one `ts` fence exists; `--ts` forces the step even with
  none collected (a no-op).
- A first line containing `@expect-error` is a deliberate-error demo (the
  lesson prose carries the real server error text) and is **skipped**, not
  applied. Anything else — no recognized path comment — is a skipped
  fragment (an intentionally incomplete excerpt, e.g. a `values.yaml` or a
  Helm template with `{{ }}` — those never get a path comment by
  convention, since they aren't a real standalone manifest).

### Namespacing

Default mode creates one namespace per lesson, `<module>--<lesson>`
(idempotent), and applies each lesson's collected yaml fences into it with
`kubectl apply --dry-run=server -n <ns> -f <fence>`. A fence is applied
**without** `-n` when any of its documents declares its own
`metadata.namespace` or is a cluster-scoped kind (checked against a live
`kubectl api-resources --namespaced=false` — not a hardcoded list). Any
namespace a lesson's fences *reference* — a `metadata.namespace: shop` on a
resource, or a `kind: Namespace` document elsewhere in the lesson — is
pre-created for real before that lesson's fences are applied, since
`NamespaceLifecycle` admission rejects a namespaced create (even
`--dry-run=server`) against a namespace that doesn't exist yet.

`--apply` is the one mode that does a **real** (non-dry-run) apply, into a
throwaway `apply--<lesson>--<random>` namespace, then waits for pods,
prints `kubectl get all`/`get events`, and always deletes the namespace
(even on failure). Cluster-scoped objects a lesson collects (CRDs,
ClusterRoles, …) are still only ever `--dry-run=server` even in `--apply`
mode — real-applying them would leak cluster-scoped state that the
namespace delete can't clean up. If a future lesson genuinely needs a real
cluster-scoped object proven end-to-end, that needs its own explicit
label-and-cleanup step; not implemented here.

### Cluster setup

`verify-k8s` is a 3-node `kind` cluster (1 control-plane + 2 workers, no
host port mappings — see Concurrency below) created on first run and reused
after that. Right after creation the harness installs a fixed CRD set so
Gateway API / VolumeSnapshot lessons validate:

- Gateway API standard channel `v1.6.2`
- external-snapshotter CRDs (`VolumeSnapshot`/`VolumeSnapshotClass`/
  `VolumeSnapshotContent`) `v8.6.0`

Both versions are recorded in `tools/probe/cluster.json` (gitignored) when
the cluster is created; a reuse run reads and reports them but does **not**
reinstall — `--fresh` if you need to pick up a version bump.

### Concurrency

Several agents can share the `verify-k8s` cluster at once — every lesson
gets its own namespace, so ordinary `npm run verify` runs never collide,
and kind maps no host ports so there's nothing to clash on either. **Never
run `--fresh` or `--delete` while another agent may be mid-run** against
the shared cluster. An agent that wants to poke at the cluster
interactively (not just run this harness) should create its **own** kind
cluster instead — `VERIFY_K8S_CLUSTER=<name>` points this harness at a
different cluster name if you need the harness itself to do that.

### Baseline (2026-09-26, before Phase 3 adds path comments)

The current lesson corpus has no `# k8s/...` path comments yet (Phase 3
agents add them lesson by lesson), so a plain `npm run verify` collects 0
yaml fences — expected, and exit 0 (108 fences fall through as
skipped-no-path: 60 yaml + 48 bash, none tagged yet).

`npm run verify -- --all-yaml` proves the harness against the real corpus
by collecting every yaml fence containing `apiVersion:` regardless of path
comment: **54 of 60 yaml fences collected, 6 skipped, 2 errors**.

- The 6 skips are all legitimate incomplete excerpts, not a harness gap:
  `helm-package-management.mdx` has one real `{{ }}` Helm template and two
  partial snippets with no `apiVersion:`; `probes-liveness-readiness-startup.mdx`
  and `deployments-and-replicasets.mdx` each have one partial snippet with
  no `apiVersion:` either.
- The 2 errors are both real, expected gaps in treating an excerpt as a
  complete standalone manifest: `rbac-and-service-accounts.mdx` fence #6
  references a ServiceAccount created by a different fence earlier in the
  same lesson (`serviceaccount "checkout-app" not found` — true in
  isolated dry-run, not true reading the lesson in order);
  `operators-and-custom-resources.mdx` fence #2 applies a custom `Database`
  CRD instance from a docs-only,
  never-installed example CRD (`no matches for kind "Database"`) — the
  lesson is explicitly demonstrating what a CRD instance looks like, not
  asserting this CRD exists on this cluster.

Bash fences: 48 in the corpus today, all still skipped-no-path (no
`# scripts/*.sh` lessons yet). Ts fences: 0. See the harness's own final
report for the exact per-module breakdown at any given commit.
