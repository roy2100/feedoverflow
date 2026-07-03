# server-go — Go backend developer tasks (mirrors the Node npm scripts).
# Run from server-go/.  `make help` lists everything.

# cgo is required (mattn/go-sqlite3); the prod binary must be built on the Mac.
export CGO_ENABLED := 1

# BIN is the process title / deployed binary name.
BIN := rss-reader
PKG := ./...

.DEFAULT_GOAL := help

## run: start the server (go run .) — reads PORT/LOCAL_API_PORT/RSS_DB from env
.PHONY: run
run:
	go run .

## build: compile the production binary into ./$(BIN) (CGO, host arch)
.PHONY: build
build:
	go build -o $(BIN) .

## test: compile-check + offline unit tests (npm `test` equivalent)
.PHONY: test
test: lint
	go test $(PKG)

## test-int: live-network integration tests (build tag `itest`; hits real feeds)
.PHONY: test-int
test-int:
	go test -tags itest $(PKG)

## test-race: offline tests under the race detector
.PHONY: test-race
test-race:
	go test -race $(PKG)

## cover: run tests with a coverage summary + HTML report (coverage.html)
.PHONY: cover
cover:
	go test -coverprofile=coverage.out $(PKG)
	go tool cover -func=coverage.out | tail -1
	go tool cover -html=coverage.out -o coverage.html
	@echo "open coverage.html"

## vet: go's built-in static analysis (subset of lint; run by `lint`)
.PHONY: vet
vet:
	go vet $(PKG)

## lint: go vet + staticcheck (catch-bug only, mirrors the JS oxlint policy)
.PHONY: lint
lint: vet
	@command -v staticcheck >/dev/null 2>&1 || { echo "staticcheck missing: go install honnef.co/go/tools/cmd/staticcheck@latest"; exit 1; }
	staticcheck $(PKG)

## fmt: format & write in place (gofmt)
.PHONY: fmt
fmt:
	gofmt -w .

## fmt-check: fail if any file is unformatted (CI / pre-commit gate)
.PHONY: fmt-check
fmt-check:
	@out="$$(gofmt -l .)"; if [ -n "$$out" ]; then echo "unformatted:"; echo "$$out"; exit 1; fi

## tidy: sync go.mod/go.sum
.PHONY: tidy
tidy:
	go mod tidy

## check: fmt-check + lint + test — the full pre-commit gate
.PHONY: check
check: fmt-check lint test

## dbinit: run the DB-init helper (cmd/dbinit)
.PHONY: dbinit
dbinit:
	go run ./cmd/dbinit

## freezefeeds: run the freeze-feeds helper (cmd/freezefeeds)
.PHONY: freezefeeds
freezefeeds:
	go run ./cmd/freezefeeds

## deploy: build client + Go binary, sync, kickstart the installed service, health-check (script-go)
.PHONY: deploy
deploy:
	../script-go/deploy.sh

## install-service: register the launchd job (write plist + bootstrap); run once on a fresh box
.PHONY: install-service
install-service:
	../script-go/install-service.sh

## uninstall-service: stop + remove the launchd job (deployed files kept)
.PHONY: uninstall-service
uninstall-service:
	../script-go/uninstall-service.sh

## clean: remove build/coverage artifacts
.PHONY: clean
clean:
	rm -f $(BIN) coverage.out coverage.html

## help: list targets
.PHONY: help
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/^## /  /' | sort
