/**
 * Jest Configuration for Product Service Integration Tests
 */
module.exports = {
  displayName: 'product-service-integration',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['**/__tests__/integration/**/*.test.js'],
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/integration/setup.js'],
  
  // Custom reporter for formatted output
  reporters: [
    '<rootDir>/../../libs/jest-custom-reporter.cjs'
  ],
  
  // Longer timeout for integration tests
  testTimeout: 30000,
  
  // Run tests serially (important for DB state)
  maxWorkers: 1,
  
  // Clear mocks between tests
  clearMocks: true,
  restoreMocks: true,
  
  // Coverage settings - disabled for cleaner output
  collectCoverage: false,
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/__tests__/**',
    '!src/db/migrations/**',
    '!src/db/seeds/**',
  ],
  coverageDirectory: 'coverage/integration',
  coverageReporters: ['text', 'lcov', 'json'],
  
  // Module paths
  moduleDirectories: ['node_modules', 'src'],
  
  // Map Docker paths to local paths for testing
  moduleNameMapper: {
    '^../libs/common/metrics$': '<rootDir>/src/__tests__/__mocks__/metrics.js',
  },
  
  // Transform settings
  transform: {},
  
  // Verbose output
  verbose: true,
};
