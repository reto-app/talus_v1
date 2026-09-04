SET ROLE talus_fn;
GRANT SELECT,INSERT ON app.pricing_revision,app.price_line,app.promo_code,app.promo_redemption TO talus_fn;
REVOKE UPDATE,DELETE ON app.pricing_revision,app.price_line FROM talus_fn;
RESET ROLE;
