const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const simpleGit = require('simple-git');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const axios = require('axios');

const analyzers = {
    javascript: runESLint,
    typescript: runESLint,
    java: runPMD,
    python: runPyLint,
    php: runPHPLint
};

/**
 * Runs static code analysis with different tools based on language
 * @param {string} repoUrl - URL of the GitHub repository
 * @param {string} language - Language to analyze
 * @param {Object} [options={}] - Additional options.
 * @param {string[]} [options.specificFiles] - Optional. Used by the internal sparse checkout to target specific files or patterns instead of language-based defaults.
 * @param {*} [options.*] - Other properties within options may be passed down to the language-specific analyzer functions (e.g., options for ESLint, PMD).
 * @returns {Promise<Object>} Analysis results
 */
async function analyzeCode(repoUrl, language, options = {}) {
    try {
        console.log(`Starting static analysis for ${repoUrl} with language: ${language}`);
        
        // Create a temporary directory
        const tempDir = path.join(os.tmpdir(), `code-analysis-${Date.now()}`);
        await fs.mkdir(tempDir, { recursive: true });
        
        console.log(`static Analyzer`);
        console.log(`Created temporary directory: ${tempDir}`);
        
        // Extract repo details from URL
        const repoDetails = extractRepoDetailsFromUrl(repoUrl);
        if (!repoDetails) {
            throw new Error(`Invalid GitHub repository URL: ${repoUrl}`);
        }
        const start = Date.now();
        // Use sparse checkout instead of full clone
        await sparseCheckout(repoUrl, tempDir, language, options.specificFiles);
        console.log(`Sparse checkout took ${(Date.now() - start) / 1000}s`);
        
        // Select the appropriate analysis tool based on language
        const analyzer = analyzers[language.toLowerCase()];
        if (!analyzer) throw new Error(`Unsupported language: ${language}`);
        const results = await analyzer(tempDir, options);
        
        // Process results to a standard format
        const standardResults = standardizeResults(results, language, tempDir);
        console.log(`standardResults:  ${standardResults}`);
        // Add file contents for files with issues (for AI fixing)
        await addFileContents(standardResults, tempDir);
        
        // Clean up
        await fs.rm(tempDir, { recursive: true, force: true }).catch(err => {
            console.warn(`Warning: Could not clean up temporary directory ${tempDir}: ${err.message}`);
        });
        console.log(`Cleaned up temporary directory: ${tempDir}`);
        
        return standardResults;
    } catch (error) {
        console.error('Static analysis error:', error);
        throw new Error(`Static analysis failed: ${error.message}`);
    }
}

/**
 * Extract repository owner and name from GitHub URL
 * @param {string} url - GitHub repository URL
 * @returns {Object|null} Repository details or null if invalid
 */
function extractRepoDetailsFromUrl(url) {
    try {
        const githubRegex = /github\.com\/([^\/]+)\/([^\/]+)/;
        const match = url.match(githubRegex);
        
        if (match && match.length >= 3) {
            return {
                owner: match[1],
                repo: match[2].replace('.git', '')
            };
        }
        return null;
    } catch (error) {
        console.error('Error extracting repo details:', error);
        return null;
    }
}

/**
 * Perform a sparse checkout of a repository
 * Only checks out files matching the language or specific files
 * @param {string} repoUrl - GitHub repository URL
 * @param {string} directory - Target directory
 * @param {string} language - Programming language
 * @param {Array} specificFiles - Optional list of specific files to checkout
 */
/**
 * Performs a sparse checkout of a Git repository.
 * @param {string} repoUrl - The URL of the Git repository (e.g., 'https://github.com/user/repo.git').
 * @param {string} directory - The local directory where the sparse checkout should happen.
 * @param {string} language - Used by generateFilePatterns to determine patterns.
 * @param {string[]} [specificFiles=[]] - Optional array of specific files/patterns to include.
 * @param {string} [branch='main'] - The branch to checkout (defaults to 'main').
 * @returns {Promise<string>} - Resolves with the path to the cloned directory on success.
 */
