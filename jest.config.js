export const testEnvironment = "node";
export const transform = {};
export const testMatch = ["**/*.test.js", "**/*.spec.js"];
export const collectCoverage = true;
export const collectCoverageFrom = ["**/*.{js,ts}", "!**/node_modules/**", "!coverage/**"];
export const coverageDirectory = "coverage";
export const coverageReporters = ["json-summary", "text", "lcov"];
export const verbose = true;
