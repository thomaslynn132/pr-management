# PR Auto Review

Automated pull request review tool that runs **ESLint**, **Jest tests**, checks **code coverage**, and posts PR feedback using the **GitHub API**.  
Works locally or in GitHub Actions, helping enforce code quality and CI/CD standards.

---

## Features

- ✅ Run ESLint checks automatically  
- ✅ Run Jest tests with coverage  
- ✅ Enforce coverage threshold (default 80%)  
- ✅ Post comments on PRs via GitHub API  
- ✅ Works locally or in GitHub Actions  

---


## Installation & Setup

```bash
# Clone repo and install dependencies
git clone https://github.com/kyawsoe-dev/pr-auto-review.git
cd pr-auto-review
npm install
```

---


# Create .env file
```env
GITHUB_REPOSITORY=yourusername/pr-auto-review
GITHUB_EVENT_PATH=./event.json
GITHUB_TOKEN=dummy-token
COVERAGE_THRESHOLD=80
```

---


## Scripts & Usage

The package provides several npm scripts to help you run linting, tests, coverage, and PR checks.  

| Script | Description | Usage Example |
|--------|-------------|---------------|
| `npm run lint` | Run ESLint checks on all JS files | `npm run lint` |
| `npm test` | Run Jest tests | `npm test` |
| `npm run test:coverage` | Run Jest tests with coverage, outputs `coverage/coverage-summary.json` | `npm run test:coverage` |
| `npm run generate-event` | Generate a local `event.json` simulating a GitHub PR | `npm run generate-event` |
| `npm run pr-check` | Run PR checks: lint, tests, coverage, and optionally post GitHub comment | `npm run pr-check` |
| `npm run pr-test` | Combine `generate-event` + `pr-check` for a full local test | `npm run pr-test` |

---

### Example Local Flow

1. Generate a dynamic PR event:

```bash
# Generate event.json
npm run generate-event

```

---



# pr-management
