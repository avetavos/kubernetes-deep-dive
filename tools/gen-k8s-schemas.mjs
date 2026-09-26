#!/usr/bin/env node
// Generates public/k8s-schemas/<group>-<version>-<Kind>.json — a strict,
// description-stripped JSON Schema draft-07 subset of the live cluster's
// real Kubernetes 1.37 OpenAPI v3 schema, for <K8sSchemaCheck>'s browser-side
// ajv validation (see src/components/k8s-schema-check-runtime.ts).
//
// Source of truth is the real API server (`kubectl get --raw /openapi/v3/...`
// against the shared `verify-k8s` cluster), not a hand-vendored swagger.json —
// this always matches whatever's actually running there. Re-run this script
// to refresh after a cluster/K8s version bump.
//
// Usage: node tools/gen-k8s-schemas.mjs [--context <kubectl-context>]

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'public', 'k8s-schemas');

const ctxFlagIdx = process.argv.indexOf('--context');
const CONTEXT = ctxFlagIdx >= 0 ? process.argv[ctxFlagIdx + 1] : 'kind-verify-k8s';

// The kinds this course teaches. group: '' = core (served from
// /openapi/v3/api/<version>, not /openapi/v3/apis/<group>/<version>).
const TARGETS = [
  { group: '', version: 'v1', kind: 'Pod' },
  { group: '', version: 'v1', kind: 'Service' },
  { group: '', version: 'v1', kind: 'ConfigMap' },
  { group: '', version: 'v1', kind: 'Secret' },
  { group: '', version: 'v1', kind: 'PersistentVolumeClaim' },
  { group: '', version: 'v1', kind: 'Namespace' },
  { group: '', version: 'v1', kind: 'ResourceQuota' },
  { group: '', version: 'v1', kind: 'LimitRange' },
  { group: '', version: 'v1', kind: 'ServiceAccount' },
  { group: 'apps', version: 'v1', kind: 'Deployment' },
  { group: 'apps', version: 'v1', kind: 'StatefulSet' },
  { group: 'apps', version: 'v1', kind: 'DaemonSet' },
  { group: 'batch', version: 'v1', kind: 'Job' },
  { group: 'batch', version: 'v1', kind: 'CronJob' },
  { group: 'networking.k8s.io', version: 'v1', kind: 'Ingress' },
  { group: 'networking.k8s.io', version: 'v1', kind: 'NetworkPolicy' },
  { group: 'gateway.networking.k8s.io', version: 'v1', kind: 'HTTPRoute' },
  { group: 'gateway.networking.k8s.io', version: 'v1', kind: 'Gateway' },
  { group: 'storage.k8s.io', version: 'v1', kind: 'StorageClass' },
  { group: 'autoscaling', version: 'v2', kind: 'HorizontalPodAutoscaler' },
  { group: 'policy', version: 'v1', kind: 'PodDisruptionBudget' },
  { group: 'rbac.authorization.k8s.io', version: 'v1', kind: 'Role' },
  { group: 'rbac.authorization.k8s.io', version: 'v1', kind: 'RoleBinding' },
  { group: 'rbac.authorization.k8s.io', version: 'v1', kind: 'ClusterRole' },
  { group: 'rbac.authorization.k8s.io', version: 'v1', kind: 'ClusterRoleBinding' },
  { group: 'scheduling.k8s.io', version: 'v1', kind: 'PriorityClass' },
  { group: 'admissionregistration.k8s.io', version: 'v1', kind: 'ValidatingAdmissionPolicy' },
];

// Removed/renamed apiVersions a reader might still paste from stale training
// data or an old blog post. `replacement: null` means genuinely removed with
// no direct successor (K8sSchemaCheck surfaces `note` instead of a schema).
const REMOVED = [
  { apiVersion: 'extensions/v1beta1', kind: 'Deployment', replacement: 'apps/v1' },
  { apiVersion: 'extensions/v1beta1', kind: 'DaemonSet', replacement: 'apps/v1' },
  { apiVersion: 'extensions/v1beta1', kind: 'ReplicaSet', replacement: 'apps/v1' },
  { apiVersion: 'extensions/v1beta1', kind: 'Ingress', replacement: 'networking.k8s.io/v1' },
  { apiVersion: 'extensions/v1beta1', kind: 'NetworkPolicy', replacement: 'networking.k8s.io/v1' },
  {
    apiVersion: 'extensions/v1beta1', kind: 'PodSecurityPolicy', replacement: null,
    note: 'PodSecurityPolicy was removed entirely in Kubernetes 1.25 (no direct successor kind) — use Pod Security Admission (namespace labels pod-security.kubernetes.io/enforce) instead.',
  },
  { apiVersion: 'apps/v1beta1', kind: 'Deployment', replacement: 'apps/v1' },
  { apiVersion: 'apps/v1beta2', kind: 'Deployment', replacement: 'apps/v1' },
  { apiVersion: 'batch/v1beta1', kind: 'CronJob', replacement: 'batch/v1' },
  { apiVersion: 'networking.k8s.io/v1beta1', kind: 'Ingress', replacement: 'networking.k8s.io/v1' },
  { apiVersion: 'policy/v1beta1', kind: 'PodDisruptionBudget', replacement: 'policy/v1' },
  {
    apiVersion: 'policy/v1beta1', kind: 'PodSecurityPolicy', replacement: null,
    note: 'PodSecurityPolicy was removed entirely in Kubernetes 1.25 (no direct successor kind) — use Pod Security Admission (namespace labels pod-security.kubernetes.io/enforce) instead.',
  },
];

