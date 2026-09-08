import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guards the declaration order of `WorkflowController`'s routes.
 *
 * **The bug this exists for:** `@Get(':id')` was declared above
 * `@Get('instances')`. Nest matches routes in declaration order, so
 * `GET /workflows/instances` was read as `getWorkflow('instances')` and
 * rejected by `ParseUUIDPipe` — a 400 for every caller, `firm_admin`
 * included. The instances list route was **unreachable**, and had been for as
 * long as both routes coexisted.
 *
 * It went unnoticed for a second reason worth recording: the same route was
 * separately found to return every matter in the tenant to a `client` token,
 * and a scoping fix was written for it. Both were true. The route leaked in
 * principle and 400'd in practice, so no test and no manual check ever saw the
 * leak — the ordering bug was hiding the authorisation bug.
 *
 * This asserts against the controller's own source rather than booting Nest,
 * following `config-pack-loader.service.spec.ts`, which regex-matches its
 * loader's source for the same reason: the property under test is the *shape
 * of the file*, and a runtime test would need a full HTTP stack to observe it.
 */
describe('WorkflowController route declaration order', () => {
  const source = readFileSync(
    join(__dirname, 'workflow.controller.ts'),
    'utf8',
  );

  /** Character offset of a decorator in the file, or -1. */
  const at = (decorator: string): number => source.indexOf(decorator);

  const CATCH_ALL = "@Get(':id')";

  it('declares the catch-all :id route in the file at all', () => {
    // If this fails the test below is vacuously true, so assert it separately.
    expect(at(CATCH_ALL)).toBeGreaterThan(-1);
  });

  it.each([
    ["@Get('tat')"],
    ["@Get('pack')"],
    ["@Get('instances')"],
    ["@Get('instances/:id')"],
  ])('declares %s before the catch-all :id route', (literalRoute) => {
    const literal = at(literalRoute);
    expect(literal).toBeGreaterThan(-1);

    // Strictly before. A literal path declared after `:id` is unreachable:
    // Nest hands the request to the parameter route and `ParseUUIDPipe`
    // turns it into a 400 that looks like a client error rather than a
    // routing mistake.
    expect(literal).toBeLessThan(at(CATCH_ALL));
  });

  it('keeps the catch-all last, so a new literal route cannot be added below it', () => {
    const after = source.slice(at(CATCH_ALL));
    // Any further @Get/@Post/@Patch/@Delete with a literal (non-`:`) path
    // after the catch-all would be shadowed the same way.
    const shadowed = after.match(
      /@(Get|Post|Patch|Put|Delete)\(\s*'(?!:)[^']+'/g,
    );
    expect(shadowed ?? []).toEqual([]);
  });
});
