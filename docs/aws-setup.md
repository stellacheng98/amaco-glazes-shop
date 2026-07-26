# AWS setup — test & prod (Lightsail + Secrets Manager + S3)

A guided, console-first runbook to host the shop on AWS in **two environments**
(`test` and `prod`) in **one AWS account**, using:

- **Lightsail** — one small VM per environment, with a persistent block-storage disk for `shop.db`.
- **S3** — one private bucket per environment for Litestream backups.
- **Secrets Manager** — one secret per environment holding the Stripe keys.
- **IAM** — one scoped user per environment; its access key is the single credential on the instance (Lightsail can't assume roles), used for both Secrets Manager and S3.

Everything is duplicated per environment, differing mainly in **names** and in **Stripe mode** (test uses `sk_test_…`, prod uses `sk_live_…`). Do the whole runbook once for `test`, confirm it works, then repeat for `prod`.

---

## 0. Before you start

- An AWS account with console access.
- Stripe **test** keys (for the test env) and **live** keys (for prod). Live mode requires an activated Stripe account.
- A domain is optional. **No domain?** Use an [sslip.io](https://sslip.io) hostname derived from the instance's static IP (e.g. `52-1-2-3.sslip.io`) — it resolves to that IP automatically and Caddy still gets a real Let's Encrypt certificate, so HTTPS (which Stripe webhooks require) works without owning a domain. Swap to a real domain later by changing the Caddyfile hostname, `PUBLIC_URL`, and the Stripe webhook URL.
- Pick one **region** and use it for *every* resource in an environment (instance, bucket, secret must match). This runbook uses `us-east-1` — substitute yours everywhere.

### What gets created (per environment)

| Resource | Test name | Prod name |
| --- | --- | --- |
| Lightsail instance | `glaze-shop-test` | `glaze-shop-prod` |
| Static IP | `glaze-shop-test-ip` | `glaze-shop-prod-ip` |
| Block-storage disk | `glaze-shop-test-data` | `glaze-shop-prod-data` |
| S3 bucket | `glaze-shop-backups-test-<unique>` | `glaze-shop-backups-prod-<unique>` |
| Secrets Manager secret | `glaze-shop/test` | `glaze-shop/prod` |
| IAM policy | `glaze-shop-test-policy` | `glaze-shop-prod-policy` |
| IAM user | `glaze-shop-test` | `glaze-shop-prod` |

> S3 bucket names are **globally unique** — append something like your account ID or a random suffix. Everything else is per-account and can use the plain names above.

---

## 1. S3 bucket (backups)

**Console → S3 → Create bucket.**

1. **Name:** `glaze-shop-backups-test-<unique>`.
2. **Region:** your chosen region.
3. **Block Public Access:** leave **all four** boxes checked (fully private).
4. **Encryption:** default (SSE-S3) is fine.
5. Versioning: not required for Litestream — leave off.
6. Create.

(Repeat later with `…-prod-<unique>` for prod.)

---

## 2. Secrets Manager secret (Stripe keys)

**Console → Secrets Manager → Store a new secret.**

1. **Type:** *Other type of secret*.
2. **Key/value** pairs (use the **test** Stripe keys for the test secret):
   - `STRIPE_SECRET_KEY` = `sk_test_…`
   - `STRIPE_WEBHOOK_SECRET` = `whsec_…` — you don't have this yet; add it in **step 9**. You can create the secret now with just `STRIPE_SECRET_KEY` and edit it later.
3. **Encryption key:** default (`aws/secretsmanager`).
4. **Secret name:** `glaze-shop/test`.
5. Turn **off** automatic rotation.
6. Store. Then open the secret and copy its **ARN** — you'll paste it into the IAM policy next.

---

## 3. IAM policy + user (the instance's one credential)

### 3a. Policy — least privilege, scoped to this env's bucket + secret

**Console → IAM → Policies → Create policy → JSON.** Paste, substituting your bucket name, region, account ID, and the secret ARN from step 2:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "LitestreamBucket",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::glaze-shop-backups-test-<unique>"
    },
    {
      "Sid": "LitestreamObjects",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::glaze-shop-backups-test-<unique>/*"
    },
    {
      "Sid": "ReadStripeSecret",
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": "arn:aws:secretsmanager:us-east-1:<account-id>:secret:glaze-shop/test-*"
    }
  ]
}
```

Name it `glaze-shop-test-policy` and create.

> The `-*` suffix on the secret ARN matches the random 6-char suffix Secrets Manager appends. It stays scoped to this one secret.

### 3b. User

**IAM → Users → Create user.**

1. **Name:** `glaze-shop-test`. Do **not** grant console access.
2. **Permissions:** attach `glaze-shop-test-policy` directly.
3. Create. Open the user → **Security credentials → Create access key** → *Application running outside AWS*.
4. **Copy the Access key ID and Secret access key now** — the secret is shown once. This pair goes on the test instance in step 6.

---

## 4. Lightsail instance

**Console → Lightsail → Create instance.**

1. **Region/AZ:** your region.
2. **Platform:** Linux/Unix → **OS Only → Ubuntu 22.04 LTS**.
3. **Plan:** the smallest ($5–7/mo) is plenty for a sample shop.
4. **Name:** `glaze-shop-test`. Create.

### 4a. Static IP

**Lightsail → Networking → Create static IP** → attach to `glaze-shop-test` → name `glaze-shop-test-ip`. (Without this the public IP changes on stop/start and breaks DNS.)

### 4b. Block-storage disk

**Lightsail → Storage → Create disk** → same AZ as the instance → size **8 GB** → name `glaze-shop-test-data` → attach to `glaze-shop-test`.

### 4c. Firewall

Instance → **Networking → IPv4 Firewall** → add **HTTP (80)** and **HTTPS (443)**. Leave SSH (22) as is. Do **not** open 4242 — the app stays behind the reverse proxy.

---

## 5. On the instance — install & mount

Open the instance's **browser SSH** (or use your own key), then:

```bash
# System packages
sudo apt-get update
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential python3 jq unzip caddy

# AWS CLI v2
curl -s "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscliv2.zip
cd /tmp && unzip -q awscliv2.zip && sudo ./aws/install && cd -

# Litestream (use the arm64 asset if `uname -m` is aarch64)
curl -L https://github.com/benbjohnson/litestream/releases/latest/download/litestream-linux-amd64.deb -o /tmp/ls.deb
sudo dpkg -i /tmp/ls.deb

# Mount the block-storage disk at /data (check the device name with: lsblk)
sudo mkfs -t ext4 /dev/xvdf            # ONLY on the fresh, empty disk — this erases it
sudo mkdir -p /data
echo '/dev/xvdf /data ext4 defaults,nofail 0 2' | sudo tee -a /etc/fstab
sudo mount -a && sudo chown ubuntu /data

# App
git clone https://github.com/stellacheng98/amaco-glazes-shop.git
cd amaco-glazes-shop
npm ci --omit=dev
```

---

## 6. Instance environment file (non-secret config + bootstrap key)

Create `/etc/glaze-shop.env` (root-only — it holds the bootstrap AWS key):

```bash
sudo tee /etc/glaze-shop.env >/dev/null <<'ENV'
# Bootstrap IAM user from step 3b — the one credential on this box.
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_DEFAULT_REGION=us-east-1

# Which Secrets Manager secret to load Stripe keys from.
SECRETS_ID=glaze-shop/test

# Litestream target (Stripe keys come from Secrets Manager, not here).
LITESTREAM_S3_BUCKET=glaze-shop-backups-test-<unique>
LITESTREAM_S3_REGION=us-east-1

# App config
DATABASE_PATH=/data/shop.db
PUBLIC_URL=https://test.shop.example.com
PORT=4242
ENV
sudo chmod 600 /etc/glaze-shop.env
```

> Litestream reads its S3 credentials from the standard `AWS_*` variables above. The app's Stripe keys are **not** in this file — `start-with-secrets.sh` pulls them from Secrets Manager at boot.

---

## 7. Seed the catalog, then run as a service

### 7a. Seed live Stripe products (one-time)

```bash
cd /home/ubuntu/amaco-glazes-shop
set -a && . /etc/glaze-shop.env && set +a
export STRIPE_SECRET_KEY="$(aws secretsmanager get-secret-value --secret-id "$SECRETS_ID" --query SecretString --output text | jq -r .STRIPE_SECRET_KEY)"
npm run sync-catalog        # seeds /data/shop.db and creates Stripe Products/Prices
```

### 7b. systemd service

Create `/etc/systemd/system/glaze-shop.service`:

```ini
[Unit]
Description=Sample Glaze Co.
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/amaco-glazes-shop
EnvironmentFile=/etc/glaze-shop.env
ExecStart=/home/ubuntu/amaco-glazes-shop/scripts/start-with-secrets.sh
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now glaze-shop
sudo systemctl status glaze-shop        # expect "active (running)"
journalctl -u glaze-shop -f             # watch startup; Ctrl-C to stop tailing
```

On boot it: loads `/etc/glaze-shop.env` → `start-with-secrets.sh` pulls Stripe keys from Secrets Manager → `start-with-litestream.sh` restores `shop.db` from S3 if `/data` is empty, then replicates and runs the app on `localhost:4242`.

---

## 8. HTTPS + domain (Caddy)

Caddy was installed in step 5 and gives automatic HTTPS. Create `/etc/caddy/Caddyfile`:

```
your-hostname {
    reverse_proxy localhost:4242
}
```

**With a real domain:** use `test.shop.example.com`, and point its DNS **A record** at the instance's static IP.

**No domain (sslip.io):** use the static IP with dashes plus `.sslip.io` — e.g. static IP `52.1.2.3` → `52-1-2-3.sslip.io`. No DNS record to create; it resolves automatically.

```bash
sudo systemctl reload caddy
```

Once the hostname resolves to the instance, Caddy fetches a certificate automatically (give it a few seconds). `PUBLIC_URL` in `/etc/glaze-shop.env` must be this exact `https://` hostname.

---

## 9. Stripe webhook

1. **Stripe Dashboard** (in **test** mode for the test env) → **Developers → Webhooks → Add endpoint**.
2. URL: `https://test.shop.example.com/webhook`; event: `checkout.session.completed`.
3. Copy the signing secret (`whsec_…`).
4. Add it to the secret: **Secrets Manager → `glaze-shop/test` → Retrieve/Edit → set `STRIPE_WEBHOOK_SECRET`**.
5. Restart so the app picks it up: `sudo systemctl restart glaze-shop`.

---

## 10. Verify — including the backup

```bash
curl https://test.shop.example.com/api/products | head        # catalog serves

# After a test purchase (test card 4242 4242 4242 4242):
sqlite3 /data/shop.db "SELECT stripe_session_id, email FROM orders;"

# Restore drill — proves the S3 backup actually works:
sudo systemctl stop glaze-shop
sudo mv /data/shop.db /data/shop.db.bak
set -a && . /etc/glaze-shop.env && set +a
litestream restore -config litestream.yml "$DATABASE_PATH"
sudo systemctl start glaze-shop                               # orders should still be there
```

**Do not consider the environment done until the restore drill passes.** An untested backup is not a backup.

---

## 11. Repeat for prod

Redo steps 1–10 with the **prod** names from the inventory table and:

- **Live** Stripe keys (`sk_live_…`) in `glaze-shop/prod`.
- Prod bucket, secret ARN, IAM policy/user, instance, disk, static IP.
- `SECRETS_ID=glaze-shop/prod`, prod bucket/region, and `PUBLIC_URL=https://shop.example.com` in `/etc/glaze-shop.env`.
- The Stripe webhook created in **live** mode.

Keeping both environments in one account is fine because every IAM policy is scoped to a single bucket and a single secret — the test user cannot touch prod data and vice versa.

---

## Cost sketch (rough, us-east-1)

Per environment: Lightsail instance ~$5–7/mo, 8 GB disk ~$0.80/mo, static IP free while attached, S3 pennies at this size, Secrets Manager ~$0.40/secret/mo. Two environments land around **$13–17/mo**.

## Teardown

Lightsail: delete instance, disk, and static IP. Then empty and delete the S3 bucket, delete the Secrets Manager secret (it has a recovery window), and delete the IAM user + policy. Do this per environment.
