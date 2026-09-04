GRANT SELECT, REFERENCES ON TABLE app.pricing_revision TO talus_fn;
REVOKE UPDATE, DELETE ON TABLE app.pricing_revision, app.price_line FROM PUBLIC, talus_fn, talus_api, talus_customer, talus_staff, talus_device;
