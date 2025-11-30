/**
 * Jest Integration Test Configuration for Payment Service
 */

module.exports = {
  displayName: 'payment-service-integration',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/integration/**/*.test.js'],
  setupFilesAfterEnv: ['<rootDir>/__tests__/integration/setup.js'],
  testTimeout: 30000,
  verbose: true,
  collectCoverage: true,
  coverageDirectory: 'coverage/integration',
  coverageReporters: ['text', 'lcov', 'json-summary'],
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/__tests__/',
    '/coverage/',
  ],
  modulePathIgnorePatterns: [
    '<rootDir>/node_modules/',
  ],
  // Map Docker paths to local paths for testing
  moduleNameMapper: {
    '^../libs/common/metrics$': '<rootDir>/__tests__/__mocks__/metrics.js',
  },
  transform: {},
  clearMocks: true,
  restoreMocks: true,
  forceExit: true,
  detectOpenHandles: true,
};
