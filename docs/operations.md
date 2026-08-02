# Operations cheat sheet — deployed shop

Quick reference for running the Lightsail-hosted shop, collected from real
day-to-day use. For first-time provisioning see [`aws-setup.md`](aws-setup.md).

Set these once per shell, then paste the commands below as-is:

```bash
KEY=lightsail-us-east-1.pem      # SSH key (from provision-env.sh step 2)
HOST=ubuntu@32.199.68.89         # instance static IP  (prod: its own IP)
SECRET_ID=glaze-shop/test        # Secrets Manager secret (prod: glaze-shop/prod)
REGION=us-east-1
```

SSH in interactively (for the multi-line recipes):

```bash
ssh -i "$KEY" "$HOST"
```

---

## Orders

```bash
# All orders, newest first, totals in dollars
ssh -i "$KEY" "$HOST" 'sqlite3 -header -column /data/shop.db \
  "SELECT stripe_session_id, email, printf(\"\$%.2f\", amount_total/100.0) AS total, payment_status, fulfillment_status, created_at FROM orders ORDER BY created_at DESC;"'

# Order line items (which glazes, quantities)
ssh -i "$KEY" "$HOST" 'sqlite3 -header -column /data/shop.db \
  "SELECT o.id, o.email, i.product_code, i.product_name, i.qty FROM orders o JOIN order_items i ON i.order_id=o.id ORDER BY o.id DESC;"'

# Count / only unshipped
ssh -i "$KEY" "$HOST" 'sqlite3 /data/shop.db "SELECT COUNT(*) FROM orders;"'
ssh -i "$KEY" "$HOST" 'sqlite3 /data/shop.db "SELECT id,email FROM orders WHERE fulfillment_status=\"pending\";"'
```

---

## Service (systemd)

```bash
ssh -i "$KEY" "$HOST" 'sudo systemctl status glaze-shop --no-pager | head -15'
ssh -i "$KEY" "$HOST" 'sudo systemctl restart glaze-shop'   # after any secret/config change
ssh -i "$KEY" "$HOST" 'sudo systemctl stop glaze-shop'
ssh -i "$KEY" "$HOST" 'sudo systemctl start glaze-shop'
```

If `status` keeps showing a climbing **restart counter**, it's crash-looping —
check the logs below for the reason (a malformed secret is a common one).

---

## Logs

Litestream prints a "replica sync" line every ~2s, which buries the app's own
output. Filter it out:

```bash
# App lines only (startup banner, orders, errors)
ssh -i "$KEY" "$HOST" 'journalctl -u glaze-shop --no-pager -n 80 | grep -va "replica sync"'

# Is checkout actually enabled?
ssh -i "$KEY" "$HOST" 'journalctl -u glaze-shop --no-pager | grep -iaE "checkout enabled|browse-only" | tail -3'

# Webhook / order activity
ssh -i "$KEY" "$HOST" 'journalctl -u glaze-shop --no-pager | grep -iaE "order confirmed|webhook|signature|error" | tail -20'

# Live tail
ssh -i "$KEY" "$HOST" 'journalctl -u glaze-shop -f'
```

---

## Health checks

```bash
# Public HTTPS (from anywhere) — expect a JSON array
curl -s https://32-199-68-89.sslip.io/api/products | head -c 200; echo

# App direct on the box (bypasses Caddy) — 502 from the curl above but 200 here
#   means Caddy is up but the Node app is down.
ssh -i "$KEY" "$HOST" 'curl -s localhost:4242/api/products | head -c 120; echo'

# What checkout actually returns (should be {"url":"https://checkout.stripe.com/..."})
ssh -i "$KEY" "$HOST" "curl -s -X POST localhost:4242/create-checkout-session \
  -H 'Content-Type: application/json' -d '{\"items\":[{\"code\":\"C-05\",\"qty\":1}]}'"; echo
```

---

## Secrets (Stripe keys + webhook signing secret)

The secret is a JSON blob the entrypoint reads at boot. **It must be valid JSON
with every key and value double-quoted** — a bad value crash-loops the service.