function fetchRaw(rawPath) {
  const out = execFileSync('kubectl', ['--context', CONTEXT, 'get', '--raw', rawPath], {
    maxBuffer: 1024 * 1024 * 128,
  });
  return JSON.parse(out.toString('utf8'));
}

function groupDocPath(group, version) {
  return group === '' ? `/openapi/v3/api/${version}` : `/openapi/v3/apis/${group}/${version}`;
}

function findRootKey(schemas, group, version, kind) {
  for (const [name, s] of Object.entries(schemas)) {
    const gvks = s['x-kubernetes-group-version-kind'];
    if (!Array.isArray(gvks)) continue;
    if (gvks.some((gvk) => gvk.group === group && gvk.version === version && gvk.kind === kind)) return name;
  }
  return null;
}

// Strips everything that doesn't affect validation (descriptions, defaults,
// examples, titles, x-kubernetes-* vendor extensions) and rewrites $ref to a
// local `#/definitions/...` bag, collecting the transitive closure of
// referenced schemas as it goes (`defs` is mutated in place).
function convert(node, schemas, defs) {
  if (node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((n) => convert(n, schemas, defs));

  if (typeof node.$ref === 'string') {
    const name = node.$ref.replace('#/components/schemas/', '');
    collect(name, schemas, defs);
    return { $ref: `#/definitions/${name}` };
  }

  // Flatten the common `{ default: {}, allOf: [{ $ref }] }` embedding pattern
  // to a bare $ref: additionalProperties:false only restricts keys listed on
  // the SAME schema object, so wrapping a single $ref in allOf buys nothing
  // here and only costs bytes.
  const keys = Object.keys(node);
  if (
    Array.isArray(node.allOf) && node.allOf.length === 1 && typeof node.allOf[0].$ref === 'string' &&
    keys.every((k) => ['allOf', 'description', 'default', 'title'].includes(k))
  ) {
    return convert(node.allOf[0], schemas, defs);
  }

  const out = {};
  for (const [key, val] of Object.entries(node)) {
    if (['description', 'default', 'example', 'title'].includes(key)) continue;
    if (key.startsWith('x-kubernetes-')) continue; // preserve-unknown-fields handled below; the rest is generation-time-only metadata
    if (key === 'properties') {
      out.properties = {};
      for (const [pk, pv] of Object.entries(val)) out.properties[pk] = convert(pv, schemas, defs);
      continue;
    }
    if (key === 'additionalProperties' && val && typeof val === 'object') {
      out.additionalProperties = convert(val, schemas, defs);
      continue;
    }
    if (['items', 'allOf', 'oneOf', 'anyOf', 'not'].includes(key)) {
      out[key] = convert(val, schemas, defs);
      continue;
    }
    out[key] = val;
  }
  if (node['x-kubernetes-preserve-unknown-fields'] === true && out.type === 'object') {
    out.additionalProperties = true; // deliberately opaque field (e.g. a CRD's arbitrary status) — can't validate it, don't reject it
  } else if (out.type === 'object' && out.properties && !('additionalProperties' in out)) {
    out.additionalProperties = false; // strict mode: unknown-field detection is the whole point of this tool
  }
  return out;
}

function collect(name, schemas, defs) {
  if (defs.has(name)) return;
  const raw = schemas[name];
  if (!raw) throw new Error(`schema not found: ${name}`);
  defs.set(name, null); // placeholder breaks reference cycles (e.g. JSONSchemaProps recursion)
  defs.set(name, convert(raw, schemas, defs));
}

function genOne(target) {
  const doc = fetchRaw(groupDocPath(target.group, target.version));
  const schemas = doc.components.schemas;
  const rootKey = findRootKey(schemas, target.group, target.version, target.kind);
  if (!rootKey) throw new Error(`no schema for ${target.group}/${target.version} ${target.kind}`);
  const defs = new Map();
  collect(rootKey, schemas, defs);
  const definitions = {};
  for (const [k, v] of defs) definitions[k] = v;
  const out = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $ref: `#/definitions/${rootKey}`,
    definitions,
  };
  const groupSlug = target.group === '' ? 'core' : target.group;
  const file = `${groupSlug}-${target.version}-${target.kind}.json`;
  const json = JSON.stringify(out);
  writeFileSync(path.join(OUT_DIR, file), json);
  const apiVersion = target.group === '' ? target.version : `${target.group}/${target.version}`;
  return { apiVersion, kind: target.kind, file, bytes: Buffer.byteLength(json) };
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const f of readdirSync(OUT_DIR)) rmSync(path.join(OUT_DIR, f), { force: true });

  const kinds = [];
  let total = 0;
  for (const target of TARGETS) {
    const entry = genOne(target);
    kinds.push({ apiVersion: entry.apiVersion, kind: entry.kind, file: entry.file });
    total += entry.bytes;
    console.log(`  ${entry.apiVersion} ${entry.kind} -> ${entry.file} (${(entry.bytes / 1024).toFixed(1)} KiB)`);
  }

  const index = {
    generatedAt: new Date().toISOString(),
    k8sVersion: '1.37',
    kinds,
    removed: REMOVED,
  };
  const indexJson = JSON.stringify(index, null, 0);
  writeFileSync(path.join(OUT_DIR, 'index.json'), indexJson);
  total += Buffer.byteLength(indexJson);

  console.log(`\n${kinds.length} kinds, total payload ${(total / 1024).toFixed(1)} KiB (${(total / 1024 / 1024).toFixed(2)} MiB)`);
  if (total > 2 * 1024 * 1024) {
    console.error('OVER 2 MiB budget — trim TARGETS or split further.');
    process.exitCode = 1;
  }
}

main();
