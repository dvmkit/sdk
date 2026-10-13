# Caller ownership

`caller-migration.json` records the ownership of declaring modules, exported symbols, consumer bindings, dependencies, and test destinations. `scripts/check-caller-ownership.mjs`, run by `npm run check:ownership`, checks the manifest against this repository.
