const express = require("express");
const cors = require("cors");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { Octokit } = require("@octokit/rest");
require("dotenv").config();

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(".")); // Serve static files from current directory

// Helper function to run commands
function runCmd(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (err.code ?? 1) : 0,
        stdout,
        stderr,
        success: !err,
      });
    });
  });
}

// Wait for file helper
async function waitForFile(filePath, timeout = 5000) {
  const start = Date.now();
  while (!fs.existsSync(filePath)) {
    if (Date.now() - start > timeout) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

// API endpoint to generate event and run PR checks
app.post("/api/generate-event", async (req, res) => {
  try {
    const {
      title,
      description,
      token,
      userName,
      repositories,
      baseBranch,
      headBranch,
      coverageThreshold,
    } = req.body;

    // Validate required fields
    if (!token || !userName || !repositories) {
      return res.status(400).json({
        success: false,
        message: "GitHub token, username, and repositories are required",
      });
    }

    // Set environment variables for the PR check script
    process.env.GITHUB_TOKEN = token;
    process.env.GITHUB_USER_NAME = userName;
    process.env.REPOSITORIES = repositories;
    process.env.BASE_BRANCH = baseBranch || "main";
    process.env.HEAD_BRANCH = headBranch || "feature-branch";
    process.env.COVERAGE_THRESHOLD = coverageThreshold || "80";

    // Create a mock event.json for testing
    const mockEvent = {
      pull_request: {
        number: Math.floor(Math.random() * 1000) + 1,
        title: title || "Test PR",
        body: description || "Test PR description",
        user: { login: userName },
        head: { ref: headBranch || "feature-branch" },
        base: { ref: baseBranch || "main" },
      },
      repository: {
        default_branch: baseBranch || "main",
      },
    };

    fs.writeFileSync("event.json", JSON.stringify(mockEvent, null, 2));

    // Run lint
    console.log("Running lint...");
    const lintResult = await runCmd("npm run lint");

    // Run tests with coverage
    console.log("Running tests with coverage...");
    const testResult = await runCmd("npm test -- --coverage");

    // Read coverage
    let coveragePct = 0;
    const covPath = path.join(
      process.cwd(),
      "coverage",
      "coverage-summary.json",
    );

    const fileExists = await waitForFile(covPath, 5000);
    if (fileExists) {
      try {
        const cov = JSON.parse(fs.readFileSync(covPath, "utf8"));
        const linesPct = cov.total?.lines?.pct;
        coveragePct =
          linesPct === "Unknown"
            ? 0
            : Number(linesPct ?? cov.total?.statements?.pct ?? 0);
      } catch (err) {
        console.error("Failed to read coverage JSON:", err);
        coveragePct = 0;
      }
    }

    // Create result object
    const result = {
      success: true,
      lint: {
        passed: lintResult.code === 0,
        output: lintResult.stdout,
        error: lintResult.stderr,
      },
      test: {
        passed: testResult.code === 0,
        output: testResult.stdout,
        error: testResult.stderr,
      },
      coverage: {
        percentage: coveragePct,
        passed: coveragePct >= parseInt(coverageThreshold || 80),
        threshold: parseInt(coverageThreshold || 80),
      },
      prDetails: mockEvent.pull_request,
    };

    // Create PR on GitHub if token is provided and not dummy
    if (token && token !== "dummy-token") {
      try {
        const octokit = new Octokit({ auth: token });
        const repos = repositories.split(",").map((repo) => repo.trim());

        for (const repo of repos) {
          try {
            // Create PR
            const pr = await octokit.rest.pulls.create({
              owner: userName,
              repo: repo,
              title: title || "Automated PR",
              body: description || "Created by PR Management System",
              head: headBranch || "feature-branch",
              base: baseBranch || "main",
            });

            result.githubPR = {
              created: true,
              repo: repo,
              prNumber: pr.data.number,
              url: pr.data.html_url,
            };

            // Try to merge if checks pass
            if (
              lintResult.code === 0 &&
              testResult.code === 0 &&
              coveragePct >= parseInt(coverageThreshold || 80)
            ) {
              try {
                await octokit.rest.pulls.merge({
                  owner: userName,
                  repo: repo,
                  pull_number: pr.data.number,
                  merge_method: "merge",
                });

                result.githubPR.merged = true;
                result.githubPR.mergeMessage = "PR merged successfully";
              } catch (mergeError) {
                result.githubPR.merged = false;
                result.githubPR.mergeError = mergeError.message;
              }
            }
          } catch (prError) {
            console.error(`Failed to create PR for ${repo}:`, prError.message);
            if (!result.githubPR) result.githubPR = {};
            result.githubPR.errors = result.githubPR.errors || [];
            result.githubPR.errors.push(`${repo}: ${prError.message}`);
          }
        }
      } catch (githubError) {
        console.error("GitHub API error:", githubError.message);
        result.githubError = githubError.message;
      }
    }

    res.json(result);
  } catch (error) {
    console.error("Error in generate-event:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
});

// API endpoint to check PR status
app.post("/api/check-pr", async (req, res) => {
  try {
    const { token, userName, repository } = req.body;

    if (!token || !userName || !repository) {
      return res.status(400).json({
        success: false,
        message: "GitHub token, username, and repository are required",
      });
    }

    const octokit = new Octokit({ auth: token });

    // Get open PRs
    const { data: prs } = await octokit.rest.pulls.list({
      owner: userName,
      repo: repository,
      state: "open",
    });

    res.json({
      success: true,
      repository,
      pullRequests: prs.map((pr) => ({
        number: pr.number,
        title: pr.title,
        state: pr.state,
        url: pr.html_url,
        user: pr.user.login,
        createdAt: pr.created_at,
      })),
    });
  } catch (error) {
    console.error("Error checking PRs:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch PRs",
      error: error.message,
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`PR Management System running at http://localhost:${PORT}`);
  console.log(`Open your browser and navigate to http://localhost:${PORT}`);
});
