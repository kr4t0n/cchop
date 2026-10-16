import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse, parseAllDocuments } from 'yaml';
import { buildHelmRepository } from './helm-repository.js';

const chart = resolve('helm/cchop');
const temporary = await mkdtemp(join(tmpdir(), 'cchop-helm-smoke-'));
const env = { ...process.env, KUBECONFIG: join(temporary, 'no-cluster') };

function render(...args: string[]): Record<string, unknown>[] {
  const yaml = execFileSync('helm', ['template', 'cchop', chart, '--namespace', 'cchop', ...args], { env, encoding: 'utf8' });
  return parseAllDocuments(yaml).map((document) => {
    assert.deepEqual(document.errors, []);
    return document.toJS() as Record<string, unknown>;
  });
}

function at(value: unknown, ...keys: (string | number)[]): unknown {
  for (const key of keys) value = (value as Record<string | number, unknown>)[key];
  return value;
}

function one(resources: Record<string, unknown>[], kind: string): Record<string, unknown> {
  const matches = resources.filter((resource) => resource.kind === kind);
  assert.equal(matches.length, 1);
  return matches[0]!;
}

function rejects(...args: string[]): void {
  const result = spawnSync('helm', ['template', 'cchop', chart, ...args], { env, encoding: 'utf8' });
  assert.notEqual(result.status, 0, `Invalid configuration accepted: ${args.join(' ')}`);
}

