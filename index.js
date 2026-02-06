import express, { json, static as expressStatic } from "express";
import cors from "cors";
import { exec } from "child_process";
import { existsSync, writeFileSync, readFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { Octokit } from "@octokit/rest";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 3000;

// Get the directory name for security
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? false : '*', // Restrict in production
  credentials: true
}));
app.use(json({ limit: '10mb' }));
app.use(expressStatic(join(__dirname, "."))); // Serve static files from current directory safely

// Sanitize inputs to prevent command injection
function sanitizeInput(input) {
  if (typeof input !== 'string') return '';
  // Remove potentially dangerous characters
  return input.replace(/[;&|`$(){}[\]\\<>]/g, '');
}

// Helper function to run commands safely
function runCmd(cmd) {
  return new Promise((resolve) => {
    // Additional safety check - ensure cmd doesn't contain dangerous characters
    if (/[;&|`$(){}[\]\\<>]/.test(cmd)) {
      resolve({
        code: 1,
        stdout: '',
        stderr: 'Command contains invalid characters',
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
    throw new Error('Invalid file path');
  }
  
  while (!existsSync(normalizedPath)) {
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

    // Validate required fields with sanitization
    if (!token || !userName || !repositories) {
      return res.status(400).json({
        success: false,
        message: "GitHub token, username, and repositories are required",
      });
    }

    // Sanitize inputs to prevent injection attacks
    const sanitizedTitle = sanitizeInput(title || "Automated PR");
    const sanitizedDescription = sanitizeInput(description || "Created by PR Management System");
    const sanitizedUserName = sanitizeInput(userName);
    const sanitizedRepos = sanitizeInput(repositories);
    
    // Sanitize and validate branch names to ensure they don't contain invalid characters
    let sanitizedBaseBranch = sanitizeInput(baseBranch || "main");
    let sanitizedHeadBranch = sanitizeInput(headBranch || "feature-branch");
    
    // Basic validation for branch names (should not contain certain characters)
    if (!/^[a-zA-Z0-9._/-]+$/.test(sanitizedBaseBranch) || sanitizedBaseBranch.length > 100) {
      return res.status(400).json({
        success: false,
        message: "Invalid base branch name. Use alphanumeric characters, dots, underscores, hyphens, and slashes only.",
      });
    }
    
    if (!/^[a-zA-Z0-9._/-]+$/.test(sanitizedHeadBranch) || sanitizedHeadBranch.length > 100) {
      return res.status(400).json({
        success: false,
        message: "Invalid head branch name. Use alphanumeric characters, dots, underscores, hyphens, and slashes only.",
      });
    }
    
    // Prevent same branch names for head and base
    if (sanitizedBaseBranch === sanitizedHeadBranch) {
      return res.status(400).json({
        success: false,
        message: "Head branch and base branch cannot be the same.",
      });
    }
    
    const sanitizedCoverageThreshold = parseInt(coverageThreshold) || 80;

    // Additional validation
    if (sanitizedCoverageThreshold < 0 || sanitizedCoverageThreshold > 100) {
      return res.status(400).json({
        success: false,
        message: "Coverage threshold must be between 0 and 100",
      });
    }

    // Parse repositories - handle both full URLs and just repo names
    const reposArray = sanitizedRepos.split(",").map(repo => {
      let cleanRepo = repo.trim();
      
      // If it looks like a URL, extract owner/repo
      if (cleanRepo.startsWith('http')) {
        try {
          const url = new URL(cleanRepo);
          // Extract path parts, removing empty first element from split('/')
          const pathParts = url.pathname.split('/').filter(part => part); 
          if (pathParts.length >= 2) {
            // Take the last two parts to get owner/repo (handles cases like /user/repo.git)
            cleanRepo = `${pathParts[pathParts.length - 2]}/${pathParts[pathParts.length - 1]}`;
            // Remove .git suffix if present
            cleanRepo = cleanRepo.replace(/\.git$/, '');
          }
        } catch (e) {
          // If URL parsing fails, leave as is and validation will catch it
        }
      }
      
      return cleanRepo;
    }).filter(repo => repo);
    
    if (reposArray.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one valid repository must be provided",
      });
    }
    
    // Validate each repository format
    for (const repo of reposArray) {
      if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo)) {
        return res.status(400).json({
          success: false,
          message: `Invalid repository format: "${repo}". Expected format: owner/repo`,
        });
      }
    }

    // Create a mock event.json for testing
    const mockEvent = {
      pull_request: {
        number: Math.floor(Math.random() * 1000) + 1,
        title: sanitizedTitle,
        body: sanitizedDescription,
        user: { login: sanitizedUserName },
        head: { ref: sanitizedHeadBranch },
        base: { ref: sanitizedBaseBranch },
      },
      repository: {
        default_branch: sanitizedBaseBranch,
      },
    };

    // Write to a temporary location for security
    const eventFilePath = join(__dirname, "temp_event.json");
    writeFileSync(eventFilePath, JSON.stringify(mockEvent, null, 2));

    try {
      // Run lint
      console.log("Running lint...");
      const lintResult = await runCmd("npm run lint");

      // Run tests with coverage
      console.log("Running tests with coverage...");
      const testResult = await runCmd("npm test -- --coverage");

      // Read coverage
      let coveragePct = 0;
      const covPath = join(process.cwd(), "coverage", "coverage-summary.json");

      const fileExists = await waitForFile(covPath, 10000); // Increased timeout
      if (fileExists) {
        try {
          const cov = JSON.parse(readFileSync(covPath, "utf8"));
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
          passed: coveragePct >= sanitizedCoverageThreshold,
          threshold: sanitizedCoverageThreshold,
        },
        prDetails: mockEvent.pull_request,
      };

      // Create PR on GitHub if token is provided
      for (const repo of reposArray) {
        try {
          const octokit = new Octokit({ auth: token });

          // First, check if the base and head branches exist
          try {
            await octokit.rest.repos.getBranch({
              owner: sanitizedUserName,
              repo: repo,
              branch: sanitizedBaseBranch
            });
          } catch (baseBranchError) {
            throw new Error(`Base branch '${sanitizedBaseBranch}' does not exist in repository '${repo}'. ${baseBranchError.message}`);
          }

          try {
            await octokit.rest.repos.getBranch({
              owner: sanitizedUserName,
              repo: repo,
              branch: sanitizedHeadBranch
            });
          } catch (headBranchError) {
            throw new Error(`Head branch '${sanitizedHeadBranch}' does not exist in repository '${repo}'. ${headBranchError.message}`);
          }

          // Create PR
          const pr = await octokit.rest.pulls.create({
            owner: sanitizedUserName,
            repo: repo,
            title: sanitizedTitle,
            body: sanitizedDescription,
            head: sanitizedHeadBranch,
            base: sanitizedBaseBranch,
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
            coveragePct >= sanitizedCoverageThreshold
          ) {
            try {
              await octokit.rest.pulls.merge({
                owner: sanitizedUserName,
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

      res.json(result);
    } finally {
      // Clean up temporary file
      try {
        if (existsSync(eventFilePath)) {
          unlinkSync(eventFilePath);
        }
      } catch (cleanupErr) {
        console.error("Error cleaning up temp file:", cleanupErr);
      }
    }
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

    // Sanitize inputs
    const sanitizedUserName = sanitizeInput(userName);
    let sanitizedRepository = sanitizeInput(repository);

    // If it looks like a URL, extract owner/repo
    if (sanitizedRepository.startsWith('http')) {
      try {
        const url = new URL(sanitizedRepository);
        // Extract path parts, removing empty first element from split('/')
        const pathParts = url.pathname.split('/').filter(part => part); 
        if (pathParts.length >= 2) {
          // Take the last two parts to get owner/repo (handles cases like /user/repo.git)
          sanitizedRepository = `${pathParts[pathParts.length - 2]}/${pathParts[pathParts.length - 1]}`;
          // Remove .git suffix if present
          sanitizedRepository = sanitizedRepository.replace(/\.git$/, '');
        }
      } catch (e) {
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

    // Get open PRs
    const { data: prs } = await octokit.rest.pulls.list({
      owner: sanitizedUserName,
      repo: sanitizedRepository,
      state: "open",
    });

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
  console.log(`Open your browser and navigate to http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
  });
});
