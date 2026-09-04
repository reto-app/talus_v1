# Talus M01 local test database

M01 integration tests use a real local PostgreSQL database. They read `TEST_DATABASE_URL`; when it is absent, they use:

```text
postgres://postgres:postgres@localhost:5432/talus_test
```

The database account must be a PostgreSQL superuser for the initial M01 migration because it creates the Talus database roles.

## macOS with Homebrew

Run these commands from the repository root:

```sh
brew install postgresql@16
brew services start postgresql@16
createdb talus_test
export TEST_DATABASE_URL="postgres://$(whoami)@localhost:5432/talus_test"
npm install
npm run db:migrate:test
npm test
```

If you prefer the default URL baked into the test suite, create a local `postgres` login role with password `postgres` and use it instead:

```sh
createuser -s -P postgres
# Enter postgres when prompted for the password.
export TEST_DATABASE_URL="postgres://postgres:postgres@localhost:5432/talus_test"
npm install
npm run db:migrate:test
npm test
```

## Existing PostgreSQL installation

Create a fresh test database and set the connection string before migrating:

```sh
createdb -h localhost -U postgres talus_test
export TEST_DATABASE_URL="postgres://postgres:postgres@localhost:5432/talus_test"
npm install
npm run db:migrate:test
npm test
```

`npm run db:migrate:test` records completed migrations in `public.talus_schema_migration`, so it is safe to run again. Use a database dedicated to Talus tests: the suite creates tenant fixtures but does not remove them after a run.
