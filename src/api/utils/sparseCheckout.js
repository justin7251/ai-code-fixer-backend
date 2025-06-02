const fs = require('fs').promises;
const path = require('path');
const { execSync, exec } = require('child_process');
const os = require('os');
const util = require('util');
const execAsync = util.promisify(exec);

// Create a temporary directory for repository checkouts
const TEMP_DIR = path.join(os.tmpdir(), 'ai-code-fixer-repos');

/**
 * Performs a sparse checkout of a repository, only retrieving files matching the specified patterns
 * @param {string} repoUrl - The URL of the git repository
 * @param {string[]} patterns - Array of file patterns to include in sparse checkout
 * @param {string} [branch='main'] - The branch to checkout
 * @returns {Promise<string>} - Path to the checked out repository
 */
async function sparseCheckout(repoUrl, patterns, branch = 'main') {
    // Validate repoUrl
    const repoUrlRegex = /^[a-zA-Z0-9.:/@\-_]+$/;
    if (!repoUrlRegex.test(repoUrl)) {
        throw new Error(`Invalid repository URL format: ${repoUrl}`);
    }

    // Validate branch name
    // Allows alphanumeric, slashes, dots, underscores, hyphens.
    // Disallows control characters, spaces, consecutive slashes, consecutive dots,
    // starting/ending with slash or dot.
    const branchRegex = /^(?!.*(\.\.| |\/\/|\/\.|\.$|\/$|\^|~|:|\?|\[))[a-zA-Z0-9\/._-]+$/;
    if (!branchRegex.test(branch)) {
        throw new Error(`Invalid branch name: ${branch}`);
    }

    // Validate patterns
    const patternRegex = /^[a-zA-Z0-9*?\/._-]+$/;
    if (!Array.isArray(patterns) || patterns.some(pattern => !patternRegex.test(pattern))) {
        throw new Error('Invalid characters in patterns. Only alphanumeric, *, ?, /, ., _, - are allowed.');
    }

    try {
        // Create a unique directory name for each invocation to prevent race conditions
        const repoHash = Buffer.from(repoUrl).toString('base64').replace(/[\/\+\=]/g, '');
        const uniqueSuffix = `-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        const repoDir = path.join(TEMP_DIR, repoHash + uniqueSuffix);

        // Create temp directory if it doesn't exist (this is for TEMP_DIR itself)
        await fs.mkdir(TEMP_DIR, { recursive: true });

        // Create the unique repository directory. 
        // No need to check for existence or pre-remove, as it's unique.
        await fs.mkdir(repoDir, { recursive: true });
        
        // Initialize git repository
        console.log(`Initializing git repository in ${repoDir}...`);
        try {
            const stdout = execSync('git init', { cwd: repoDir });
            console.log(`'git init' stdout:\n${stdout}`);
        } catch (error) {
            console.error(`'git init' failed in ${repoDir}.`);
            console.error(`Stdout: ${error.stdout?.toString()}`);
            console.error(`Stderr: ${error.stderr?.toString()}`);
            throw error;
        }
        
        // Add remote
        console.log(`Adding remote for ${repoUrl}...`);
        try {
            const stdout = execSync(`git remote add origin ${repoUrl}`, { cwd: repoDir });
            console.log(`'git remote add origin' stdout:\n${stdout}`);
        } catch (error) {
            console.error(`'git remote add origin ${repoUrl}' failed in ${repoDir}.`);
            console.error(`Stdout: ${error.stdout?.toString()}`);
            console.error(`Stderr: ${error.stderr?.toString()}`);
            throw error;
        }
        
        // Configure sparse checkout
        console.log('Configuring sparse checkout...');
        try {
            const stdout = execSync('git config core.sparseCheckout true', { cwd: repoDir });
            console.log(`'git config core.sparseCheckout true' stdout:\n${stdout}`);
        } catch (error) {
            console.error(`'git config core.sparseCheckout true' failed in ${repoDir}.`);
            console.error(`Stdout: ${error.stdout?.toString()}`);
            console.error(`Stderr: ${error.stderr?.toString()}`);
            throw error;
        }
        
        // Write sparse checkout patterns to .git/info/sparse-checkout
        const sparseCheckoutFile = path.join(repoDir, '.git', 'info', 'sparse-checkout');
        await fs.writeFile(sparseCheckoutFile, patterns.join('\n'));
        
        // Fetch and checkout the specified branch
        console.log(`Fetching and checking out ${branch} branch...`);
        try {
            const stdout = execSync(`git fetch --depth=1 origin ${branch}`, { cwd: repoDir });
            console.log(`'git fetch --depth=1 origin ${branch}' stdout:\n${stdout}`);
        } catch (error) {
            console.error(`'git fetch --depth=1 origin ${branch}' failed in ${repoDir}.`);
            console.error(`Stdout: ${error.stdout?.toString()}`);
            console.error(`Stderr: ${error.stderr?.toString()}`);
            throw error;
        }
        // Checkout the remote tracking branch (e.g., 'origin/main') into a detached HEAD state.
        // This is suitable for temporary read-only access as it avoids creating a local branch.
        try {
            const stdout = execSync(`git checkout origin/${branch}`, { cwd: repoDir });
            console.log(`'git checkout origin/${branch}' stdout:\n${stdout}`);
        } catch (error) {
            console.error(`'git checkout origin/${branch}' failed in ${repoDir}.`);
            console.error(`Stdout: ${error.stdout?.toString()}`);
            console.error(`Stderr: ${error.stderr?.toString()}`);
            throw error;
        }
        
        console.log(`Repository checked out to ${repoDir}`);
        return repoDir;
    } catch (error) {
        console.error(`Sparse checkout failed: ${error.message}`);
        throw error;
    }
}

/**
 * Fetches a single file from a repository without cloning the entire repo
 * @param {string} repoUrl - The URL of the git repository
 * @param {string} filePath - Path to the file within the repository
 * @param {string} [branch='main'] - The branch to fetch from
 * @returns {Promise<string>} - Contents of the requested file
 */
async function fetchSingleFile(repoUrl, filePath, branch = 'main') {
    // For GitHub repositories, we can use the raw content URL
    if (repoUrl.includes('github.com')) {
        try {
            // Try different branch names if the first fails
            const branchesToTry = [branch, 'main', 'master'];
            let content = null;
            let lastError = null;
            
            // Extract GitHub repo details for better error messages
            const repoMatch = repoUrl.match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
            const repoOwner = repoMatch ? repoMatch[1] : '';
            const repoName = repoMatch ? repoMatch[2] : '';
            
            console.log(`[DEBUG] Attempting to fetch file "${filePath}" from ${repoOwner}/${repoName}`);
            
            // Try each branch until we find one that works
            for (const branchName of branchesToTry) {
                try {
                    // Convert github.com URL to raw.githubusercontent.com
                    const rawUrl = repoUrl
                        .replace('github.com', 'raw.githubusercontent.com')
                        .replace(/\.git$/, '')
                        + `/${branchName}/${filePath}`;
                    
                    console.log(`[DEBUG] Fetching from URL: ${rawUrl}`);
                    
                    const { default: fetch } = await import('node-fetch');
                    const response = await fetch(rawUrl);
                    
                    if (response.ok) {
                        content = await response.text();
                        console.log(`[DEBUG] Successfully fetched file from branch: ${branchName}`);
                        break; // Found the file, exit the loop
                    } else {
                        lastError = new Error(`Failed to fetch file (HTTP ${response.status}): ${response.statusText}`);
                        console.log(`[DEBUG] Branch ${branchName} failed with status ${response.status}`);
                    }
                } catch (error) {
                    lastError = error;
                    console.log(`[DEBUG] Error trying branch ${branchName}: ${error.message}`);
                }
            }
            
            if (content !== null) {
                return content;
            } else {
                const attemptedBranches = branchesToTry.join(', ');
                const repoId = repoOwner && repoName ? `${repoOwner}/${repoName}` : repoUrl;
                let errorMessage = `Failed to fetch file "${filePath}" from ${repoId} (tried branches: ${attemptedBranches}).`;
                if (lastError) {
                    errorMessage += ` Last error: ${lastError.message}`;
                }
                // Ensure a default error if lastError is somehow null, though the logic implies it should be set.
                throw new Error(errorMessage || `Failed to fetch file "${filePath}" from ${repoId} after trying branches: ${attemptedBranches}. Unknown error.`);
            }
        } catch (error) {
            // The error thrown from the try block will now be more specific for GitHub failures.
            // This catch block will log it and rethrow, preserving the detailed message.
            console.error(`[ERROR] Failed to fetch file from GitHub: ${error.message}`);
            throw error; // Rethrow the original error which now contains more details
        }
    } else {
        try {
            // For non-GitHub repositories, we need to use sparse checkout
            console.log(`[DEBUG] Using sparse checkout for non-GitHub repo: ${repoUrl}`);
            const repoDir = await sparseCheckout(repoUrl, [filePath], branch);
            const fileContent = await fs.readFile(path.join(repoDir, filePath), 'utf8');
            return fileContent;
        } catch (error) {
            console.error(`[ERROR] Failed to fetch file via sparse checkout: ${error.message}`);
            throw new Error(`Failed to fetch file via sparse checkout: ${error.message}`);
        }
    }
}

/**
 * Lists all files in a repository that match the given pattern(s)
 * @param {string} repoUrl - The URL of the git repository
 * @param {string[]} patterns - Array of glob patterns to match files
 * @param {string} [branch='main'] - The branch to checkout
 * @returns {Promise<string[]>} - Array of file paths that match the pattern
 */
async function listMatchingFiles(repoUrl, patterns, branch = 'main') {
    const repoDir = await sparseCheckout(repoUrl, patterns, branch);
    
    // Get all files recursively
    const getAllFiles = async (dir) => {
        const files = await fs.readdir(dir, { withFileTypes: true });
        const allFiles = await Promise.all(
            files.map(async (file) => {
                const filePath = path.join(dir, file.name);
                if (file.isDirectory()) {
                    return getAllFiles(filePath);
                } else {
                    return filePath;
                }
            })
        );
        
        return allFiles.flat();
    };
    
    const allFiles = await getAllFiles(repoDir);
    
    // Convert absolute paths to relative paths within the repository
    return allFiles.map(file => path.relative(repoDir, file));
}

/**
 * Cleans up temporary repositories that are older than the specified age
 * @param {number} maxAgeMs - Maximum age in milliseconds (default: 24 hours)
 */
async function cleanupOldRepositories(maxAgeMs = 24 * 60 * 60 * 1000) {
    try {
        const now = Date.now();
        
        // Get all directories in the temp folder
        const dirs = await fs.readdir(TEMP_DIR, { withFileTypes: true });
        
        for (const dir of dirs) {
            if (dir.isDirectory()) {
                const dirPath = path.join(TEMP_DIR, dir.name);
                const stats = await fs.stat(dirPath);
                
                // Remove directories older than the specified age
                if (now - stats.mtime.getTime() > maxAgeMs) {
                    console.log(`Removing old repository: ${dirPath}`);
                    await fs.rm(dirPath, { recursive: true, force: true });
                }
            }
        }
    } catch (error) {
        console.error(`Error during cleanup: ${error.message}`);
    }
}

module.exports = {
    sparseCheckout,
    fetchSingleFile,
    listMatchingFiles,
    cleanupOldRepositories
}; 