#!/usr/bin/env node
// Manifest-verification harness for the bilingual Kubernetes Deep Dive course.
//
// Unlike the Astro/Svelte/React/Next sibling courses (which check that a
// CODE snippet compiles against the framework the course teaches), this
// course teaches Kubernetes YAML — the only real proof that a lesson's
// manifest is correct is a real API server: `kubectl apply --dry-run=server`
// against a real `kind` cluster runs full OpenAPI schema validation *and*
// every admission plugin (so a removed API version, an immutable-field
// change, or a missing CRD produces the exact same error a reader would hit
// copy-pasting the lesson). This harness owns that cluster (`verify-k8s`,
// reused across runs and across agents — see the concurrency note below)
// the same way the Astro course's `tools/verify-snippets.mjs` owns a
// throwaway Astro project ("the probe"): create once, reuse by default,
// `--fresh` to rebuild.
//
// The fence-collection scanner (parseStringAt/scanBalanced/quiz-array and
// SpotTheBug exclusion) is ported from this repo's own
// tools/check-parity.mjs, which already implements exactly this
// depth-first string/bracket walk to keep a quiz's `export const x = [...]`
// or a `<SpotTheBug code={`...`}>` template literal from confusing a naive
// ``` fence regex — same technique astro-deep-dive's verify-snippets.mjs
// ported into itself, reused here rather than re-derived.
//
// Fence convention (spec §1/§5):
//   ```yaml   first line `# k8s/<...>.yaml` (optionally ` <trailing note>`)
//   ```bash   first line `# scripts/<name>.sh`
//   ```ts     first line `// src/<...>.ts`
// A first line containing `@expect-error` is a deliberate-error demo (the
// lesson prose carries the real server error) and is skipped, not applied.
// Anything else — no recognized path comment — is a skipped fragment.
//
// Usage:
//   node tools/verify-manifests.mjs                  dry-run=server every collected
//                                                     yaml fence, bash -n every bash
//                                                     fence, tsc --noEmit ts fences
//                                                     (auto, see --ts below)
//   node tools/verify-manifests.mjs --all-yaml        ALSO collect any yaml fence
//                                                     containing `apiVersion:` (skips
//                                                     `{{` Helm-template fences) even
//                                                     with no path comment — baseline
//                                                     mode for a corpus that hasn't
//                                                     added path comments yet
//   node tools/verify-manifests.mjs --ts              force the tsc probe step even if
//                                                     no ts fence was collected (it
//                                                     always runs when one exists)
//   node tools/verify-manifests.mjs --fresh           delete + recreate verify-k8s first
//   node tools/verify-manifests.mjs --delete          delete verify-k8s and exit
//   node tools/verify-manifests.mjs --apply <module>/<lesson>
//                                                     real apply into a fresh temp
//                                                     namespace, wait/get/events, delete
//   node tools/verify-manifests.mjs --self-test       harness self-check (see selfTest())
//
// Concurrency: several agents can share the verify-k8s cluster at once —
// each lesson gets its own `<module>--<lesson>` namespace, so ordinary runs
// never collide. NEVER run `--fresh`/`--delete` while another agent may be
// mid-run against the shared cluster; an agent that wants to poke at the
// cluster interactively (not just run this harness) should create its OWN
// kind cluster instead. Set VERIFY_K8S_CLUSTER to point this harness at a
// different cluster name (e.g. for exactly that kind of isolated poking).

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, mkdtempSync, globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DOCS_EN = path.join(REPO_ROOT, 'src/content/docs/en');
const PROBE_DIR = path.join(REPO_ROOT, 'tools/probe');
const PROBE_LESSONS_DIR = path.join(PROBE_DIR, 'src/lessons');
const CLUSTER_JSON = path.join(PROBE_DIR, 'cluster.json');
const KIND_CONFIG_PATH = path.join(PROBE_DIR, 'kind-config.yaml');
const TSC_BIN = path.join(PROBE_DIR, 'node_modules/.bin/tsc');

