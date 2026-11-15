// Vite+ per-package settings: the shared gatekeeper-configurator tasks and its vitest `test` task,
// plus `build:integration-worker`.
import { withTests } from '@gadgets/scripts/gatekeeper-configurator'
import { TESTS_WITH_TIMEOUT_ENV, withTestTimeout } from '@gadgets/scripts/vitest-task'

export default {
  ...withTests,
  run: {
    ...withTests.run,
    tasks: {
      ...withTests.run.tasks,
      /**
       * The validated entrypoint `@gadgets/integration-tests` boots this gatekeeper from (FAC-236),
       * built before its test files start, with the generated configurator UI it imports, as
       * gatekeeper-github's is. Cached like workshop-backend's own `build:integration-worker`:
       * `.wrangler` is left out of the inputs, since the build writes it, and named as the output,
       * since a cache hit has to leave the tree on disk for the suite to read.
       */
      'build:integration-worker': {
        command: withTestTimeout('capnweb-validate build --out .wrangler/validate'),
        dependsOn: ['build:configurator'],
        cache: {
          env: TESTS_WITH_TIMEOUT_ENV,
          input: [{ auto: true }, { pattern: '!**/.wrangler/**', base: 'workspace' }],
          output: ['.wrangler/validate/**'],
        },
      },
    },
  },
}