async function sparseCheckout(repoUrl, fullTargetDirPath, language, specificFiles = [], branch = 'main') {

    let git;

    try {
        console.log(`[START] Starting sparse checkout for ${repoUrl} into ${fullTargetDirPath}`);

 
        git = simpleGit({
            baseDir: fullTargetDirPath,
            // You can add a timeout for Git commands if they often hang
            timeout: {
                block: 10000
            },
        });
        console.log(`[SG_INIT_DONE] simple-git instance initialized.`);

        // 4. Initialize local Git repo
        console.log(`[GIT_INIT] Initializing git repo in ${fullTargetDirPath}...`);
        await git.init();
        console.log(`[GIT_INIT_DONE] Git repo initialized.`);

        // 5. Add remote
        console.log(`[GIT_REMOTE] Adding remote 'origin' (${repoUrl})...`);
        await git.addRemote('origin', repoUrl);
        console.log(`[GIT_REMOTE_DONE] Remote added.`);

        // 6. Enable sparse-checkout mode
        console.log(`[GIT_CONFIG] Enabling sparse-checkout mode...`);
        await git.raw(['config', 'core.sparseCheckout', 'true']);
        console.log(`[GIT_CONFIG_DONE] Sparse-checkout enabled.`);

        // 7. Generate patterns
        console.log(`[PATTERNS] Setting up sparse-checkout patterns...`);
        const patterns = specificFiles.length > 0
            ? specificFiles
            : generateFilePatterns(language);

        // 8. Write patterns to sparse-checkout file
        const sparseFilePath = path.join(fullTargetDirPath, '.git', 'info', 'sparse-checkout');
        console.log(`[FS_WRITE] Writing patterns to ${sparseFilePath}:`, patterns);
        await fs.writeFile(sparseFilePath, patterns.join('\n'), 'utf8');
        console.log(`[FS_WRITE_DONE] Patterns written.`);

        // 9. Determine the actual branch to use and fetch/checkout
        let actualBranch = branch;
        console.log(`[BRANCH_CHECK] Checking for remote branches to confirm '${branch}'...`);
        try {
            const remoteBranches = await git.listRemote(['--heads', 'origin']);
            if (!remoteBranches.includes(`refs/heads/${branch}`)) {
                console.warn(`[WARN] Specified branch '${branch}' not found on remote. Trying 'main' or 'master'.`);
                if (remoteBranches.includes('refs/heads/main')) {
                    actualBranch = 'main';
                } else if (remoteBranches.includes('refs/heads/master')) {
                    actualBranch = 'master';
                } else {
                    console.error('[ERROR] Neither specified branch, "main", nor "master" found on remote.');
                    throw new Error(`Cannot find a suitable branch on remote.`);
                }
            }
            console.log(`[BRANCH_RESOLVED] Will fetch and checkout branch: ${actualBranch}`);
        } catch (branchError) {
            console.error(`[ERROR] Could not determine remote branches during sparse checkout for ${repoUrl}: ${branchError.message}. Cannot verify branch existence.`);
            // Re-throw the original error or a new one to make the failure explicit
            throw new Error(`Failed to verify remote branches: ${branchError.message}`);
        }

        // 10. Fetch the remote repository (shallow clone for efficiency)
        console.log(`[GIT_FETCH] Fetching branch '${actualBranch}' from origin with depth=1...`);
        await git.fetch('origin', actualBranch, ['--depth=1']);
        console.log(`[GIT_FETCH_DONE] Fetch completed.`);

        // 11. Checkout the desired branch. This is where sparse-checkout rules apply.
        console.log(`[GIT_CHECKOUT] Checking out branch '${actualBranch}'...`);
        await git.checkout(actualBranch);
        console.log(`[GIT_CHECKOUT_DONE] Checkout completed.`);

        console.log(`[SUCCESS] ✅ Sparse checkout completed for ${repoUrl} into ${fullTargetDirPath}`);
        return fullTargetDirPath;

    } catch (error) {
        console.error('❌ Sparse checkout error:', error);
        // Log more detailed error properties if available
        if (error.stack) console.error('Error Stack:', error.stack);
        if (error.message) console.error('Error Message:', error.message);
        if (error.command) console.error('Git Command that failed:', error.command);
        if (error.stdout) console.error('Git stdout:', error.stdout);
        if (error.stderr) console.error('Git stderr:', error.stderr);
        if (error.code) console.error('Exit Code:', error.code);
        if (error.exitCode) console.error('simple-git exitCode:', error.exitCode);

        // Optional: Clean up partially cloned directory on error
        try {
            const stats = await fs.stat(fullTargetDirPath).catch(() => null); // Catch if dir doesn't exist
            if (stats && stats.isDirectory()) {
                console.log(`[CLEANUP] Cleaning up ${fullTargetDirPath} due to error.`);
                await fs.rm(fullTargetDirPath, { recursive: true, force: true });
                console.log(`[CLEANUP_DONE] Directory cleaned.`);
            }
        } catch (cleanupErr) {
            console.error(`[CLEANUP_ERROR] Error during cleanup: ${cleanupErr.message}`);
        }
        throw new Error(`Repository sparse checkout failed: ${error.message}`);
    }
}


