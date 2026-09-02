.PHONY: install fmt fmt-check typecheck lint scripts-syntax test coverage coverage-gate coverage-parity build build-binary clean ci security codex-smoke-security

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

# Syntax-check every shell script; install.sh must additionally stay POSIX sh.
scripts-syntax:
	for script in scripts/*.sh; do bash -n "$$script" || exit 1; done
	sh -n scripts/install.sh

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

security:
	bash scripts/security-check.sh

codex-smoke-security:
	bash -n scripts/codex-smoke.sh
	KIRO_PROVIDER_SMOKE_SECURITY_SELF_TEST=1 bash scripts/codex-smoke.sh

# Coverage runs separately via coverage-gate and in the GitHub Actions coverage job.
ci: typecheck lint scripts-syntax test
