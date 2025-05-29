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
 * @param {Object} options - Additional options
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
        const standardResults = standardizeResults(results, language);
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
            binary: 'C:/Program Files/Git/bin/git.exe',
            unsafe: {
                allowUnsafeCustomBinary: true
            },
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
            console.warn(`[WARN] Could not determine remote branches: ${branchError.message}. Proceeding with initial branch: ${branch}. This might indicate network or authentication issues.`);
            // Proceed with the initial `branch` value.
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
 * @param {Object} options - ESLint options
 * @returns {Promise<Object>} ESLint results
 */
async function runESLint(directory, options = {}) {
    try {
        // Check if ESLint is installed locally in the project
        const hasLocalESLint = await checkFileExists(path.join(directory, 'node_modules', '.bin', 'eslint'));
        let eslintPath = hasLocalESLint ? 
            path.join(directory, 'node_modules', '.bin', 'eslint') : 
            'eslint'; // Use global ESLint
        
        // Check for ESLint config
        const hasESLintConfig = await hasAnyFile(directory, [
            '.eslintrc.js', '.eslintrc.json', '.eslintrc.yml', '.eslintrc'
        ]);
        
        // Set up a default ESLint config if none exists
        if (!hasESLintConfig) {
            await fs.writeFile(
                path.join(directory, '.eslintrc.json'), 
                JSON.stringify({
                    "env": { "browser": true, "es2021": true, "node": true },
                    "extends": "eslint:recommended",
                    "parserOptions": { "ecmaVersion": "latest", "sourceType": "module" }
                }, null, 2)
            );
        }
        
        // Install ESLint if not available
        if (!hasLocalESLint && (await execPromise('which eslint').then(() => false).catch(() => true))) {
            console.log('ESLint not found, installing globally...');
            await execPromise('npm install -g eslint');
        }
        
        // Determine file extensions to check
        const fileExtension = options.fileExtension || (options.typescript ? 'ts,tsx' : 'js,jsx');
        
        // Run ESLint
        console.log(`Running ESLint on ${directory} with extensions: ${fileExtension}`);
        const { stdout } = await execPromise(
            `${eslintPath} ${directory} --ext ${fileExtension} -f json`
        );
        
        return JSON.parse(stdout);
    } catch (error) {
        console.error('ESLint error:', error);
        if (error.stderr && error.stderr.includes('not found')) {
            throw new Error('ESLint not installed. Please run npm install -g eslint');
        }
        throw error;
    }
}

/**
 * Run PMD on a directory
 * @param {string} directory - Directory to analyze
 * @param {Object} options - PMD options
 * @returns {Promise<Object>} PMD results
 */
async function runPMD(directory, options = {}) {
    // PMD path (environment variable or default)
    const PMD_PATH = process.env.PMD_PATH || '/usr/local/pmd/bin/pmd';
    
    // Default rulesets
    const rulesets = options.rulesets || 'category/java/bestpractices.xml,category/java/errorprone.xml';
    
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
 * @param {Object} options - PyLint options
 * @returns {Promise<Object>} PyLint results
 */
async function runPyLint(directory, options = {}) {
    try {
        // Check if PyLint is installed
        await execPromise('which pylint').catch(async () => {
            console.log('PyLint not found, installing...');
            await execPromise('pip install pylint');
        });
        
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
 * @param {Object} options - PHP_CodeSniffer options
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
 * @returns {Object} Standardized results
 */
function standardizeResults(results, language) {
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
                const relativeFilePath = normalizePath(file.filePath);
                
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
                    const relativeFilePath = normalizePath(file.filename);
                    
                    (file.violations || []).forEach(violation => {
                        const severity = getSeverityFromPriority(violation.priority);
                        
                        standardResults.issues.push({
                            file: relativeFilePath,
                            line: violation.beginline,
                            column: violation.begincolumn,
                            severity,
                            rule: violation.rule,
                            message: violation.description || violation.msg
                        });
                        
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
                const relativeFilePath = normalizePath(issue.path);
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
                    const relativeFilePath = normalizePath(filePath);
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
 * Normalize a file path to a consistent format
 * @param {string} filePath - File path to normalize
 * @returns {string} Normalized path
 */
function normalizePath(filePath) {
    if (!filePath) return 'unknown';
    
    // Replace backslashes with forward slashes
    let normalized = filePath.replace(/\\/g, '/');
    
    // Remove any absolute path elements
    const parts = normalized.split('/');
    const rootDirIndex = parts.findIndex(p => 
        p === 'src' || 
        p === 'lib' || 
        p === 'app' || 
        p === 'test'
    );
    
    if (rootDirIndex !== -1) {
        normalized = parts.slice(rootDirIndex).join('/');
    } else {
        // Just get the filename if we can't determine the project structure
        normalized = parts[parts.length - 1];
    }
    
    return normalized;
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