/**
 * Generate file patterns for sparse checkout based on language
 * @param {string} language - Programming language
 * @returns {Array} Array of file patterns
 */
function generateFilePatterns(language) {
    const patterns = [];
    
    // Common configuration files
    patterns.push('.eslintrc*');
    patterns.push('.prettierrc*');
    patterns.push('package.json');
    patterns.push('pom.xml');
    patterns.push('requirements.txt');
    patterns.push('composer.json');
    
    // Language specific patterns
    switch (language.toLowerCase()) {
        case 'javascript':
            patterns.push('**/*.js');
            patterns.push('**/*.jsx');
            break;
        case 'typescript':
            patterns.push('**/*.ts');
            patterns.push('**/*.tsx');
            patterns.push('tsconfig.json');
            break;
        case 'java':
            patterns.push('**/*.java');
            break;
        case 'python':
            patterns.push('**/*.py');
            break;
        case 'php':
            patterns.push('**/*.php');
            break;
    }
    
    return patterns;
}

/**
 * Add file contents to the results for files with issues
 * @param {Object} results - Standardized analysis results
 * @param {string} directory - Directory containing the files
 */
async function addFileContents(results, directory) {
    try {
        // Get unique file paths
        const uniqueFiles = [...new Set(results.issues.map(issue => issue.file))];
        
        // Create file contents object
        results.fileContents = {};
        
        // Read each file and add its content
        for (const filePath of uniqueFiles) {
            try {
                // Convert absolute path to relative path
                const relativePath = filePath.replace(directory, '').replace(/^[\/\\]/, '');
                const fullPath = path.join(directory, relativePath);
                
                const content = await fs.readFile(fullPath, 'utf8');
                results.fileContents[relativePath] = content;
            } catch (fileError) {
                console.warn(`Could not read file ${filePath}: ${fileError.message}`);
            }
        }
        
        console.log(`Added content for ${Object.keys(results.fileContents).length} files`);
    } catch (error) {
        console.error('Error adding file contents:', error);
    }
}

/**
 * Run ESLint on a directory
 * @param {string} directory - Directory to analyze
 * @param {Object} [options={}] - ESLint options.
 * @param {string} [options.fileExtension] - Optional. Comma-separated file extensions for ESLint to check (e.g., 'js,jsx' or 'ts,tsx').
 * @param {boolean} [options.typescript] - Optional. If true, implies TypeScript files and sets a default `fileExtension` to 'ts,tsx' if `options.fileExtension` is not provided.
 * @returns {Promise<Object>} ESLint results
 */
