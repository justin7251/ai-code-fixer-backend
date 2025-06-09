const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const simpleGit = require('simple-git');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const axios = require('axios');

// --- Path Helper Functions ---

/**
 * Safely joins path segments and ensures the resulting path is within the base directory.
 * @param {string} baseDir - The base directory.
 * @param {...string} subPaths - Path segments to join.
 * @returns {string} The resolved, validated absolute path.
 * @throws {Error} If path traversal is attempted or if the path is outside the base directory.
 */
function safeJoinPath(baseDir, ...subPaths) {
    const rawJoinedPath = path.join(baseDir, ...subPaths);
    const resolvedPath = path.resolve(rawJoinedPath);
    const resolvedBaseDir = path.resolve(baseDir);

    if (!resolvedPath.startsWith(resolvedBaseDir + path.sep) && resolvedPath !== resolvedBaseDir) {
        console.error(`Security Alert: Path traversal attempt or invalid path. Base: '${baseDir}', Subpaths: '${subPaths.join('/')}', Resolved: '${resolvedPath}'`);
        throw new Error(`Path Error: Attempted to access path '${resolvedPath}' which is outside the allowed base directory '${resolvedBaseDir}'.`);
    }
    return resolvedPath;
}

/**
 * Normalizes a file path to use forward slashes and makes it relative to a base directory.
 * Issues a warning and returns only the basename if the path is outside the base directory.
 * @param {string} filePath - File path to normalize.
 * @param {string} baseDirectory - The base directory for relativization.
 * @param {boolean} [allowOutside=false] - If true, allows paths outside baseDirectory and returns the original normalized path.
 * @returns {string} Normalized and relativized path, or 'unknown' if filePath is falsy.
 */
function normalizeAndRelativizePath(filePath, baseDirectory, allowOutside = false) {
    if (!filePath) return 'unknown';

    // Standardize slashes first for consistent processing
    let normalizedFilePath = filePath.replace(/\\/g, '/');
    const normalizedBaseDirectory = baseDirectory.replace(/\\/g, '/');

    // Determine if the path is absolute, considering Windows drive letters even on non-Windows hosts
    const isWindowsAbsoluteWithDrive = /^[a-zA-Z]:\//.test(normalizedFilePath);
    // path.isAbsolute is OS-dependent. On Linux, 'C:/...' is not absolute.
    // We need a more robust cross-platform interpretation for string inputs that might be foreign.
    const isEffectivelyAbsolute = isWindowsAbsoluteWithDrive || normalizedFilePath.startsWith('/');

    if (isEffectivelyAbsolute) {
        // If the path is considered absolute (either Unix-style or Windows-style with drive letter),
        // then attempt to make it relative to the base directory.
        let relativePath = path.relative(normalizedBaseDirectory, normalizedFilePath).replace(/\\/g, '/');

        // If after relativization, it still looks like a Windows absolute path (e.g. C:/...)
        // and normalizedBaseDirectory was something different like /app/project,
        // then path.relative might return the original path if it can't make it relative.
        // In such cases, or if it correctly becomes '../...', handle as outside.
        const stillLooksAbsoluteWindows = /^[a-zA-Z]:\//.test(relativePath);

        if (relativePath.startsWith('../') || (stillLooksAbsoluteWindows && relativePath === normalizedFilePath)) {
            if (!allowOutside) {
                console.warn(`[Path WARN] File path ${normalizedFilePath} is outside the base directory ${normalizedBaseDirectory}. Returning basename only for security.`);
                return path.basename(normalizedFilePath); // Return just the filename part
            } else {
                // If allowed outside, return the original normalized (forward slashes) absolute path.
                return normalizedFilePath;
            }
        }
        return relativePath === '' ? '.' : relativePath; // Return '.' if path is same as baseDirectory
    }

    // If not effectively absolute, assume it's already a relative path.
    // Ensure it uses forward slashes.
    return normalizedFilePath;
}

/**
 * Validates a PMD ruleset path.
 * Allows URLs, PMD category strings, or safe relative file paths.
 * @param {string} rulesetPath - The ruleset path to validate.
 * @param {string} baseDir - The base directory for resolving relative paths.
 * @returns {string} The validated ruleset path (could be original URL/category or resolved absolute path).
 * @throws {Error} If the path is invalid or insecure.
 */
