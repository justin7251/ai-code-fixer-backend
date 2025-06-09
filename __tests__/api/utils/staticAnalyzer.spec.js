// __tests__/api/utils/staticAnalyzer.spec.js
const path = require('path');
const fs = require('fs').promises;
const childProcess = require('child_process');
const util = require('util'); // For promisify, if needed for exec mock

// Mock 'child_process' to control behavior of 'exec'
jest.mock('child_process');

// Mock 'fs.promises' for file system operations
// We only mock specific functions we need to control, others use original
const actualFsPromises = jest.requireActual('fs').promises;
jest.mock('fs', () => {
    const originalFs = jest.requireActual('fs');
    return {
        ...originalFs,
        promises: {
            ...originalFs.promises,
            access: jest.fn(), // Used by checkFileExists
            writeFile: jest.fn(), // Used by runESLint for default config
            // mkdir and rm are used by analyzeCode, not directly by functions under test here yet.
        },
    };
});

// Mock 'simple-git'
jest.mock('simple-git');

// Import the functions to be tested.
// IMPORTANT: For testing non-exported functions like path helpers,
// staticAnalyzer.js would need to either export them, or a tool like 'rewire'
// would be used. For this exercise, we'll assume they are exported for testing.
// If staticAnalyzer.js is modified to export them:
// e.g. module.exports = { ..., safeJoinPath, normalizeAndRelativizePath, validatePmdRulesetPath };
const {
    runESLint,
    // Assuming these are exported for testing based on task requirements:
    safeJoinPath,
    normalizeAndRelativizePath,
    validatePmdRulesetPath,
    // sparseCheckout sub-functions would also need exporting if tested directly
} = require('../../../src/api/utils/staticAnalyzer');

// If path helpers are not exported, this is a common workaround using rewire or babel plugins.
// For this environment, we'll assume the module is temporarily modified or test framework handles it.
// const staticAnalyzerModule = require('../../../src/api/utils/staticAnalyzer');
// const safeJoinPath = staticAnalyzerModule.safeJoinPath; // if exported
// const normalizeAndRelativizePath = staticAnalyzerModule.normalizeAndRelativizePath; // if exported
// const validatePmdRulesetPath = staticAnalyzerModule.validatePmdRulesetPath; // if exported