async function runESLint(directory, options = {}) {
    try {
        const hasLocalESLint = await checkFileExists(path.join(directory, 'node_modules', '.bin', 'eslint'));
        let eslintPath = hasLocalESLint ? 
            path.join(directory, 'node_modules', '.bin', 'eslint') : 
            'eslint';

        let eslintConfigOption = '';
        let customConfigProvided = false;

        if (options.eslint && typeof options.eslint.configFile === 'string' && options.eslint.configFile.trim() !== '') {
            customConfigProvided = true;
            const customConfigPath = path.join(directory, options.eslint.configFile.trim());

            // Security: Ensure the resolved custom config path is within the project directory
            const normalizedDirectory = path.resolve(directory);
            const normalizedCustomConfigPath = path.resolve(customConfigPath);
            if (!normalizedCustomConfigPath.startsWith(normalizedDirectory + path.sep) && normalizedCustomConfigPath !== normalizedDirectory) {
                console.error(`Security Alert: ESLint config path '${options.eslint.configFile.trim()}' resolves to '${normalizedCustomConfigPath}' which is outside of project directory '${normalizedDirectory}'`);
                throw new Error("Invalid ESLint config path: attempts to access outside of project directory.");
            }

            eslintConfigOption = `--config "${customConfigPath}"`; // Ensure quotes for paths with spaces
            console.log(`Using custom ESLint config: ${customConfigPath}`);
        }

        // Check for common ESLint config files if no custom config is specified via options
        if (!customConfigProvided) {
            const hasStandardESLintConfig = await hasAnyFile(directory, [
                '.eslintrc.js', '.eslintrc.json', '.eslintrc.yml', '.eslintrc', 'eslint.config.js' // Added eslint.config.js for flat config
            ]);
            if (!hasStandardESLintConfig) {
                // Set up a default ESLint config only if no custom config is provided AND no standard config exists
                const defaultConfigPath = path.join(directory, '.eslintrc.json');
                await fs.writeFile(
                    defaultConfigPath,
                    JSON.stringify({
                        "env": { "browser": true, "es2021": true, "node": true },
                        "extends": "eslint:recommended",
                        "parserOptions": { "ecmaVersion": "latest", "sourceType": "module" }
                    }, null, 2)
                );
                console.log(`Created default ESLint config at: ${defaultConfigPath}`);
            }
        }

        const fileExtension = options.fileExtension || (options.typescript ? 'ts,tsx' : 'js,jsx');
        
        // Construct the command, ensuring proper spacing for the config option
        const commandParts = [
            eslintPath,
            `"${directory}"`, // Quote directory path
            `--ext ${fileExtension}`,
            '-f json'
        ];
        if (eslintConfigOption) {
            commandParts.push(eslintConfigOption);
        }
        const eslintCommand = commandParts.join(' ');

        console.log(`Running ESLint on ${directory} with extensions: ${fileExtension}`);
        console.log(`Executing ESLint command: ${eslintCommand}`); // Log the full command
        const { stdout } = await execPromise(eslintCommand);
        
        return JSON.parse(stdout);
    } catch (error) {
        console.error('ESLint error:', error.message); // Log error message
        if (error.stderr) console.error('ESLint stderr:', error.stderr);
        if (error.stdout) console.error('ESLint stdout (on error):', error.stdout); // stdout might contain info on parse errors

        // Check if error is due to ESLint not being installed
        if (error.message && (error.message.includes('eslint: not found') || error.message.includes('ENOENT'))) {
            throw new Error('ESLint not installed or not found in PATH. Please ensure ESLint is installed globally or locally in the project.');
        }
        // If ESLint exits with stdout (often JSON containing errors, but non-zero exit code), try to parse it.
        // This handles cases where ESLint finds linting errors and exits with a non-zero code, but still outputs valid JSON.
        if (error.stdout) {
            try {
                console.warn('ESLint exited with an error, but stdout was found. Attempting to parse stdout as JSON.');
                return JSON.parse(error.stdout);
            } catch (parseError) {
                console.error('Failed to parse ESLint stdout as JSON after error:', parseError.message);
            }
        }
        throw new Error(`ESLint execution failed: ${error.message}`);
    }
}

/**
 * Run PMD on a directory
 * @param {string} directory - Directory to analyze
 * @param {Object} [options={}] - PMD options.
 * @param {string} [options.rulesets] - Optional. Comma-separated string of PMD rulesets to use. Defaults to 'category/java/bestpractices.xml,category/java/errorprone.xml'.
 * @returns {Promise<Object>} PMD results
 */
