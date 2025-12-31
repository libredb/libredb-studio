/**
 * Showcase SQL Queries for Demo Database
 *
 * These queries demonstrate LibreDB Studio's capabilities with the Neon Employee database.
 * Organized by difficulty: Simple -> Intermediate -> Advanced
 */

export interface ShowcaseQuery {
  title: string;
  description: string;
  difficulty: 'simple' | 'intermediate' | 'advanced';
  query: string;
}

export const SHOWCASE_QUERIES: ShowcaseQuery[] = [
  // ============================================
  // SIMPLE QUERIES - Easy to understand basics
  // ============================================
  {
    title: 'Employee Directory',
    description: 'Browse employees with their hire dates',
    difficulty: 'simple',
    query: `-- Employee Directory
-- Simple SELECT with ordering
SELECT
  first_name,
  last_name,
  gender,
  hire_date,
  EXTRACT(YEAR FROM AGE(CURRENT_DATE, hire_date)) AS years_employed
FROM employees.employee
ORDER BY hire_date DESC
LIMIT 25;`
  },
  {
    title: 'Department Overview',
    description: 'All departments with employee counts',
    difficulty: 'simple',
    query: `-- Department Overview
-- Basic aggregation with GROUP BY
SELECT
  d.dept_name AS department,
  COUNT(*) AS employee_count
FROM employees.department d
JOIN employees.department_employee de ON d.id = de.department_id
WHERE de.to_date > CURRENT_DATE
GROUP BY d.dept_name
ORDER BY employee_count DESC;`
  },
  {
    title: 'Name Popularity Contest',
    description: 'Most common first names in the company',
    difficulty: 'simple',
    query: `-- Name Popularity Contest
-- Which names are most common?
SELECT
  first_name,
  COUNT(*) AS count,
  STRING_AGG(DISTINCT gender::text, ', ') AS used_by_genders
FROM employees.employee
GROUP BY first_name
ORDER BY count DESC
LIMIT 20;`
  },
  {
    title: 'Birthday Calendar',
    description: 'When do most employees celebrate birthdays?',
    difficulty: 'simple',
    query: `-- Birthday Calendar
-- Birth month distribution across the company
SELECT
  TO_CHAR(birth_date, 'Month') AS birth_month,
  COUNT(*) AS employee_count,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER(), 1) AS percentage
FROM employees.employee
GROUP BY TO_CHAR(birth_date, 'Month'), EXTRACT(MONTH FROM birth_date)
ORDER BY EXTRACT(MONTH FROM birth_date);`
  },

  // ============================================
  // INTERMEDIATE QUERIES - JOINs and aggregations
  // ============================================
  {
    title: 'Friday the 13th Club',
    description: 'Employees hired on Friday the 13th!',
    difficulty: 'intermediate',
    query: `-- Friday the 13th Club
-- Find the brave souls hired on this "unlucky" day
SELECT
  first_name || ' ' || last_name AS employee,
  hire_date,
  TO_CHAR(hire_date, 'FMMonth DD, YYYY') AS formatted_date,
  d.dept_name AS department
FROM employees.employee e
JOIN employees.department_employee de ON e.id = de.employee_id
JOIN employees.department d ON de.department_id = d.id
WHERE EXTRACT(DAY FROM hire_date) = 13
  AND EXTRACT(DOW FROM hire_date) = 5
  AND de.to_date > CURRENT_DATE
ORDER BY hire_date
LIMIT 25;`
  },
  {
    title: 'Age at Hire Analysis',
    description: 'What age were employees when hired?',
    difficulty: 'intermediate',
    query: `-- Age at Hire Analysis
-- Distribution of hiring ages using CASE expressions
SELECT
  CASE
    WHEN AGE(hire_date, birth_date) < INTERVAL '25 years' THEN 'Under 25'
    WHEN AGE(hire_date, birth_date) < INTERVAL '35 years' THEN '25-34'
    WHEN AGE(hire_date, birth_date) < INTERVAL '45 years' THEN '35-44'
    ELSE '45+'
  END AS age_group_at_hire,
  COUNT(*) AS employees,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER(), 1) AS percentage
FROM employees.employee
GROUP BY 1
ORDER BY MIN(AGE(hire_date, birth_date));`
  },
  {
    title: 'Department Salary Showdown',
    description: 'Which department pays the best?',
    difficulty: 'intermediate',
    query: `-- Department Salary Showdown
-- Compare salary statistics across departments
SELECT
  d.dept_name AS department,
  COUNT(DISTINCT de.employee_id) AS team_size,
  MIN(s.amount) AS lowest_salary,
  ROUND(AVG(s.amount)) AS avg_salary,
  MAX(s.amount) AS highest_salary,
  MAX(s.amount) - MIN(s.amount) AS salary_spread
FROM employees.department d
JOIN employees.department_employee de ON d.id = de.department_id
JOIN employees.salary s ON de.employee_id = s.employee_id
WHERE de.to_date > CURRENT_DATE AND s.to_date > CURRENT_DATE
GROUP BY d.dept_name
ORDER BY avg_salary DESC;`
  },
  {
    title: 'Title Distribution',
    description: 'Job titles and their average salaries',
    difficulty: 'intermediate',
    query: `-- Title Distribution
-- What titles exist and how do they pay?
SELECT
  t.title,
  COUNT(*) AS employee_count,
  ROUND(AVG(s.amount)) AS avg_salary,
  MIN(s.amount) AS min_salary,
  MAX(s.amount) AS max_salary
FROM employees.title t
JOIN employees.salary s ON t.employee_id = s.employee_id
WHERE t.to_date > CURRENT_DATE AND s.to_date > CURRENT_DATE
GROUP BY t.title
ORDER BY avg_salary DESC;`
  },
  {
    title: 'Hiring Waves',
    description: 'How hiring patterns changed over years',
    difficulty: 'intermediate',
    query: `-- Hiring Waves
-- Track hiring trends with gender breakdown
SELECT
  EXTRACT(YEAR FROM hire_date) AS year,
  COUNT(*) AS total_hired,
  SUM(CASE WHEN gender = 'M' THEN 1 ELSE 0 END) AS men,
  SUM(CASE WHEN gender = 'F' THEN 1 ELSE 0 END) AS women,
  ROUND(100.0 * SUM(CASE WHEN gender = 'F' THEN 1 ELSE 0 END) / COUNT(*), 1) AS women_pct
FROM employees.employee
GROUP BY EXTRACT(YEAR FROM hire_date)
ORDER BY year;`
  },

  // ============================================
  // ADVANCED QUERIES - Window functions & CTEs
  // ============================================
  {
    title: 'Salary Journey Tracker',
    description: 'Track salary changes with LAG window function',
    difficulty: 'advanced',
    query: `-- Salary Journey Tracker
-- Using LAG() to see salary progression
WITH salary_changes AS (
  SELECT
    e.first_name || ' ' || e.last_name AS employee,
    s.amount AS salary,
    LAG(s.amount) OVER (PARTITION BY e.id ORDER BY s.from_date) AS prev_salary,
    s.from_date
  FROM employees.employee e
  JOIN employees.salary s ON e.id = s.employee_id
  WHERE e.id IN (10001, 10002, 10003)
)
SELECT
  employee,
  salary,
  prev_salary,
  salary - prev_salary AS raise,
  ROUND(100.0 * (salary - prev_salary) / NULLIF(prev_salary, 0), 1) AS raise_pct,
  from_date
FROM salary_changes
WHERE prev_salary IS NOT NULL
ORDER BY employee, from_date;`
  },
  {
    title: 'Top 3 Earners per Department',
    description: 'Window function RANK() in action',
    difficulty: 'advanced',
    query: `-- Top 3 Earners per Department
-- Using RANK() window function
SELECT department, employee, salary, dept_rank
FROM (
  SELECT
    d.dept_name AS department,
    e.first_name || ' ' || e.last_name AS employee,
    s.amount AS salary,
    RANK() OVER (PARTITION BY d.dept_name ORDER BY s.amount DESC) AS dept_rank
  FROM employees.employee e
  JOIN employees.department_employee de ON e.id = de.employee_id
  JOIN employees.department d ON de.department_id = d.id
  JOIN employees.salary s ON e.id = s.employee_id
  WHERE de.to_date > CURRENT_DATE AND s.to_date > CURRENT_DATE
) ranked
WHERE dept_rank <= 3
ORDER BY department, dept_rank;`
  },
  {
    title: 'Career Ladder Climbers',
    description: 'Employees with most title promotions',
    difficulty: 'advanced',
    query: `-- Career Ladder Climbers
-- Track career progression using STRING_AGG
SELECT
  e.first_name || ' ' || e.last_name AS employee,
  COUNT(*) AS promotions,
  STRING_AGG(t.title, ' -> ' ORDER BY t.from_date) AS career_path,
  MIN(t.from_date) AS started,
  MAX(t.from_date) AS last_promotion
FROM employees.employee e
JOIN employees.title t ON e.id = t.employee_id
GROUP BY e.id, e.first_name, e.last_name
HAVING COUNT(*) >= 3
ORDER BY promotions DESC, last_promotion DESC
LIMIT 15;`
  },
  {
    title: 'Department Hoppers',
    description: 'Who switched departments the most?',
    difficulty: 'advanced',
    query: `-- Department Hoppers
-- Find employees who explored multiple departments
SELECT
  e.first_name || ' ' || e.last_name AS employee,
  COUNT(DISTINCT de.department_id) AS depts_explored,
  STRING_AGG(DISTINCT d.dept_name, ' -> ' ORDER BY d.dept_name) AS departments
FROM employees.employee e
JOIN employees.department_employee de ON e.id = de.employee_id
JOIN employees.department d ON de.department_id = d.id
GROUP BY e.id, e.first_name, e.last_name
HAVING COUNT(DISTINCT de.department_id) > 1
ORDER BY depts_explored DESC
LIMIT 20;`
  },
  {
    title: 'Loyalty Champions',
    description: '40-year veterans still with the company',
    difficulty: 'advanced',
    query: `-- Loyalty Champions
-- Employees with longest tenure in their department
SELECT
  e.first_name || ' ' || e.last_name AS employee,
  d.dept_name AS department,
  de.from_date AS member_since,
  EXTRACT(YEAR FROM AGE(CURRENT_DATE, de.from_date)) AS years_in_dept,
  t.title AS current_title
FROM employees.employee e
JOIN employees.department_employee de ON e.id = de.employee_id
JOIN employees.department d ON de.department_id = d.id
LEFT JOIN employees.title t ON e.id = t.employee_id AND t.to_date > CURRENT_DATE
WHERE de.to_date > CURRENT_DATE
ORDER BY de.from_date ASC
LIMIT 20;`
  },
  {
    title: 'Salary Percentile Analysis',
    description: 'Advanced percentile calculations',
    difficulty: 'advanced',
    query: `-- Salary Percentile Analysis
-- Using PERCENTILE_CONT for statistical insights
SELECT DISTINCT
  d.dept_name AS department,
  ROUND(PERCENTILE_CONT(0.10) WITHIN GROUP (ORDER BY s.amount)
    OVER (PARTITION BY d.dept_name)) AS p10,
  ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY s.amount)
    OVER (PARTITION BY d.dept_name)) AS median,
  ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY s.amount)
    OVER (PARTITION BY d.dept_name)) AS p90
FROM employees.department d
JOIN employees.department_employee de ON d.id = de.department_id
JOIN employees.salary s ON de.employee_id = s.employee_id
WHERE de.to_date > CURRENT_DATE AND s.to_date > CURRENT_DATE
ORDER BY median DESC;`
  },
  {
    title: 'Manager vs Team Salary',
    description: 'Compare manager salaries to their teams',
    difficulty: 'advanced',
    query: `-- Manager vs Team Salary
-- How do manager salaries compare to their teams?
WITH manager_salaries AS (
  SELECT
    dm.department_id,
    e.first_name || ' ' || e.last_name AS manager_name,
    s.amount AS manager_salary
  FROM employees.department_manager dm
  JOIN employees.employee e ON dm.employee_id = e.id
  JOIN employees.salary s ON e.id = s.employee_id
  WHERE dm.to_date > CURRENT_DATE AND s.to_date > CURRENT_DATE
),
team_salaries AS (
  SELECT
    de.department_id,
    ROUND(AVG(s.amount)) AS team_avg_salary
  FROM employees.department_employee de
  JOIN employees.salary s ON de.employee_id = s.employee_id
  WHERE de.to_date > CURRENT_DATE AND s.to_date > CURRENT_DATE
  GROUP BY de.department_id
)
SELECT
  d.dept_name AS department,
  m.manager_name,
  m.manager_salary,
  t.team_avg_salary,
  m.manager_salary - t.team_avg_salary AS difference,
  ROUND(100.0 * m.manager_salary / t.team_avg_salary - 100, 1) AS pct_above_team
FROM manager_salaries m
JOIN team_salaries t ON m.department_id = t.department_id
JOIN employees.department d ON m.department_id = d.id
ORDER BY pct_above_team DESC;`
  },
  {
    title: 'Gender Pay Analysis',
    description: 'Deep dive into salary by gender per department',
    difficulty: 'advanced',
    query: `-- Gender Pay Analysis
-- Comprehensive gender salary comparison
SELECT
  d.dept_name AS department,
  ROUND(AVG(CASE WHEN e.gender = 'M' THEN s.amount END)) AS avg_male,
  ROUND(AVG(CASE WHEN e.gender = 'F' THEN s.amount END)) AS avg_female,
  ROUND(AVG(s.amount)) AS avg_overall,
  ROUND(AVG(CASE WHEN e.gender = 'F' THEN s.amount END) -
        AVG(CASE WHEN e.gender = 'M' THEN s.amount END)) AS gap,
  ROUND(100.0 * (AVG(CASE WHEN e.gender = 'F' THEN s.amount END) /
        NULLIF(AVG(CASE WHEN e.gender = 'M' THEN s.amount END), 0) - 1), 1) AS gap_pct
FROM employees.employee e
JOIN employees.department_employee de ON e.id = de.employee_id
JOIN employees.department d ON de.department_id = d.id
JOIN employees.salary s ON e.id = s.employee_id
WHERE de.to_date > CURRENT_DATE AND s.to_date > CURRENT_DATE
GROUP BY d.dept_name
ORDER BY gap_pct DESC;`
  },
  {
    title: 'Department Growth Story',
    description: 'Year-over-year department expansion',
    difficulty: 'advanced',
    query: `-- Department Growth Story
-- Track how each department grew over time
SELECT
  d.dept_name AS department,
  EXTRACT(YEAR FROM de.from_date) AS year,
  COUNT(*) AS new_hires,
  SUM(COUNT(*)) OVER (
    PARTITION BY d.dept_name
    ORDER BY EXTRACT(YEAR FROM de.from_date)
  ) AS cumulative_hires
FROM employees.department d
JOIN employees.department_employee de ON d.id = de.department_id
GROUP BY d.dept_name, EXTRACT(YEAR FROM de.from_date)
ORDER BY department, year
LIMIT 50;`
  },
  {
    title: 'Current Managers',
    description: 'All department managers and their tenure',
    difficulty: 'intermediate',
    query: `-- Current Managers
-- Who runs each department?
SELECT
  d.dept_name AS department,
  e.first_name || ' ' || e.last_name AS manager,
  dm.from_date AS since,
  EXTRACT(YEAR FROM AGE(CURRENT_DATE, dm.from_date)) AS years_as_manager,
  s.amount AS salary
FROM employees.department_manager dm
JOIN employees.employee e ON dm.employee_id = e.id
JOIN employees.department d ON dm.department_id = d.id
JOIN employees.salary s ON e.id = s.employee_id
WHERE dm.to_date > CURRENT_DATE AND s.to_date > CURRENT_DATE
ORDER BY years_as_manager DESC;`
  }
];

