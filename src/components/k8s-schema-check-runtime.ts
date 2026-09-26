// Pure logic for <K8sSchemaCheck>. No DOM access at module scope except the
// lazy import()s below — same shape as astro-deep-dive's
// astro-playground-runtime.ts (a lazy CDN-loaded library, a pure check()
// wrapper, a copyFor() i18n table), ported to this course's own component.
//
// What this actually checks (see BADGE_TEXT, shown verbatim on the page):
// static OpenAPI-schema validation only — unknown fields, missing required
// fields, wrong types, and apiVersions that were removed upstream. It does
// NOT run defaulting, admission webhooks/policies, or cross-object checks
// (a Service selector matching no Pods, a ConfigMap a Deployment references
// not existing) — `kubectl apply --dry-run=server` against a real API
// server remains the real test for all of that (this course's own
// tools/verify-manifests.mjs harness runs exactly that, against a real
// cluster, for every collected lesson manifest).
//
// Schemas are pre-generated from the real verify-k8s cluster's own
// /openapi/v3 endpoint by tools/gen-k8s-schemas.mjs (not hand-vendored),
// converted to strict (additionalProperties:false) JSON Schema draft-07,
// and lazy-fetched one kind at a time from public/k8s-schemas/ — see that
// script's module doc comment for the exact conversion rules.

export const YAML_CDN_VERSION = '2.9.1';
export const AJV_CDN_VERSION = '8.20.0';
const YAML_ESM = `https://esm.sh/yaml@${YAML_CDN_VERSION}`;
const AJV_ESM = `https://esm.sh/ajv@${AJV_CDN_VERSION}`;

export const BADGE_TEXT = {
  en: () =>
    `Static OpenAPI schema check only (K8s 1.37, bundled from the real cluster) — catches unknown fields, missing required fields, wrong types, and removed apiVersions. Does NOT catch: defaulting, admission webhooks/policies, or cross-object references. \`kubectl apply --dry-run=server\` remains the real test.`,
  th: () =>
    `ตรวจแค่ static ตาม OpenAPI schema (K8s 1.37, bundle จาก cluster จริง) — จับ field ที่ไม่มีจริง, field ที่จำเป็นแต่ขาด, type ผิด และ apiVersion ที่ถูกลบไปแล้ว **ไม่จับ**: การใส่ default, admission webhook/policy, หรือการอ้างอิงข้ามอ็อบเจ็กต์ \`kubectl apply --dry-run=server\` ยังเป็นบททดสอบจริงเสมอ`,
};

// ---------------------------------------------------------------------------
// Lazy-load CDN libraries (mirrors loadAstroCompiler in astro-playground-runtime.ts)
// ---------------------------------------------------------------------------

type YamlModule = typeof import('yaml');
type AjvCtor = new (opts: Record<string, unknown>) => {
  compile: (schema: unknown) => {
    (data: unknown): boolean;
    errors?: Array<{ instancePath: string; message?: string; keyword: string; params: Record<string, unknown> }> | null;
  };
};

let yamlPromise: Promise<YamlModule> | null = null;
export function loadYaml(): Promise<YamlModule> {
  if (!yamlPromise) yamlPromise = import(/* @vite-ignore */ YAML_ESM) as Promise<YamlModule>;
  return yamlPromise;
}

let ajvPromise: Promise<AjvCtor> | null = null;
export function loadAjv(): Promise<AjvCtor> {
  if (!ajvPromise) {
    ajvPromise = (import(/* @vite-ignore */ AJV_ESM) as Promise<{ default: AjvCtor }>).then((m) => m.default);
  }
  return ajvPromise;
}

// ---------------------------------------------------------------------------
// Schema index (public/k8s-schemas/index.json) + per-kind schema, cached.
// ---------------------------------------------------------------------------

export interface RemovedEntry {
  apiVersion: string;
  kind: string;
  replacement: string | null;
  note?: string;
}
export interface SchemaIndex {
  generatedAt: string;
  k8sVersion: string;
  kinds: Array<{ apiVersion: string; kind: string; file: string }>;
  removed: RemovedEntry[];
}

let indexPromise: Promise<SchemaIndex> | null = null;
function loadIndex(base: string): Promise<SchemaIndex> {
  if (!indexPromise) {
    indexPromise = fetch(`${base}k8s-schemas/index.json`).then((r) => {
      if (!r.ok) throw new Error(`fetching schema index: HTTP ${r.status}`);
      return r.json() as Promise<SchemaIndex>;
    });
  }
  return indexPromise;
}