describe('Static Code Analysis Utilities', () => {
    const originalConsoleWarn = console.warn;
    const originalConsoleError = console.error;

    beforeEach(() => {
        jest.resetAllMocks(); // Resets all mocks (jest.mock, jest.fn, jest.spyOn)

        // Mock console.warn and console.error to suppress output and allow assertions
        console.warn = jest.fn();
        console.error = jest.fn();
    });

    afterAll(() => {
        console.warn = originalConsoleWarn;
        console.error = originalConsoleError;
    });

    // Path helper functions are now assumed to be exported and imported directly.
    // The conditional skipping block is removed for simplicity and because staticAnalyzer.js was updated.
    describe('Path Helper Functions', () => {
        describe('safeJoinPath', () => {
            const baseDir = path.resolve(process.platform === 'win32' ? 'C:\\app\\project' : '/app/project');

            it('should join paths correctly within the base directory', () => {
                const result = safeJoinPath(baseDir, 'src', 'file.js');
                expect(result).toBe(path.join(baseDir, 'src', 'file.js'));
            });

            it('should throw an error for path traversal attempts', () => {
                expect(() => safeJoinPath(baseDir, '..', '..', 'etc', 'passwd'))
                    .toThrow(/^Path Error: Attempted to access path .* which is outside the allowed base directory/);
            });

            it('should allow joining to the base directory itself', () => {
                const result = safeJoinPath(baseDir);
                expect(result).toBe(baseDir);
            });

            it('should handle subpaths that resolve within baseDir', () => {
                const result = safeJoinPath(baseDir, 'src', '..', 'other_src', 'file.js');
                expect(result).toBe(path.join(baseDir, 'other_src', 'file.js'));
            });

            it('should throw an error if subpaths lead outside baseDir', () => {
                expect(() => safeJoinPath(baseDir, 'src', '..', '..', 'file.js')) // Goes one level above baseDir
                    .toThrow(/^Path Error: Attempted to access path .* which is outside the allowed base directory/);
            });

            it('should correctly resolve and validate if baseDir has trailing slash', () => {
                const result = safeJoinPath(baseDir + path.sep, 'src', 'file.js');
                expect(result).toBe(path.join(baseDir, 'src', 'file.js'));
            });
        });

        describe('normalizeAndRelativizePath', () => {
            const baseDir = path.resolve(process.platform === 'win32' ? 'C:\\app\\project' : '/app/project');

            it('should normalize and relativize an absolute path within baseDir', () => {
                const filePath = path.join(baseDir, 'src', 'file.js');
                expect(normalizeAndRelativizePath(filePath, baseDir)).toBe('src/file.js');
            });

            it('should handle windows paths and normalize to forward slashes', () => {
                const windowsBaseDir = 'C:\\app\\project';
                const windowsFilePath = 'C:\\app\\project\\src\\file.js';
                expect(normalizeAndRelativizePath(windowsFilePath, windowsBaseDir)).toBe('src/file.js');
            });

            it('should return basename for path outside baseDir by default and warn', () => {
                const otherDir = path.resolve(process.platform === 'win32' ? 'C:\\app\\other' : '/app/other');
                const filePath = path.join(otherDir, 'file.js');
                expect(normalizeAndRelativizePath(filePath, baseDir)).toBe('file.js');
                expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[Path WARN] File path'));
            });

            it('should return normalized absolute path if path is outside baseDir and allowOutside is true', () => {
                const otherDir = path.resolve(process.platform === 'win32' ? 'C:\\app\\other' : '/app/other');
                const filePath = path.join(otherDir, 'file.js');
                expect(normalizeAndRelativizePath(filePath, baseDir, true)).toBe(filePath.replace(/\\/g, '/'));
            });

            it('should return "." if filePath is same as baseDir', () => {
                expect(normalizeAndRelativizePath(baseDir, baseDir)).toBe('.');
            });

            it('should handle already relative paths (treats them as relative to an unspecified current location, not baseDir)', () => {
                // This test clarifies behavior: if a path is already relative, it's returned as is (normalized).
                expect(normalizeAndRelativizePath('src/file.js', baseDir)).toBe('src/file.js');
            });

            it('should return "unknown" for falsy filePath', () => {
                expect(normalizeAndRelativizePath(null, baseDir)).toBe('unknown');
            });
        });

        describe('validatePmdRulesetPath', () => {
            const baseDir = '/app/project'; // Base dir doesn't affect non-file paths or already validated file paths

            it('should allow valid HTTP URLs', () => {
                const url = 'http://example.com/ruleset.xml';
                expect(validatePmdRulesetPath(url, baseDir)).toBe(url);
            });

            it('should allow valid HTTPS URLs', () => {
                const url = 'https://example.com/ruleset.xml';
                expect(validatePmdRulesetPath(url, baseDir)).toBe(url);
            });

            it('should allow valid PMD category strings', () => {
                const category = 'category/java/bestpractices.xml';
                expect(validatePmdRulesetPath(category, baseDir)).toBe(category);
            });

            it('should allow valid relative file paths (returns them as is)', () => {
                const relativePath = 'config/pmd/myrules.xml';
                expect(validatePmdRulesetPath(relativePath, baseDir)).toBe(relativePath);
            });

            it('should trim whitespace from paths', () => {
                const relativePath = '  config/pmd/myrules.xml  ';
                expect(validatePmdRulesetPath(relativePath, baseDir)).toBe('config/pmd/myrules.xml');
            });

            it('should throw error for absolute file paths', () => {
                const absolutePath = path.resolve('/opt/customrules/myrules.xml'); // Ensure it's absolute for the OS
                expect(() => validatePmdRulesetPath(absolutePath, baseDir))
                    .toThrow(`Path Error: Absolute PMD ruleset path '${absolutePath}' is not allowed.`);
            });

            it('should throw error for paths with ".." traversal', () => {
                const traversalPath = '../config/myrules.xml';
                expect(() => validatePmdRulesetPath(traversalPath, baseDir))
                    .toThrow(`Path Error: Path traversal ('..') in PMD ruleset path '${traversalPath}' is not allowed.`);
            });

            it('should throw error for complex paths with ".." traversal', () => {
                const traversalPath = 'config/../../etc/passwd';
                expect(() => validatePmdRulesetPath(traversalPath, baseDir))
                    .toThrow(`Path Error: Path traversal ('..') in PMD ruleset path '${traversalPath}' is not allowed.`);
            });
        });
    }); // This curly brace closes 'Path Helper Functions' describe


    describe('runESLint Error Handling', () => {
        const mockDirectory = path.resolve('/app/project'); // Consistent absolute path
        const execOriginal = util.promisify(childProcess.exec); // Keep original for structure reference

        beforeEach(() => {
            // Default: local eslint not found, no standard configs found
            fs.access.mockRejectedValue(new Error('ENOENT: file not found'));
            fs.writeFile.mockResolvedValue(undefined); // Default for creating .eslintrc.json
        });

        it('should return parsed JSON on successful ESLint execution (exit code 0)', async () => {
            const mockOutput = [{ filePath: 'file.js', messages: [], errorCount: 0, warningCount: 0 }];
            // childProcess.exec.mockImplementation takes (command, options?, callback)
            childProcess.exec.mockImplementation((command, callback) => callback(null, { stdout: JSON.stringify(mockOutput), stderr: '' }));

            const results = await runESLint(mockDirectory);
            expect(results).toEqual(mockOutput);
            expect(fs.writeFile).toHaveBeenCalledWith(
                safeJoinPath(mockDirectory, '.eslintrc.json'), // It will try to create default config
                expect.any(String)
            );
        });

        it('should return parsed JSON when ESLint finds linting errors (e.g., exit code 1)', async () => {
            const mockOutput = [{ filePath: 'file.js', messages: [{ ruleId: 'semi', message: 'Missing semicolon.' }], errorCount: 1, warningCount: 0 }];
            const execError = new Error('Command failed with exit code 1');
            // @ts-ignore
            execError.code = 1;
            // @ts-ignore
            execError.stdout = JSON.stringify(mockOutput);
            execError.stderr = '';
            // util.promisify(exec) attaches stdout and stderr to the error object itself.
            childProcess.exec.mockImplementation((command, callback) => {
                const err = new Error('Command failed with exit code 1');
                // @ts-ignore
                err.code = 1;
                // @ts-ignore
                err.stdout = JSON.stringify(mockOutput);
                // @ts-ignore
                err.stderr = '';
                callback(err, null, null);
            });

            const results = await runESLint(mockDirectory);
            expect(results).toEqual(mockOutput);
        });

        it('should throw "ESLint Error: Executable not found" if eslint is not found', async () => {
            childProcess.exec.mockImplementation((command, callback) => {
                const execError = new Error('Command failed: eslint');
                // @ts-ignore
                execError.code = 'ENOENT';
                execError.stdout = '';
                execError.stderr = 'eslint: not found';
                callback(execError, null, null);
            });

            await expect(runESLint(mockDirectory))
                .rejects
                .toThrow('ESLint Error: Executable not found. Ensure ESLint is installed.');
        });

        it('should throw "ESLint Error: Configuration error" for configuration issues', async () => {
            childProcess.exec.mockImplementation((command, callback) => {
                const execError = new Error('Command failed: eslint');
                // @ts-ignore
                execError.code = 2;
                execError.stdout = '';
                execError.stderr = 'ESLint configuration error: Invalid config.';
                callback(execError, null, null);
            });

            await expect(runESLint(mockDirectory))
                .rejects
                .toThrow('ESLint Error: Configuration error. Details: ESLint configuration error: Invalid config.');
        });

        it('should throw generic "ESLint Error: Execution failed" for other errors if stdout is not JSON', async () => {
            childProcess.exec.mockImplementation((command, callback) => {
                const execError = new Error('Command failed: eslint');
                // @ts-ignore
                execError.code = 127;
                execError.stdout = 'Some non-JSON output';
                execError.stderr = 'Some other ESLint error';
                callback(execError, null, null);
            });

            await expect(runESLint(mockDirectory))
                .rejects
                .toThrow(/^ESLint Error: Execution failed. Code: 127. Stderr: Some other ESLint error. Stdout: Some non-JSON output$/);
        });

        it('should throw specific error if stdout is not JSON after non-zero exit, even if stdout looks like JSON start', async () => {
            childProcess.exec.mockImplementation((command, callback) => {
                const execError = new Error('Command failed: eslint');
                // @ts-ignore
                execError.code = 1;
                execError.stdout = '{ "malformedJson": true '; // Starts like JSON but is invalid
                execError.stderr = '';
                callback(execError, null, null);
            });

            await expect(runESLint(mockDirectory))
                .rejects
                .toThrow(/^ESLint Error: Failed to parse stdout JSON after non-zero exit./);
        });


        it('should use local ESLint if checkFileExists passes for it', async () => {
            fs.access.mockImplementation(async (p) => {
                if (p === safeJoinPath(mockDirectory, 'node_modules', '.bin', 'eslint')) {
                    return; // Simulate file exists
                }
                throw new Error('ENOENT for other paths');
            });
            const mockOutput = [{ filePath: 'local.js', messages: [], errorCount: 0, warningCount: 0 }];
            childProcess.exec.mockImplementation((command, callback) => {
                expect(command).toContain(safeJoinPath(mockDirectory, 'node_modules', '.bin', 'eslint'));
                callback(null, { stdout: JSON.stringify(mockOutput), stderr: '' });
            });
            await runESLint(mockDirectory);
        });

        it('should correctly use custom config path if provided and valid', async () => {
            // Assume no local eslint, no standard configs, so default would normally be created
            fs.access.mockRejectedValue(new Error('ENOENT'));

            const mockOutput = [{ filePath: 'customConfig.js', messages: [], errorCount: 0, warningCount: 0 }];
            childProcess.exec.mockImplementation((command, callback) => {
                // Use path.join for OS-specific separator in assertion
                expect(command).toContain(`--config "${path.join(mockDirectory, 'my', 'custom.eslintrc.json')}"`);
                callback(null, { stdout: JSON.stringify(mockOutput), stderr: '' });
            });

            await runESLint(mockDirectory, { eslint: { configFile: 'my/custom.eslintrc.json' } });
            expect(fs.writeFile).not.toHaveBeenCalledWith(
                safeJoinPath(mockDirectory, '.eslintrc.json'), // Default config should NOT be created
                expect.any(String)
            );
        });

        it('should throw Path Error if custom config path is outside directory', async () => {
             await expect(runESLint(mockDirectory, { eslint: { configFile: '../../outside_config.json' } }))
                .rejects
                .toThrow(/^Path Error: Attempted to access path .* which is outside the allowed base directory/);
        });

        it('should NOT write default config if a standard ESLint config file is found', async () => {
            // Simulate a standard config (e.g., .eslintrc.js) exists
             fs.access.mockImplementation(async (p) => {
                if (p === safeJoinPath(mockDirectory, '.eslintrc.js')) {
                    return; // .eslintrc.js exists
                }
                 // local eslint in node_modules not found
                if (p === safeJoinPath(mockDirectory, 'node_modules', '.bin', 'eslint')) {
                     throw new Error('ENOENT for local eslint');
                }
                // other standard configs not found
                 const standardConfigs = ['.eslintrc.json', '.eslintrc.yml', '.eslintrc', 'eslint.config.js'];
                 if (standardConfigs.some(cfg => p === safeJoinPath(mockDirectory, cfg))) {
                     throw new Error('ENOENT for other standard configs');
                 }
            });

            const mockOutput = [{ filePath: 'file.js', messages: [], errorCount: 0, warningCount: 0 }];
            childProcess.exec.mockImplementation((command, callback) => callback(null, { stdout: JSON.stringify(mockOutput), stderr: '' }));

            await runESLint(mockDirectory);

            // Ensure fs.writeFile was NOT called for the default .eslintrc.json
            expect(fs.writeFile).not.toHaveBeenCalledWith(
                safeJoinPath(mockDirectory, '.eslintrc.json'),
                expect.any(String)
            );
        });
    });
    // Note: Tests for sparseCheckout sub-functions are omitted as per the original plan's
    // "if time permits" and complexity of mocking simple-git thoroughly.
    // The path helper and runESLint tests provide good coverage for key areas.
});