function validatePmdRulesetPath(rulesetPath, baseDir) {
    const trimmedPath = rulesetPath.trim();
    const isUrl = trimmedPath.startsWith('http://') || trimmedPath.startsWith('https://');
    const isPmdCategory = trimmedPath.startsWith('category/');

    if (isUrl || isPmdCategory) {
        return trimmedPath; // Valid as is
    }

    // Treat as a file path
    if (path.isAbsolute(trimmedPath)) {
        console.error(`Security Alert: Absolute PMD ruleset path detected: '${trimmedPath}'`);
        throw new Error(`Path Error: Absolute PMD ruleset path '${trimmedPath}' is not allowed. Please use a relative path or a standard PMD category.`);
    }
    if (trimmedPath.includes('..')) {
        console.error(`Security Alert: Path traversal detected in PMD ruleset path: '${trimmedPath}'`);
        throw new Error(`Path Error: Path traversal ('..') in PMD ruleset path '${trimmedPath}' is not allowed.`);
    }

    // If it's a relative path, it should be joined with baseDir and validated
    // For PMD, the path string itself is passed to the command, not necessarily resolved by us first,
    // unless PMD expects an absolute path for local files. Assuming PMD handles relative paths from execution dir.
    // The key is to ensure the *provided string* doesn't try to escape.
    // If we were to resolve it, we'd use safeJoinPath(baseDir, trimmedPath) here.
    // For now, the validation above (no absolute, no '..') is key for the string passed to PMD.
    return trimmedPath;
}


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
    let tempDir; // Declare tempDir here to ensure it's available in the finally block if needed
    try {
        console.log(`Starting static analysis for ${repoUrl} with language: ${language}`);
        
        // Create a temporary directory
        // For temp directories, direct os.tmpdir() join is usually fine and doesn't need safeJoinPath
        // as os.tmpdir() is a trusted system path.
        const uniqueDirName = `code-analysis-${Date.now()}`;
        tempDir = path.join(os.tmpdir(), uniqueDirName);
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
        // console.log(`standardResults:  ${JSON.stringify(standardResults, null, 2)}`); // More detailed log for debugging

        // Add file contents for files with issues (for AI fixing)
        await addFileContents(standardResults, tempDir);
        
        return standardResults;
    } catch (error) {
        console.error('Static analysis error:', error);
        // Ensure the error message indicates it's from the top-level analysis
        const newError = new Error(`Static analysis failed: ${error.message}`);
        newError.stack = error.stack; // Preserve original stack
        throw newError;
    } finally {
        if (tempDir) {
            try {
                await fs.rm(tempDir, { recursive: true, force: true });
                console.log(`Cleaned up temporary directory: ${tempDir}`);
            } catch (cleanupError) {
                console.warn(`Warning: Could not clean up temporary directory ${tempDir}: ${cleanupError.message}`);
            }
        }
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
 * @param {string} directory - Target directory (this is the base for the sparse checkout, e.g., tempDir)
 * @param {string} language - Programming language
 * @param {Array} specificFiles - Optional list of specific files to checkout
 */
/**
 * Performs a sparse checkout of a Git repository.
 * @param {string} repoUrl - The URL of the Git repository (e.g., 'https://github.com/user/repo.git').
 * @param {string} fullTargetDirPath - The local directory where the sparse checkout should happen.
 * @param {string} language - Used by generateFilePatterns to determine patterns.
 * @param {string[]} [specificFiles=[]] - Optional array of specific files/patterns to include.
 * @param {string} [branch='main'] - The branch to checkout (defaults to 'main').
 * @returns {Promise<string>} - Resolves with the path to the cloned directory on success.
 */

// --- Sparse Checkout Sub-functions ---

/**
 * Initializes a Git repository and adds a remote.
 * @param {import('simple-git').SimpleGit} git - The simple-git instance.
 * @param {string} repoUrl - The URL of the remote repository.
 * @param {string} directoryPath - The local directory path for the repo.
 */
async function _initializeGitRepoAndRemote(git, repoUrl, directoryPath) {
    // Initialize a new Git repository in the target directory.
    console.log(`[GIT_INIT] Initializing git repo in ${directoryPath}...`);
    await git.init();
    console.log(`[GIT_INIT_DONE] Git repo initialized.`);

    // Add the remote repository URL with the name 'origin'.
    console.log(`[GIT_REMOTE] Adding remote 'origin' (${repoUrl})...`);
    await git.addRemote('origin', repoUrl);
    console.log(`[GIT_REMOTE_DONE] Remote added.`);
}

/**
 * Configures sparse checkout by enabling it and writing patterns to the sparse-checkout file.
 * @param {import('simple-git').SimpleGit} git - The simple-git instance.
 * @param {string[]} patterns - An array of patterns for sparse checkout.
 * @param {string} directoryPath - The local directory path of the repo.
 */
async function _configureSparseCheckout(git, patterns, directoryPath) {
    // Enable sparse checkout mode in Git configuration.
    console.log(`[GIT_CONFIG] Enabling sparse-checkout mode...`);
    await git.raw(['config', 'core.sparseCheckout', 'true']);
    console.log(`[GIT_CONFIG_DONE] Sparse-checkout enabled.`);

    // Define the path to the sparse-checkout file within the .git directory.
    // This path is constructed safely to prevent traversal issues.
    const sparseFilePath = safeJoinPath(directoryPath, '.git', 'info', 'sparse-checkout');

    // Write the generated patterns to the sparse-checkout file.
    // Each pattern is written on a new line.
    console.log(`[FS_WRITE] Writing patterns to ${sparseFilePath}:`, patterns);
    await fs.writeFile(sparseFilePath, patterns.join('\n'), 'utf8');
    console.log(`[FS_WRITE_DONE] Patterns written.`);
}

/**
 * Determines the actual branch to use by checking remote branches.
 * Falls back to 'main' or 'master' if the desired branch is not found.
 * @param {import('simple-git').SimpleGit} git - The simple-git instance.
 * @param {string} desiredBranch - The initially requested branch name.
 * @param {string} repoUrl - Repository URL (for logging).
 * @returns {Promise<string>} The resolved branch name.
 * @throws {Error} If no suitable branch (desired, main, or master) is found.
 */
async function _determineRemoteBranch(git, desiredBranch, repoUrl) {
    console.log(`[BRANCH_CHECK] Checking remote branches for '${desiredBranch}' at ${repoUrl}...`);
    try {
        // Fetch the list of remote branches from 'origin'.
        const remoteBranches = await git.listRemote(['--heads', 'origin']);

        // Check if the desired branch exists on the remote.
        if (remoteBranches.includes(`refs/heads/${desiredBranch}`)) {
            console.log(`[BRANCH_RESOLVED] Desired branch '${desiredBranch}' found on remote.`);
            return desiredBranch;
        }

        // If desired branch is not found, issue a warning and try fallback branches.
        console.warn(`[WARN] Specified branch '${desiredBranch}' not found on remote for ${repoUrl}. Trying 'main' or 'master'.`);
        if (remoteBranches.includes('refs/heads/main')) {
            console.log(`[BRANCH_RESOLVED] Using fallback branch 'main'.`);
            return 'main';
        }
        if (remoteBranches.includes('refs/heads/master')) {
            console.log(`[BRANCH_RESOLVED] Using fallback branch 'master'.`);
            return 'master';
        }

        // If neither desired nor fallback branches are found, throw an error.
        console.error(`[ERROR] Neither specified branch '${desiredBranch}', nor 'main', nor 'master' found on remote for ${repoUrl}.`);
        throw new Error(`Cannot find a suitable branch (tried ${desiredBranch}, main, master) on remote for ${repoUrl}.`);
    } catch (branchError) {
        // Log and re-throw any errors encountered during branch determination.
        console.error(`[ERROR] Could not determine remote branches for ${repoUrl}: ${branchError.message}.`);
        throw new Error(`Failed to verify remote branches for ${repoUrl}: ${branchError.message}`);
    }
}

/**
 * Fetches a specific branch (shallowly) and then checks it out.
 * @param {import('simple-git').SimpleGit} git - The simple-git instance.
 * @param {string} branchName - The name of the branch to fetch and checkout.
 */
async function _fetchAndCheckoutBranch(git, branchName) {
    // Perform a shallow fetch (depth 1) of the specified branch from 'origin'.
    // This is more efficient as it doesn't download the entire Git history.
    console.log(`[GIT_FETCH] Fetching branch '${branchName}' from origin with depth=1...`);
    await git.fetch('origin', branchName, ['--depth=1']);
    console.log(`[GIT_FETCH_DONE] Fetch completed for branch '${branchName}'.`);

    // Checkout the fetched branch.
    // Sparse checkout rules are applied at this stage.
    console.log(`[GIT_CHECKOUT] Checking out branch '${branchName}'...`);
    await git.checkout(branchName);
    console.log(`[GIT_CHECKOUT_DONE] Checkout completed for branch '${branchName}'.`);
}


// --- Main Sparse Checkout Function ---

/**
 * Performs a sparse checkout of a Git repository.
 * This process involves initializing a Git repository, setting up sparse checkout patterns,
 * determining the correct branch, and fetching/checking out only necessary files.
 * @param {string} repoUrl - The URL of the Git repository.
 * @param {string} fullTargetDirPath - The local directory where the sparse checkout will occur.
 * @param {string} language - The programming language to determine default file patterns.
 * @param {string[]} [specificFiles=[]] - Optional list of specific files/patterns for checkout.
 * @param {string} [defaultBranch='main'] - The default branch to try if the primary isn't found.
 * @returns {Promise<string>} - Resolves with the path to the directory upon successful checkout.
 * @throws {Error} If any step of the sparse checkout process fails.
 */
async function sparseCheckout(repoUrl, fullTargetDirPath, language, specificFiles = [], defaultBranch = 'main') {
    let git;
    try {
        console.log(`[START] Starting sparse checkout for ${repoUrl} into ${fullTargetDirPath}`);
 
        // Initialize the simple-git instance with the target directory.
        git = simpleGit({
            baseDir: fullTargetDirPath,
            timeout: { block: 10000 }, // Set a timeout for Git operations.
        });
        console.log(`[SG_INIT_DONE] simple-git instance initialized.`);

        // Step 1: Initialize local Git repository and add remote.
        await _initializeGitRepoAndRemote(git, repoUrl, fullTargetDirPath);

        // Step 2: Generate file patterns for sparse checkout based on language or specific files.
        console.log(`[PATTERNS] Setting up sparse-checkout patterns...`);
        const patterns = specificFiles.length > 0
            ? specificFiles  // Use specific files if provided.
            : generateFilePatterns(language); // Otherwise, generate patterns based on language.

        // Step 3: Configure sparse checkout settings and write patterns.
        await _configureSparseCheckout(git, patterns, fullTargetDirPath);

        // Step 4: Determine the actual branch to checkout.
        // This handles cases where the default branch might not exist, falling back to main/master.
        const branchToCheckout = await _determineRemoteBranch(git, defaultBranch, repoUrl);

        // Step 5: Fetch the selected branch (shallowly) and perform the checkout.
        await _fetchAndCheckoutBranch(git, branchToCheckout);

        console.log(`[SUCCESS] ✅ Sparse checkout completed for ${repoUrl} (branch: ${branchToCheckout}) into ${fullTargetDirPath}`);
        return fullTargetDirPath; // Return the path upon successful completion.

    } catch (error) {
        // Log any errors encountered during the process.
        console.error(`❌ Sparse checkout error for ${repoUrl}: ${error.message}`);
        if (error.stack) console.error('Error Stack:', error.stack);

        // Re-throw a new error with a more specific message, preserving the original stack.
        // The actual cleanup of fullTargetDirPath is handled by the `analyzeCode` function's `finally` block.
        const newError = new Error(`Repository sparse checkout failed for ${repoUrl}: ${error.message}`);
        newError.stack = error.stack;
        throw newError;
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
 * Add file contents to the results for files with issues.
 * @param {Object} results - Standardized analysis results.
 * @param {string} baseDirectory - The base directory where files were analyzed (e.g., tempDir).
 */
async function addFileContents(results, baseDirectory) {
    try {
        const uniqueFiles = [...new Set(results.issues.map(issue => issue.file))];
        results.fileContents = {};

        for (const relativeFilePath of uniqueFiles) {
            if (relativeFilePath === 'unknown') {
                console.warn(`Skipping file content retrieval for an 'unknown' file path.`);
                continue;
            }
            try {
                // relativeFilePath should already be safe and relative from standardizeResults.
                // We join it with baseDirectory to get the actual full path for reading.
                const fullPath = safeJoinPath(baseDirectory, relativeFilePath);
                const content = await fs.readFile(fullPath, 'utf8');
                results.fileContents[relativeFilePath] = content;
            } catch (fileError) {
                // Log specific file error but continue processing other files
                console.warn(`Could not read file content for '${relativeFilePath}' (resolved from base '${baseDirectory}'): ${fileError.message}`);
            }
        }
        console.log(`Attempted to add content for ${uniqueFiles.length} unique files. Successfully added for ${Object.keys(results.fileContents).length}.`);
    } catch (error) {
        // Log error related to the overall addFileContents operation
        console.error(`Error adding file contents: ${error.message}`);
        // Optionally, re-throw or handle more gracefully depending on requirements
    }
}


/**
 * Run ESLint on a directory
 * @param {string} directory - Directory to analyze (this is the base execution directory, e.g. tempDir)
 * @param {Object} [options={}] - ESLint options.
 * @param {string} [options.fileExtension] - Optional. Comma-separated file extensions for ESLint to check (e.g., 'js,jsx' or 'ts,tsx').
 * @param {boolean} [options.typescript] - Optional. If true, implies TypeScript files and sets a default `fileExtension` to 'ts,tsx' if `options.fileExtension` is not provided.
 * @returns {Promise<Object>} ESLint results
 */
async function runESLint(directory, options = {}) {
    try {
        // Determine ESLint executable path (local or global)
        // safeJoinPath ensures these paths are within the project's temp directory
        const localEslintPath = safeJoinPath(directory, 'node_modules', '.bin', 'eslint');
        const hasLocalESLint = await checkFileExists(localEslintPath);
        let eslintPath = hasLocalESLint ? localEslintPath : 'eslint'; // Fallback to global if not local

        let eslintConfigOption = '';
        let customConfigProvided = false;

        // Handle custom ESLint config path
        if (options.eslint && typeof options.eslint.configFile === 'string') {
            const userConfigPath = options.eslint.configFile.trim();
            if (userConfigPath) {
                customConfigProvided = true;
                // Validate and resolve custom config path securely within the project directory
                const customConfigFullPath = safeJoinPath(directory, userConfigPath);
                eslintConfigOption = `--config "${customConfigFullPath}"`;
                console.log(`Using custom ESLint config: ${customConfigFullPath}`);
            }
        }

        // Setup default ESLint config if no custom or standard config is found
        if (!customConfigProvided) {
            const standardConfigs = ['.eslintrc.js', '.eslintrc.json', '.eslintrc.yml', '.eslintrc', 'eslint.config.js'];
            const foundStandardConfig = await hasAnyFile(directory, standardConfigs); // hasAnyFile uses safeJoinPath

            if (!foundStandardConfig) {
                const defaultConfigPath = safeJoinPath(directory, '.eslintrc.json'); // Use safeJoinPath
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
        const cachePath = safeJoinPath(directory, '.eslintcache'); // Use safeJoinPath
        
        const commandParts = [
            eslintPath,
            `"${directory}"`, // Target directory for linting
            `--ext ${fileExtension}`,
            '-f json',
            '--cache',
            `--cache-location "${cachePath}"`
        ];
        if (eslintConfigOption) {
            commandParts.push(eslintConfigOption);
        }
        const eslintCommand = commandParts.join(' ');

        console.log(`Running ESLint on ${directory} with extensions: ${fileExtension}, cache: ${cachePath}`);
        console.log(`Executing ESLint command: ${eslintCommand}`);
        
        try {
            const { stdout } = await execPromise(eslintCommand);
            return JSON.parse(stdout);
        } catch (error) {
            console.error('ESLint execution encountered an error:', error.message);
            const trimmedStdout = error.stdout && typeof error.stdout === 'string' ? error.stdout.trim() : '';
            if (trimmedStdout && (trimmedStdout.startsWith('{') || trimmedStdout.startsWith('['))) {
                console.warn('ESLint exited non-zero, but stdout appears to be JSON. Parsing for lint violations.');
                try {
                    return JSON.parse(trimmedStdout);
                } catch (parseError) {
                    throw new Error(`ESLint Error: Failed to parse stdout JSON after non-zero exit. ${parseError.message}. Stderr: ${error.stderr || 'N/A'}`);
                }
            }
            if (error.code === 'ENOENT' || error.message.includes('eslint: not found')) {
                throw new Error('ESLint Error: Executable not found. Ensure ESLint is installed.');
            }
            // Temporary log for debugging Failure 2
            // console.log(`DEBUG: Stderr type: ${typeof error.stderr}, Stderr content: ${error.stderr}`);
            if (error.stderr && (
                   error.stderr.toLowerCase().includes('configuration error') ||
                   error.stderr.toLowerCase().includes('cannot find module') ||
                   error.stderr.toLowerCase().includes('parsing error')
                )) {
                throw new Error(`ESLint Error: Configuration error. Details: ${error.stderr}`);
            }
            throw new Error(`ESLint Error: Execution failed. Code: ${error.code || 'N/A'}. Stderr: ${error.stderr || 'N/A'}. Stdout: ${error.stdout || 'N/A'}`);
        }
    } catch (err) {
        // If err.message starts with "Path Error:" or "ESLint Error:", it's an error we've already categorized.
        if (err.message && (err.message.startsWith('ESLint Error:') || err.message.startsWith('Path Error:'))) {
            throw err; // Re-throw it as is.
        }
        // Otherwise, wrap it as a generic unexpected ESLint error.
        console.error('Unhandled error in runESLint:', err);
        throw new Error(`ESLint Error: An unexpected error occurred during ESLint analysis. Details: ${err.message}`);
    }
}

/**
 * Run PMD on a directory
 * @param {string} directory - Directory to analyze (base execution directory)
 * @param {Object} [options={}] - PMD options.
 * @param {string} [options.rulesets] - Optional. Comma-separated string of PMD rulesets to use.
 * @returns {Promise<Object>} PMD results
 */
async function runPMD(directory, options = {}) {
    try {
        const PMD_PATH = process.env.PMD_PATH || '/usr/local/pmd/bin/pmd'; // Default PMD path
        let rulesetOption = 'category/java/bestpractices.xml,category/java/errorprone.xml'; // Default ruleset

        if (options.pmd && options.pmd.rulesets && typeof options.pmd.rulesets === 'string') {
            const customRulesetStr = options.pmd.rulesets.trim();
            if (customRulesetStr) {
                const validatedPaths = customRulesetStr.split(',')
                    .map(p => validatePmdRulesetPath(p, directory)) // Validate each path
                    .filter(p => p);
                if (validatedPaths.length > 0) {
                    rulesetOption = validatedPaths.join(',');
                } else {
                    console.warn("PMD: Custom ruleset string was empty after validation. Using default rulesets.");
                }
            }
        }
    
        const pmdCommand = `${PMD_PATH} check -d "${directory}" -R "${rulesetOption}" -f json`;
        console.log(`Running PMD on ${directory} with ruleset: ${rulesetOption}`);
        console.log(`Executing PMD command: ${pmdCommand}`);
        
        try {
            const { stdout } = await execPromise(pmdCommand);
            return JSON.parse(stdout);
        } catch (error) {
            console.error('PMD execution error:', error.message);
            // PMD might output JSON to stdout even on error (e.g., if violations are found)
            if (error.stdout && typeof error.stdout === 'string' && error.stdout.trim().startsWith('{')) {
                console.warn('PMD exited non-zero, but stdout is JSON. Attempting to parse.');
                try {
                    return JSON.parse(error.stdout);
                } catch (parseError) {
                    throw new Error(`PMD Error: Failed to parse stdout JSON after non-zero exit. ${parseError.message}. Stderr: ${error.stderr || 'N/A'}`);
                }
            }
            if (error.code === 'ENOENT' || error.message.includes('pmd: not found')) { // Check if PMD executable is found
                throw new Error('PMD Error: Executable not found. Ensure PMD is installed and PMD_PATH is set correctly if not in system PATH.');
            }
            // Include stderr for more context on PMD failures
            throw new Error(`PMD Error: Execution failed. Code: ${error.code || 'N/A'}. Stderr: ${error.stderr || 'N/A'}. Stdout: ${error.stdout || 'N/A'}`);
        }
    } catch (err) {
        // Ensure consistent error reporting
        if (err.message && (err.message.startsWith('PMD Error:') || err.message.startsWith('Path Error:'))) {
            throw err;
        }
        console.error('Unhandled error in runPMD:', err);
        throw new Error(`PMD Error: An unexpected error occurred. ${err.message}`);
    }
}


/**
 * Run PyLint on a directory
 * @param {string} directory - Directory to analyze
 * @param {Object} [options={}] - PyLint options.
 * @returns {Promise<Object>} PyLint results
 */
async function runPyLint(directory, options = {}) {
    try {
        await execPromise('which pylint'); // Check if pylint is in PATH
        
        const pylintCommand = `pylint --output-format=json "${directory}"`;
        console.log(`Running PyLint on ${directory}`);
        console.log(`Executing PyLint command: ${pylintCommand}`);

        const { stdout } = await execPromise(pylintCommand).catch((error) => {
            // PyLint exits non-zero for warnings/errors, but output is still valid JSON
            if (error.stdout) return { stdout: error.stdout };
            console.error('PyLint execution error (no stdout):', error.message);
            throw new Error(`PyLint Error: Execution failed and no stdout. Code: ${error.code || 'N/A'}. Stderr: ${error.stderr || 'N/A'}`);
        });
        
        return JSON.parse(stdout);
    } catch (error) {
        if (error.message && error.message.startsWith('PyLint Error:')) throw error;
        if (error.message && error.message.includes('pylint: not found')) {
             throw new Error('PyLint Error: Executable not found. Ensure PyLint is installed and in PATH.');
        }
        console.error('Unhandled PyLint error:', error);
        throw new Error(`PyLint Error: An unexpected error occurred. ${error.message}`);
    }
}

/**
 * Run PHP_CodeSniffer on a directory.
 * @param {string} directory - Directory to analyze.
 * @param {Object} [options={}] - PHP_CodeSniffer options.
 * @returns {Promise<Object>} PHP_CodeSniffer results.
 */
async function runPHPLint(directory, options = {}) {
    try {
        await execPromise('which phpcs'); // Check if phpcs is in PATH

        const phpcsCommand = `phpcs --report=json "${directory}"`;
        console.log(`Running PHP_CodeSniffer on ${directory}`);
        console.log(`Executing PHP_CodeSniffer command: ${phpcsCommand}`);

        const { stdout } = await execPromise(phpcsCommand).catch((error) => {
            // PHPCS also exits non-zero for warnings/errors with valid JSON output
            if (error.stdout) return { stdout: error.stdout };
            console.error('PHP_CodeSniffer execution error (no stdout):', error.message);
            throw new Error(`PHPCS Error: Execution failed and no stdout. Code: ${error.code || 'N/A'}. Stderr: ${error.stderr || 'N/A'}`);
        });
        
        return JSON.parse(stdout);
    } catch (error) {
        if (error.message && error.message.startsWith('PHPCS Error:')) throw error;
        if (error.message && error.message.includes('phpcs: not found')) {
            throw new Error('PHPCS Error: Executable not found. Ensure PHP_CodeSniffer is installed (e.g., via Composer) and in PATH.');
        }
        console.error('Unhandled PHP_CodeSniffer error:', error);
        throw new Error(`PHPCS Error: An unexpected error occurred. ${error.message}`);
    }
}


/**
 * Standardize results from different tools into a common format.
 * @param {Object} results - Analysis results from a specific tool.
 * @param {string} language - Language that was analyzed.
 * @param {string} baseDirectory - The base directory for the analysis, used for path normalization.
 * @returns {Object} Standardized results.
 */
function standardizeResults(results, language, baseDirectory) {
    const standardResults = {
        tool: '',
        language,
        summary: { errorCount: 0, warningCount: 0, fileCount: 0 },
        issues: [],
        fileContents: {} // Will be populated by addFileContents
    };

    try {
        switch (language.toLowerCase()) {
            case 'javascript':
            case 'typescript':
                standardResults.tool = 'ESLint';
                if (Array.isArray(results)) {
                    standardResults.summary.errorCount = results.reduce((sum, file) => sum + file.errorCount, 0);
                    standardResults.summary.warningCount = results.reduce((sum, file) => sum + file.warningCount, 0);
                    standardResults.summary.fileCount = results.length;
                    results.forEach(file => {
                        const relativeFilePath = normalizeAndRelativizePath(file.filePath, baseDirectory);
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
                    });
                } else {
                     console.warn("ESLint results were not in the expected array format. Skipping issue processing.");
                }
                break;
            
            case 'java':
                standardResults.tool = 'PMD';
                if (results && Array.isArray(results.files)) {
                    standardResults.summary.fileCount = results.files.length;
                    results.files.forEach(file => {
                        const relativeFilePath = normalizeAndRelativizePath(file.filename, baseDirectory);
                        (file.violations || []).forEach(violation => {
                            const severity = getSeverityFromPriority(violation.priority);
                            standardResults.issues.push({
                                file: relativeFilePath,
                                line: violation.beginline,
                                column: violation.begincolumn,
                                severity,
                                rule: violation.rule,
                                message: violation.description || violation.msg,
                                ...(violation.suggestion && { pmdSuggestion: violation.suggestion })
                            });
                            if (severity === 'error') standardResults.summary.errorCount++;
                            else standardResults.summary.warningCount++;
                        });
                    });
                } else {
                    console.warn("PMD results or results.files were not in the expected format. Skipping issue processing.");
                }
                break;

            case 'python': // PyLint
                standardResults.tool = 'PyLint';
                 if (Array.isArray(results)) {
                    const filePaths = new Set();
                    results.forEach(issue => {
                        const relativeFilePath = normalizeAndRelativizePath(issue.path, baseDirectory);
                        filePaths.add(relativeFilePath);
                        const severity = getPyLintSeverity(issue.type);
                        standardResults.issues.push({
                            file: relativeFilePath,
                            line: issue.line,
                            column: issue.column,
                            severity,
                            rule: issue.symbol || issue.message_id,
                            message: issue.message
                        });
                        if (severity === 'error') standardResults.summary.errorCount++;
                        else standardResults.summary.warningCount++;
                    });
                    standardResults.summary.fileCount = filePaths.size;
                } else {
                    console.warn("PyLint results were not in the expected array format. Skipping issue processing.");
                }
                break;

            case 'php': // PHP_CodeSniffer
                standardResults.tool = 'PHP_CodeSniffer';
                if (results && results.files && typeof results.files === 'object') {
                    standardResults.summary.fileCount = Object.keys(results.files).length;
                    Object.entries(results.files).forEach(([filePath, fileData]) => {
                        const relativeFilePath = normalizeAndRelativizePath(filePath, baseDirectory);
                        if (fileData.messages && Array.isArray(fileData.messages)) {
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
                                if (severity === 'error') standardResults.summary.errorCount++;
                                else standardResults.summary.warningCount++;
                            });
                        }
                    });
                } else {
                     console.warn("PHPCS results or results.files were not in the expected format. Skipping issue processing.");
                }
                break;
            default:
                console.warn(`StandardizeResults: Unknown language '${language}'. Cannot process tool-specific results.`);
        }
    } catch (processingError) {
        console.error(`Error during standardizeResults for ${language}: ${processingError.message}`);
        // Optionally, you might want to clear issues if processing fails partially
        // standardResults.issues = [];
        // standardResults.summary = { errorCount: 0, warningCount: 0, fileCount: 0 };
    }
    
    // Final filtering of issues
    standardResults.issues = standardResults.issues.filter(issue => 
        issue.file && issue.file !== 'unknown' &&
        !issue.file.includes('node_modules') && // General exclusion
        (issue.line !== undefined && issue.line > 0)
    );
    
    return standardResults;
}

// This function is replaced by normalizeAndRelativizePath
// function normalizePath(filePath, baseDirectory) { ... }


/**
 * Convert PMD priority to standardized severity
 * @param {number} priority - PMD priority (1-5)
 * @returns {string} Standardized severity
 */
function getSeverityFromPriority(priority) {
    priority = parseInt(priority, 10); // Ensure priority is a number
    if (priority <= 2) return 'error';
    if (priority <= 4) return 'warning';
    return 'info';
}

/**
 * Convert PyLint message type to standardized severity.
 * @param {string} type - PyLint message type (e.g., 'error', 'warning', 'convention', 'refactor').
 * @returns {string} Standardized severity ('error', 'warning', 'info').
 */
function getPyLintSeverity(type) {
    const lowerType = type.toLowerCase();
    if (lowerType === 'error' || lowerType === 'fatal') return 'error';
    if (lowerType === 'warning') return 'warning';
    return 'info'; // Treat convention, refactor, etc. as info
}

/**
 * Check if a file exists at the given path.
 * @param {string} filePath - Path to file.
 * @returns {Promise<boolean>} True if file exists, false otherwise.
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
 * Check if any of the specified files exist in a directory.
 * Uses safeJoinPath for security.
 * @param {string} directory - Directory to check.
 * @param {Array<string>} fileNames - File names to check.
 * @returns {Promise<boolean>} True if any file exists, false otherwise.
 */
async function hasAnyFile(directory, fileNames) {
    for (const fileName of fileNames) {
        try {
            const fullPath = safeJoinPath(directory, fileName); // Securely join path
            if (await checkFileExists(fullPath)) {
                return true;
            }
        } catch (error) {
            // If safeJoinPath throws an error (e.g., path traversal), log it and continue
            // This file effectively "does not exist" in a valid way.
            console.warn(`Path validation error in hasAnyFile for '${fileName}': ${error.message}`);
        }
    }
    return false;
}

module.exports = {
    analyzeCode,
    runESLint,
    runPMD,
    runPyLint,
    runPHPLint,
    // Export helpers for testing
    safeJoinPath,
    normalizeAndRelativizePath,
    validatePmdRulesetPath
};