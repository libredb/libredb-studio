/* eslint-disable @typescript-eslint/no-explicit-any */

declare module 'mssql' {
  const mssql: any;
  namespace mssql {
    type ConnectionPool = any;
    type Transaction = any;
    type Request = any;
    type config = any;
    type IResult = any;
  }
  export = mssql;
}

declare module 'oracledb' {
  const oracledb: any;
  namespace oracledb {
    type Pool = any;
    type Connection = any;
    type ExecuteResult = any;
  }
  export = oracledb;
}