const CLUSTER_NAME = process.env.VERIFY_K8S_CLUSTER || 'verify-k8s';

// Pinned per spec §5 — checked against the real GitHub releases API for
// this repo at authoring time (github.com/kubernetes-sigs/gateway-api and
// github.com/kubernetes-csi/external-snapshotter `/releases/latest`); bump
// both here and in the comment together if the course is re-baselined.
const GATEWAY_API_VERSION = 'v1.6.2';
const EXTERNAL_SNAPSHOTTER_VERSION = 'v8.6.0';
const GATEWAY_API_URL = `https://github.com/kubernetes-sigs/gateway-api/releases/download/${GATEWAY_API_VERSION}/standard-install.yaml`;
const SNAPSHOTTER_KUSTOMIZE = `github.com/kubernetes-csi/external-snapshotter/client/config/crd?ref=${EXTERNAL_SNAPSHOTTER_VERSION}`;

const KIND_CONFIG_SRC = `# Generated by tools/verify-manifests.mjs — safe to regenerate, do not hand-edit.
# 3 nodes (1 control-plane + 2 workers) so topologySpreadConstraints /
# podAntiAffinity lessons have real multi-node spread to prove against. No
# extraPortMappings — this cluster is only ever reached via kubectl, never
# a host port, so agents sharing it never collide on ports.
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
  - role: worker
  - role: worker
`;

// ---------------------------------------------------------------------------
// String/bracket scanning helpers — ported verbatim from this repo's own
// tools/check-parity.mjs (parseStringAt/scanBalanced), which already solves
// "walk the source honoring string literals so brackets/backticks inside a
// quiz array or a SpotTheBug template literal never look like real
// structure". Reused rather than reinvented, per astro-deep-dive's own
// verify-snippets.mjs doing the same port.
// ---------------------------------------------------------------------------

function parseStringAt(text, i) {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === quote) {
      j++;
      break;
    }
    j++;
  }
  return { end: j };
}

function scanBalanced(text, start, open, close) {
  let depth = 1;
  let i = start;
  while (i < text.length && depth > 0) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      i = parseStringAt(text, i).end;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) depth--;
    i++;
  }
  return i;
}

