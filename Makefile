VERCEL ?= npx --yes vercel@latest
VERCEL_SCOPE ?= floresjs-projects
VERCEL_PROJECT ?= ironvim

PORT ?= 5173

.PHONY: install test serve dev open vercel-whoami vercel-teams vercel-init deploy deploy-prod

node_modules: package.json
	npm install
	@touch node_modules

## install: install the local dev dependencies (vite)
install: node_modules

## test: parser, workout collection + schema, sync state machine, and mounted-UI checks (no browser needed)
test: node_modules
	@node test/parser.test.js
	@node test/workouts.test.js
	@node test/migration-schema.test.js
	@node test/sync.test.js
	@node test/render.test.js

## serve: run the vite dev server at http://localhost:$(PORT) (ctrl-c to stop)
serve: node_modules
	@echo "note: the service worker is cache-first, so hard-reload (cmd-shift-r) to pick up edits"
	npx vite --host 0.0.0.0 --port $(PORT) --open

dev: serve

## open: open the running local app in the default browser
open:
	@open http://localhost:$(PORT)

vercel-whoami:
	$(VERCEL) whoami

vercel-teams:
	$(VERCEL) teams ls

vercel-init:
	$(VERCEL) --yes --scope $(VERCEL_SCOPE) --name $(VERCEL_PROJECT)

deploy:
	$(VERCEL) --yes --scope $(VERCEL_SCOPE)

deploy-prod:
	$(VERCEL) --yes --scope $(VERCEL_SCOPE) --prod
