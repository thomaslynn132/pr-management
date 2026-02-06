#!/usr/bin/env node
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { Octokit } = require("@octokit/rest");
require("dotenv").config();

function runCmd(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr });
    });
  });
}

async function waitForFile(filePath, timeout = 5000) {
  const start = Date.now();
  while (!fs.existsSync(filePath)) {
    if (Date.now() - start > timeout) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const eventPath = process.env.GITHUB_EVENT_PATH || "event.json";

  if (!repo || !fs.existsSync(eventPath)) {
    console.error("Missing GITHUB_REPOSITORY or event.json for local testing.");
    process.exit(1);
  }

  const [owner, name] = repo.split("/");
  const payload = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  const prNumber = payload.pull_request?.number;

  if (!prNumber) {
    console.error("No pull request number found in event.json");
    process.exit(1);
  }

  // Run lint
  console.log("Running lint...");
  const lint = await runCmd("npm run lint");
  console.log(lint.stdout);
  if (lint.stderr) console.error(lint.stderr);

  // Run tests with coverage
  console.log("Running tests with coverage...");
  const test = await runCmd("npm test -- --coverage");
  console.log(test.stdout);
  if (test.stderr) console.error(test.stderr);

  // Read coverage safely
  let coveragePct = 0;
  const covPath = path.join(process.cwd(), "coverage", "coverage-summary.json");
  console.log("Looking for coverage file at:", covPath);

  const fileExists = await waitForFile(covPath, 5000);
  if (fileExists) {
    try {
      const cov = JSON.parse(fs.readFileSync(covPath, "utf8"));
      const linesPct = cov.total?.lines?.pct;
      coveragePct =
        linesPct === "Unknown"
          ? 0
          : Number(linesPct ?? cov.total?.statements?.pct ?? 0);

      console.log("Coverage percent:", coveragePct);
    } catch (err) {
      console.error("Failed to read coverage JSON:", err);
      coveragePct = 0;
    }
  } else {
    console.log(
      "Coverage file not found after waiting, skipping coverage check."
    );
    coveragePct = 0;
  }

  // Build PR comment
  let comment = "## Automated PR Review\n\n";
  comment += lint.code === 0 ? "Lint passed\n" : "Lint failed\n";
  comment += test.code === 0 ? "Tests passed\n" : "Tests failed\n";

  if (coveragePct === 0) {
    comment += "No source files instrumented — coverage is 0%\n";
  } else {
    comment += `Coverage: ${coveragePct}%\n`;
  }

  // Post comment
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN !== "dummy-token") {
    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    try {
      await octokit.rest.issues.createComment({
        owner,
        repo: name,
        issue_number: prNumber,
        body: comment,
      });
      console.log("Posted PR comment successfully.");
    } catch (err) {
      console.error("Failed to post PR comment:", err);
    }
  } else {
    console.log("Skipping GitHub comment (dummy token).");
  }

  const threshold = Number(process.env.COVERAGE_THRESHOLD ?? 80);
  if (lint.code !== 0 || test.code !== 0 || coveragePct < threshold) {
    console.error("PR checks failed!");
    process.exit(1);
  }

  console.log("PR checks passed!");

  // Auto-merge PR normally (no squash/rebase)
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN !== "dummy-token") {
    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

    try {
      const merge = await octokit.rest.pulls.merge({
        owner,
        repo: name,
        pull_number: prNumber,
        merge_method: "merge",
      });

      if (merge.status === 200) {
        console.log(`PR #${prNumber} merged successfully!`);

        const branch = payload.pull_request?.head?.ref;
        const defaultBranch = payload.repository?.default_branch || "master";

        if (branch && branch !== defaultBranch) {
          await octokit.rest.git.deleteRef({
            owner,
            repo: name,
            ref: `heads/${branch}`,
          });
        }
      }
    } catch (err) {
      console.error("Failed to auto-merge PR:", err.message);
    }
  }
}

main();