async function runPMD(directory, options = {}) {
    // PMD path (environment variable or default)
    const PMD_PATH = process.env.PMD_PATH || '/usr/local/pmd/bin/pmd';
    
    // Default rulesets
    let rulesets = 'category/java/bestpractices.xml,category/java/errorprone.xml'; // Default value
    if (options.pmd && options.pmd.rulesets && typeof options.pmd.rulesets === 'string' && options.pmd.rulesets.trim() !== '') {
        const customRulesetPaths = options.pmd.rulesets.split(',').map(p => p.trim()).filter(p => p !== '');
        for (const p of customRulesetPaths) {
            const isUrl = p.startsWith('http://') || p.startsWith('https://');
            const isPmdCategory = p.startsWith('category/'); // e.g. category/java/bestpractices.xml
            // Allow URLs and PMD category-style paths
            if (!isUrl && !isPmdCategory) {
                // For file paths, disallow absolute paths and path traversal
                if (path.isAbsolute(p)) {
                    console.error(`Security Alert: Absolute PMD ruleset path detected: '${p}'`);
                    throw new Error(`Invalid PMD ruleset path: '${p}'. Absolute paths are not allowed for custom rulesets.`);
                }
                if (p.includes('..')) {
                    console.error(`Security Alert: Path traversal detected in PMD ruleset path: '${p}'`);
                    throw new Error(`Invalid PMD ruleset path: '${p}'. Path traversal ('..') is not allowed.`);
                }
            }
        }
        rulesets = customRulesetPaths.join(','); // Use the trimmed and validated paths
    }
    
    // Run PMD
    console.log(`Running PMD on ${directory} with ruleset: ${rulesets}`);
    try {
        const { stdout } = await execPromise(
            `${PMD_PATH} check -d ${directory} -R ${rulesets} -f json`
        );
        
        return JSON.parse(stdout);
    } catch (error) {
        console.error('PMD error:', error);
        throw error;
    }
}

/**
 * Run PyLint on a directory
 * @param {string} directory - Directory to analyze
 * @param {Object} [options={}] - PyLint options. Currently, no specific properties from the `options` object are used by this function.
 * @returns {Promise<Object>} PyLint results
 */
async function runPyLint(directory, options = {}) {
    try {
        // Check if PyLint is installed and available in PATH
        // PyLint is expected to be installed and available in the system PATH.
        // No automatic global installation will be attempted.
        try {
            await execPromise('which pylint');
        } catch (error) {
            console.error('PyLint not found in PATH. Please ensure PyLint is installed and accessible.');
            throw new Error('PyLint not found in PATH. Please ensure PyLint is installed and accessible.');
        }
        
        // Run PyLint with JSON reporter
        console.log(`Running PyLint on ${directory}`);
        const { stdout } = await execPromise(
            `pylint --output-format=json ${directory}`
        ).catch((error) => {
            // PyLint returns non-zero exit code even for warnings
            if (error.stdout) {
                return { stdout: error.stdout };
            }
            throw error;
        });
        
        return JSON.parse(stdout);
    } catch (error) {
        console.error('PyLint error:', error);
        throw error;
    }
}

/**
 * Run PHP_CodeSniffer on a directory
 * @param {string} directory - Directory to analyze
 * @param {Object} [options={}] - PHP_CodeSniffer options. Currently, no specific properties from the `options` object are used by this function.
 * @returns {Promise<Object>} PHP_CodeSniffer results
 */
async function runPHPLint(directory, options = {}) {
    try {
        // Check if PHP_CodeSniffer is installed
        await execPromise('which phpcs').catch(async () => {
            console.log('PHP_CodeSniffer not found, installation may be required');
            throw new Error('PHP_CodeSniffer not installed. Please install it with: composer global require squizlabs/php_codesniffer');
        });
        
        // Run PHP_CodeSniffer with JSON reporter
        console.log(`Running PHP_CodeSniffer on ${directory}`);
        const { stdout } = await execPromise(
            `phpcs --report=json ${directory}`
        ).catch((error) => {
            // PHPCS returns non-zero exit code for warnings/errors
            if (error.stdout) {
                return { stdout: error.stdout };
            }
            throw error;
        });
        
        return JSON.parse(stdout);
    } catch (error) {
        console.error('PHP_CodeSniffer error:', error);
        throw error;
    }
}

