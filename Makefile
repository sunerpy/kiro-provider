.PHONY: install fmt fmt-check typecheck lint test coverage coverage-gate coverage-parity build build-binary clean ci

install:
	bun install

fmt:
	oxfmt --ignore-path .oxfmtignore --write '**/*.{yml,yaml,json,md}'
	bunx --bun @biomejs/biome check --write ./src ./scripts ./__tests__

fmt-check:
	oxfmt --ignore-path .oxfmtignore --check '**/*.{yml,yaml,json,md}'
	bunx --bun @biomejs/biome check ./src ./scripts ./__tests__

typecheck:
	bun run typecheck

lint:
	bunx --bun @biomejs/biome check ./src ./scripts ./__tests__

test:
	bun test

coverage:
	bun test --coverage --coverage-reporter=lcov --coverage-reporter=text

coverage-gate: coverage
	bun run scripts/coverage-gate.ts

coverage-parity:
	bun run scripts/coverage-parity.ts

build:
	bun run build

build-binary:
	bun run build:binary

clean:
	rm -rf dist

# Coverage runs separately via coverage-gate and in the GitHub Actions coverage job.
ci: typecheck lint test
