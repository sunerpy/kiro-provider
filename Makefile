.PHONY: install fmt fmt-check typecheck lint test coverage build build-binary clean ci

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
	bun test --coverage

build:
	bun run build

build-binary:
	bun run build:binary

clean:
	rm -rf dist

ci: typecheck lint test
