# PR Auto Review

Automated pull request review tool that runs **ESLint**, **Jest tests**, checks **code coverage**, and create merge PRs using the **GitHub API**.
Doesn't use a database to store any data.

---

## Features

- ✅ Run ESLint checks automatically
- ✅ Run Jest tests with coverage
- ✅ Enforce coverage threshold (default 80%)
- ✅ Create/Merge PRs via GitHub API

---

## Requirements

- github repo owner name
- repo name
- github token
- Content read, write and pull requests read, write accesses for github tokens for corresponding projects

## Installation & Setup

```bash
# Clone repo and install dependencies
git clone https://github.com/kyawsoe-dev/pr-auto-review.git
cd pr-auto-review
npm install
```

---

## Scripts & Usage

The package provides several npm scripts to help you run linting, tests, coverage, and PR checks.

| Script                   | Description                                                              | Usage Example            |
| ------------------------ | ------------------------------------------------------------------------ | ------------------------ |
| `npm run lint`           | Run ESLint checks on all JS files                                        | `npm run lint`           |
| `npm test`               | Run Jest tests                                                           | `npm test`               |
| `npm run test:coverage`  | Run Jest tests with coverage, outputs `coverage/coverage-summary.json`   | `npm run test:coverage`  |
| `npm run generate-event` | Generate a local `event.json` simulating a GitHub PR                     | `npm run generate-event` |
| `npm run pr-check`       | Run PR checks: lint, tests, coverage, and optionally post GitHub comment | `npm run pr-check`       |
| `npm run pr-test`        | Combine `generate-event` + `pr-check` for a full local test              | `npm run pr-test`        |

---

### Example Local Flow

1. Generate a dynamic PR event:

```bash
# Generate event.json
npm run generate-event

```

---

# pr-management

# pr-management