function findExcludedRanges(src) {
  const ranges = [];
  {
    const re = /export\s+const\s+\w+\s*=\s*\[/g;
    let m;
    while ((m = re.exec(src))) {
      const end = scanBalanced(src, re.lastIndex, '[', ']');
      ranges.push([m.index, end]);
      re.lastIndex = end;
    }
  }
  {
    const re = /<SpotTheBug\s+code=\{\s*`/g;
    let m;
    while ((m = re.exec(src))) {
      const backtickIdx = m.index + m[0].length - 1;
      const { end } = parseStringAt(src, backtickIdx);
      ranges.push([m.index, end]);
      re.lastIndex = end;
    }
  }
  return ranges;
}

function stripExcluded(src, ranges) {
  if (!ranges.length) return src;
  ranges.sort((a, b) => a[0] - b[0]);
  let out = '';
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start < cursor) continue;
    out += src.slice(cursor, start);
    out += src.slice(start, end).replace(/[^\n]/g, '');
    cursor = end;
  }
  out += src.slice(cursor);
  return out;
}

// ---------------------------------------------------------------------------
// Fence collection
// ---------------------------------------------------------------------------

const FENCE_LANGS = new Set(['yaml', 'yml', 'bash', 'sh', 'ts']);

const YAML_PATH_RE = /^# (k8s\/[\w@.\-/]+\.yaml)(?:\s+\S.*)?$/;
const BASH_PATH_RE = /^# (scripts\/[\w@.\-/]+\.sh)(?:\s+\S.*)?$/;
const TS_PATH_RE = /^\/\/ (src\/[\w@.\-/]+\.ts)(?:\s+\S.*)?$/;

function fenceKind(lang) {
  if (lang === 'yaml' || lang === 'yml') return 'yaml';
  if (lang === 'bash' || lang === 'sh') return 'bash';
  return 'ts';
}

// Collect every fenced code block in one MDX file. Returns
// [{ fenceNum, kind, line, category, path?, body? }], fenceNum is 1-based
// over ALL real fences (any language) in document order — matches what a
// human counts reading the rendered lesson top to bottom.
function collectFences(rawSrc, { allYaml = false } = {}) {
  const src = stripExcluded(rawSrc, findExcludedRanges(rawSrc));
  const fenceRe = /```([\w-]*)[^\n]*\n([\s\S]*?)```/g;
  const results = [];
  let fenceNum = 0;
  let m;
  while ((m = fenceRe.exec(src))) {
    fenceNum++;
    const lang = m[1];
    if (!FENCE_LANGS.has(lang)) continue;
    const body = m[2];
    const firstLine = body.split('\n', 1)[0].trim();
    const kind = fenceKind(lang);

    if (firstLine.includes('@expect-error')) {
      results.push({ fenceNum, kind, category: 'expect-error' });
      continue;
    }

    if (kind === 'yaml') {
      const pm = YAML_PATH_RE.exec(firstLine);
      if (pm) {
        results.push({ fenceNum, kind, category: 'collected', path: pm[1], body });
      } else if (allYaml && /apiVersion:/.test(body) && !body.includes('{{')) {
        results.push({ fenceNum, kind, category: 'collected', path: `(all-yaml fence #${fenceNum})`, body });
      } else {
        results.push({ fenceNum, kind, category: 'skipped-no-path' });
      }
      continue;
    }

    if (kind === 'bash') {
      const pm = BASH_PATH_RE.exec(firstLine);
      if (pm) results.push({ fenceNum, kind, category: 'collected', path: pm[1], body });
      else results.push({ fenceNum, kind, category: 'skipped-no-path' });
      continue;
    }

    // ts
    const pm = TS_PATH_RE.exec(firstLine);
    if (pm) results.push({ fenceNum, kind, category: 'collected', path: pm[1], body });
    else results.push({ fenceNum, kind, category: 'skipped-no-path' });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Lesson discovery
// ---------------------------------------------------------------------------

function discoverLessons() {
  const rels = globSync('**/*.mdx', { cwd: DOCS_EN }).sort();
  return rels.map((rel) => {
    const posixRel = rel.replaceAll('\\', '/');
    const module = posixRel.split('/')[0];
    const lesson = path.basename(posixRel, '.mdx');
    return {
      absPath: path.join(DOCS_EN, rel),
      mdxRelPath: `src/content/docs/en/${posixRel}`,
      module,
      lesson,
      namespace: sanitizeNs(`${module}--${lesson}`),
    };
  });
}

// DNS-1123 label: lowercase alphanumeric or '-', 63 chars max. Course
// module/lesson names are already kebab-case, so this is a defensive
// no-op in practice — kept cheap and unconditional rather than trusted.
function sanitizeNs(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

// ---------------------------------------------------------------------------
// kubectl/kind process helpers
// ---------------------------------------------------------------------------

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

function firstLine(s) {
  return (s ?? '').split('\n').find((l) => l.trim().length > 0)?.trim() ?? '(no output)';
}

function kubectlGetNs(ns) {
  return run('kubectl', ['get', 'namespace', ns]).status === 0;
}

// Idempotent: create the namespace if it doesn't already exist. Tolerates a
// race against another agent creating the same namespace concurrently
// (AlreadyExists is not an error here).
function ensureNamespace(ns) {
  if (kubectlGetNs(ns)) return;
  const res = run('kubectl', ['create', 'namespace', ns]);
  if (res.status !== 0 && !(res.stderr ?? '').includes('AlreadyExists')) {
    console.error(`failed to create namespace ${ns}: ${firstLine(res.stderr)}`);
    process.exit(1);
  }
}

let clusterScopedKindsCache = null;
function clusterScopedKinds() {
  if (clusterScopedKindsCache) return clusterScopedKindsCache;
  const res = run('kubectl', ['api-resources', '--namespaced=false', '--no-headers']);
  const set = new Set();
  for (const line of (res.stdout ?? '').split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length >= 2) set.add(fields.at(-1)); // KIND is always the last column
  }
  clusterScopedKindsCache = set;
  return set;
}

// A fence's docs, split on document separators — used only to sniff
// `kind:`/`metadata.namespace`/`metadata.name`, never to decide what gets
// written to the temp file (kubectl apply -f handles multi-doc yaml
// natively, so the fence body is always applied whole, unsplit).
// ponytail: regex field-sniffing, not a real YAML parser — ceiling is
// anchors/multi-line scalars/a `namespace:`-or-`name:` key outside
// metadata; upgrade to js-yaml if a lesson's manifest ever needs it.
function splitDocs(body) {
  return body
    .split(/^---\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
}

function docKind(doc) {
  return /^kind:\s*(\S+)/m.exec(doc)?.[1];
}

function docNamespace(doc) {
  return /^\s*namespace:\s*['"]?([\w.-]+)/m.exec(doc)?.[1];
}

function docName(doc) {
  return /^\s*name:\s*['"]?([\w.-]+)/m.exec(doc)?.[1];
}

// Fence-level (not per-doc) per spec: a fence applied without -n if ANY of
// its documents declares its own namespace or is a cluster-scoped kind.
function appliesWithoutNamespace(body, scopedKinds) {
  return splitDocs(body).some((doc) => {
    const kind = docKind(doc);
    return (kind && scopedKinds.has(kind)) || Boolean(docNamespace(doc));
  });
}

// Namespaces a lesson's fences reference but don't necessarily declare
// themselves (metadata.namespace: shop) or explicitly declare (kind:
// Namespace) — pre-created for real before any dry-run apply in the
// lesson, since NamespaceLifecycle admission rejects a namespaced create
// (even dry-run) against a namespace that doesn't exist.
function referencedNamespaces(fences) {
  const set = new Set();
  for (const f of fences) {
    for (const doc of splitDocs(f.body)) {
      const ns = docNamespace(doc);
      if (ns) set.add(ns);
      if (docKind(doc) === 'Namespace') {
        const name = docName(doc);
        if (name) set.add(name);
      }
    }
  }
  return set;
}

function writeTemp(prefix, ext, content) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(dir, `fence${ext}`);
  writeFileSync(file, content);
  return { dir, file };
}

// ---------------------------------------------------------------------------
// Cluster lifecycle
// ---------------------------------------------------------------------------

function existingClusters() {
  return (run('kind', ['get', 'clusters']).stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
}

function installCrds() {
  console.log(`installing CRDs: Gateway API ${GATEWAY_API_VERSION} (standard channel), external-snapshotter ${EXTERNAL_SNAPSHOTTER_VERSION}...`);
  const gw = run('kubectl', ['apply', '-f', GATEWAY_API_URL], { stdio: 'inherit' });
  const snap = run('kubectl', ['apply', '-k', SNAPSHOTTER_KUSTOMIZE], { stdio: 'inherit' });
  if (gw.status !== 0 || snap.status !== 0) {
    console.error('CRD install failed — cluster is up but some lessons (Gateway API / VolumeSnapshot) will not validate.');
    process.exit(1);
  }
  mkdirSync(PROBE_DIR, { recursive: true });
  writeFileSync(
    CLUSTER_JSON,
    JSON.stringify(
      {
        cluster: CLUSTER_NAME,
        createdAt: new Date().toISOString(),
        gatewayApi: GATEWAY_API_VERSION,
        externalSnapshotter: EXTERNAL_SNAPSHOTTER_VERSION,
      },
      null,
      2,
    ) + '\n',
  );
}

// Ensures verify-k8s (or $VERIFY_K8S_CLUSTER) exists and kubectl's
// current-context points at it. Installs the pinned CRD set only right
// after creation (spec: "record installed versions ... so a reuse run can
// tell") — a reused cluster's CRDs are NOT reinstalled every run; this
// function just reports what's on record for it.
function ensureCluster({ fresh = false } = {}) {
  let exists = existingClusters().includes(CLUSTER_NAME);
  if (fresh && exists) {
    console.log(`--fresh: deleting existing cluster ${CLUSTER_NAME}...`);
    run('kind', ['delete', 'cluster', '--name', CLUSTER_NAME], { stdio: 'inherit' });
    exists = false;
  }
  if (!exists) {
    console.log(`creating cluster ${CLUSTER_NAME} (1 control-plane + 2 workers)...`);
    mkdirSync(PROBE_DIR, { recursive: true });
    writeFileSync(KIND_CONFIG_PATH, KIND_CONFIG_SRC);
    const create = run('kind', ['create', 'cluster', '--name', CLUSTER_NAME, '--config', KIND_CONFIG_PATH], { stdio: 'inherit' });
    if (create.status !== 0) {
      console.error(`kind create cluster failed`);
      process.exit(1);
    }
    installCrds();
  } else {
    run('kubectl', ['config', 'use-context', `kind-${CLUSTER_NAME}`]);
    if (existsSync(CLUSTER_JSON)) {
      const info = JSON.parse(readFileSync(CLUSTER_JSON, 'utf8'));
      console.log(
        `reusing cluster ${CLUSTER_NAME} (Gateway API ${info.gatewayApi}, external-snapshotter ${info.externalSnapshotter}, created ${info.createdAt})`,
      );
    } else {
      console.log(`reusing cluster ${CLUSTER_NAME} (no tools/probe/cluster.json on record — CRD versions unknown; --fresh to rebuild with known versions)`);
    }
  }
}

function deleteMode() {
  if (!existingClusters().includes(CLUSTER_NAME)) {
    console.log(`no cluster named ${CLUSTER_NAME} to delete`);
    process.exit(0);
  }
  run('kind', ['delete', 'cluster', '--name', CLUSTER_NAME], { stdio: 'inherit' });
  rmSync(CLUSTER_JSON, { force: true });
  process.exit(0);
}

// ---------------------------------------------------------------------------
// ts probe (tools/probe/): tiny tsc-only project, gitignored, scaffolded on
// demand the first time a `// src/*.ts` fence needs type-checking.
// ---------------------------------------------------------------------------

const PROBE_PACKAGE_JSON = {
  name: 'verify-manifests-probe',
  private: true,
  type: 'module',
  devDependencies: { '@kubernetes/client-node': '^2.0.0', typescript: '^7.0.2' },
};

const PROBE_TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    esModuleInterop: true,
    forceConsistentCasingInFileNames: true,
  },
  include: ['src/**/*'],
};

function ensureTsProbe() {
  mkdirSync(PROBE_DIR, { recursive: true });
  writeFileSync(path.join(PROBE_DIR, 'package.json'), JSON.stringify(PROBE_PACKAGE_JSON, null, 2) + '\n');
  writeFileSync(path.join(PROBE_DIR, 'tsconfig.json'), JSON.stringify(PROBE_TSCONFIG, null, 2) + '\n');
  if (!existsSync(path.join(PROBE_DIR, 'node_modules'))) {
    console.log('tools/probe/node_modules missing — npm install (@kubernetes/client-node@2, typescript)...');
    const install = run('npm', ['install'], { cwd: PROBE_DIR, stdio: 'inherit' });
    if (install.status !== 0) {
      console.error('probe npm install failed');
      process.exit(1);
    }
  }
}

const TSC_DIAG_RE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/gm;

// Writes every collected ts fence to tools/probe/src/lessons/<ns>/<rest>,
// runs one `tsc --noEmit`, maps diagnostics back to `lesson.mdx:fence #n`.
// Returns [{ mdx, fenceNum, path, message }] — empty means all fences
// type-checked clean.
function runTsProbe(tsFencesByLesson) {
  ensureTsProbe();
  rmSync(PROBE_LESSONS_DIR, { recursive: true, force: true });
  mkdirSync(PROBE_LESSONS_DIR, { recursive: true });

  const owner = new Map(); // "src/lessons/<ns>/<rest>" -> { mdxRelPath, fenceNum }
  for (const { lesson, fences } of tsFencesByLesson) {
    const ns = sanitizeNs(`${lesson.module}__${lesson.lesson}`);
    for (const f of fences) {
      const rest = f.path.slice('src/'.length);
      const relPath = path.posix.join('src/lessons', ns, rest);
      const destAbs = path.join(PROBE_DIR, relPath);
      mkdirSync(path.dirname(destAbs), { recursive: true });
      writeFileSync(destAbs, f.body);
      owner.set(relPath, { mdxRelPath: lesson.mdxRelPath, fenceNum: f.fenceNum, path: f.path });
    }
  }

  const res = run(TSC_BIN, ['--noEmit', '--pretty', 'false'], { cwd: PROBE_DIR });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const errors = [];
  let m;
  while ((m = TSC_DIAG_RE.exec(out))) {
    const [, file, , , code, message] = m;
    const norm = file.replaceAll('\\', '/');
    const info = owner.get(norm);
    if (info) errors.push({ mdx: info.mdxRelPath, fenceNum: info.fenceNum, path: info.path, message: `${code}: ${message}` });
    else errors.push({ mdx: '[unmapped]', fenceNum: 0, path: norm, message: `${code}: ${message}` });
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Default (and --all-yaml) mode
// ---------------------------------------------------------------------------

function verifyLesson(lesson, fences, { apply = false, applyNs = null } = {}) {
  const errors = [];
  const scopedKinds = clusterScopedKinds();
  const ns = apply ? applyNs : lesson.namespace;

  ensureNamespace(ns);
  for (const extraNs of referencedNamespaces(fences.filter((f) => f.kind === 'yaml' && f.category === 'collected'))) {
    ensureNamespace(extraNs);
  }

  for (const f of fences) {
    if (f.category !== 'collected') continue;

    if (f.kind === 'yaml') {
      const { dir, file } = writeTemp('verify-manifests-yaml-', '.yaml', f.body);
      const withoutNs = appliesWithoutNamespace(f.body, scopedKinds);
      const args = ['apply'];
      if (!apply) args.push('--dry-run=server');
      else if (withoutNs) args.push('--dry-run=server'); // cluster-scoped in --apply: dry-run only, see README
      if (!withoutNs) args.push('-n', ns);
      args.push('-f', file);
      const res = run('kubectl', args);
      rmSync(dir, { recursive: true, force: true });
      if (res.status !== 0) {
        errors.push(`error ${lesson.mdxRelPath}:fence #${f.fenceNum} (${f.path}) — ${firstLine(res.stderr)}`);
      }
      continue;
    }

    if (f.kind === 'bash') {
      const { dir, file } = writeTemp('verify-manifests-sh-', '.sh', f.body);
      const res = run('bash', ['-n', file]);
      rmSync(dir, { recursive: true, force: true });
      if (res.status !== 0) {
        errors.push(`error ${lesson.mdxRelPath}:fence #${f.fenceNum} (${f.path}) — ${firstLine(res.stderr)}`);
      }
    }
    // ts fences are handled in one batch by runTsProbe, not here.
  }

  return errors;
}

function printStats(stats) {
  console.log('\nPer-module fence summary (collected / skipped-no-path / expect-error / bash / ts):');
  const totals = { collected: 0, skippedNoPath: 0, expectError: 0, bash: 0, ts: 0 };
  for (const [module, c] of [...stats.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${module}: ${c.collected} / ${c.skippedNoPath} / ${c.expectError} / ${c.bash} / ${c.ts}`);
    for (const k of Object.keys(totals)) totals[k] += c[k];
  }
  console.log(
    `  TOTAL: ${totals.collected} / ${totals.skippedNoPath} / ${totals.expectError} / ${totals.bash} / ${totals.ts}`,
  );
}

function defaultMode({ allYaml, forceTs, fresh }) {
  ensureCluster({ fresh });

  const lessons = discoverLessons();
  const stats = new Map();
  const allErrors = [];
  const tsFencesByLesson = [];

  for (const lesson of lessons) {
    const counters = stats.get(lesson.module) ?? { collected: 0, skippedNoPath: 0, expectError: 0, bash: 0, ts: 0 };
    stats.set(lesson.module, counters);

    const src = readFileSync(lesson.absPath, 'utf8');
    const fences = collectFences(src, { allYaml });

    const tsFences = [];
    for (const f of fences) {
      if (f.category === 'expect-error') counters.expectError++;
      else if (f.category === 'skipped-no-path') counters.skippedNoPath++;
      else if (f.category === 'collected') {
        if (f.kind === 'yaml') counters.collected++;
        else if (f.kind === 'bash') counters.bash++;
        else if (f.kind === 'ts') {
          counters.ts++;
          tsFences.push(f);
        }
      }
    }
    if (tsFences.length) tsFencesByLesson.push({ lesson, fences: tsFences });

    allErrors.push(...verifyLesson(lesson, fences));
  }

  const anyTs = tsFencesByLesson.some((l) => l.fences.length > 0);
  if (forceTs || anyTs) {
    if (!anyTs) console.log('\n--ts passed but no ts fence was collected — nothing to type-check.');
    else {
      const tsErrors = runTsProbe(tsFencesByLesson);
      for (const e of tsErrors) allErrors.push(`error ${e.mdx}:fence #${e.fenceNum} (${e.path}) — ${e.message}`);
    }
  }

  if (allErrors.length) {
    console.log(`\n${allErrors.length} error(s):\n`);
    for (const e of allErrors) console.log(e);
  } else {
    console.log('\nno errors.');
  }
  printStats(stats);
  process.exit(allErrors.length ? 1 : 0);
}

// ---------------------------------------------------------------------------
// --apply <module>/<lesson>
// ---------------------------------------------------------------------------

function applyMode(target, { allYaml }) {
  if (!target) {
    console.error('usage: node tools/verify-manifests.mjs --apply <module>/<lesson>');
    process.exit(1);
  }
  const parts = target.split('/');
  const lesson = parts.pop();
  const module = parts.join('/');
  const mdxAbs = path.join(DOCS_EN, module, `${lesson}.mdx`);
  if (!existsSync(mdxAbs)) {
    console.error(`lesson not found: ${mdxAbs}`);
    process.exit(1);
  }

  ensureCluster({});

  const ns = sanitizeNs(`apply--${lesson}--${crypto.randomBytes(3).toString('hex')}`);
  const fences = collectFences(readFileSync(mdxAbs, 'utf8'), { allYaml });
  const lessonDescriptor = { module, lesson, mdxRelPath: `src/content/docs/en/${module}/${lesson}.mdx`, namespace: ns };

  console.log(`--apply ${target}: real apply into ${ns}`);
  let errors = [];
  try {
    errors = verifyLesson(lessonDescriptor, fences, { apply: true, applyNs: ns });

    const wait = run('kubectl', ['wait', '--for=condition=Ready', 'pod', '--all', '-n', ns, '--timeout=90s']);
    console.log(`\nkubectl wait: ${(wait.stdout ?? '').trim() || (wait.stderr ?? '').trim() || '(no pods)'}`);

    const getAll = run('kubectl', ['get', 'all', '-n', ns]);
    console.log(`\nkubectl get all -n ${ns}:\n${getAll.stdout ?? getAll.stderr ?? ''}`);

    const events = run('kubectl', ['get', 'events', '-n', ns, '--sort-by=.lastTimestamp']);
    const eventLines = (events.stdout ?? '').split('\n');
    console.log(`\nkubectl get events -n ${ns} (last 20):\n${eventLines.slice(-21).join('\n')}`);
  } finally {
    console.log(`\ndeleting namespace ${ns}...`);
    run('kubectl', ['delete', 'namespace', ns, '--wait=false']);
  }

  if (errors.length) {
    console.log(`\n${errors.length} error(s):\n${errors.join('\n')}`);
  }
  process.exit(errors.length ? 1 : 0);
}

// ---------------------------------------------------------------------------
// --self-test
// ---------------------------------------------------------------------------

function selfTest() {
  ensureCluster({});

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'verify-manifests-selftest-'));
  const mdxPath = path.join(tmpDir, 'self.mdx');
  writeFileSync(
    mdxPath,
    [
      '---',
      'title: selftest',
      '---',
      '',
      '```yaml',
      '# k8s/self/good.yaml',
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata:',
      '  name: good',
      'spec:',
      '  replicas: 1',
      '  selector: { matchLabels: { app: good } }',
      '  template:',
      '    metadata: { labels: { app: good } }',
      '    spec: { containers: [{ name: app, image: nginx:1.27 }] }',
      '```',
      '',
      '```yaml',
      '# k8s/self/bad.yaml',
      'apiVersion: extensions/v1beta1',
      'kind: Deployment',
      'metadata:',
      '  name: bad',
      'spec:',
      '  replicas: 1',
      '```',
      '',
      '```yaml',
      '# @expect-error the field manager conflict shown in the lesson prose',
      'apiVersion: v1',
      'kind: ConfigMap',
      'metadata: { name: nope }',
      '```',
      '',
      '```yaml',
      '# k8s/self/multi.yaml',
      'apiVersion: v1',
      'kind: ConfigMap',
      'metadata: { name: cm-a }',
      '---',
      'apiVersion: v1',
      'kind: ConfigMap',
      'metadata: { name: cm-b }',
      '```',
      '',
      '```yaml',
      '# k8s/self/other-ns.yaml',
      'apiVersion: v1',
      'kind: ConfigMap',
      'metadata:',
      '  name: cm-other',
      '  namespace: other',
      '```',
      '',
    ].join('\n'),
  );

  const lesson = {
    absPath: mdxPath,
    mdxRelPath: 'selftest/self.mdx',
    module: '__selftest__',
    lesson: 'self',
    namespace: sanitizeNs('__selftest__--self'),
  };
  const fences = collectFences(readFileSync(mdxPath, 'utf8'));
  const otherNsExistedBefore = kubectlGetNs('other');
  const errors = verifyLesson(lesson, fences);

  const goodFailed = errors.some((e) => e.includes('(k8s/self/good.yaml)'));
  const badFailed = errors.some((e) => e.includes('(k8s/self/bad.yaml)'));
  const multiFailed = errors.some((e) => e.includes('(k8s/self/multi.yaml)'));
  const otherNsFailed = errors.some((e) => e.includes('(k8s/self/other-ns.yaml)'));
  const expectErrorSkipped = fences.find((f) => f.category === 'expect-error') !== undefined;
  const otherNsCreated = kubectlGetNs('other');

  rmSync(tmpDir, { recursive: true, force: true });
  run('kubectl', ['delete', 'namespace', lesson.namespace, '--wait=false']);
  if (!otherNsExistedBefore) run('kubectl', ['delete', 'namespace', 'other', '--wait=false']);

  const ok = !goodFailed && badFailed && !multiFailed && !otherNsFailed && expectErrorSkipped && otherNsCreated;
  const detail = { goodFailed, badFailed, multiFailed, otherNsFailed, expectErrorSkipped, otherNsCreated, errors };
  if (ok) {
    console.log(
      '\nself-test: PASS (good Deployment passed dry-run=server, bad Deployment [removed extensions/v1beta1] ' +
        'failed with the server\'s own error, @expect-error fence skipped, multi-doc fence applied clean, ' +
        'metadata.namespace: other pre-created and its fence applied clean)',
    );
    process.exit(0);
  }
  console.error('\nself-test: FAIL', detail);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--delete')) return deleteMode();
  if (args.includes('--self-test')) return selfTest();

  const applyIdx = args.indexOf('--apply');
  if (applyIdx !== -1) return applyMode(args[applyIdx + 1], { allYaml: args.includes('--all-yaml') });

  return defaultMode({
    allYaml: args.includes('--all-yaml'),
    forceTs: args.includes('--ts'),
    fresh: args.includes('--fresh'),
  });
}

main();
