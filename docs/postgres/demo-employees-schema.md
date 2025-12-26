# Demo Employees Database Schema

This document describes the schema of the Neon Cloud PostgreSQL demo database used by LibreDB Studio.

## Database Info

- **Database**: `employees`
- **Schema**: `employees`
- **Total Rows**: ~3.9M across 6 tables

## Tables

### employees.employee (~300,024 rows)

| Column | Type | Nullable | Key |
|--------|------|----------|-----|
| id | bigint | NO | PK |
| birth_date | date | NO | |
| first_name | varchar | NO | |
| last_name | varchar | NO | |
| gender | USER-DEFINED (enum: M/F) | NO | |
| hire_date | date | NO | |

### employees.department (9 rows)

| Column | Type | Nullable | Key |
|--------|------|----------|-----|
| id | character | NO | PK |
| dept_name | varchar | NO | |

**Values:**
| id | dept_name |
|----|-----------|
| d001 | Marketing |
| d002 | Finance |
| d003 | Human Resources |
| d004 | Production |
| d005 | Development |
| d006 | Quality Management |
| d007 | Sales |
| d008 | Research |
| d009 | Customer Service |

### employees.department_employee (~331,603 rows)

| Column | Type | Nullable | Key |
|--------|------|----------|-----|
| employee_id | bigint | NO | PK, FK -> employee.id |
| department_id | character | NO | PK, FK -> department.id |
| from_date | date | NO | |
| to_date | date | NO | |

### employees.department_manager (24 rows)

| Column | Type | Nullable | Key |
|--------|------|----------|-----|
| employee_id | bigint | NO | PK, FK -> employee.id |
| department_id | character | NO | PK, FK -> department.id |
| from_date | date | NO | |
| to_date | date | NO | |

### employees.salary (~2,844,047 rows)

| Column | Type | Nullable | Key |
|--------|------|----------|-----|
| employee_id | bigint | NO | PK, FK -> employee.id |
| amount | bigint | NO | |
| from_date | date | NO | PK |
| to_date | date | NO | |

**Stats:**
- Min salary: 38,623
- Max salary: 158,220
- Avg salary: 63,811

### employees.title (~443,308 rows)

| Column | Type | Nullable | Key |
|--------|------|----------|-----|
| employee_id | bigint | NO | PK, FK -> employee.id |
| title | varchar | NO | PK |
| from_date | date | NO | PK |
| to_date | date | YES | |

**Unique Titles:**
- Assistant Engineer
- Engineer
- Manager
- Senior Engineer
- Senior Staff
- Staff
- Technique Leader

## Relationships

```
employee (1) ────┬──── (N) department_employee ──── (N) department
                 │
                 ├──── (N) department_manager ───── (N) department
                 │
                 ├──── (N) salary
                 │
                 └──── (N) title
```

## Foreign Keys

| Source Table | Source Column | Target Table | Target Column |
|--------------|---------------|--------------|---------------|
| department_employee | employee_id | employee | id |
| department_employee | department_id | department | id |
| department_manager | employee_id | employee | id |
| department_manager | department_id | department | id |
| salary | employee_id | employee | id |
| title | employee_id | employee | id |

## Query Notes

- All tables are in the `employees` schema, so queries must use `employees.table_name` format
- Use `to_date > CURRENT_DATE` or `to_date = '9999-01-01'` to filter for current records
- The `gender` column uses an enum type with values 'M' and 'F'
- Dates range from 1985 to 2002 (historical dataset)
