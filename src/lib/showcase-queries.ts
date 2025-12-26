/**
 * Showcase SQL Queries for Demo Database
 *
 * These queries demonstrate LibreDB Studio's capabilities with the Neon Employee database.
 * Each query showcases different SQL features: JOINs, aggregations, window functions, etc.
 */

export interface ShowcaseQuery {
  title: string;
  description: string;
  query: string;
}

export const SHOWCASE_QUERIES: ShowcaseQuery[] = [
  {
    title: 'Department Salary Analysis',
    description: 'Discover salary insights across departments with team sizes',
    query: `-- Department Salary Analysis
-- Discover how salaries vary across different departments
SELECT
  d.dept_name AS department,
  COUNT(DISTINCT de.employee_id) AS team_size,
  ROUND(AVG(s.amount), 0) AS avg_salary,
  MIN(s.amount) AS min_salary,
  MAX(s.amount) AS max_salary
FROM employees.department d
JOIN employees.department_employee de ON d.id = de.department_id
JOIN employees.salary s ON de.employee_id = s.employee_id
WHERE de.to_date > CURRENT_DATE
  AND s.to_date > CURRENT_DATE
GROUP BY d.dept_name
ORDER BY avg_salary DESC;`
  },
  {
    title: 'Top Earners by Department',
    description: 'Find top 3 earners in each department using window functions',
    query: `-- Top Earners by Department
-- Using RANK() window function to find top 3 earners per department
SELECT department, first_name, last_name, salary, dept_rank
FROM (
  SELECT
    d.dept_name AS department,
    e.first_name,
    e.last_name,
    s.amount AS salary,
    RANK() OVER (PARTITION BY d.dept_name ORDER BY s.amount DESC) AS dept_rank
  FROM employees.employee e
  JOIN employees.department_employee de ON e.id = de.employee_id
  JOIN employees.department d ON de.department_id = d.id
  JOIN employees.salary s ON e.id = s.employee_id
  WHERE de.to_date > CURRENT_DATE
    AND s.to_date > CURRENT_DATE
) ranked
WHERE dept_rank <= 3
ORDER BY department, dept_rank;`
  },
  {
    title: 'Hiring Trends Over Years',
    description: 'Analyze hiring patterns and gender distribution by year',
    query: `-- Hiring Trends Over Years
-- See how hiring patterns changed over time with gender breakdown
SELECT
  EXTRACT(YEAR FROM hire_date) AS year,
  COUNT(*) AS total_hires,
  SUM(CASE WHEN gender = 'M' THEN 1 ELSE 0 END) AS male_hires,
  SUM(CASE WHEN gender = 'F' THEN 1 ELSE 0 END) AS female_hires,
  ROUND(100.0 * SUM(CASE WHEN gender = 'F' THEN 1 ELSE 0 END) / COUNT(*), 1) AS female_pct
FROM employees.employee
GROUP BY EXTRACT(YEAR FROM hire_date)
ORDER BY year;`
  },
  {
    title: 'Department Growth Timeline',
    description: 'Track how departments grew over the years',
    query: `-- Department Growth Timeline
-- See how each department expanded over the years
SELECT
  d.dept_name AS department,
  EXTRACT(YEAR FROM de.from_date) AS year,
  COUNT(*) AS new_members
FROM employees.department d
JOIN employees.department_employee de ON d.id = de.department_id
GROUP BY d.dept_name, EXTRACT(YEAR FROM de.from_date)
ORDER BY department, year
LIMIT 50;`
  },
  {
    title: 'Current Managers Overview',
    description: 'List all current department managers with their tenure',
    query: `-- Current Managers Overview
-- Find who manages each department and how long they've been in the role
SELECT
  d.dept_name AS department,
  e.first_name || ' ' || e.last_name AS manager_name,
  dm.from_date AS manager_since,
  EXTRACT(YEAR FROM AGE(CURRENT_DATE, dm.from_date)) AS years_as_manager
FROM employees.department_manager dm
JOIN employees.employee e ON dm.employee_id = e.id
JOIN employees.department d ON dm.department_id = d.id
WHERE dm.to_date > CURRENT_DATE
ORDER BY years_as_manager DESC;`
  },
  {
    title: 'Title Distribution Analysis',
    description: 'Explore the distribution of job titles across the company',
    query: `-- Title Distribution Analysis
-- See how many employees hold each title currently
SELECT
  t.title,
  COUNT(*) AS employee_count,
  ROUND(AVG(s.amount), 0) AS avg_salary
FROM employees.title t
JOIN employees.salary s ON t.employee_id = s.employee_id
WHERE t.to_date > CURRENT_DATE
  AND s.to_date > CURRENT_DATE
GROUP BY t.title
ORDER BY employee_count DESC;`
  },
  {
    title: 'Salary Percentiles by Department',
    description: 'Calculate salary percentiles using window functions',
    query: `-- Salary Percentiles by Department
-- Find median and percentile salaries per department
SELECT DISTINCT
  d.dept_name AS department,
  PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY s.amount) OVER (PARTITION BY d.dept_name) AS p25_salary,
  PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY s.amount) OVER (PARTITION BY d.dept_name) AS median_salary,
  PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY s.amount) OVER (PARTITION BY d.dept_name) AS p75_salary
FROM employees.department d
JOIN employees.department_employee de ON d.id = de.department_id
JOIN employees.salary s ON de.employee_id = s.employee_id
WHERE de.to_date > CURRENT_DATE
  AND s.to_date > CURRENT_DATE
ORDER BY median_salary DESC;`
  },
  {
    title: 'Recent Hires with Departments',
    description: 'View the most recently hired employees and their departments',
    query: `-- Recent Hires with Departments
-- See who joined the company most recently
SELECT
  e.first_name,
  e.last_name,
  e.hire_date,
  d.dept_name AS department,
  t.title
FROM employees.employee e
JOIN employees.department_employee de ON e.id = de.employee_id
JOIN employees.department d ON de.department_id = d.id
LEFT JOIN employees.title t ON e.id = t.employee_id AND t.to_date > CURRENT_DATE
WHERE de.to_date > CURRENT_DATE
ORDER BY e.hire_date DESC
LIMIT 25;`
  },
  {
    title: 'Gender Salary Comparison',
    description: 'Compare average salaries between genders across departments',
    query: `-- Gender Salary Comparison
-- Analyze salary differences by gender in each department
SELECT
  d.dept_name AS department,
  ROUND(AVG(CASE WHEN e.gender = 'M' THEN s.amount END), 0) AS avg_male_salary,
  ROUND(AVG(CASE WHEN e.gender = 'F' THEN s.amount END), 0) AS avg_female_salary,
  ROUND(AVG(s.amount), 0) AS avg_overall_salary
FROM employees.employee e
JOIN employees.department_employee de ON e.id = de.employee_id
JOIN employees.department d ON de.department_id = d.id
JOIN employees.salary s ON e.id = s.employee_id
WHERE de.to_date > CURRENT_DATE
  AND s.to_date > CURRENT_DATE
GROUP BY d.dept_name
ORDER BY avg_overall_salary DESC;`
  },
  {
    title: 'Employee Count by Title and Department',
    description: 'Cross-tabulation of titles across departments',
    query: `-- Employee Count by Title and Department
-- See how titles are distributed across departments
SELECT
  d.dept_name AS department,
  t.title,
  COUNT(*) AS employee_count
FROM employees.employee e
JOIN employees.department_employee de ON e.id = de.employee_id
JOIN employees.department d ON de.department_id = d.id
JOIN employees.title t ON e.id = t.employee_id
WHERE de.to_date > CURRENT_DATE
  AND t.to_date > CURRENT_DATE
GROUP BY d.dept_name, t.title
ORDER BY department, employee_count DESC;`
  }
];

/**
 * Returns a random showcase query for demo connections
 */
export function getRandomShowcaseQuery(): string {
  const index = Math.floor(Math.random() * SHOWCASE_QUERIES.length);
  return SHOWCASE_QUERIES[index].query;
}

/**
 * Returns the default query based on connection type
 */
export function getDefaultQuery(isDemo: boolean, dbType?: string): string {
  if (isDemo) {
    return getRandomShowcaseQuery();
  }

  if (dbType === 'mongodb') {
    return '// Start typing your MongoDB query here\n';
  }

  return '-- Start typing your SQL query here\n';
}
