import { writeFileSync } from "fs";

async function main() {
  // For the script version, we'll just create a mock event
  // since the web interface handles the real GitHub API calls

  const mockEvent = {
    pull_request: {
      number: 1,
      title: "Test PR",
      body: "Test PR description",
      user: { login: "test-user" },
      head: { ref: "feature-branch" },
      base: { ref: "main" },
    },
    repository: {
      default_branch: "main",
    },
  };

  writeFileSync("event.json", JSON.stringify(mockEvent, null, 2));
  console.log("Created mock event.json for local testing");

  // If environment variables are set, use them (for backward compatibility)
  if (
    process.env.GITHUB_TOKEN &&
    process.env.GITHUB_USER_NAME &&
    process.env.REPOSITORIES
  ) {
    console.log("Using environment variables for GitHub integration");
  }
}

// Only run if this script is executed directly
if (require.main === module) {
  main();
}

export default { main };
