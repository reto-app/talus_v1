SET ROLE talus_fn;
GRANT ALL PRIVILEGES ON TABLE app.pricing_revision, app.price_line, app.promo_code, app.promo_redemption TO talus_fn;
REVOKE UPDATE, DELETE ON TABLE app.pricing_revision, app.price_line FROM talus_fn, PUBLIC, talus_api, talus_customer, talus_staff, talus_device;
RESET ROLE;
