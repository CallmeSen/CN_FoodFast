/**
 * Mock for libs/common/metrics module
 * Used for integration testing without actual Prometheus metrics
 */

const mockSetupMetrics = jest.fn((app, serviceName) => {
  // Add mock /metrics endpoint
  app.get('/metrics', (req, res) => {
    res.set('Content-Type', 'text/plain');
    res.send('# Mock metrics endpoint');
  });
});

const mockRecordUserAuth = jest.fn();
const mockRecordError = jest.fn();

module.exports = {
  setupMetrics: mockSetupMetrics,
  recordUserAuth: mockRecordUserAuth,
  recordError: mockRecordError,
};