/**
 * Standardize results from different tools into a common format
 * @param {Object} results - Analysis results from a specific tool
 * @param {string} language - Language that was analyzed
 * @param {string} baseDirectory - The base directory for the analysis, used for path normalization.
 * @returns {Object} Standardized results
 */
function standardizeResults(results, language, baseDirectory) {
    const standardResults = {
        tool: '',
        language,
        summary: {
            errorCount: 0,
            warningCount: 0,
            fileCount: 0
        },
        issues: [],
        fileContents: {}
    };
    
    switch (language.toLowerCase()) {
        case 'javascript':
        case 'typescript':
            standardResults.tool = 'ESLint';
            standardResults.summary.errorCount = results.reduce((sum, file) => sum + file.errorCount, 0);
            standardResults.summary.warningCount = results.reduce((sum, file) => sum + file.warningCount, 0);
            standardResults.summary.fileCount = results.length;
            
            // Process messages
            results.forEach(file => {
                // Normalize file path
                const relativeFilePath = normalizePath(file.filePath, baseDirectory);
                
                console.log(`relativeFilePath:  ${relativeFilePath}`);

                file.messages.forEach(message => {
                    standardResults.issues.push({
                        file: relativeFilePath,
                        line: message.line,
                        column: message.column,
                        severity: message.severity === 2 ? 'error' : 'warning',
                        rule: message.ruleId || 'unknown',
                        message: message.message
                    });
                });
                console.log(`standardResults:  ${standardResults}`);
            });
            break;
            
        case 'java':
            standardResults.tool = 'PMD';
            standardResults.summary.fileCount = results.length || 0;
            
            if (results.files) {
                // Process Java issues from PMD
                results.files.forEach(file => {
                    const relativeFilePath = normalizePath(file.filename, baseDirectory);
                    
                    (file.violations || []).forEach(violation => {
                        const severity = getSeverityFromPriority(violation.priority);
                        
                        const issue = { // Create an issue object
                            file: relativeFilePath,
                            line: violation.beginline,
                            column: violation.begincolumn,
                            severity,
                            rule: violation.rule,
                            message: violation.description || violation.msg
                        };

                        if (violation.suggestion) { // Check for suggestion
                            issue.pmdSuggestion = violation.suggestion; // Add it to the issue object
                        }

                        standardResults.issues.push(issue); // Add the modified issue object
                        
                        // Update counts based on severity
                        if (severity === 'error') {
                            standardResults.summary.errorCount++;
                        } else {
                            standardResults.summary.warningCount++;
                        }
                    });
                });
            }
            break;
            
        case 'python':
            standardResults.tool = 'PyLint';
            
            // Process Python issues from PyLint
            results.forEach(issue => {
                const relativeFilePath = normalizePath(issue.path, baseDirectory);
                const severity = getPyLintSeverity(issue.type);
                
                standardResults.issues.push({
                    file: relativeFilePath,
                    line: issue.line,
                    column: issue.column,
                    severity,
                    rule: issue.symbol || issue.message_id,
                    message: issue.message
                });
                
                // Update counts based on severity
                if (severity === 'error') {
                    standardResults.summary.errorCount++;
                } else {
                    standardResults.summary.warningCount++;
                }
            });
            
            // Get unique file count
            standardResults.summary.fileCount = 
                new Set(standardResults.issues.map(i => i.file)).size;
            break;
            
        case 'php':
            standardResults.tool = 'PHP_CodeSniffer';
            
            // Process PHP issues from PHP_CodeSniffer
            if (results.files) {
                Object.keys(results.files).forEach(filePath => {
                    const relativeFilePath = normalizePath(filePath, baseDirectory);
                    const fileData = results.files[filePath];
                    
                    if (fileData.messages && fileData.messages.length > 0) {
                        fileData.messages.forEach(message => {
                            const severity = message.type.toLowerCase() === 'error' ? 'error' : 'warning';
                            
                            standardResults.issues.push({
                                file: relativeFilePath,
                                line: message.line,
                                column: message.column,
                                severity,
                                rule: message.source || 'phpcs',
                                message: message.message
                            });
                            
                            // Update counts based on severity
                            if (severity === 'error') {
                                standardResults.summary.errorCount++;
                            } else {
                                standardResults.summary.warningCount++;
                            }
                        });
                    }
                });
                
                standardResults.summary.fileCount = Object.keys(results.files).length;
            }
            break;
    }
    
    // Ensure all file paths are normalized
    standardResults.issues = standardResults.issues.map(issue => {
        if (!issue.file) {
            issue.file = 'unknown';
        }
        return issue;
    });
    
    // Filter out issues with invalid files (might happen if analysis includes directories)
    standardResults.issues = standardResults.issues.filter(issue => 
        issue.file !== 'unknown' && 
        !issue.file.includes('node_modules') &&
        issue.line > 0
    );
    
    return standardResults;
}