```bash
# View current value (and validate it parses — jq errors = malformed)
aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --region "$REGION" --query SecretString --output text | jq .

# Set it correctly (jq -n guarantees valid JSON). sk_test_ = SECRET key; whsec_ = webhook signing secret.
aws secretsmanager put-secret-value --secret-id "$SECRET_ID" --region "$REGION" \
  --secret-string "$(jq -n --arg sk 'sk_test_...' --arg wh 'whsec_...' \
    '{STRIPE_SECRET_KEY:$sk, STRIPE_WEBHOOK_SECRET:$wh}')"

# Then reload it:
ssh -i "$KEY" "$HOST" 'sudo systemctl restart glaze-shop'
```

- `STRIPE_SECRET_KEY` → the **secret** key `sk_test_…` (never the `pk_…` publishable one).
- `STRIPE_WEBHOOK_SECRET` → **Stripe → Developers → Webhooks → your endpoint → Signing secret** (`whsec_…`), *not* the API-keys page.
- `put-secret-value` replaces the **whole** JSON — always include both keys.

---

## Stripe webhook

- Endpoint: `https://<host>/webhook`, in the **same** sandbox/live mode as the keys.
- Subscribe the endpoint to **all three** checkout events:
  - `checkout.session.completed` — records the order (the only one card payments ever fire).
  - `checkout.session.async_payment_succeeded` — a delayed payment (ACH / bank debit) finally cleared; promotes the order to paid.
  - `checkout.session.async_payment_failed` — a delayed payment bounced; marks the order `canceled` so it isn't fulfilled.

  The async pair stays dormant while checkout is card-only, but **Stripe only delivers events you've subscribed to** — add all three now so they already work the day a non-card method is enabled.
- Opening `/webhook` in a browser shows `Cannot GET /webhook` — that's correct; it's POST-only.
- Check deliveries: **Stripe → Developers → Webhooks → endpoint → Recent deliveries**.
  - **400** = signature mismatch → fix `STRIPE_WEBHOOK_SECRET` in the secret + restart, then **Resend** the event.
  - **200** = recorded; confirm with the Orders queries above.

---

## Catalog / stock

```bash
ssh -i "$KEY" "$HOST" 'sqlite3 /data/shop.db "SELECT COUNT(*) FROM products;"'                 # count
ssh -i "$KEY" "$HOST" 'cd amaco-glazes-shop && npm run stock'                                   # list out-of-stock
ssh -i "$KEY" "$HOST" 'cd amaco-glazes-shop && npm run stock -- C-05 out'                        # mark OOS
ssh -i "$KEY" "$HOST" 'cd amaco-glazes-shop && npm run stock -- C-05 in'                         # back in stock
```

Re-price / re-seed after catalog changes (needs the Stripe key in the env):

```bash
ssh -i "$KEY" "$HOST" 'cd amaco-glazes-shop && set -a && sudo cat /etc/glaze-shop.env >/tmp/e && . /tmp/e && rm /tmp/e && \
  export STRIPE_SECRET_KEY=$(aws secretsmanager get-secret-value --secret-id "'$SECRET_ID'" --region "'$REGION'" --query SecretString --output text | jq -r .STRIPE_SECRET_KEY) && npm run sync-catalog'
```

---

## Backup & restore (Litestream → S3)

```bash
# Confirm replication is live (txid.db should advance as orders come in)
ssh -i "$KEY" "$HOST" 'journalctl -u glaze-shop --no-pager | grep "replica sync" | tail -3'
```

**Restore drill** (proves the backup) — run interactively on the box:

```bash
ssh -i "$KEY" "$HOST"
# then, on the instance:
sudo systemctl stop glaze-shop
sudo mv /data/shop.db /data/shop.db.bak
sudo bash -c 'set -a; . /etc/glaze-shop.env; set +a; cd ~ubuntu/amaco-glazes-shop && litestream restore -config litestream.yml "$DATABASE_PATH"'
sudo chown ubuntu:ubuntu /data/shop.db        # restore runs as root; hand it back to the app
sudo systemctl start glaze-shop
sqlite3 /data/shop.db "SELECT COUNT(*) FROM orders;"   # orders should still be there
```

