// __tests__/api/utils/staticAnalyzer.spec.js
const path = require('path');

// Mock child_process
jest.mock('child_process', () => ({
    exec: jest.fn(),
}));

// Mock util.promisify to return a jest.fn() for execPromise
const mockExecPromise = jest.fn();
jest.mock('util', () => ({
    ...jest.requireActual('util'), // Import and retain default util behavior
    promisify: jest.fn((fn) => {
        if (fn === require('child_process').exec) {
            return mockExecPromise;
        }
        // For other uses of promisify, return the original or a generic mock
        return jest.fn();
    }),
}));

// Mock fs.promises
const mockWriteFile = jest.fn();
const mockAccess = jest.fn();
jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    promises: {
        writeFile: mockWriteFile,
        access: mockAccess,
        // Mock other fs.promises functions if they get used by staticAnalyzer directly
        // For now, `access` is key for `checkFileExists` and `hasAnyFile`
        mkdir: jest.fn(() => Promise.resolve()), // Mock mkdir used in analyzeCode
        rm: jest.fn(() => Promise.resolve()),    // Mock rm used in analyzeCode
    },
}));

// Import the module to be tested AFTER mocks are set up
const { runESLint } = require('../../../src/api/utils/staticAnalyzer');

describe('runESLint', () => {
    const testDir = '/tmp/test-repo';

    beforeEach(() => {
        // Reset mocks before each test
        mockExecPromise.mockReset();
        mockWriteFile.mockReset();
        mockAccess.mockReset();
        // Reset any other mocks if necessary
    });

    // Scenario 1: ESLint Not Found
    test('Scenario 1: should throw specific error if ESLint executable is not found (ENOENT)', async () => {
        const error = new Error("Command failed: eslint '/tmp/test-repo' --ext js,jsx -f json --cache --cache-location \"/tmp/test-repo/.eslintcache\"");
        error.code = 'ENOENT';
        error.stderr = '';
        error.stdout = '';
        mockExecPromise.mockRejectedValue(error);

        await expect(runESLint(testDir)).rejects.toThrow('Error: ESLint executable not found. Please ensure ESLint is installed and in your PATH.');
    });

    test('Scenario 1: should throw specific error if ESLint executable is not found (eslint: not found)', async () => {
        const error = new Error("eslint: not found");
        // error.code might not be ENOENT in this specific message case, ensure the message check works
        error.stderr = '';
        error.stdout = '';
        mockExecPromise.mockRejectedValue(error);

        await expect(runESLint(testDir)).rejects.toThrow('Error: ESLint executable not found. Please ensure ESLint is installed and in your PATH.');
    });

    // Scenario 2: ESLint Configuration Error
    test('Scenario 2: should throw specific error for ESLint configuration error (stderr contains "Configuration error")', async () => {
        const stderrOutput = 'Configuration error: Cannot find module "eslint-config-nonexistent"';
        const error = new Error("Command failed with exit code 1");
        error.stderr = stderrOutput;
        error.stdout = '';
        error.code = 1; // ESLint often exits with 1 for config errors
        mockExecPromise.mockRejectedValue(error);

        await expect(runESLint(testDir)).rejects.toThrow(`Error: ESLint configuration error. Details: ${stderrOutput}`);
    });

    test('Scenario 2: should throw specific error for ESLint configuration error (stderr contains "Parsing error")', async () => {
        const stderrOutput = 'Oops! Something went wrong! ESLint: 8.0.0.\nESLint couldn\'t find the config "nonexistent-config" to extend from. Please check ...\nParsing error: ...';
        const error = new Error("Command failed with exit code 1");
        error.stderr = stderrOutput;
        error.stdout = '';
        error.code = 1;
        mockExecPromise.mockRejectedValue(error);

        await expect(runESLint(testDir)).rejects.toThrow(`Error: ESLint configuration error. Details: ${stderrOutput}`);
    });

    // Scenario 3: ESLint General Execution Error
    test('Scenario 3: should throw generic error for other ESLint execution failures', async () => {
        const exitCode = 2;
        const stderrOutput = 'Some other ESLint error.';
        const stdoutOutput = 'Not JSON output.';
        const error = new Error(`Command failed with exit code ${exitCode}`);
        error.code = exitCode;
        error.stderr = stderrOutput;
        error.stdout = stdoutOutput;
        mockExecPromise.mockRejectedValue(error);

        await expect(runESLint(testDir)).rejects.toThrow(`Error: ESLint execution failed. Exit code: ${exitCode}. Stderr: ${stderrOutput}. Stdout: ${stdoutOutput}`);
    });

    // Scenario 4: Successful ESLint Run (with linting issues reported in stdout, non-zero exit but valid JSON)
    test('Scenario 4: should return parsed JSON when ESLint reports linting issues in stdout (non-zero exit)', async () => {
        const lintResults = [{ filePath: 'file.js', messages: [{ ruleId: 'no-undef', message: 'Error' }] }];
        const stdoutJson = JSON.stringify(lintResults);
        const error = new Error("Command failed with exit code 1"); // ESLint exits > 0 if issues are found
        error.code = 1;
        error.stdout = stdoutJson;
        error.stderr = '';
        mockExecPromise.mockRejectedValue(error); // Simulates ESLint exiting with error code due to lint issues

        const result = await runESLint(testDir);
        expect(result).toEqual(lintResults);
    });

    // Scenario 5: Successful ESLint Run (no linting issues)
    test('Scenario 5: should return parsed JSON for a successful ESLint run with no issues', async () => {
        const lintResults = [{ filePath: 'file.js', messages: [] }];
        const stdoutJson = JSON.stringify(lintResults);
        mockExecPromise.mockResolvedValue({ stdout: stdoutJson, stderr: '' });

        // Mock fs.access to simulate an existing ESLint config file to prevent default config creation
        mockAccess.mockResolvedValue(undefined); // undefined means success (file exists)

        const result = await runESLint(testDir);
        expect(result).toEqual(lintResults);
    });

    // Scenario 6: Caching Flags Correctly Added
    test('Scenario 6: should call execPromise with --cache and --cache-location flags', async () => {
        const expectedCachePath = path.join(testDir, '.eslintcache');
        mockExecPromise.mockResolvedValue({ stdout: '[]', stderr: '' });

        // Mock fs.access to simulate an existing ESLint config to simplify this test
        mockAccess.mockResolvedValue(undefined);

        await runESLint(testDir, { fileExtension: 'js' });

        expect(mockExecPromise).toHaveBeenCalledTimes(1);
        const commandExecuted = mockExecPromise.mock.calls[0][0];
        expect(commandExecuted).toContain('--cache');
        expect(commandExecuted).toContain(`--cache-location "${expectedCachePath}"`);
        expect(commandExecuted).toContain(`"${testDir}"`); // Ensure target directory is quoted
        expect(commandExecuted).toContain('--ext js');
        expect(commandExecuted).toContain('-f json');
    });

    // Scenario 7: Default ESLint Config Creation
    test('Scenario 7: should create a default .eslintrc.json if no config is found', async () => {
        mockExecPromise.mockResolvedValue({ stdout: '[]', stderr: '' });

        // Simulate no ESLint config files found:
        // mockAccess used by checkFileExists (for local eslint) and hasAnyFile (for configs)
        // First call to checkFileExists (local eslint) - let's say it's not found.
        // Subsequent calls for hasAnyFile (config files) - all not found.
        mockAccess.mockRejectedValueOnce(new Error('File not found')); // For local eslint path check (hasLocalESLint = false)
        mockAccess.mockRejectedValue(new Error('File not found')); // For all config file checks in hasAnyFile

        await runESLint(testDir);

        expect(mockWriteFile).toHaveBeenCalledTimes(1);
        const defaultConfPath = path.join(testDir, '.eslintrc.json');
        expect(mockWriteFile).toHaveBeenCalledWith(defaultConfPath, expect.any(String));
        const writtenConfig = JSON.parse(mockWriteFile.mock.calls[0][1]);
        expect(writtenConfig).toHaveProperty('extends', 'eslint:recommended');
    });

    // Scenario 8: Custom ESLint Config Usage
    test('Scenario 8: should use custom ESLint config if provided via options', async () => {
        const customConfigFilename = 'custom.eslintrc.js';
        const customConfigPath = path.join(testDir, customConfigFilename);
        mockExecPromise.mockResolvedValue({ stdout: '[]', stderr: '' });

        // Simulate custom config file exists when checkFileExists is called for it
        // This is tricky because checkFileExists is used multiple times.
        // For this test, we assume the custom config path check is what we're targeting.
        // The staticAnalyzer's checkFileExists uses fs.promises.access.
        // We need to ensure that when path.join(directory, options.eslint.configFile) is checked, it resolves.

        // Let's mock access to allow the custom config to be "found"
        // and other configs (like default ones) to be "not found" if necessary.
        // This specific mockAccess might need refinement if other file checks interfere.
        mockAccess.mockImplementation(async (filePath) => {
            if (filePath === customConfigPath) {
                return undefined; // Found
            }
            if (filePath.includes('node_modules/.bin/eslint')) {
                 throw new Error('Local eslint not found'); // Assume global for simplicity
            }
            // For other standard config files, make them not found so custom is preferred
            // throw new Error('Standard config not found');
            // For this test, let's assume this is sufficient. If default config creation interferes,
            // we'd need hasAnyFile to return false for standard configs.
            // For now, the critical part is that --config "customConfigPath" is added.
            return undefined; // Let other checks pass to avoid default creation if not needed for this specific test focus.
        });


        await runESLint(testDir, { eslint: { configFile: customConfigFilename } });

        expect(mockExecPromise).toHaveBeenCalledTimes(1);
        const commandExecuted = mockExecPromise.mock.calls[0][0];
        expect(commandExecuted).toContain(`--config "${customConfigPath}"`);
    });

    // Test for when ESLint exits with non-zero code, stdout is not JSON, and it's not a known error type
    test('should throw generic error if ESLint exits non-zero, stdout not JSON, and not ENOENT/config error', async () => {
        const error = new Error("Command failed with exit code 1");
        error.code = 1;
        error.stdout = "This is not JSON output.";
        error.stderr = "Some other error, but not a config error pattern.";
        mockExecPromise.mockRejectedValue(error);

        await expect(runESLint(testDir)).rejects.toThrow('Error: ESLint execution failed. Exit code: 1. Stderr: Some other error, but not a config error pattern.. Stdout: This is not JSON output.');
    });

    // Test for when error.stdout is present but cannot be parsed as JSON
    test('should throw generic error if stdout is present but not parsable JSON after non-zero exit', async () => {
        const error = new Error("Command failed with exit code 1");
        error.code = 1;
        error.stdout = "This is { not quite JSON."; // Intentionally malformed
        error.stderr = "Linting problems found.";
        mockExecPromise.mockRejectedValue(error);

        await expect(runESLint(testDir)).rejects.toThrow(`Error: ESLint execution failed. Exit code: 1. Stderr: Linting problems found.. Stdout: This is { not quite JSON.`);
        // Check console logs if needed, e.g., for the "Failed to parse ESLint stdout" message
    });

    // Test for typescript flag setting default extension
     test('should use ts,tsx extensions if options.typescript is true and no fileExtension option', async () => {
        mockExecPromise.mockResolvedValue({ stdout: '[]', stderr: '' });
        mockAccess.mockResolvedValue(undefined); // Assume config exists

        await runESLint(testDir, { typescript: true });
        expect(mockExecPromise).toHaveBeenCalledTimes(1);
        const command = mockExecPromise.mock.calls[0][0];
        expect(command).toContain('--ext ts,tsx');
    });

    test('should use provided fileExtension option even if options.typescript is true', async () => {
        mockExecPromise.mockResolvedValue({ stdout: '[]', stderr: '' });
        mockAccess.mockResolvedValue(undefined); // Assume config exists

        await runESLint(testDir, { typescript: true, fileExtension: 'ts' });
        expect(mockExecPromise).toHaveBeenCalledTimes(1);
        const command = mockExecPromise.mock.calls[0][0];
        expect(command).toContain('--ext ts');
        expect(command).not.toContain('tsx');
    });

});

// Basic mock for hasAnyFile and checkFileExists (used internally by runESLint)
// These are implicitly tested via fs.promises.access mock.
// If more direct control is needed, they could be mocked directly:
/*
jest.mock('../../../src/api/utils/staticAnalyzer', () => {
  const originalModule = jest.requireActual('../../../src/api/utils/staticAnalyzer');
  return {
    ...originalModule,
    checkFileExists: jest.fn(), // then set mockResolvedValue per test
    hasAnyFile: jest.fn(),      // then set mockResolvedValue per test
  };
});
*/
