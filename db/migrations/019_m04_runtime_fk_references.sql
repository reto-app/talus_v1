GRANT REFERENCES ON TABLE app.pricing_revision TO talus_staff, talus_api;
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE app.pricing_revision, app.price_line FROM talus_staff, talus_api;
