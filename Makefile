.PHONY: install fmt fmt-check typecheck lint docs-links scripts-syntax test coverage coverage-gate coverage-parity build build-binary clean security codex-smoke-security quality check pre-ci ci

install:
	bun install --frozen-lockfile

fmt:
	bun run fmt

fmt-check:
	bun run fmt:check

typecheck:
	bun run typecheck

lint:
	bun run lint

docs-links:
	bun run docs:links

# Syntax-check every shell script; install.sh must additionally stay POSIX sh.
scripts-syntax:
	for script in scripts/*.sh .github/scripts/*.sh; do bash -n "$$script" || exit 1; done
	sh -n scripts/install.sh

test:
	bun run test

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

# Test-free quality gate. `coverage-gate` owns the test execution in `pre-ci`,
# so CI does not pay for the same suite twice.
quality: fmt-check typecheck lint docs-links scripts-syntax build security codex-smoke-security coverage-parity

# Fast local correctness gate for changes that do not need coverage output.
check: quality test

# High-fidelity release preflight, including the project-owned coverage floor.
pre-ci: quality coverage-gate

# Compatibility alias retained for existing automation.
ci: check
