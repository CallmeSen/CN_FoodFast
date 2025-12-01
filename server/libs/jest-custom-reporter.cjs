/**
 * Custom Jest Reporter
 * Output format:
 * - Test summary (suites, tests, time)
 * - Success Test: list of passed test files
 * - Error Test: list of failed test files
 */

class CustomReporter {
  constructor(globalConfig, options) {
    this._globalConfig = globalConfig;
    this._options = options;
  }

  onRunComplete(contexts, results) {
    const { numFailedTestSuites, numPassedTestSuites, numTotalTestSuites } = results;
    const { numFailedTests, numPassedTests, numTotalTests } = results;
    const snapshotResults = results.snapshot || {};
    const numTotalSnapshots = snapshotResults.total || 0;
    const testTime = ((Date.now() - results.startTime) / 1000).toFixed(3);

    console.log('\n');
    
    // Timestamp
    const now = new Date();
    const timestamp = now.toISOString().replace('T', ' ').substring(0, 19);
    console.log(`[${timestamp}]`);
    
    // Summary
    const failedSuites = numFailedTestSuites > 0 ? `${numFailedTestSuites} failed, ` : '';
    const passedSuites = numPassedTestSuites > 0 ? `${numPassedTestSuites} passed, ` : '';
    console.log(`Test Suites: ${failedSuites}${passedSuites}${numTotalTestSuites} total`);
    
    const failedTests = numFailedTests > 0 ? `${numFailedTests} failed, ` : '';
    const passedTests = numPassedTests > 0 ? `${numPassedTests} passed, ` : '';
    console.log(`Tests:       ${failedTests}${passedTests}${numTotalTests} total`);
    
    console.log(`Snapshots:   ${numTotalSnapshots} total`);
    console.log(`Time:        ${testTime} s`);

    // Categorize test files
    const passedFiles = [];
    const failedFiles = [];

    results.testResults.forEach((testResult) => {
      const relativePath = testResult.testFilePath
        .replace(/\\/g, '/')
        .replace(/.*\/src\//, 'src/');
      
      if (testResult.numFailingTests > 0) {
        failedFiles.push(relativePath);
      } else {
        passedFiles.push(relativePath);
      }
    });

    // Success Test
    if (passedFiles.length > 0) {
      console.log('\nSuccess Test:');
      passedFiles.forEach((file) => {
        console.log(` PASS  ${file}`);
      });
    }

    // Error Test
    if (failedFiles.length > 0) {
      console.log('\nError Test:');
      failedFiles.forEach((file) => {
        console.log(` FAIL  ${file}`);
      });
    }

    console.log('');
  }
}

module.exports = CustomReporter;
