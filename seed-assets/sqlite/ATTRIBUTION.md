# employee.db — Attribution

`employee.db` is vendored from the **Employee Sample Database** maintained at
[bytebase/employee-sample-database](https://github.com/bytebase/employee-sample-database)
(file `sqlite/dataset_small/employee.db`), which is itself based on the
Employees Sample Database at
[datacharmer/test_db](https://github.com/datacharmer/test_db).

## Provenance and licenses

- Original data created by Fusheng Wang and Carlo Zaniolo (Siemens Corporate
  Research); relational schema by Giuseppe Maxia, data conversion by Patrick
  Crews. Licensed under [Creative Commons Attribution-ShareAlike 3.0 Unported
  (CC BY-SA 3.0)](https://creativecommons.org/licenses/by-sa/3.0/). The data
  is fabricated and does not correspond to real people; any resemblance to
  existing people is purely coincidental.
- [bytebase/employee-sample-database](https://github.com/bytebase/employee-sample-database)
  (repository license: MIT) derived the reduced datasets and database ports
  from datacharmer/test_db: `dataset_small` keeps 1,000 of the original
  ~300,000 employees, table names are singular (`employees` -> `employee`),
  and the SQLite conversion this file comes from is theirs.
- Because the underlying data derives from a CC BY-SA 3.0 work, this file is
  redistributed under the same CC BY-SA 3.0 license.

## Modifications made in this repository

- Removed the import-verification tables that ship with the dataset
  (`expected_value`, `found_value`, `tchecksum`) and compacted the file with
  `VACUUM` — those tables exist to verify a full-dataset install and are not
  sample content.

Shipped tables: `employee`, `department`, `dept_emp`, `dept_manager`,
`salary`, `title`; views `current_dept_emp`, `dept_emp_latest_date`.

This file ships in LibreDB Studio distribution artifacts as the template for
the embedded "Sample (Employees)" connection (see `docs/providers/sqlite.md`).
