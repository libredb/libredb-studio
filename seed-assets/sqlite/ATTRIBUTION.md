# employee.db — Attribution

`employee.db` is a reduced SQLite conversion of the **Employees Sample Database**
maintained at [datacharmer/test_db](https://github.com/datacharmer/test_db).

- Original data created by Fusheng Wang and Carlo Zaniolo (Siemens Corporate
  Research); relational schema by Giuseppe Maxia, data conversion by Patrick
  Crews.
- License: [Creative Commons Attribution-ShareAlike 3.0 Unported
  (CC BY-SA 3.0)](https://creativecommons.org/licenses/by-sa/3.0/).
- The data is fabricated and does not correspond to real people; any
  resemblance to existing people is purely coincidental.

## Modifications relative to the upstream dataset

- Reduced subset: 1,000 employees (upstream ships ~300,000) with their
  departments, salaries, titles, and department assignments, so the sample
  stays small enough to vendor in every distribution artifact.
- Converted to a single SQLite database file (tables `employee`, `department`,
  `dept_emp`, `dept_manager`, `salary`, `title`; views `current_dept_emp`,
  `dept_emp_latest_date`).
- The upstream test-harness tables (`expected_value`, `found_value`,
  `tchecksum`) were removed — they verify full-dataset imports and are not
  sample content.

This file is redistributed under the same CC BY-SA 3.0 license. It ships in
LibreDB Studio distribution artifacts as the template for the embedded
"Sample (Employees)" connection (see `docs/providers/sqlite.md`).
