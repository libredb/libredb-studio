## Description
<!-- Provide a brief description of the changes in this PR -->

## Type of Change
<!-- Mark the relevant option with an "x" -->

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update
- [ ] Code refactoring
- [ ] Performance improvement
- [ ] Test addition or update

## Related Issue
<!-- Link to the related issue using #issue_number -->
Closes #

## Changes Made
<!-- Describe the changes in detail -->

- 
- 
- 

## Testing
<!-- Describe the testing you've done -->

- [ ] I have tested this locally
- [ ] I have added/updated tests
- [ ] All existing tests pass

### Test Environment
- **LibreDB Studio Version**: 
- **Browser**: 
- **OS**: 
- **Node.js/Bun Version**: 
- **Database Type**: 

## Screenshots (if applicable)
<!-- Add screenshots to help explain your changes -->

## Checklist
<!-- Mark completed items with an "x" -->

- [ ] My code follows the project's code style guidelines
- [ ] I have performed a self-review of my code
- [ ] I have commented my code, particularly in hard-to-understand areas
- [ ] I have updated the documentation accordingly
- [ ] My changes generate no new warnings
- [ ] I have added tests that prove my fix is effective or that my feature works
- [ ] New and existing unit tests pass locally with my changes
- [ ] The required CI test job passes the **100% line-coverage gate** (`bun run test:coverage` and `bun run coverage:check`)
- [ ] If I changed `src/lib/db/providers/`, I updated the matching `tests/integration/db/` tests in the same PR (provider triad); `docs/providers/` is frozen until the engine moves into its package
- [ ] If the type-id's granted statement language is non-null, I kept its agent leg in step: the engine overlay under `src/lib/agent/languages/<statement-language>/engines/` and the engine's cases in `engine-overlays.test.ts` and `engine-pack-contract.test.ts`
- [ ] Any dependent changes have been merged and published

## Additional Notes
<!-- Add any additional notes or context about the PR -->
