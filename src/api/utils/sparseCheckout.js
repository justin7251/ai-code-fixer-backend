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
    try {
        // Create a unique directory name based on repo URL
        const repoHash = Buffer.from(repoUrl).toString('base64').replace(/[\/\+\=]/g, '');
        const repoDir = path.join(TEMP_DIR, repoHash);

        // Create temp directory if it doesn't exist
        await fs.mkdir(TEMP_DIR, { recursive: true });

        // Check if the directory already exists
        try {
            await fs.access(repoDir);
            // If it exists, remove it to ensure a clean checkout
            await fs.rm(repoDir, { recursive: true, force: true });
        } catch (error) {
            // Directory doesn't exist, which is fine
        }

        // Create the repository directory
        await fs.mkdir(repoDir, { recursive: true });
        
        // Initialize git repository
        console.log(`Initializing git repository in ${repoDir}...`);
        execSync('git init', { cwd: repoDir });
        
        // Add remote
        console.log(`Adding remote for ${repoUrl}...`);
        execSync(`git remote add origin ${repoUrl}`, { cwd: repoDir });
        
        // Configure sparse checkout
        console.log('Configuring sparse checkout...');
        execSync('git config core.sparseCheckout true', { cwd: repoDir });
        
        // Write sparse checkout patterns to .git/info/sparse-checkout
        const sparseCheckoutFile = path.join(repoDir, '.git', 'info', 'sparse-checkout');
        await fs.writeFile(sparseCheckoutFile, patterns.join('\n'));
        
        // Fetch and checkout the specified branch
        console.log(`Fetching and checking out ${branch} branch...`);
        execSync(`git fetch --depth=1 origin ${branch}`, { cwd: repoDir });
        execSync(`git checkout origin/${branch}`, { cwd: repoDir });
        
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
                throw lastError || new Error(`Failed to fetch file "${filePath}" from any branch`);
            }
        } catch (error) {
            console.error(`[ERROR] Failed to fetch file from GitHub: ${error.message}`);
            throw new Error(`Failed to fetch file from GitHub: ${error.message}`);
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