const schemaCache = new Map<string, Promise<unknown>>();
function loadSchema(base: string, file: string): Promise<unknown> {
  let p = schemaCache.get(file);
  if (!p) {
    p = fetch(`${base}k8s-schemas/${file}`).then((r) => {
      if (!r.ok) throw new Error(`fetching ${file}: HTTP ${r.status}`);
      return r.json();
    });
    schemaCache.set(file, p);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Check one YAML document's parsed value against the bundled schemas.
// ---------------------------------------------------------------------------

export type DocStatus = 'valid' | 'invalid' | 'unknown-kind' | 'removed-api' | 'yaml-error' | 'not-an-object';

export interface DocResult {
  index: number;
  apiVersion?: string;
  kind?: string;
  status: DocStatus;
  messages: string[];
}

function formatAjvError(e: { instancePath: string; message?: string; keyword: string; params: Record<string, unknown> }): string {
  const at = e.instancePath || '(root)';
  if (e.keyword === 'additionalProperties') {
    return `unknown field: ${at}/${e.params.additionalProperty}`;
  }
  if (e.keyword === 'required') {
    return `missing required field: ${at}/${e.params.missingProperty}`;
  }
  if (e.keyword === 'type') {
    return `wrong type at ${at}: ${e.message}`;
  }
  return `${at}: ${e.message ?? e.keyword}`;
}

export async function checkYaml(source: string, base: string): Promise<DocResult[]> {
  const [{ parseAllDocuments }, Ajv, index] = await Promise.all([loadYaml(), loadAjv(), loadIndex(base)]);
  const ajv = new Ajv({ allErrors: true, strict: false, logger: false });
  const docs = parseAllDocuments(source);
  const results: DocResult[] = [];

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    if (doc.errors.length) {
      results.push({ index: i, status: 'yaml-error', messages: doc.errors.map((e) => e.message) });
      continue;
    }
    const value = doc.toJS();
    if (value == null) continue; // a blank document between `---` separators
    if (typeof value !== 'object' || Array.isArray(value)) {
      results.push({ index: i, status: 'not-an-object', messages: ['document is not a YAML mapping (object)'] });
      continue;
    }
    const apiVersion = value.apiVersion;
    const kind = value.kind;
    if (typeof apiVersion !== 'string' || typeof kind !== 'string') {
      results.push({ index: i, status: 'not-an-object', messages: ['missing apiVersion or kind'] });
      continue;
    }

    const removed = index.removed.find((r) => r.apiVersion === apiVersion && r.kind === kind);
    if (removed) {
      const msg = removed.replacement
        ? `${apiVersion} ${kind} was removed — use ${removed.replacement} instead.`
        : (removed.note ?? `${apiVersion} ${kind} was removed, with no direct replacement.`);
      results.push({ index: i, apiVersion, kind, status: 'removed-api', messages: [msg] });
      continue;
    }

    const entry = index.kinds.find((k) => k.apiVersion === apiVersion && k.kind === kind);
    if (!entry) {
      results.push({
        index: i,
        apiVersion,
        kind,
        status: 'unknown-kind',
        messages: [`no bundled schema for ${apiVersion} ${kind} — this tool cannot check it statically (that does not mean it's invalid).`],
      });
      continue;
    }

    const schema = await loadSchema(base, entry.file);
    const validate = ajv.compile(schema as object);
    const ok = validate(value);
    if (ok) {
      results.push({ index: i, apiVersion, kind, status: 'valid', messages: [] });
    } else {
      results.push({ index: i, apiVersion, kind, status: 'invalid', messages: (validate.errors ?? []).map(formatAjvError) });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// i18n copy (mirrors copyFor in astro-playground-runtime.ts)
// ---------------------------------------------------------------------------

export const COPY = {
  en: {
    check: 'Check',
    checking: 'Checking…',
    loadFailed: 'Could not load the checker (network blocked, or esm.sh unreachable). Try again.',
    valid: 'Valid ✓ (matches the bundled schema)',
    noDocs: 'No YAML documents found.',
    doc: (n: number) => `Document ${n}`,
  },
  th: {
    check: 'ตรวจสอบ',
    checking: 'กำลังตรวจสอบ…',
    loadFailed: 'โหลดตัวตรวจสอบไม่สำเร็จ (เครือข่ายถูกบล็อก หรือเข้าถึง esm.sh ไม่ได้) ลองใหม่อีกครั้ง',
    valid: 'ถูกต้อง ✓ (ตรงกับ schema ที่ bundle ไว้)',
    noDocs: 'ไม่พบ YAML document',
    doc: (n: number) => `Document ${n}`,
  },
};

export function copyFor(lang: string | undefined): typeof COPY.en {
  return lang?.startsWith('th') ? COPY.th : COPY.en;
}

export const STATUS_LABEL: Record<DocStatus, { en: string; th: string }> = {
  valid: { en: 'valid', th: 'ถูกต้อง' },
  invalid: { en: 'invalid', th: 'ไม่ถูกต้อง' },
  'unknown-kind': { en: 'no schema bundled', th: 'ไม่มี schema ให้ตรวจ' },
  'removed-api': { en: 'removed apiVersion', th: 'apiVersion ถูกลบแล้ว' },
  'yaml-error': { en: 'YAML syntax error', th: 'YAML ผิด syntax' },
  'not-an-object': { en: 'not a manifest', th: 'ไม่ใช่ manifest' },
};