/**
 * Fun, rotating intro messages for showcase queries
 * These add personality and make each query feel special
 */
const SHOWCASE_INTROS = [
  // Motivational & Encouraging
  `-- Welcome to LibreDB Studio!
-- Hit "Run" (or Ctrl+Enter) and watch the magic happen...
`,
  `-- Your SQL adventure starts here!
-- Feel free to modify this query and experiment.
`,
  `-- Ready, Set, Query!
-- This is a live database with real employee data.
`,
  `-- Showcase Query - Handpicked just for you!
-- Tip: Check the sidebar to explore more tables.
`,

  // Fun Facts
  `-- Fun Fact: This database has 300,000+ employees!
-- That's more than Apple, Google, and Meta combined.
`,
  `-- Did you know? SQL was invented in 1974!
-- 50+ years later, it's still the king of data.
`,
  `-- Fun Fact: Window functions were added to SQL in 2003
-- They changed everything. Try RANK() or LAG()!
`,
  `-- The "employees" dataset is a classic!
-- Used by millions of developers to learn SQL.
`,

  // Playful & Witty
  `-- The database whispers: "Query me..."
-- Don't keep it waiting. Press Run!
`,
  `-- Roses are red, JOINs can be slow,
-- But with proper indexes, watch your queries flow!
`,
  `-- SELECT happiness FROM life WHERE coffee = true;
-- Meanwhile, try this query...
`,
  `-- A JOIN walks into a bar...
-- ...and asks to merge with another table.
`,
  `-- In a world of NoSQL, be a PostgreSQL.
-- Relational databases never go out of style!
`,

  // Wisdom & Philosophy
  `-- "Give me six hours to chop down a tree,
-- and I'll spend four sharpening the axe." - SQL Developer
`,
  `-- The best query is the one that answers your question.
-- This one might just spark new ones...
`,
  `-- Data tells a story. SQL helps you read it.
-- What story will you discover today?
`,
  `-- Every expert was once a beginner.
-- Every master query started as SELECT *.
`,

  // Interactive & Encouraging
  `-- This query works, but can you make it better?
-- Try adding a WHERE clause or changing the ORDER BY!
`,
  `-- Showcase Mode: ON
-- Change anything! The database is read-only, so you can't break it.
`,
  `-- Pro tip: Highlight part of this query
-- and press Ctrl+Enter to run just that section!
`,
  `-- See something interesting in the results?
-- Click any table in the sidebar to explore further.
`,

  // Time-aware greetings (these work anytime)
  `-- Another day, another query!
-- Let's see what insights we can uncover...
`,
  `-- Coffee + SQL = Productivity
-- Here's a query to get you started!
`,
  `-- Welcome back, data explorer!
-- Here's a fresh query for you...
`,

  // Celebratory
  `-- You found a showcase query!
-- These are our favorites. Enjoy!
`,
  `-- Lucky you! This is one of our best queries.
-- It demonstrates some cool SQL techniques.
`,
  `-- Achievement Unlocked: Opened LibreDB Studio!
-- Now let's unlock some data insights...
`,
];

