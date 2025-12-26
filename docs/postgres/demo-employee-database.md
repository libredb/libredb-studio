# Demo Employee Database Setup Guide

This guide explains how to set up a pre-configured demo PostgreSQL database for LibreDB Studio using Neon Cloud. This feature provides an instant, ready-to-use database experience for new users, demos, and product showcases.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Neon Cloud Setup](#neon-cloud-setup)
- [Loading the Employees Dataset](#loading-the-employees-dataset)
- [Creating a Read-Only User](#creating-a-read-only-user)
- [Environment Configuration](#environment-configuration)
- [How It Works](#how-it-works)
- [Security Considerations](#security-considerations)
- [Troubleshooting](#troubleshooting)

---

## Overview

The Demo Database feature automatically provisions a pre-configured PostgreSQL connection when users open LibreDB Studio. This eliminates the friction of manual database setup and allows users to immediately explore SQL capabilities with real, meaningful data.

### Key Benefits

- **Zero Configuration**: Users can start querying immediately
- **Real Dataset**: The Employees dataset contains realistic HR data (departments, salaries, titles)
- **Safe Environment**: Read-only access prevents accidental data modifications
- **Seamless UX**: Demo connection appears automatically with a distinctive badge

### The Employees Dataset

The dataset contains approximately 300,000 employee records with:
- Employee information (names, birth dates, hire dates)
- Department assignments and history
- Salary records over time
- Job titles and promotions
- Manager relationships

This provides rich data for demonstrating JOINs, aggregations, window functions, and complex queries.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           LibreDB Studio                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────┐    ┌──────────────────────┐    ┌────────────────┐  │
│  │   Environment   │───▶│ /api/demo-connection │───▶│   Dashboard    │  │
│  │   Variables     │    │     (Server)         │    │   (Client)     │  │
│  └─────────────────┘    └──────────────────────┘    └────────────────┘  │
│                                                              │          │
│  DEMO_DB_ENABLED=true                                        │          │
│  DEMO_DB_HOST=...                                            ▼          │
│  DEMO_DB_USER=...                              ┌────────────────────┐   │
│  DEMO_DB_PASSWORD=...                          │   LocalStorage     │   │
│                                                │   (Connections)    │   │
│                                                └────────────────────┘   │
│                                                              │          │
└──────────────────────────────────────────────────────────────│──────────┘
                                                               │
                                                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Neon Cloud PostgreSQL                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Database: employees                                              │   │
│  │  Schema: employees                                               │   │
│  │                                                                  │   │
│  │  Tables:                                                         │   │
│  │  ├── employees.employee        (~300k rows)                      │   │
│  │  ├── employees.department      (9 departments)                   │   │
│  │  ├── employees.department_employee                               │   │
│  │  ├── employees.department_manager                                │   │
│  │  ├── employees.salary                                            │   │
│  │  └── employees.title                                             │   │
│  │                                                                  │   │
│  │  User: employees_readonly (SELECT only)                          │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Request Flow

1. User opens LibreDB Studio
2. Dashboard component mounts and calls `/api/demo-connection`
3. Server checks `DEMO_DB_ENABLED` environment variable
4. If enabled, server returns connection details (including credentials)
5. Client stores connection in LocalStorage with `isDemo: true` flag
6. Demo connection appears in sidebar with special styling
7. User can immediately query the Employees database

---

## Neon Cloud Setup

### Step 1: Create a Neon Account

1. Go to [https://neon.tech](https://neon.tech)
2. Sign up with GitHub, Google, or email
3. Create a new project (free tier is sufficient)

### Step 2: Note Your Connection Details

After creating a project, Neon provides connection details:

```
PGHOST='ep-xxx-xxx-pooler.region.aws.neon.tech'
PGDATABASE='neondb'
PGUSER='neondb_owner'
PGPASSWORD='npg_xxxxxxxxxxxxx'
PGSSLMODE='require'
```

> **Important**: Save these credentials securely. The pooler endpoint (`-pooler`) is recommended for serverless applications.

### Step 3: Connect via psql (Optional)

Test your connection:

```bash
psql "postgresql://neondb_owner:npg_xxxxx@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require"
```

---

## Loading the Employees Dataset

The Employees dataset is a well-known sample database originally created for MySQL and adapted for PostgreSQL.

### Step 1: Create the Database and Schema

Connect to your Neon project (default `neondb`) and create a separate database:

```sql
-- Create a dedicated database for the employees data
CREATE DATABASE employees;

-- Connect to the new database
\c employees

-- Create the schema
CREATE SCHEMA IF NOT EXISTS employees;
```

> **Important**: The employees dataset must be loaded into a separate `employees` database, not `neondb`. This keeps demo data isolated from your default database.

### Step 2: Download the Dataset

```bash
# Download the PostgreSQL-compatible employees dump
wget https://raw.githubusercontent.com/neondatabase/postgres-sample-dbs/main/employees.sql.gz
```

### Step 3: Load the Data

```bash
# Replace with your actual connection details
# Note: Connect to the 'employees' database, not 'neondb'
pg_restore -d "postgresql://[user]:[password]@[neon_hostname]/employees" \
  -Fc employees.sql.gz \
  -c -v \
  --no-owner \
  --no-privileges
```

**Parameters explained:**
- `-Fc`: Custom format (compressed)
- `-c`: Clean (drop) existing objects before recreating
- `-v`: Verbose output
- `--no-owner`: Don't set ownership
- `--no-privileges`: Don't restore privileges

### Step 4: Verify the Import

```sql
-- Check tables exist
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'employees';

-- Count records
SELECT
  'employee' as table_name, COUNT(*) FROM employees.employee
UNION ALL
SELECT 'department', COUNT(*) FROM employees.department
UNION ALL
SELECT 'salary', COUNT(*) FROM employees.salary;
```

Expected output:
```
  table_name  | count
--------------+--------
 employee     | 300024
 department   |      9
 salary       | 2844047
```

---

## Creating a Read-Only User

For security, create a dedicated read-only user for demo access.

### Step 1: Create the User

Connect to the `employees` database as the owner and run:

```sql
-- Create a read-only user
CREATE USER employees_readonly WITH PASSWORD 'your_secure_password_here';

-- Grant connect permission to the employees database
GRANT CONNECT ON DATABASE employees TO employees_readonly;

-- Grant usage on the employees schema
GRANT USAGE ON SCHEMA employees TO employees_readonly;

-- Grant SELECT on all existing tables
GRANT SELECT ON ALL TABLES IN SCHEMA employees TO employees_readonly;

-- Grant SELECT on future tables (optional)
ALTER DEFAULT PRIVILEGES IN SCHEMA employees
GRANT SELECT ON TABLES TO employees_readonly;
```

### Step 2: Verify Permissions

Connect as the read-only user and test:

```bash
psql "postgresql://employees_readonly:password@host/employees?sslmode=require"
```

```sql
-- This should work
SELECT * FROM employees.employee LIMIT 5;

-- This should fail with "permission denied"
INSERT INTO employees.employee (emp_no, first_name, last_name)
VALUES (999999, 'Test', 'User');
```

### Step 3: Test from LibreDB Studio

Before configuring environment variables, test the connection manually in LibreDB Studio to ensure everything works.

---

## Environment Configuration

### Required Variables

Add these to your deployment environment (Render, Vercel, Docker, etc.):

```bash
# Enable the demo database feature
DEMO_DB_ENABLED=true

# Display name in the UI
DEMO_DB_NAME=Employee PostgreSQL (Demo)

# Neon connection details
DEMO_DB_HOST=ep-xxx-xxx-pooler.region.aws.neon.tech
DEMO_DB_PORT=5432
DEMO_DB_DATABASE=employees
DEMO_DB_USER=employees_readonly
DEMO_DB_PASSWORD=your_readonly_password
```

> **Critical**: Make sure `DEMO_DB_DATABASE=employees`, not `neondb`. The employees dataset is in a separate database.

### Render Deployment

1. Go to your Render dashboard
2. Select your LibreDB Studio service
3. Navigate to **Environment** tab
4. Add each variable above
5. Click **Save Changes** (triggers redeploy)

### Docker Deployment

```bash
docker run -d \
  -e DEMO_DB_ENABLED=true \
  -e DEMO_DB_NAME="Employee PostgreSQL (Demo)" \
  -e DEMO_DB_HOST=ep-xxx-pooler.region.aws.neon.tech \
  -e DEMO_DB_PORT=5432 \
  -e DEMO_DB_DATABASE=employees \
  -e DEMO_DB_USER=employees_readonly \
  -e DEMO_DB_PASSWORD=your_password \
  libredb-studio
```

### Local Development

Add to `.env.local`:

```bash
DEMO_DB_ENABLED=true
DEMO_DB_NAME=Employee PostgreSQL (Demo)
DEMO_DB_HOST=ep-xxx-pooler.region.aws.neon.tech
DEMO_DB_PORT=5432
DEMO_DB_DATABASE=employees
DEMO_DB_USER=employees_readonly
DEMO_DB_PASSWORD=your_password
```

---

## How It Works

### API Endpoint: `/api/demo-connection`

**Location:** `src/app/api/demo-connection/route.ts`

```typescript
// Simplified logic
export async function GET() {
  // Check if feature is enabled
  if (process.env.DEMO_DB_ENABLED !== 'true') {
    return { enabled: false, connection: null };
  }

  // Return connection object
  return {
    enabled: true,
    connection: {
      id: 'demo-postgres-neon',
      name: process.env.DEMO_DB_NAME,
      type: 'postgres',
      host: process.env.DEMO_DB_HOST,
      port: parseInt(process.env.DEMO_DB_PORT),
      database: process.env.DEMO_DB_DATABASE,
      user: process.env.DEMO_DB_USER,
      password: process.env.DEMO_DB_PASSWORD,
      isDemo: true,  // Special flag
    }
  };
}
```

### Dashboard Integration

**Location:** `src/components/Studio.tsx`

On component mount:

```typescript
useEffect(() => {
  const initializeConnections = async () => {
    const loadedConnections = storage.getConnections();

    // Fetch demo connection
    const res = await fetch('/api/demo-connection');
    const data = await res.json();

    if (data.enabled && data.connection) {
      // Check if already exists
      const existingDemo = loadedConnections.find(c => c.id === data.connection.id);

      if (!existingDemo) {
        // Add to storage
        storage.saveConnection(data.connection);

        // Auto-select if no other connections
        if (loadedConnections.length === 0) {
          setActiveConnection(data.connection);
        }
      }
    }
  };

  initializeConnections();
}, []);
```

### Sidebar Display

**Location:** `src/components/Sidebar.tsx`

Demo connections have special treatment:

```typescript
// Visual distinction
{conn.isDemo && (
  <span className="text-emerald-400">Demo Database</span>
)}

// Prevent deletion
{!conn.isDemo && (
  <Button onClick={() => onDeleteConnection(conn.id)}>
    <Trash2 />
  </Button>
)}
```

### Type Definition

**Location:** `src/lib/types.ts`

```typescript
export interface DatabaseConnection {
  id: string;
  name: string;
  type: DatabaseType;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  createdAt: Date;
  isDemo?: boolean;  // Demo connections cannot be deleted/edited
}
```

---

## Security Considerations

### 1. Read-Only Access

Always use a read-only database user for demo connections:

```sql
-- The user should only have SELECT permissions
GRANT SELECT ON ALL TABLES IN SCHEMA employees TO employees_readonly;
```

This prevents:
- Accidental data deletion (DROP, DELETE, TRUNCATE)
- Data modification (INSERT, UPDATE)
- Schema changes (ALTER, CREATE)

### 2. Connection Pooling

Use Neon's pooler endpoint (`-pooler` suffix) to:
- Handle multiple concurrent connections efficiently
- Reduce connection overhead
- Work better with serverless deployments

### 3. Password Security

- Use a strong, unique password for the demo user
- Store credentials in environment variables, never in code
- Rotate passwords periodically

### 4. Rate Limiting

Consider implementing rate limiting on the demo database to prevent abuse:

```sql
-- Example: Set connection limits (at Neon dashboard level)
-- Or implement application-level throttling
```

### 5. Data Sensitivity

The Employees dataset is synthetic/generated data. Never use real personal data for demo purposes.

---

## Troubleshooting

### Demo Connection Not Appearing

1. **Check environment variables:**
   ```bash
   # Verify DEMO_DB_ENABLED is exactly "true"
   echo $DEMO_DB_ENABLED
   ```

2. **Check API response:**
   ```bash
   curl https://your-app.com/api/demo-connection
   ```

3. **Clear localStorage:**
   ```javascript
   // In browser console
   localStorage.removeItem('libredb_studio_db_connections');
   ```

### Schema Shows 0 Tables

This is the most common issue. If the connection succeeds but no tables appear:

1. **Wrong database configured:**
   ```bash
   # Common mistake: using neondb instead of employees
   DEMO_DB_DATABASE=neondb    # WRONG
   DEMO_DB_DATABASE=employees # CORRECT
   ```

2. **Verify tables exist in the employees database:**
   ```sql
   -- Connect as owner to employees database
   \c employees
   SELECT table_schema, table_name
   FROM information_schema.tables
   WHERE table_schema = 'employees';
   ```

3. **Check user has USAGE permission on schema:**
   ```sql
   GRANT USAGE ON SCHEMA employees TO employees_readonly;
   ```

### Connection Fails

1. **Verify Neon endpoint:**
   - Ensure using the pooler endpoint (`-pooler`)
   - Check SSL mode is enabled

2. **Test credentials directly:**
   ```bash
   psql "postgresql://user:pass@host/db?sslmode=require"
   ```

3. **Check user permissions:**
   ```sql
   SELECT * FROM information_schema.role_table_grants
   WHERE grantee = 'employees_readonly';
   ```

### Query Errors

1. **Schema prefix required:**
   ```sql
   -- Wrong
   SELECT * FROM employee;

   -- Correct
   SELECT * FROM employees.employee;
   ```

2. **Set search path (alternative):**
   ```sql
   SET search_path TO employees, public;
   SELECT * FROM employee;  -- Now works
   ```

---

## Sample Queries

Here are some example queries users can try with the Employees dataset:

### Basic Queries

```sql
-- List all employees
SELECT * FROM employees.employee LIMIT 100;

-- Count by gender
SELECT gender, COUNT(*)
FROM employees.employee
GROUP BY gender;

-- Find employees hired in a specific year
SELECT * FROM employees.employee
WHERE EXTRACT(YEAR FROM hire_date) = 1990
LIMIT 50;
```

### Join Queries

```sql
-- Employees with their current department
SELECT
  e.first_name,
  e.last_name,
  d.dept_name
FROM employees.employee e
JOIN employees.department_employee de ON e.emp_no = de.employee_id
JOIN employees.department d ON de.department_id = d.id
WHERE de.to_date > CURRENT_DATE
LIMIT 50;
```

### Aggregation Queries

```sql
-- Top 5 departments by average salary
SELECT
  d.dept_name,
  ROUND(AVG(s.amount)::numeric, 2) AS avg_salary
FROM employees.salary s
JOIN employees.department_employee de ON s.employee_id = de.employee_id
JOIN employees.department d ON de.department_id = d.id
WHERE s.to_date > CURRENT_DATE
  AND de.to_date > CURRENT_DATE
GROUP BY d.dept_name
ORDER BY avg_salary DESC
LIMIT 5;
```

### Window Functions

```sql
-- Salary ranking within each department
SELECT
  e.first_name,
  e.last_name,
  d.dept_name,
  s.amount AS salary,
  RANK() OVER (PARTITION BY d.id ORDER BY s.amount DESC) AS salary_rank
FROM employees.employee e
JOIN employees.salary s ON e.emp_no = s.employee_id
JOIN employees.department_employee de ON e.emp_no = de.employee_id
JOIN employees.department d ON de.department_id = d.id
WHERE s.to_date > CURRENT_DATE
  AND de.to_date > CURRENT_DATE
LIMIT 100;
```

---

## References

- [Neon Documentation](https://neon.tech/docs)
- [PostgreSQL Sample Databases](https://github.com/neondatabase/postgres-sample-dbs)
- [Original Employees Database](https://github.com/datacharmer/test_db) (MySQL version)
- [PostgreSQL Adaptation](https://github.com/h8/employees-database)

---

## License

The Employees dataset is licensed under [Creative Commons Attribution-Share Alike 3.0 Unported License](http://creativecommons.org/licenses/by-sa/3.0/).

Original data generated by Fusheng Wang and Carlo Zaniolo (Siemens Corporate Research), with schema design by Giuseppe Maxia and MySQL adaptation by Patrick Crews.
