// Ends a read-only transaction through node-oracledb Thin, the driver the provider uses, as the
// read-only user APP_RO. run.sh passes the connect string. ORA-01453 on a second SET TRANSACTION
// shows a transaction is still open; its success after a driver call shows that call ended it.
import oracledb from "oracledb";

const connectString = process.argv[2];
const connection = await oracledb.getConnection({
  user: "APP_RO",
  password: "not-a-real-password",
  connectString,
});
console.log(`thin=${oracledb.thin} server=${connection.oracleServerVersionString}`);
const step = async (name, run) => {
  try {
    const result = await run();
    console.log(`${name}: ok ${JSON.stringify(result?.rows ?? null)}`);
  } catch (error) {
    console.log(`${name}: ${error.message.split("\n")[0]}`);
  }
};
await step("SET TRANSACTION READ ONLY", () => connection.execute("SET TRANSACTION READ ONLY"));
await step("SELECT 1 FROM DUAL", () => connection.execute("SELECT 1 FROM DUAL"));
await step("SET TRANSACTION READ ONLY again, same transaction", () => connection.execute("SET TRANSACTION READ ONLY"));
await step("connection.rollback()", () => connection.rollback());
await step("SET TRANSACTION READ ONLY after rollback()", () => connection.execute("SET TRANSACTION READ ONLY"));
await step("connection.commit()", () => connection.commit());
await step("SET TRANSACTION READ ONLY after commit()", () => connection.execute("SET TRANSACTION READ ONLY"));
await step("execute ROLLBACK statement", () => connection.execute("ROLLBACK"));
await step("execute COMMIT statement", () => connection.execute("COMMIT"));
await step("connection.rollback() again", () => connection.rollback());
await connection.close();
