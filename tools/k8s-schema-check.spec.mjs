#!/usr/bin/env node
// Playwright smoke spec for <K8sSchemaCheck>, both locales.
//
// Usage:
//   npx astro build --outDir dist
//   npx astro preview --outDir dist --port 4961 &
//   npx -p playwright node tools/k8s-schema-check.spec.mjs http://localhost:4961/kubernetes
//
// <baseUrl> is the site root INCLUDING the astro.config.mjs `base`
// (`/kubernetes`) — this script appends `/en/...` / `/th/...` itself.
//
// Not a test-runner spec (no @playwright/test): a small self-contained
// script using the `playwright` package directly, per this course's own
// convention for one-off browser checks (mirrors the sibling courses'
// snippet-verification harnesses, which are also plain node scripts).

import { chromium } from 'playwright';

const baseUrl = process.argv[2];
if (!baseUrl) {
  console.error('usage: node tools/k8s-schema-check.spec.mjs <baseUrl>  (e.g. http://localhost:4961/kubernetes)');
  process.exit(1);
}

const PAGE_PATH = '/foundations/kubectl-and-declarative-yaml/';
const COMPONENT_ID = 'ksc-kubectl-declarative';

const CLEAN_SAMPLE = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: nginx:1.31
`;

let failures = 0;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  failures++;
}

async function checkLocale(browser, locale) {
  const page = await browser.newPage();
  const url = `${baseUrl}/${locale}${PAGE_PATH}`;
  await page.goto(url, { waitUntil: 'networkidle' });
  if (!page.url().includes(`/${locale}/`)) fail(`${locale}: navigated URL ${page.url()} does not contain /${locale}/`);

  const root = page.locator(`#${COMPONENT_ID}`);
  await root.waitFor({ state: 'visible', timeout: 10_000 });

  // 1. Sample as embedded is already broken (`restartPolicy` inside a
  // container) — Check must report it as an unknown field.
  await root.locator('[data-check]').click();
  const resultsBox = root.locator('[data-results]');
  await resultsBox.waitFor({ state: 'visible', timeout: 15_000 });
  const brokenText = (await resultsBox.innerText()).toLowerCase();
  if (!brokenText.includes('privileged')) {
    fail(`${locale}: broken sample — expected an unknown-field error mentioning privileged, got: ${brokenText.slice(0, 300)}`);
  } else {
    console.log(`PASS: ${locale} broken sample reported unknown field (privileged)`);
  }

  // 2. Replace the textarea with a clean manifest and check again — must pass.
  const ta = root.locator('[data-ta]');
  await ta.fill(CLEAN_SAMPLE);
  await root.locator('[data-check]').click();
  await page.waitForFunction(
    (id) => {
      const el = document.querySelector(`#${id} [data-results]`);
      return el && !el.hidden && el.textContent && el.textContent.trim().length > 0;
    },
    COMPONENT_ID,
    { timeout: 15_000 },
  );
  const cleanText = await resultsBox.innerText();
  const cleanClass = await root.locator('.ksc__doc').first().getAttribute('class');
  if (!cleanClass?.includes('ksc__doc--ok')) {
    fail(`${locale}: clean sample — expected a valid (ok) result, got class="${cleanClass}" text="${cleanText.slice(0, 300)}"`);
  } else {
    console.log(`PASS: ${locale} clean sample validated OK`);
  }

  await page.close();
}

async function main() {
  const browser = await chromium.launch();
  try {
    await checkLocale(browser, 'en');
    await checkLocale(browser, 'th');
  } finally {
    await browser.close();
  }
  if (failures > 0) {
    console.error(`\n${failures} failure(s).`);
    process.exit(1);
  }
  console.log('\nAll K8sSchemaCheck checks passed (en + th).');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
