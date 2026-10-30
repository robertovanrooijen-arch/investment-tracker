# Database migrations

The migrations in `migrations/` were applied to production on 2026-10-30 and
their filenames match the versions stored in Supabase migration history.
Nothing in the app or a Vercel build executes SQL automatically.

The target account data from `manual/m12_google_funding_and_vusa_value_date.sql`
was applied on 2026-10-30 together with ten confirmed 2025 statement balances.
`manual/m8_u1_tr_contributions.sql` and `migrations-post-deploy/` have not been
run.

| Folder | What | When |
|---|---|---|
| `manual/00_preflight_readonly.sql` | MA-0: read-only inventory and data checks | first, on the target |
| `migrations/` | MA, M1–M7 (+M11), M9, M10 (in M6), official balances | before the deploy |
| `migrations-post-deploy/` | MA-3: fx_rates writes only via service role | after the deploy |
| `manual/m8_u1_tr_contributions.sql` | M8: data move for the old U1 account | only with explicit approval |
| `manual/m12_google_funding_and_vusa_value_date.sql` | Google funding as re-used sale proceeds; VUSA dividend value date | after M6 + M9, with approval |

## Order

1. Run `manual/00_preflight_readonly.sql` on a **Supabase branch** (copy of
   production). Expected: 0 duplicate source keys, 0 owner mismatches,
   0 year mismatches; 1 known commodity row without kind/unit.
2. Apply `migrations/` on the branch, oldest first. Each file runs as a single
   transaction (the CLI does this; in the SQL editor wrap a file in
   `begin; … commit;`). MA stops by itself if a security-definer function
   is used in a policy.
3. Test on the branch: grants/RLS tests from the implementation report
   (anon nowhere; authenticated reads only its own rows; no client writes to
   global tables), then deploy a preview against the branch with
   `SNAPSHOT_QUALITY_COLUMNS=enabled` and run one manual refresh.
4. Repeat steps 1–2 on production while the **current** production code runs
   (all changes are additive; old code ignores the new columns).
5. Deploy the new code with `SNAPSHOT_QUALITY_COLUMNS=enabled`.
   Without the flag the new code writes exactly the old columns.
6. Apply `migrations-post-deploy/` (fx_rates writes revoked from clients).
7. Historical valuation: dry-run only
   (`scripts/valuation/backfill-valuations-dry-run.mjs`, refuses `--apply`),
   review, then a separate, still-to-be-built apply step.

Do not validate `investments_commodity_fields_not_null` or
`transactions_imported_needs_fx` before the preflight shows 0 violations
and the U2 row has been decided.
