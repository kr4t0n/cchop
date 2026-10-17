# cchop Helm chart

Deploys one cchop process with the bundled dashboard and Claude Code. One private PVC mounts the entire `/home/node`, preserving Claude login, OAuth rotation, the capture, cchop configuration, and relay/admin keys. The Deployment uses one replica and `Recreate`; upgrades deliberately interrupt service so two processes do not refresh the same credentials.

Chart **0.1.3** defaults to cchop **0.1.3** in the published `sha-4597998` build pinned by its amd64/arm64 digest. `appVersion` describes the CLI version; chart versions are independent. A nonempty `image.digest` takes precedence over `image.tag`. Changing only the tag does not override a digest.

## Prerequisites

- Kubernetes 1.25+ and Helm 3.20+ (CI uses 3.22.1).
- A StorageClass or an existing private PVC writable by UID/GID 1000. The chart requests 1 GiB and `ReadWriteOnce`; CSI drivers that support `ReadWriteOncePod` can use that stronger single-pod constraint.
- Egress to Claude login, API, and OAuth endpoints. Login and auxiliary Claude features can contact additional endpoints beyond the configured API origin.
- An ingress controller for remote HTTPS access. The optional Tailscale example requires the operator, tailnet HTTPS, and appropriate tailnet access rules.

The commands below are for the operator to run. Chart validation and publication do not access a Kubernetes cluster.

## Install and capture

Add the published chart repository:

```bash
helm repo add cchop https://kr4t0n.github.io/cchop/helm
helm repo update cchop
```

First render the proposed resources locally, then install in setup mode:

```bash
helm template cchop cchop/cchop --version 0.1.3 \
  --namespace cchop --set setup.enabled=true > /tmp/cchop-setup.yaml

helm upgrade --install cchop cchop/cchop --version 0.1.3 \
  --namespace cchop --create-namespace --set setup.enabled=true \
  --wait --timeout 5m
```

This creates one Deployment, a retained PVC named `cchop-home`, and two ClusterIP Services. In setup mode the pod runs an idle process, has no relay probes, and is excluded from both Services. It never initializes or logs in automatically. If reusing prepared state, set `persistence.existingClaim` to its PVC name; no new claim is created.

Open the setup pod in the first terminal:

```bash
kubectl -n cchop exec -it deployment/cchop -- bash
```

Inside it, initialize a **new** home volume, log in, then leave capture running in the foreground:

```bash
cchop init
claude auth login
cchop capture
```

Skip `init` for an existing configuration; it refuses to overwrite files. Complete the login link in your own browser. In a second terminal, run Claude in the same pod against the loopback capture listener:

```bash
kubectl -n cchop exec -it deployment/cchop -- env \
  -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_API_KEY -u ANTHROPIC_CUSTOM_HEADERS \
  ANTHROPIC_BASE_URL=http://127.0.0.1:9999 claude
```

Send a short message, wait for capture to finish, then exit Claude. The chart never exposes port 9999. Back in the first terminal, run `cchop doctor --offline`, then exit the shell. Capturing a fingerprint does not prove provider authentication succeeded; check the capture result too.

Start the relay using the same release and PVC:

```bash
helm upgrade cchop cchop/cchop --version 0.1.3 \
  --namespace cchop --reuse-values --set setup.enabled=false \
  --wait --timeout 5m
```

Do not leave Claude running when enabling the relay. Never scale the Deployment above one replica, share the PVC with another release, or force-delete a pod whose process might still be running on an unreachable node. `Recreate` handles normal upgrades; it is not distributed fencing for node failures.

## Networking and keys

The relay Service is `cchop-relay:8787`; the dashboard Service is `cchop-admin:8788`. Both are ClusterIP by default. Service ports are configurable, while container ports remain fixed. The dashboard uses its own admin key; the relay key does not authenticate the dashboard.

For Tailscale, use [examples/values.tailscale.yaml](examples/values.tailscale.yaml) as the values file passed with `-f` during install and upgrades. It creates two independent Ingress resources with short device names `cchop` and `cchop-admin`. The operator supplies certificates; no TLS Secret is required. Open the resulting full `https://cchop.<tailnet>.ts.net` and `https://cchop-admin.<tailnet>.ts.net` URLs. Add `publicUrl` with the relay's actual HTTPS origin if generated client settings should use it by default. See the [Tailscale ingress documentation](https://tailscale.com/docs/kubernetes-operator/ingress).

For another ingress controller, configure each ingress's host, class, annotations, and TLS Secret independently. Use distinct relay and admin hosts, and configure streaming timeouts and buffering for long Claude responses. Ingress is off by default; enable admin access only on the network intended to administer the relay.

