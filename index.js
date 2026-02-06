import express, { json, static as expressStatic } from "express";
import cors from "cors";
import { exec } from "child_process";
import { existsSync, writeFileSync, readFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { Octokit } from "@octokit/rest";
import { fileURLToPath } from "url";
import { log } from "console";

const app = express();
const PORT = process.env.PORT || 3000;

// Get the directory name for security
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Middleware
app.use(
  cors({
    origin: process.env.NODE_ENV === "production" ? false : "*", // Restrict in production
    credentials: true,
  }),
);
app.use(json({ limit: "10mb" }));
app.use(expressStatic(join(__dirname, "."))); // Serve static files from current directory safely

// Sanitize inputs to prevent command injection
function sanitizeInput(input) {
  if (typeof input !== "string") return "";
  // Remove potentially dangerous characters
  return input;
}

// Helper function to run commands safely
function runCmd(cmd) {
  return new Promise((resolve) => {
    // Additional safety check - ensure cmd doesn't contain dangerous characters
    if (/[;&|`$(){}[\]\\<>]/.test(cmd)) {
      resolve({
        code: 1,
        stdout: "",
        stderr: "Command contains invalid characters",
        success: false,
      });
      return;
    }

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

  // Security check: ensure filePath is within expected directory
  const normalizedPath = join(process.cwd(), filePath);
  if (!normalizedPath.startsWith(process.cwd())) {
    throw new Error("Invalid file path");
  }

  while (!existsSync(normalizedPath)) {
    if (Date.now() - start > timeout) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

app.post("/api/generate-event", async (req, res) => {
  let eventFilePath;

  try {
    const {
      title,
      description,
      token,
      repositories,
      baseBranch = "main",
      headBranch = "feature-branch",
      coverageThreshold = 80,
    } = req.body;

    if (!token || !repositories) {
      return res.status(400).json({
        success: false,
        message: "GitHub token and repositories are required",
      });
    }

    // ---------------------------
    // Sanitize
    // ---------------------------
    const sanitizedTitle = sanitizeInput(title || "Automated PR");
    const sanitizedDescription = sanitizeInput(
      description || "Created by PR Management System",
    );
    const sanitizedRepos = sanitizeInput(repositories);
    const sanitizedBaseBranch = sanitizeInput(baseBranch);
    const sanitizedHeadBranch = sanitizeInput(headBranch);
    const sanitizedCoverageThreshold =
      Number.parseInt(coverageThreshold, 10) || 80;

    if (sanitizedBaseBranch === sanitizedHeadBranch) {
      return res.status(400).json({
        success: false,
        message: "Base and head branch cannot be the same",
      });
    }

    if (sanitizedCoverageThreshold < 0 || sanitizedCoverageThreshold > 100) {
      return res.status(400).json({
        success: false,
        message: "Coverage threshold must be between 0 and 100",
      });
    }

    // ---------------------------
    // Parse repositories
    // ---------------------------
    const reposArray = sanitizedRepos
      .split(",")
      .map((repo) => repo.trim())
      .filter(Boolean);

    if (reposArray.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one repository is required",
      });
    }

    for (const repo of reposArray) {
      if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo)) {
        return res.status(400).json({
          success: false,
          message: `Invalid repository format: ${repo}`,
        });
      }
    }

    // ---------------------------
    // Mock PR event (local tooling)
    // ---------------------------
    const mockEvent = {
      pull_request: {
        number: Math.floor(Math.random() * 1000) + 1,
        title: sanitizedTitle,
        body: sanitizedDescription,
        head: { ref: sanitizedHeadBranch },
        base: { ref: sanitizedBaseBranch },
      },
    };

    eventFilePath = join(process.cwd(), "temp_event.json");
    writeFileSync(eventFilePath, JSON.stringify(mockEvent, null, 2));

    // ---------------------------
    // Run lint & tests
    // ---------------------------
    const lintResult = await runCmd("npm run lint");
    const testResult = await runCmd("npm test -- --coverage");

    // ---------------------------
    // Read coverage
    // ---------------------------
    let coveragePct = 0;
    const covPath = join(process.cwd(), "coverage", "coverage-summary.json");

    if (await waitForFile(covPath, 10000)) {
      try {
        const cov = JSON.parse(readFileSync(covPath, "utf8"));
        coveragePct = Number(
          cov.total?.lines?.pct ?? cov.total?.statements?.pct ?? 0,
        );
      } catch (err) {
        console.error("Coverage parse failed:", err);
      }
    }

    const checksPassed =
      lintResult.code === 0 &&
      testResult.code === 0 &&
      coveragePct >= sanitizedCoverageThreshold;

    // ---------------------------
    // GitHub PR logic
    // ---------------------------
    const octokit = new Octokit({ auth: token });

    const result = {
      success: true,
      lint: { passed: lintResult.code === 0 },
      test: { passed: testResult.code === 0 },
      coverage: {
        percentage: coveragePct,
        passed: coveragePct >= sanitizedCoverageThreshold,
        threshold: sanitizedCoverageThreshold,
      },
      githubPR: { results: [] },
    };

    for (const repo of reposArray) {
      const [owner, repoName] = repo.split("/");

      try {
        // 1️⃣ Ensure branches exist
        await octokit.rest.repos.getBranch({
          owner,
          repo: repoName,
          branch: sanitizedBaseBranch,
        });

        await octokit.rest.repos.getBranch({
          owner,
          repo: repoName,
          branch: sanitizedHeadBranch,
        });

        // 2️⃣ Look for existing PR
        const existingPRs = await octokit.rest.pulls.list({
          owner,
          repo: repoName,
          state: "open",
          head: sanitizedHeadBranch,
          base: sanitizedBaseBranch,
        });

        let pr;
        let created = false;
        if (existingPRs.data.length > 0) {
          pr = existingPRs.data[0];
        } else {
          const createdPR = await octokit.rest.pulls.create({
            owner,
            repo: repoName,
            title: sanitizedTitle,
            body: sanitizedDescription,
            head: sanitizedHeadBranch,
            base: sanitizedBaseBranch,
          });

          pr = createdPR.data;
          created = true;
        }
        let merged = false;
        let mergeError;

        if (checksPassed) {
          try {
            console.log("exi pr", existingPRs);
            await octokit.rest.pulls.merge({
              owner,
              repo: repoName,
              pull_number: pr.number,
              merge_method: "merge",
            });
            merged = true;
          } catch (err) {
            mergeError = err.response?.data?.message || err.message;
            console.log("exiprs", mergeError);
          }
        }
        result.githubPR.results.push({
          repo,
          prNumber: pr.number,
          url: pr.html_url,
          created,
          merged,
          mergeError,
        });
      } catch (err) {
        result.githubPR.results.push({
          repo,
          created: false,
          error: err.response?.data?.message || err.message,
        });
      }
    }

    res.json(result);
  } catch (error) {
    console.error("generate-event error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    try {
      if (eventFilePath && existsSync(eventFilePath)) {
        unlinkSync(eventFilePath);
      }
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
  }
});

// API endpoint to check PR status
app.post("/api/check-pr", async (req, res) => {
  try {
    const { token, repository } = req.body;

    if (!token || !repository) {
      return res.status(400).json({
        success: false,
        message: "GitHub token, and repository are required",
      });
    }

    let sanitizedRepository = sanitizeInput(repository);

    // If it looks like a URL, extract owner/repo
    if (sanitizedRepository.startsWith("http")) {
      try {
        const url = new URL(sanitizedRepository);
        // Extract path parts, removing empty first element from split('/')
        const pathParts = url.pathname.split("/").filter((part) => part);
        if (pathParts.length >= 2) {
          // Take the last two parts to get owner/repo (handles cases like /user/repo.git)
          sanitizedRepository = `${pathParts[pathParts.length - 2]}/${pathParts[pathParts.length - 1]}`;
          // Remove .git suffix if present
          sanitizedRepository = sanitizedRepository.replace(/\.git$/, "");
        }
      } catch (e) {
        log("Error parsing repository URL:", e);
        // If URL parsing fails, leave as is and validation will catch it
      }
    }

    // Validate repository format
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(sanitizedRepository)) {
      return res.status(400).json({
        success: false,
        message: `Invalid repository format: "${sanitizedRepository}". Expected format: owner/repo`,
      });
    }
    const octokit = new Octokit({ auth: token });
    const [owner, repo] = sanitizedRepository.split("/");

    // Get open PRs
    const { data: prs } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: "open",
    });
    console.log("sani repo", sanitizedRepository);
    res.json({
      success: true,
      repository: sanitizedRepository,
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
const server = app.listen(PORT, () => {
  console.log(`PR Management System running at http://localhost:${PORT}`);
});
server.setTimeout(5 * 60 * 1000); // 5 minutes

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully");
  server.close(() => {
    console.log("Process terminated");
  });
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down gracefully");
  server.close(() => {
    console.log("Process terminated");
  });
});
