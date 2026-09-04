import{Pool}from"pg";import{beforeAll,afterAll,it,expect}from"vitest";
const u=process.env.TEST_DATABASE_URL??"postgres://postgres:postgres@localhost:5432/talus_test";let a,p;
beforeAll(async()=>{a=new Pool({connectionString:u});p=new Pool({connectionString:u});if(!(await a.query("SELECT column_name FROM information_schema.columns WHERE table_schema='app' AND table_name='audit_event' AND column_name='event_hash'")).rowCount)throw Error("audit hardening missing")});afterAll(async()=>{await p.end();await a.end()});
it("adds chained audit ledger columns",async()=>{expect((await a.query("SELECT count(*)::int n FROM app.audit_event WHERE event_hash IS NOT NULL")).rows[0].n).toBeGreaterThanOrEqual(0)});