/**
 * Normalize a file path to a consistent format, making it relative to the baseDirectory.
 * @param {string} filePath - File path to normalize.
 * @param {string} baseDirectory - The base directory for the analysis.
 * @returns {string} Normalized and relativized path, or 'unknown' if filePath is falsy.
 */
function normalizePath(filePath, baseDirectory) {
    if (!filePath) return 'unknown';

    // Always use forward slashes for consistency internally
    let normalizedFilePath = filePath.replace(/\\/g, '/');
    const normalizedBaseDirectory = baseDirectory ? baseDirectory.replace(/\\/g, '/') : null;

    if (normalizedBaseDirectory && path.isAbsolute(normalizedFilePath)) {
        let relativePath = path.relative(normalizedBaseDirectory, normalizedFilePath);
        relativePath = relativePath.replace(/\\/g, '/'); // Ensure forward slashes in output

        // If the path is outside the base directory (e.g., starts with '../'),
        // it might indicate an issue or an unexpected file.
        // Fall back to basename to avoid exposing external paths.
        if (relativePath.startsWith('../')) {
            console.warn(`[WARN] File path ${normalizedFilePath} is outside the base directory ${normalizedBaseDirectory}. Falling back to basename.`);
            return path.basename(normalizedFilePath);
        }
        return relativePath;
    }
    
    // If filePath is not absolute, or baseDirectory is not provided,
    // assume filePath is already relative or a simple filename.
    // Ensure it uses forward slashes.
    return normalizedFilePath;
}

/**
 * Convert PMD priority to standardized severity
 * @param {number} priority - PMD priority (1-5)
 * @returns {string} Standardized severity
 */
function getSeverityFromPriority(priority) {
    priority = parseInt(priority, 10);
    
    if (priority <= 2) {
        return 'error';
    } else if (priority <= 4) {
        return 'warning';
    } else {
        return 'info';
    }
}

/**
 * Convert PyLint message type to standardized severity
 * @param {string} type - PyLint message type
 * @returns {string} Standardized severity
 */
function getPyLintSeverity(type) {
    type = type.toLowerCase();
    
    if (type === 'error' || type === 'fatal') {
        return 'error';
    } else if (type === 'warning') {
        return 'warning';
    } else {
        return 'info';
    }
}

/**
 * Check if a file exists
 * @param {string} filePath - Path to file
 * @returns {Promise<boolean>} True if file exists
 */
async function checkFileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Check if any of the specified files exist in a directory
 * @param {string} directory - Directory to check
 * @param {Array<string>} fileNames - File names to check
 * @returns {Promise<boolean>} True if any file exists
 */
async function hasAnyFile(directory, fileNames) {
    for (const fileName of fileNames) {
        if (await checkFileExists(path.join(directory, fileName))) {
            return true;
        }
    }
    return false;
}

module.exports = {
    analyzeCode,
    runESLint,
    runPMD,
    runPyLint,
    runPHPLint
}; 