By default, `cchop init` stores generated keys in `/home/node/.config/cchop/credentials.env` on the PVC. Alternatively, `auth.existingSecret` names an operator-managed Secret containing `CCHOP_GATEWAY_TOKEN` and `CCHOP_ADMIN_TOKEN`. Each must be a different 24–256 character value without whitespace. These environment values override the generated file. Restart through a controlled rollout after changing a referenced Secret, because environment values are read at pod creation. The chart never embeds credentials in Helm values or generates a Secret.

Use `cchop client --url <relay HTTPS origin>` to generate private Claude client settings, and transfer the file securely. Keep the admin key separate. Claude OAuth credentials must remain writable on the PVC for atomic rotation; do not mount them from a read-only Kubernetes Secret.

## Configuration

| Value | Default / behavior |
| --- | --- |
| `setup.enabled` | `false`; enable for first login, recapture, or credential recovery |
| `image.repository`, `image.tag`, `image.digest` | Published cchop image; digest wins when set |
| `imagePullSecrets` | Optional existing registry Secret names |
| `persistence.existingClaim` | Empty creates a retained `<release>-home` PVC |
| `persistence.size` | `1Gi`; expansion requires storage-driver support |
| `persistence.storageClass` | `null` uses the default class; `""` requests no class |
| `persistence.accessMode` | `ReadWriteOnce`; `ReadWriteOncePod` also supported |
| `auth.existingSecret` | Empty uses the private credentials file on the PVC |
| `publicUrl` | Empty preserves the URL in cchop's configuration |
| `terminationGracePeriodSeconds` | `45`; must exceed `shutdownGraceMs` in cchop's configuration |
| `service.relay`, `service.admin` | Independent ports and annotations |
| `ingress.relay`, `ingress.admin` | Independent enablement, hosts, classes, annotations, and TLS |
| `resources` | Requests 100m CPU / 256Mi memory; memory limit 1Gi |
| `nodeSelector`, `tolerations`, `affinity` | Optional scheduling constraints |
| `podAnnotations` | Optional annotations, including an operator-controlled rollout marker |

Remaining application settings live in `/home/node/.config/cchop/cchop.json`. The chart fixes configuration/home paths and listener ports. It provides writable home and `/tmp` volumes, a read-only root filesystem, UID/GID 1000, dropped capabilities, and no mounted Kubernetes API token.

## Upgrades, verification, and rollback

Before upgrading Claude Code or changing the capture identity, switch the release to setup mode and wait for the old relay to stop. Upgrade the image while still in setup mode, run `cchop capture --replace`, exit Claude, and then disable setup mode. For a new chart version, explicitly review its default image and supply your intended values; blindly reusing old values also retains old image overrides. To use a tag instead of the chart digest, set both `image.digest=""` and `image.tag=<published tag>`.

Check deployment and storage status without exposing credentials:

```bash
kubectl -n cchop get deployment,pods,services,pvc,ingress
kubectl -n cchop logs deployment/cchop --tail=50
curl --fail https://cchop.YOUR-TAILNET.ts.net/readyz
```

The startup/readiness/liveness probes use the relay's unauthenticated health routes and make no provider requests. A healthy pod means the local relay started with valid files; provider compatibility still needs an operator test. The grace period allows the default 30-second stream drain to complete.

To return to an earlier Helm revision, the operator can run `helm -n cchop history cchop`, then `helm -n cchop rollback cchop <revision> --wait --timeout 5m`. This replaces only that release's workloads and configuration, with downtime; it does not restore the PVC. If reverting Claude Code, use setup mode and recapture with the selected version before resuming traffic. Never restore an old OAuth refresh token as a routine rollback strategy.

Uninstalling removes the workloads, Services, and ingresses but retains a chart-created PVC via `helm.sh/resource-policy: keep`. Treat it as private credential storage. Reinstall with `persistence.existingClaim=cchop-home` to reuse the retained claim. Do not delete or change a populated claim during an upgrade.

## Chart publication

The repository workflow validates and publishes changes under `helm/` from `main` to `https://kr4t0n.github.io/cchop/helm`. Enable **Settings → Pages → Source: GitHub Actions** once. No registry token or additional secret is required: the workflow uses `GITHUB_TOKEN` for the `gh-pages` archive branch and explicit Pages deployment.

Bump `Chart.yaml`'s `version` for any packaged change, including documentation or defaults. Publishing identical contents preserves the existing archive and index; different contents at the same version fail. Older archives remain available. PRs and manual validation-only runs test locally without publishing; manual publication is restricted to `main`. CI verifies the public chart download matches the archived package before reporting publication success.

From a checkout, run `npm ci` and `npm run test:helm` with Helm installed. The checks render default/setup/Tailscale configurations, validate single-process and credential-storage behavior, reject invalid values, and exercise version collision handling. No cluster or user credentials are used.