---

## Disk

```bash
ssh -i "$KEY" "$HOST" 'lsblk'                 # find the data disk (Nitro/Lightsail = /dev/nvme1n1)
ssh -i "$KEY" "$HOST" 'df -h /data'           # free space on the data volume
```

---

## Redeploy after pushing code to `main`

```bash
# Re-run the bootstrap (idempotent). DATA_DEVICE override needed on NVMe hosts.
ssh -i "$KEY" "$HOST" \
  'curl -fsSL https://raw.githubusercontent.com/stellacheng98/amaco-glazes-shop/main/scripts/aws/bootstrap-instance.sh | DATA_DEVICE=/dev/nvme1n1 bash'

# Or a lighter app-only update:
ssh -i "$KEY" "$HOST" 'cd amaco-glazes-shop && git pull --ff-only && npm ci --omit=dev && sudo systemctl restart glaze-shop'
```

---

## restrict-ip-while-testing

The site is normally firewall-locked to your IP (so it's private pre-launch). But
while locked, **Stripe's webhook is blocked** — Stripe POSTs from its own IPs, not
yours — so orders won't record. To test the real order flow, briefly open the
site, test, then re-lock. (The Stripe checkout page itself is on
`checkout.stripe.com` and always works; only *your* server is gated.)

```bash
INSTANCE=glaze-shop-test        # or glaze-shop-prod
REGION=us-east-1
```

**1. Open the site to the public** (leave SSH locked to you):
```bash
aws lightsail open-instance-public-ports --instance-name $INSTANCE --region $REGION \
  --port-info fromPort=443,toPort=443,protocol=TCP,cidrs=0.0.0.0/0
aws lightsail open-instance-public-ports --instance-name $INSTANCE --region $REGION \
  --port-info fromPort=80,toPort=80,protocol=TCP,cidrs=0.0.0.0/0
```

**2. Test.** Buy a glaze with card `4242 4242 4242 4242`, then confirm it actually
**recorded** (not just the thank-you page, which reads Stripe directly and always
shows "paid"):
```bash
ssh -i lightsail-us-east-1.pem ubuntu@<static-ip> \
  'sqlite3 -header -column /data/shop.db "SELECT stripe_session_id, email, created_at FROM orders ORDER BY created_at DESC LIMIT 3;"'
```
A **new row** = the full chain works. Stripe → Webhooks → Recent deliveries should show **200**.

**3. Re-lock to your current IP** when done:
```bash
MYIP=$(curl -fsS https://checkip.amazonaws.com)
for p in 80 443 22; do
  aws lightsail open-instance-public-ports --instance-name $INSTANCE --region $REGION \
    --port-info fromPort=$p,toPort=$p,protocol=TCP,cidrs=${MYIP}/32
done
aws lightsail get-instance-port-states --instance-name $INSTANCE --region $REGION \
  --query 'portStates[].{port:fromPort,ipv4:cidrs}' --output table   # verify your /32
```

- Orders only record while 443 is reachable by Stripe (i.e. open to the world) — that's the point of opening it.
- Re-locking uses your **current** IP, so it's safe if your IP changed.
- IPv6 stays blocked throughout (`ipv6Cidrs` stay empty) — fine, since Stripe and the `sslip.io` name are IPv4.
- Don't leave it open longer than the test needs. A private alternative that keeps `/webhook` open is Caddy basic-auth (see [aws-setup.md → Restricting access before launch](aws-setup.md#restricting-access-before-launch)).

---

## Gotchas seen during setup

- **`Cannot GET /webhook`** in a browser is normal (POST-only endpoint).
- **502 Bad Gateway** = Caddy up but the Node app is down → check service status/logs.
- **"string did not match the expected pattern"** in the browser at checkout = the app is down (502); the fetch got HTML, not JSON.
- **Segfault on start** = Node too old for `better-sqlite3@13` (needs Node ≥ 22).
- **`Could not find a Litestream .deb`** = arch mismatch; amd64 is spelled `x86_64` in the asset name.
- **SSH key "invalid format"** = don't `base64 --decode` Lightsail's `privateKeyBase64`; it's already PEM.