/**
 * Minimal divider line to separate intro from query
 */
const DIVIDER = '-- ─────────────────────────────────────────────────\n\n';

/**
 * Returns a random intro message with divider
 */
function getRandomIntro(): string {
  const index = Math.floor(Math.random() * SHOWCASE_INTROS.length);
  return SHOWCASE_INTROS[index] + DIVIDER;
}

/**
 * Returns a random showcase query for demo connections
 */
export function getRandomShowcaseQuery(): string {
  const queryIndex = Math.floor(Math.random() * SHOWCASE_QUERIES.length);
  const query = SHOWCASE_QUERIES[queryIndex];
  const intro = getRandomIntro();

  // Combine intro with the query (removing the query's own intro comment)
  const queryLines = query.query.split('\n');
  // Find where the actual SQL starts (after the title comments)
  const sqlStartIndex = queryLines.findIndex(line =>
    line.trim().startsWith('SELECT') ||
    line.trim().startsWith('WITH') ||
    line.trim().startsWith('(')
  );

  if (sqlStartIndex > 0) {
    // Keep the query title but add our fun intro before it
    const titleLines = queryLines.slice(0, sqlStartIndex).join('\n');
    const sqlLines = queryLines.slice(sqlStartIndex).join('\n');
    return `${intro}${titleLines}\n${sqlLines}`;
  }

  return `${intro}${query.query}`;
}

/**
 * Returns a random query of specific difficulty
 */
export function getRandomQueryByDifficulty(difficulty: 'simple' | 'intermediate' | 'advanced'): string {
  const filtered = SHOWCASE_QUERIES.filter(q => q.difficulty === difficulty);
  const index = Math.floor(Math.random() * filtered.length);
  const intro = getRandomIntro();
  return `${intro}${filtered[index].query}`;
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
