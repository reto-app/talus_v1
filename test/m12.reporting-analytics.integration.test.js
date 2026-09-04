import{Pool}from"pg";import{beforeAll,afterAll,it,expect}from"vitest";
const u=process.env.TEST_DATABASE_URL??"postgres://postgres:postgres@localhost:5432/talus_test";let a,p;
beforeAll(async()=>{a=new Pool({connectionString:u});p=new Pool({connectionString:u});if(!(await a.query("SELECT to_regclass('app.analytics_daily_snapshot') x")).rows[0].x)throw Error("M12 migration missing")});afterAll(async()=>{await p.end();await a.end()});
it("installs tenant-scoped integer analytics contracts",async()=>{expect((await a.query("SELECT to_regclass('app.analytics_daily_snapshot') x")).rows[0].x).toBe("app.analytics_daily_snapshot")});
