# Managing finished pieces (the Pieces section)

Finished one-of-a-kind pieces live in the **`pieces` table** in the SQLite DB and
are managed from the **admin page** — no code edits or deploys to add a piece.

## Admin page

Visit **`/admin`** (e.g. `https://<site>/admin`). It asks for the admin password
(`ADMIN_PASSWORD`), then lets you:

- **Add a piece**: name, price, swatch color, description, and photo URLs.
- **Mark sold / available** and **delete** pieces from the inventory list.

Prices and availability are authoritative on the server; the storefront and
checkout read from the `pieces` table.

## Photos (S3)

Piece photos are hosted in an **S3 bucket**. Upload each image to the bucket,
copy its public URL, and paste the URLs into the admin form (one per line — the
first is the cover shown in the grid). Only `https://…` URLs are kept; up to 12
per piece.

## The admin password

`ADMIN_PASSWORD` is read from Secrets Manager (same secret as the Stripe keys).
Set or change it with:

```bash
# merge ADMIN_PASSWORD into the existing secret (keeps the Stripe keys)
SECRET=glaze-shop/test   # or glaze-shop/prod
aws secretsmanager get-secret-value --secret-id "$SECRET" --region us-east-1 --query SecretString --output text \
  | jq '. + {ADMIN_PASSWORD: "your-password-here"}' \
  | xargs -0 -I{} aws secretsmanager put-secret-value --secret-id "$SECRET" --region us-east-1 --secret-string {}
# then restart:  sudo systemctl restart glaze-shop
```

If `ADMIN_PASSWORD` isn't set, the admin endpoints return 503 and `/admin` can't
be used (the storefront still works).