try {
  for (const args of [[], ['--set', 'setup.enabled=true'], ['-f', join(chart, 'examples/values.tailscale.yaml')]]) {
    execFileSync('helm', ['lint', '--strict', chart, ...args], { env, stdio: 'pipe' });
  }
  const resources = render();
  assert.deepEqual(resources.map((resource) => resource.kind).sort(), ['Deployment', 'PersistentVolumeClaim', 'Service', 'Service']);
  const deployment = one(resources, 'Deployment');
  assert.equal(at(deployment, 'spec', 'replicas'), 1);
  assert.deepEqual(at(deployment, 'spec', 'strategy'), { type: 'Recreate' });
  const pod = at(deployment, 'spec', 'template', 'spec');
  const container = at(pod, 'containers', 0);
  assert.equal(at(pod, 'automountServiceAccountToken'), false);
  assert.equal(at(pod, 'terminationGracePeriodSeconds'), 45);
  assert.equal(at(pod, 'securityContext', 'runAsUser'), 1000);
  assert.equal(at(pod, 'securityContext', 'fsGroup'), 1000);
  assert.equal(at(container, 'securityContext', 'readOnlyRootFilesystem'), true);
  assert.deepEqual(at(container, 'securityContext', 'capabilities', 'drop'), ['ALL']);
  assert.match(at(container, 'image') as string, /^docker\.io\/kr4t0n\/cchop@sha256:[0-9a-f]{64}$/);
  assert.equal(at(container, 'args'), undefined, 'Relay uses the image default and Tini');
  assert.deepEqual(at(container, 'readinessProbe', 'httpGet'), { path: '/readyz', port: 'relay' });
  assert.deepEqual(at(container, 'livenessProbe', 'httpGet'), { path: '/healthz', port: 'relay' });
  assert.deepEqual(at(container, 'volumeMounts'), [{ name: 'home', mountPath: '/home/node' }, { name: 'tmp', mountPath: '/tmp' }]);
  const pvc = one(resources, 'PersistentVolumeClaim');
  assert.equal(at(pvc, 'metadata', 'annotations', 'helm.sh/resource-policy'), 'keep');
  assert.deepEqual(at(pvc, 'spec', 'accessModes'), ['ReadWriteOnce']);
  assert.equal(at(pvc, 'spec', 'storageClassName'), undefined);
  assert.equal(at(one(render('--set-string', 'persistence.storageClass='), 'PersistentVolumeClaim'), 'spec', 'storageClassName'), '');

  const setup = render('--set', 'setup.enabled=true');
  const setupDeployment = one(setup, 'Deployment');
  assert.equal(at(setupDeployment, 'spec', 'template', 'metadata', 'labels', 'cchop.dev/mode'), 'setup');
  const setupContainer = at(setupDeployment, 'spec', 'template', 'spec', 'containers', 0);
  assert.deepEqual(at(setupContainer, 'args'), ['node', '-e', 'setInterval(() => {}, 3600000)']);
  for (const key of ['startupProbe', 'livenessProbe', 'readinessProbe', 'ports']) assert.equal(at(setupContainer, key), undefined);
  for (const service of setup.filter((resource) => resource.kind === 'Service')) {
    assert.equal(at(service, 'spec', 'type'), 'ClusterIP');
    assert.equal(at(service, 'spec', 'selector', 'cchop.dev/mode'), 'relay', 'Setup pod must not receive Service traffic');
  }

  const existing = render('--set', 'persistence.existingClaim=private-home,auth.existingSecret=relay-keys');
  assert.ok(!existing.some((resource) => ['PersistentVolumeClaim', 'Secret'].includes(resource.kind as string)));
  const existingPod = at(one(existing, 'Deployment'), 'spec', 'template', 'spec');
  assert.equal(at(existingPod, 'volumes', 0, 'persistentVolumeClaim', 'claimName'), 'private-home');
  const variables = at(existingPod, 'containers', 0, 'env') as { name: string; valueFrom?: unknown }[];
  for (const name of ['CCHOP_GATEWAY_TOKEN', 'CCHOP_ADMIN_TOKEN']) {
    assert.deepEqual(variables.find((variable) => variable.name === name)?.valueFrom, { secretKeyRef: { name: 'relay-keys', key: name } });
  }
  const ingresses = render('-f', join(chart, 'examples/values.tailscale.yaml')).filter((resource) => resource.kind === 'Ingress');
  assert.equal(ingresses.length, 2);
  for (const ingress of ingresses) {
    assert.equal(at(ingress, 'spec', 'ingressClassName'), 'tailscale');
    const host = at(ingress, 'spec', 'tls', 0, 'hosts', 0);
    assert.equal(at(ingress, 'spec', 'rules', 0, 'host'), host);
    assert.equal(at(ingress, 'spec', 'tls', 0, 'secretName'), undefined);
    const backend = at(ingress, 'spec', 'rules', 0, 'http', 'paths', 0, 'backend', 'service');
    assert.deepEqual(backend, { name: host === 'cchop' ? 'cchop-relay' : 'cchop-admin', port: { name: 'http' } });
  }
  assert.equal(at(one(render('--set', 'image.digest=', '--set-string', 'image.tag=next'), 'Deployment'), 'spec', 'template', 'spec', 'containers', 0, 'image'), 'docker.io/kr4t0n/cchop:next');
  for (const value of ['replicaCount=2', 'persistence.accessMode=ReadWriteMany', 'terminationGracePeriodSeconds=30', 'auth.token=inline-secret', 'image.digest=broken', 'image.digest=,image.tag=', 'ingress.admin.enabled=true']) {
    rejects('--set', value);
  }
  rejects('-f', join(chart, 'examples/values.tailscale.yaml'), '--set', 'ingress.admin.host=cchop');
  rejects('-f', join(chart, 'examples/values.tailscale.yaml'), '--set', 'ingress.relay.tls.enabled=false');

  const pages = join(temporary, 'pages');
  const url = 'https://example.test/cchop/helm';
  const first = await buildHelmRepository(chart, pages, url);
  assert.equal(first.changed, true);
  const archive = await readFile(join(pages, 'helm', first.archive));
  const index = await readFile(join(pages, 'helm', 'index.yaml'));
  const second = await buildHelmRepository(chart, pages, url);
  assert.equal(second.changed, false);
  assert.deepEqual(await readFile(join(pages, 'helm', first.archive)), archive);
  assert.deepEqual(await readFile(join(pages, 'helm', 'index.yaml')), index);
  const changedChart = join(temporary, 'chart');
  await cp(chart, changedChart, { recursive: true });
  await writeFile(join(changedChart, 'README.md'), 'Changed chart documentation\n');
  await assert.rejects(buildHelmRepository(changedChart, pages, url), /bump Chart.yaml version/);
  assert.deepEqual(await readFile(join(pages, 'helm', first.archive)), archive);
  const metadata = await readFile(join(changedChart, 'Chart.yaml'), 'utf8');
  await writeFile(join(changedChart, 'Chart.yaml'), metadata.replace(/^version: .+$/m, 'version: 999.0.0'));
  const next = await buildHelmRepository(changedChart, pages, url);
  assert.equal(next.version, '999.0.0');
  const published = parse(await readFile(join(pages, 'helm', 'index.yaml'), 'utf8')) as { entries: { cchop: { version: string; urls: string[] }[] } };
  assert.deepEqual(published.entries.cchop.map((entry) => entry.version), ['999.0.0', first.version]);
  assert.deepEqual(await readFile(join(pages, 'helm', first.archive)), archive);
  assert.ok(published.entries.cchop.every((entry) => entry.urls[0] === `${url}/cchop-${entry.version}.tgz`));
  process.stdout.write('Helm smoke passed: single-writer deployment, setup isolation, persistence, secret references, ingresses, schema rejection, and immutable versioned repository. No cluster access.\n');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
